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
                       reporter_email, reporter_phone AND id_number_hint --
                       see PUBLIC_FIELDS. Contact details are only ever
                       delivered out-of-band via SMS once a match is
                       confirmed.

Location, for the map layer:
  A report carries a `location_input` of one of three shapes -- device GPS, a
  dragged pin, or a typed address. GPS and a dragged pin already hold
  coordinates, so they are stored inline here: no external call, no added
  latency. A typed address is NOT geocoded here. The record is saved without
  coordinates and a job goes to the geocode queue, where idfinder_geocode_worker
  resolves it and updates the record. That update raises a Streams event which
  rebuilds the public pin files.

  Geocoding is a call to a third party that can be slow or down, and this is
  the request path. The same reasoning already moved image archiving onto SQS
  (see idfinder_save.py). A report must never wait on a metered API.

Environment variables required:
  TABLE_NAME         - DynamoDB table name (see terraform/dynamodb.tf)
  MATCH_INDEX_NAME   - GSI name used for match lookups (default: match-index)
  GEOCODE_QUEUE_URL  - SQS queue consumed by idfinder_geocode_worker. Optional:
                       if unset, typed addresses are simply stored unresolved
                       rather than failing the report.
"""

import json
import os
import re
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
MATCH_INDEX_NAME = os.environ.get("MATCH_INDEX_NAME", "match-index")
GEOCODE_QUEUE_URL = os.environ.get("GEOCODE_QUEUE_URL", "")
# Off by default so you can test the report/match flow without needing SNS
# SMS sandbox approval first. Matching still runs and records still get
# marked "matched" -- only the actual SMS send is skipped. Flip to "true"
# (see terraform/lambda.tf) once you're ready to send real texts.
SMS_ENABLED = os.environ.get("SMS_ENABLED", "false").lower() == "true"

# Hard cap on records returned by a single GET, so a large table can't blow
# the Lambda's memory or API Gateway's response size limit.
MAX_LIST_ITEMS = 500

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
sns = boto3.client("sns")
sqs = boto3.client("sqs")

ALLOWED_ID_TYPES = {
    "national_id",
    "drivers_license",
    "passport",
    "student_id",
    "work_id",
    "other",
}
ALLOWED_RECORD_TYPES = {"lost", "found"}

# Fields returned by GET /IDfinder.
#
# Deliberately excluded:
#   reporter_email / reporter_phone -- contact details, never returned.
#   id_number_hint -- this plus id_type IS the match key (see build_record).
#                     Publishing it let anyone read a pending record's last-4,
#                     POST a forged opposite-type record with their own phone
#                     number, and be texted the other party's name and email --
#                     while also burning the real record's "pending" status so
#                     the genuine finder could never match it. The hint is
#                     still stored and still used for matching; it is just no
#                     longer broadcast.
#   photo_key      -- internal S3 object key, not useful to a browser and not
#                     something to hand out.
#   lat / lng      -- the stored coordinate is full precision. The public map
#                     is served from static GeoJSON that geojson_builder has
#                     already snapped to a 250m grid; handing out the exact
#                     position here would defeat that entirely. Precise
#                     coordinates reach a matched pair by SMS, never by API.
#   geo_source / geo_accuracy_m / address_raw -- same reasoning. address_raw
#                     is whatever the reporter typed, which may be far more
#                     precise than the fuzzed pin.
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

    scan_kwargs = {}
    if record_type:
        # Attr, not Key: FilterExpression operates on non-key attributes.
        # Key() renders the same expression here by coincidence, but it is
        # the wrong builder and breaks as soon as the filter gets richer.
        scan_kwargs["FilterExpression"] = Attr("record_type").eq(record_type)

    # A single scan() returns at most 1MB and then stops, leaving the rest
    # behind LastEvaluatedKey. Without this loop the listing silently
    # truncated once the table outgrew 1MB -- no error, just missing records.
    items = []
    while True:
        result = table.scan(**scan_kwargs)
        items.extend(redact(item) for item in result.get("Items", []))

        last_key = result.get("LastEvaluatedKey")
        if not last_key or len(items) >= MAX_LIST_ITEMS:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    return response(200, {"success": True, "items": items[:MAX_LIST_ITEMS]})


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

    # After the write, so a queue outage can never cost us the record, and
    # before matching, so a typed address starts resolving while the match
    # lookup runs.
    enqueue_geocode(record)

    match = find_match(record)
    if match and mark_matched_and_notify(record, match):
        record["status"] = "matched"

    return response(
        201,
        {
            "success": True,
            "record_id": record["record_id"],
            # Lets the form tell the reporter their pin is still resolving,
            # rather than leaving them wondering why the map looks empty.
            "pin_pending": bool(record.get("address_raw")) and "lat" not in record,
        },
    )


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
    photo_key = (body.get("photo_key") or "").strip()

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
    assert_location_is_coarse(location)

    # Matching compares match_key by exact string equality, so an unnormalised
    # hint ("1234 " vs "1234", "ksab" vs "KSAB") silently fails to match.
    # Strip separators, upper-case, take the last 4.
    #
    # Alphanumeric, NOT digits-only: plenty of ID numbers end in letters -- a
    # UK driving licence like ASAMO712049EK9AB ends "EK9AB". Stripping to
    # digits turned those into an empty hint and rejected the submission with
    # "id_number_hint is required", on a value the OCR had just auto-filled.
    id_number_hint = re.sub(r"[^A-Za-z0-9]", "", id_number_hint).upper()[-4:]
    if not id_number_hint:
        raise ValidationError(
            "id_number_hint is required -- matching relies on it, and a "
            "record without it can never be matched"
        )

    now = datetime.now(timezone.utc).isoformat()

    record = {
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
        "photo_key": photo_key,
        "status": "pending",
        "matched_with": None,
        "created_at": now,
    }

    record.update(build_location_fields(body.get("location_input")))
    return record


# ---------------------------------------------------------------------------
# Location
# ---------------------------------------------------------------------------

# A street number followed by a word ("14 Foo Street"), either at the start or
# after a comma so "Flat 2, 14 Foo Street" is caught too.
STREET_NUMBER_RE = re.compile(r"(^|,\s*)\d{1,4}[A-Za-z]?\s+[A-Za-z]")

# A full UK postcode identifies roughly fifteen addresses -- finer than the
# 250m grid the map pins are snapped to. The outward code alone ("SW1A") is
# district-level and stays allowed.
FULL_POSTCODE_RE = re.compile(r"\b[A-Za-z]{1,2}\d[A-Za-z\d]?\s*\d[A-Za-z]{2}\b")


def assert_location_is_coarse(location):
    """Keep the public free-text location no sharper than the public pin.

    `location` is in PUBLIC_FIELDS: it is required at submit and returned to
    any caller, signed in or not. Snapping the coordinate to a 250m grid while
    publishing "outside 14 Foo Street" in the very next field protects
    nothing -- the precise location is still public, just in a different
    field. This field is an AREA, and is validated as one.

    Deliberately a rejection rather than a silent truncation: quietly editing
    what someone typed leaves them believing the precise text was recorded.
    """
    if STREET_NUMBER_RE.search(location):
        raise ValidationError(
            "Please give an area rather than a street address -- a "
            "neighbourhood, landmark or street name without the number. "
            "Exact positions are shared only once a match is confirmed."
        )
    if FULL_POSTCODE_RE.search(location):
        raise ValidationError(
            "Please leave off the full postcode -- the first half on its own "
            "(e.g. SW1A) is fine. Exact positions are shared only once a "
            "match is confirmed."
        )


def build_location_fields(location_input):
    """Turn the form's location_input into stored attributes.

    Three shapes, and only one of them costs anything:

      {"source": "device", "lat": .., "lng": .., "accuracy_m": ..}
      {"source": "manual", "lat": .., "lng": ..}
      {"source": "geocoded", "address": ".."}

    device and manual already carry coordinates, so they are stored inline.
    geocoded stores the raw address and leaves coordinates absent -- the
    record is enqueued for the geocode worker by handle_create().

    Anything malformed returns {} rather than raising. A location is a
    nice-to-have on a report; refusing to file a lost ID because a browser
    sent a odd accuracy value would be the wrong trade.
    """
    if not isinstance(location_input, dict):
        return {}

    source = location_input.get("source")

    if source in ("device", "manual"):
        lat = to_coord(location_input.get("lat"))
        lng = to_coord(location_input.get("lng"))
        if lat is None or lng is None:
            return {}
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            return {}
        # 0,0 is Null Island in the Gulf of Guinea. It is what a failed
        # geolocation call looks like far more often than a real position.
        if lat == 0 and lng == 0:
            return {}

        fields = {
            "lat": Decimal(str(lat)),
            "lng": Decimal(str(lng)),
            "geo_source": source,
        }

        accuracy = to_coord(location_input.get("accuracy_m"))
        if source == "device" and accuracy is not None and accuracy >= 0:
            fields["geo_accuracy_m"] = Decimal(str(round(accuracy)))

        return fields

    if source == "geocoded":
        address = (location_input.get("address") or "").strip()
        if not address:
            return {}
        # No coordinates and no geo_source yet: the worker sets both when it
        # resolves. Absent geo_source is how "unpinned" is represented.
        return {"address_raw": address[:250]}

    return {}


def to_coord(value):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    # NaN and the infinities all survive float() and then poison every
    # comparison downstream, so screen them out here.
    if parsed != parsed or parsed in (float("inf"), float("-inf")):
        return None
    return parsed


def enqueue_geocode(record):
    """Ask the geocode worker to resolve this record's typed address.

    Best-effort by design. If the queue is unset or the send fails, the report
    is already saved -- it simply has no pin. Failing the request here would
    lose a lost-ID report over a map feature, which is the wrong priority.
    """
    address = record.get("address_raw")
    if not address or not GEOCODE_QUEUE_URL:
        return

    try:
        sqs.send_message(
            QueueUrl=GEOCODE_QUEUE_URL,
            MessageBody=json.dumps(
                {"record_id": record["record_id"], "address": address}
            ),
        )
    except ClientError as e:
        print(f"Could not enqueue geocode for {record['record_id']}: {e}")


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
    """Claim `match` for `record` and notify both parties.

    Returns True if this call won the match, False if a concurrent request
    claimed the same pending record first.
    """
    # Claim the candidate conditionally. Two simultaneous POSTs can both see
    # the same pending record in find_match(); whichever arrives here second
    # fails the condition and backs off rather than silently overwriting the
    # first match.
    try:
        table.update_item(
            Key={"record_id": match["record_id"]},
            UpdateExpression="SET #s = :matched, matched_with = :other",
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":matched": "matched",
                ":other": record["record_id"],
                ":pending": "pending",
            },
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print(
                f"Match {match['record_id']} was already claimed by another "
                f"request; leaving {record['record_id']} pending."
            )
            return False
        raise

    table.update_item(
        Key={"record_id": record["record_id"]},
        UpdateExpression="SET #s = :matched, matched_with = :other",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":matched": "matched",
            ":other": match["record_id"],
        },
    )

    # A notification failure must not fail the request. Both records are
    # already written and marked matched by this point, so raising here would
    # return a 500 to a caller whose report actually succeeded -- they would
    # retry and create a duplicate. Log and carry on instead.
    try:
        send_match_sms(to_phone=record["reporter_phone"], other=match)
        send_match_sms(to_phone=match["reporter_phone"], other=record)
    except Exception as e:  # noqa: BLE001
        print(
            f"Match {record['record_id']}<->{match['record_id']} recorded, "
            f"but SMS notification failed: {e}"
        )

    return True


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
