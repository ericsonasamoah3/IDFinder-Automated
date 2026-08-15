"""
IDFinder1 backend Lambda.

Handles:
  POST /IDfinder   -> create a lost/found record. Public (no auth required),
                       matching the report forms which don't require login.
                       Automatically checks for a match against the opposite
                       record_type on (id_type, id_number_hint). On match,
                       both records are marked "matched" and an SMS is sent
                       to each party via SNS.

  GET  /IDfinder    -> list records, filtered by record_type=lost|found.
                       Public -- no login required, so anyone can quickly
                       check "has my ID turned up" without creating an
                       account. Returned fields deliberately EXCLUDE
                       reporter_email and reporter_phone -- those are never
                       returned by this API under any circumstances. Contact
                       details are only ever delivered out-of-band via SMS
                       once a match is confirmed.

Environment variables required:
  TABLE_NAME       - DynamoDB table name (see idfinder_table.tf)
  MATCH_INDEX_NAME - GSI name used for match lookups (default: match-index)
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Key

TABLE_NAME = os.environ["TABLE_NAME"]
MATCH_INDEX_NAME = os.environ.get("MATCH_INDEX_NAME", "match-index")
# Off by default so you can test the report/match flow without needing SNS
# SMS sandbox approval first. Matching still runs and records still get
# marked "matched" -- only the actual SMS send is skipped. Flip to "true"
# (see terraform/lambda.tf) once you're ready to send real texts.
SMS_ENABLED = os.environ.get("SMS_ENABLED", "false").lower() == "true"

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
sns = boto3.client("sns")

ALLOWED_ID_TYPES = {
    "national_id",
    "drivers_license",
    "passport",
    "student_id",
    "work_id",
    "other",
}
ALLOWED_RECORD_TYPES = {"lost", "found"}

# Fields returned by GET /IDfinder. reporter_email and reporter_phone are
# intentionally never included here -- see module docstring.
#
# name_on_id: the name printed on the ID itself (from OCR or manual entry).
# reporter_name/email/phone: whoever is SUBMITTING the report -- the ID's
# owner for a "lost" report, or the finder for a "found" report. These are
# deliberately kept separate: a finder does not know the owner's contact
# details, and the owner's contact details should never be shown to a
# stranger browsing found reports before a match is confirmed.
PUBLIC_FIELDS = (
    "record_id",
    "record_type",
    "name_on_id",
    "id_type",
    "id_number_hint",
    "location",
    "description",
    "status",
    "created_at",
)

CORS_HEADERS = {
    "Content-Type": "application/json",
    # Tighten to your Amplify domain + localhost in API Gateway / Terraform;
    # kept permissive here since the Lambda itself doesn't own CORS policy.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
}


def lambda_handler(event, context):
    try:
        method = event.get("httpMethod") or event.get(
            "requestContext", {}
        ).get("http", {}).get("method")

        if method == "OPTIONS":
            return response(200, {})
        if method == "GET":
            return handle_list(event)
        if method == "POST":
            return handle_create(event)

        return response(405, {"error": f"Unsupported method: {method}"})

    except ValidationError as e:
        return response(400, {"error": str(e)})
    except Exception as e:  # noqa: BLE001 - top-level Lambda guard
        print(f"Unhandled error: {e}")
        return response(500, {"error": "Internal server error"})


class ValidationError(Exception):
    pass


# ---------------------------------------------------------------------------
# GET /IDfinder
# ---------------------------------------------------------------------------

def handle_list(event):
    params = event.get("queryStringParameters") or {}
    record_type = params.get("record_type")

    if record_type and record_type not in ALLOWED_RECORD_TYPES:
        raise ValidationError("record_type must be 'lost' or 'found'")

    if record_type:
        result = table.scan(
            FilterExpression=Key("record_type").eq(record_type)
        )
    else:
        result = table.scan()

    items = [redact(item) for item in result.get("Items", [])]
    return response(200, {"success": True, "items": items})


def redact(item):
    return {field: item.get(field) for field in PUBLIC_FIELDS if field in item}


# ---------------------------------------------------------------------------
# POST /IDfinder
# ---------------------------------------------------------------------------

def handle_create(event):
    if not event.get("body"):
        raise ValidationError("No request body received")

    body = json.loads(event["body"])
    record = build_record(body)

    table.put_item(Item=record)

    match = find_match(record)
    if match:
        mark_matched_and_notify(record, match)
        record["status"] = "matched"

    return response(201, {"success": True, "record_id": record["record_id"]})


def build_record(body):
    record_type = body.get("record_type")
    name_on_id = (body.get("name_on_id") or "").strip()
    reporter_name = (body.get("reporter_name") or "").strip()
    reporter_email = (body.get("reporter_email") or "").strip()
    reporter_phone = (body.get("reporter_phone") or "").strip()
    id_type = body.get("id_type")
    id_number_hint = (body.get("id_number_hint") or "").strip()
    location = (body.get("location") or "").strip()
    description = (body.get("description") or "").strip()

    if record_type not in ALLOWED_RECORD_TYPES:
        raise ValidationError("record_type must be 'lost' or 'found'")
    if not name_on_id:
        raise ValidationError("name_on_id is required")
    if not reporter_name:
        raise ValidationError("reporter_name is required")
    if not reporter_email or "@" not in reporter_email:
        raise ValidationError("A valid reporter_email is required")
    if not reporter_phone or not is_valid_phone(reporter_phone):
        raise ValidationError(
            "A valid reporter_phone is required, in E.164 format e.g. +447700900123"
        )
    if id_type not in ALLOWED_ID_TYPES:
        raise ValidationError("id_type is not a recognised type")
    if not location:
        raise ValidationError("location is required")

    now = datetime.now(timezone.utc).isoformat()

    return {
        "record_id": str(uuid.uuid4()),
        "record_type": record_type,
        "name_on_id": name_on_id,
        "reporter_name": reporter_name,
        "reporter_email": reporter_email,
        "reporter_phone": reporter_phone,
        "id_type": id_type,
        "id_number_hint": id_number_hint,
        "match_key": f"{id_type}#{id_number_hint}",
        "location": location,
        "description": description,
        "status": "pending",
        "matched_with": None,
        "created_at": now,
    }


def is_valid_phone(phone):
    # Basic E.164 check: + followed by 8-15 digits.
    return re.fullmatch(r"\+[1-9]\d{7,14}", phone) is not None


# ---------------------------------------------------------------------------
# Matching + SMS
# ---------------------------------------------------------------------------

def find_match(record):
    """Look for a pending record of the opposite type with the same
    (id_type, id_number_hint) pair."""
    if not record["id_number_hint"]:
        # An empty hint is too weak to match on -- skip matching entirely
        # rather than pairing records on id_type alone.
        return None

    opposite_type = "found" if record["record_type"] == "lost" else "lost"

    result = table.query(
        IndexName=MATCH_INDEX_NAME,
        KeyConditionExpression=(
            Key("match_key").eq(record["match_key"])
            & Key("record_type").eq(opposite_type)
        ),
    )

    for candidate in result.get("Items", []):
        if candidate.get("status") == "pending":
            return candidate

    return None


def mark_matched_and_notify(record, match):
    table.update_item(
        Key={"record_id": record["record_id"]},
        UpdateExpression="SET #s = :matched, matched_with = :other",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":matched": "matched",
            ":other": match["record_id"],
        },
    )
    table.update_item(
        Key={"record_id": match["record_id"]},
        UpdateExpression="SET #s = :matched, matched_with = :other",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":matched": "matched",
            ":other": record["record_id"],
        },
    )

    send_match_sms(to_phone=record["reporter_phone"], other=match)
    send_match_sms(to_phone=match["reporter_phone"], other=record)


def send_match_sms(to_phone, other):
    message = (
        "IDFinder: possible match found for your ID report. "
        f"Contact {other['reporter_name']} at {other['reporter_email']} to confirm."
    )

    if not SMS_ENABLED:
        # SMS disabled for testing -- log what would have been sent instead
        # of calling SNS. Matching/record-status logic above still runs
        # normally, so you can verify the match flow end-to-end.
        print(f"[SMS disabled] Would send to {to_phone}: {message}")
        return

    sns.publish(
        PhoneNumber=to_phone,
        Message=message,
        MessageAttributes={
            "AWS.SNS.SMS.SMSType": {
                "DataType": "String",
                "StringValue": "Transactional",
            }
        },
    )


# ---------------------------------------------------------------------------
# Response helper
# ---------------------------------------------------------------------------

class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return int(o) if o % 1 == 0 else float(o)
        return super().default(o)


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": CORS_HEADERS,
        "body": json.dumps(body, cls=DecimalEncoder),
    }
