"""
Handles POST /save -- archives an ID photo and its OCR output to S3.

Layout in the bucket, keyed by the name printed on the ID:

    lost/ERICSON_KOFI_ASAMOAH.jpg          <- the photo
    lost/json/ERICSON_KOFI_ASAMOAH.json    <- the OCR output for it
    found/JANE_DOE.jpg
    found/json/JANE_DOE.json

Each of `lost/` and `found/` holds that side's photos directly, with the
matching OCR JSON alongside in a `json/` subfolder under the same base
filename, so a photo and its extracted data are always findable from each
other.

The frontend calls this right before submitting a lost/found report if the
user attached a photo. It is intentionally decoupled from the DynamoDB
write in idfinder_backend.py: a failed image save shouldn't block a report,
and a report shouldn't require a photo.

Environment variables required:
  BUCKET_NAME - S3 bucket to store uploaded ID photos in
"""

import base64
import json
import os
import re
import unicodedata
import uuid

import boto3
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ["BUCKET_NAME"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB guard against oversized uploads
MAX_NAME_LEN = 80  # keep keys readable; S3 itself allows far more

s3 = boto3.client("s3")


def lambda_handler(event, context):
    try:
        if not event.get("body"):
            return response(400, {"error": "No request body received"})

        body = json.loads(event["body"])
        image_b64 = body.get("image_base64")
        form_type = body.get("form_type", "unknown")
        name_on_id = body.get("name_on_id") or ""
        ocr_json = body.get("ocr_json")

        if not image_b64:
            return response(400, {"error": "image_base64 missing from request"})
        if form_type not in ("lost", "found", "unknown"):
            return response(400, {"error": "form_type must be 'lost' or 'found'"})

        image_bytes = base64.b64decode(image_b64)
        if len(image_bytes) > MAX_IMAGE_BYTES:
            return response(400, {"error": "Image exceeds 8MB limit"})

        base = ensure_unique(form_type, safe_filename(name_on_id))

        image_key = f"{form_type}/{base}.jpg"
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=image_key,
            Body=image_bytes,
            ContentType="image/jpeg",
            ServerSideEncryption="AES256",
        )

        json_key = None
        if ocr_json is not None:
            json_key = f"{form_type}/json/{base}.json"
            s3.put_object(
                Bucket=BUCKET_NAME,
                Key=json_key,
                Body=json.dumps(ocr_json, indent=2).encode("utf-8"),
                ContentType="application/json",
                ServerSideEncryption="AES256",
            )

        return response(200, {"success": True, "key": image_key, "json_key": json_key})

    except Exception as e:  # noqa: BLE001
        # Log the detail, return a generic message -- str(e) leaked bucket
        # names and boto internals to a public, unauthenticated endpoint.
        print(f"Image save failed: {e}")
        return response(500, {"success": False, "error": "Could not save the image."})


def safe_filename(name):
    """Turn the name printed on an ID into a safe, readable S3 key segment.

    "Ericson Kofi Asamoah" -> "ERICSON_KOFI_ASAMOAH"

    Accents are folded rather than dropped ("Munoz" from "Muñoz") so the key
    stays recognisable. Anything left that isn't alphanumeric becomes an
    underscore, which keeps keys free of the characters that make them
    awkward to handle from a shell, a URL, or the S3 console.
    """
    folded = unicodedata.normalize("NFKD", name)
    ascii_only = folded.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", ascii_only).strip("_").upper()
    cleaned = cleaned[:MAX_NAME_LEN].strip("_")

    # No usable name: OCR found nothing and the field was left blank, or the
    # name was written entirely in a non-latin script. A UUID keeps the
    # upload from failing and from colliding with a real name.
    return cleaned or f"UNNAMED_{uuid.uuid4().hex[:8]}"


def ensure_unique(form_type, base):
    """Avoid silently overwriting an earlier report filed under the same name.

    Two different people genuinely can share a name, and the same person can
    report more than once. Without this, a second upload would replace the
    first one's photo and JSON with no trace that it had happened.
    """
    try:
        s3.head_object(Bucket=BUCKET_NAME, Key=f"{form_type}/{base}.jpg")
    except ClientError as e:
        # 404 means the name is free, which is the common case.
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return base
        raise

    return f"{base}_{uuid.uuid4().hex[:6].upper()}"


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "OPTIONS,POST",
            "Access-Control-Allow-Headers": "Content-Type",
        },
        "body": json.dumps(body),
    }
