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
        with urllib.request.urlopen(req, timeout=60) as res:
            container_output = json.loads(res.read().decode("utf-8"))

        # -----------------------------
        # 3) Normalise response
        # -----------------------------
        extracted = container_output.get("extracted_details", {})
        name_on_id = extracted.get("full_name", "")
        licence_number = extracted.get("licence_number", "")
        id_number_hint = licence_number[-4:] if len(licence_number) >= 4 else licence_number

        raw_doc_type = container_output.get("document_type", "").lower()
        if "licence" in raw_doc_type:
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
    except Exception as e:
        return response(500, {
            "success": False,
            "error": str(e),
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
