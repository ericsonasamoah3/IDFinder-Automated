"""
Handles POST /saveprocess/save -- uploads a base64-encoded ID photo to S3.

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
import uuid

import boto3

BUCKET_NAME = os.environ["BUCKET_NAME"]
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB guard against oversized uploads

s3 = boto3.client("s3")


def lambda_handler(event, context):
    try:
        if not event.get("body"):
            return response(400, {"error": "No request body received"})

        body = json.loads(event["body"])
        image_b64 = body.get("image_base64")
        form_type = body.get("form_type", "unknown")

        if not image_b64:
            return response(400, {"error": "image_base64 missing from request"})
        if form_type not in ("lost", "found", "unknown"):
            return response(400, {"error": "form_type must be 'lost' or 'found'"})

        image_bytes = base64.b64decode(image_b64)
        if len(image_bytes) > MAX_IMAGE_BYTES:
            return response(400, {"error": "Image exceeds 8MB limit"})

        key = f"{form_type}/{uuid.uuid4()}.jpg"
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=key,
            Body=image_bytes,
            ContentType="image/jpeg",
            ServerSideEncryption="AES256",
        )

        return response(200, {"success": True, "key": key})

    except Exception as e:  # noqa: BLE001
        return response(500, {"success": False, "error": str(e)})


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
