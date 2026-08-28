"""
SQS consumer for image-save jobs enqueued by idfinder_save.py.

Writes the archive layout, keyed by the name printed on the ID:

    lost/ERICSON_KOFI_ASAMOAH.jpg          <- the photo
    lost/json/ERICSON_KOFI_ASAMOAH.json    <- the OCR output for it
    found/JANE_DOE.jpg
    found/json/JANE_DOE.json

Each of `lost/` and `found/` holds that side's photos directly, with the
matching OCR JSON alongside in a `json/` subfolder under the same base
filename, so a photo and its extracted data are always findable from each
other.

Per job it copies the staged object to its final key, writes the JSON
sidecar, and deletes the staging object.

Failure handling: this returns batchItemFailures rather than raising, so one
bad job in a batch does not force redelivery of the ones that succeeded.
A job that keeps failing is retried by SQS and moves to the dead-letter
queue after the redrive policy's maxReceiveCount. Requires
ReportBatchItemFailures on the event source mapping (see terraform/lambda.tf).

Idempotency matters here: SQS is at-least-once, so a job can legitimately
arrive twice. Every operation below is safe to repeat -- the copy overwrites
the same key with the same bytes, and a missing staging object on the second
run is treated as work already done rather than an error.

Environment variables required:
  BUCKET_NAME - S3 bucket holding both the staging and final objects
"""

import json
import os

import boto3
from botocore.exceptions import ClientError

BUCKET_NAME = os.environ["BUCKET_NAME"]

s3 = boto3.client("s3")


def lambda_handler(event, context):
    failures = []

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            process_job(json.loads(record["body"]))
        except Exception as e:  # noqa: BLE001
            # Log and mark only this message for retry. Raising instead would
            # redeliver the whole batch, including jobs that already wrote
            # their objects.
            print(f"Save job {message_id} failed: {e}")
            failures.append({"itemIdentifier": message_id})

    return {"batchItemFailures": failures}


def process_job(job):
    staging_key = job["staging_key"]
    image_key = job["image_key"]
    json_key = job.get("json_key")
    ocr_json = job.get("ocr_json")

    if not copy_to_final(staging_key, image_key):
        # Staging object is gone. Either a previous delivery of this same
        # message already finished the job, or the lifecycle rule expired it.
        # Neither is retryable, so report success and let the message drop
        # rather than burning attempts on its way to the DLQ.
        print(
            f"Staging object {staging_key} missing; treating job "
            f"{job.get('job_id')} as already complete."
        )
        return

    if json_key and ocr_json is not None:
        s3.put_object(
            Bucket=BUCKET_NAME,
            Key=json_key,
            Body=json.dumps(ocr_json, indent=2).encode("utf-8"),
            ContentType="application/json",
            ServerSideEncryption="AES256",
        )

    # Only after both writes have succeeded -- if the JSON write throws, the
    # retry still finds the staged bytes and can finish the job.
    s3.delete_object(Bucket=BUCKET_NAME, Key=staging_key)

    print(f"Saved {image_key}" + (f" and {json_key}" if json_key else ""))


def copy_to_final(staging_key, image_key):
    """Copy staging -> final. Returns False if the staged object is gone."""
    try:
        s3.copy_object(
            Bucket=BUCKET_NAME,
            CopySource={"Bucket": BUCKET_NAME, "Key": staging_key},
            Key=image_key,
            ContentType="image/jpeg",
            ServerSideEncryption="AES256",
            MetadataDirective="REPLACE",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] in ("404", "NoSuchKey", "NotFound"):
            return False
        raise
