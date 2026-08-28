"""
POST /save -- accepts an ID photo, then hands the archiving work to SQS.

This Lambda is the PRODUCER. It does the fast, request-path work only:

  1. validate the payload
  2. work out the final S3 key from the name on the ID
  3. drop the raw bytes at incoming/<uuid>.jpg
  4. enqueue a small job message
  5. return 202 immediately

The actual archiving -- final naming, the JSON sidecar, cleanup -- happens in
idfinder_save_worker.py, triggered by the queue. See that module for the
layout it writes.

Why the bytes go to S3 rather than into the message: SQS caps a message at
256 KB and uploads here can reach 8 MB, so the image cannot travel in the
message body. This is the "claim check" pattern -- store the payload, pass a
pointer. The message carries only the pointer plus small metadata.

What decoupling buys: a slow or failing S3 write no longer holds the browser
request open, and a job that fails is retried by SQS and lands in the
dead-letter queue after MAX_RECEIVES attempts instead of vanishing into a
500 the user never sees again.

Environment variables required:
  BUCKET_NAME    - S3 bucket to store uploaded ID photos in
  SAVE_QUEUE_URL - SQS queue the worker consumes from
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
SAVE_QUEUE_URL = os.environ["SAVE_QUEUE_URL"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB guard against oversized uploads
MAX_NAME_LEN = 80  # keep keys readable; S3 itself allows far more

s3 = boto3.client("s3")
sqs = boto3.client("sqs")


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
        json_key = f"{form_type}/json/{base}.json" if ocr_json is not None else None

        # Claim check: park the bytes, pass a pointer.
        staging_key = f"incoming/{uuid.uuid4()}.jpg"
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=staging_key,
            Body=image_bytes,
            ContentType="image/jpeg",
            ServerSideEncryption="AES256",
        )

        job_id = str(uuid.uuid4())
        sqs.send_message(
            QueueUrl=SAVE_QUEUE_URL,
            MessageBody=json.dumps(
                {
                    "job_id": job_id,
                    "staging_key": staging_key,
                    "image_key": image_key,
                    "json_key": json_key,
                    "ocr_json": ocr_json,
                }
            ),
        )

        # 202, not 200: the object is not at image_key yet. The key is
        # returned anyway so the caller can record it against the report --
        # the worker writes to exactly this key.
        return response(
            202,
            {
                "success": True,
                "key": image_key,
                "json_key": json_key,
                "job_id": job_id,
            },
        )

    except Exception as e:  # noqa: BLE001
        # Log the detail, return a generic message -- str(e) leaked bucket
        # names and boto internals to a public, unauthenticated endpoint.
        print(f"Enqueue of image save failed: {e}")
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

    This runs in the producer so the caller can be told the final key
    synchronously. Two uploads of the same name landing within the same
    instant can still both see the name as free; that is a narrow race and
    the loser is overwritten rather than lost.
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
