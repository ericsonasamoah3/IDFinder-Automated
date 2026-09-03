"""Rebuilds the two public pin files whenever a record changes.

    s3://<map bucket>/pins/lost.geojson
    s3://<map bucket>/pins/found.geojson

Triggered by DynamoDB Streams on the records table. It does not read the
stream's contents beyond "something changed" -- it rebuilds both files from a
full scan every time. That is the right trade at this size: the dataset is
small, the files must be internally consistent, and an incremental writer
would have to solve merge ordering for no benefit yet. Batching on the event
source mapping (25 records / 30s window) keeps a burst of writes down to one
rebuild.

Where this stops working: somewhere in the low tens of thousands of records a
full scan per rebuild gets expensive, and the answer then is an incremental
build, not a bigger scan. Ordering is safe today because Streams processes one
shard serially, so two rebuilds cannot interleave and leave a stale file
behind; revisit that if the table ever grows enough to split shards.

WHAT GOES IN THE FILES -- these are public, unauthenticated, and cacheable:

  * only `record_id` and `record_type` per feature. No names, no ID numbers,
    no contact details, no free-text location, no timestamps.
  * only records still `pending`. A matched record has been returned to its
    owner; leaving it pinned turns the map into a growing pile of resolved
    reports and makes every rebuild slower for no user benefit.
  * every coordinate snapped to a ~250m grid. NEVER the stored precision.

The fuzzing is not decoration. An exact public map of where found IDs are
sitting is a shopping list for a fraudulent claimant, and exact lost locations
leak the reporter's movements. Precise coordinates stay in DynamoDB and reach
a matched pair through the existing SMS path only.

Environment variables required:
  TABLE_NAME - DynamoDB table holding the records
  MAP_BUCKET - S3 bucket serving the map behind CloudFront
"""

import json
import math
import os

import boto3
from boto3.dynamodb.conditions import Attr

TABLE_NAME = os.environ["TABLE_NAME"]
MAP_BUCKET = os.environ["MAP_BUCKET"]

GRID_M = 250.0

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
s3 = boto3.client("s3")


def fuzz(lat, lng):
    """Snap a coordinate to the nearest ~250m grid intersection.

    Longitude degrees get narrower toward the poles, so the longitude step is
    scaled by cos(latitude) to keep the cell roughly square on the ground.
    The cos() is floored at 0.01 so a coordinate near a pole cannot divide by
    zero -- a real crash we would only ever see from a GPS glitch.
    """
    lat_step = GRID_M / 111_320.0
    lng_step = GRID_M / (111_320.0 * max(math.cos(math.radians(lat)), 0.01))
    return (
        round(lat / lat_step) * lat_step,
        round(lng / lng_step) * lng_step,
    )


def lambda_handler(event, context):
    features = {"lost": [], "found": []}

    for item in scan_pinnable():
        record_type = item.get("record_type")
        if record_type not in features:
            continue

        lat, lng = fuzz(float(item["lat"]), float(item["lng"]))

        features[record_type].append(
            {
                "type": "Feature",
                "geometry": {
                    # GeoJSON is [longitude, latitude]. Reversing this is the
                    # classic way to put every pin in the sea off Africa.
                    "type": "Point",
                    "coordinates": [round(lng, 5), round(lat, 5)],
                },
                "properties": {
                    "record_id": item["record_id"],
                    "record_type": record_type,
                },
            }
        )

    for record_type, collection in features.items():
        write_collection(record_type, collection)

    counts = {k: len(v) for k, v in features.items()}
    print(f"Rebuilt pin files: {counts}")
    return {"ok": True, "counts": counts}


def scan_pinnable():
    """Yield every pending record that has coordinates.

    ProjectionExpression keeps names, contact details and the free-text
    location out of this Lambda's memory entirely. It cannot leak a field it
    never read.

    `lng` is a DynamoDB reserved word, hence the expression-name aliases.
    """
    kwargs = {
        "ProjectionExpression": "record_id, record_type, #lat, #lng, #st",
        "ExpressionAttributeNames": {
            "#lat": "lat",
            "#lng": "lng",
            "#st": "status",
        },
        "FilterExpression": (
            Attr("lat").exists()
            & Attr("lng").exists()
            & Attr("status").eq("pending")
        ),
    }

    while True:
        result = table.scan(**kwargs)

        for item in result.get("Items", []):
            if item.get("lat") is None or item.get("lng") is None:
                continue
            yield item

        last_key = result.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key


def write_collection(record_type, collection):
    body = json.dumps(
        {"type": "FeatureCollection", "features": collection},
        separators=(",", ":"),
    ).encode("utf-8")

    s3.put_object(
        Bucket=MAP_BUCKET,
        Key=f"pins/{record_type}.geojson",
        Body=body,
        ContentType="application/geo+json",
        # CloudFront holds these for 60s (see map_delivery.tf). Matching the
        # object's own header keeps a direct-to-origin fetch consistent with
        # what the CDN serves.
        CacheControl="public, max-age=60",
        ServerSideEncryption="AES256",
    )
