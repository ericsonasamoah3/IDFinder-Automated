import json
import base64
import os
import urllib.request

CONTAINER_URL = os.environ["CONTAINER_URL"]
# Set to your real frontend origin(s) via Terraform, e.g. your Amplify domain.
# Falls back to "*" only if not configured, so local dev keeps working.
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "*")


def lambda_handler(event, context):
    try:
        # -----------------------------
        # 1) Parse JSON body
        # -----------------------------
        if "body" not in event or not event["body"]:
            return response(400, {"error": "No request body received"})
        body = json.loads(event["body"])
        if "image_base64" not in body:
            return response(400, {"error": "image_base64 missing from request"})
        image_bytes = base64.b64decode(body["image_base64"])

        # -----------------------------
        # 2) Send image to OCR container
        # -----------------------------
        req = urllib.request.Request(
            url=CONTAINER_URL,
            data=image_bytes,
            headers={"Content-Type": "application/octet-stream"},
            method="POST",
        )
        # Must stay under the Lambda's own timeout (29s, itself capped by
        # API Gateway's ~30s integration limit). A longer timeout here is
        # unreachable -- the request is killed upstream before it fires.
        with urllib.request.urlopen(req, timeout=25) as res:
            container_output = json.loads(res.read().decode("utf-8"))

        # -----------------------------
        # 3) Normalise response
        # -----------------------------
        # The container returns its fields FLAT, not wrapped:
        #   {"is_government_id": true, "document_type": "Driving Licence",
        #    "full_name": ..., "license_number": ..., "date_of_birth": ...}
        # This used to read container_output["extracted_details"], which does
        # not exist -- so it silently got {} and every field came back empty.
        # document_type was read from the top level, which is why the ID type
        # mapped correctly while the name and number stayed blank. The `or`
        # keeps working if a future image version does wrap its output.
        extracted = container_output.get("extracted_details") or container_output

        name_on_id = extracted.get("full_name") or ""
        # US spelling is what the container actually emits; accept both, since
        # the field name is the container's to change and this is cheap.
        licence_number = (
            extracted.get("license_number")
            or extracted.get("licence_number")
            or ""
        )
        id_number_hint = licence_number[-4:] if len(licence_number) >= 4 else licence_number

        raw_doc_type = (container_output.get("document_type") or "").lower()
        if "licence" in raw_doc_type or "license" in raw_doc_type:
            id_type = "drivers_license"
        elif "passport" in raw_doc_type:
            id_type = "passport"
        elif "national" in raw_doc_type:
            id_type = "national_id"
        elif "student" in raw_doc_type:
            id_type = "student_id"
        elif "work" in raw_doc_type:
            id_type = "work_id"
        else:
            id_type = "other"

        # -----------------------------
        # 4) Return frontend response
        # -----------------------------
        return response(200, {
            "success": True,
            "name_on_id": name_on_id,
            "id_type": id_type,
            "id_number_hint": id_number_hint,
        })
    except Exception as e:  # noqa: BLE001
        # Log the detail, return a generic message. str(e) here leaked the
        # container's internal ALB hostname and urllib internals to any
        # caller, and this endpoint is public.
        print(f"OCR process failed: {e}")
        return response(500, {
            "success": False,
            "error": "Could not process the image. Please try again.",
        })


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
