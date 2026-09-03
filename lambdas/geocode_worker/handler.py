"""SQS consumer that turns a typed address into coordinates.

Why this exists at all, rather than geocoding inline in idfinder_backend.py:
POST /IDfinder is the request path. A geocode is a call to a third party that
can be slow, rate-limited, or down, and the report form should not wait on it.
The same reasoning already moved image archiving onto SQS (see
idfinder_save.py); this is that decision applied to the map layer.

So the record is written immediately, without coordinates, and a job lands
here. When it resolves, the record is updated in place -- which raises a
DynamoDB Streams event, which wakes geojson_builder, which rebuilds the pin
files. The pin simply appears on the map a moment later.

Only typed addresses reach this queue. Device GPS and a dragged pin already
carry coordinates, so idfinder_backend.py stores those directly and never
enqueues anything. The more people tap "use my location", the less of the
metered allowance gets spent.

Caching, and why misses are cached too:
  hit  -> resolved=true,  30-day TTL
  miss -> resolved=false, 7-day TTL

Without the miss half, one address the provider cannot resolve, resubmitted
in a loop, is a free way to drain a metered allowance. The miss TTL is
shorter than the hit TTL because a miss can become a hit later (better
address data upstream, a fixed typo) while a hit rarely stops being true.

Environment variables required:
  TABLE_NAME    - DynamoDB table holding the records
  GEOCACHE_NAME - DynamoDB table used as the address cache
"""

import json
import os
import re
import time
import unicodedata
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

from geocoder import geocode

TABLE_NAME = os.environ["TABLE_NAME"]
GEOCACHE_NAME = os.environ["GEOCACHE_NAME"]

HIT_TTL_SECONDS = 30 * 24 * 60 * 60
MISS_TTL_SECONDS = 7 * 24 * 60 * 60

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
geocache = dynamodb.Table(GEOCACHE_NAME)


def normalise(address):
    """Fold an address to a stable cache key.

    Must be deterministic or the cache never hits and every submission is a
    fresh metered call. "14 Foo St." / "14  foo st" / "14 FOO ST" all have to
    collapse to the same key.
    """
    s = unicodedata.normalize("NFKD", address).casefold()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def lambda_handler(event, context):
    failures = []

    for record in event.get("Records", []):
        message_id = record.get("messageId")
        try:
            process(json.loads(record["body"]))
        except Exception as e:  # noqa: BLE001 - one bad job must not fail the batch
            print(f"Geocode job {message_id} failed: {e}")
            failures.append({"itemIdentifier": message_id})

    # Names only the messages that actually failed. Without this the whole
    # batch is redelivered, re-running jobs that already succeeded.
    return {"batchItemFailures": failures}


def process(job):
    record_id = job.get("record_id")
    address = (job.get("address") or "").strip()

    if not record_id or not address:
        # Nothing actionable. Returning cleanly retires the message rather
        # than retrying a job that can never succeed.
        print(f"Skipping malformed geocode job: {job!r}")
        return

    key = normalise(address)
    if not key:
        print(f"Address normalised to nothing, skipping: {address!r}")
        return

    coords = lookup(key, address)
    if coords is None:
        # Unresolvable is a normal outcome. The record stays exactly as it
        # is -- saved, listed, matchable, just not pinned on the map.
        print(f"No coordinates for {address!r}; record {record_id} stays unpinned")
        return

    lat, lng = coords
    write_coordinates(record_id, lat, lng)


def lookup(key, address):
    """Cache-first resolve. Returns (lat, lng) or None."""
    cached = get_cached(key)

    if cached is not None:
        if cached.get("resolved"):
            return (float(cached["lat"]), float(cached["lng"]))
        # A cached miss. Do NOT call the provider again -- that is the whole
        # point of caching misses.
        return None

    coords = geocode(address)
    put_cached(key, coords)
    return coords


def get_cached(key):
    try:
        result = geocache.get_item(Key={"normalised_address": key})
    except ClientError as e:
        # A cache read failure must not sink the job. Fall through to the
        # provider; the worst case is one extra metered call.
        print(f"Geocache read failed for {key!r}: {e}")
        return None

    return result.get("Item")


def put_cached(key, coords):
    now = int(time.time())
    resolved = coords is not None

    item = {
        "normalised_address": key,
        "resolved": resolved,
        "provider": "amazon-location-geoplaces",
        "cached_at": now,
        "expires_at": now + (HIT_TTL_SECONDS if resolved else MISS_TTL_SECONDS),
    }

    if resolved:
        lat, lng = coords
        # str() first: Decimal(float) carries the float's binary rounding
        # error into the item and DynamoDB rejects the resulting precision.
        item["lat"] = Decimal(str(lat))
        item["lng"] = Decimal(str(lng))

    try:
        geocache.put_item(Item=item)
    except ClientError as e:
        # Same reasoning as the read: losing a cache write costs one call
        # next time, which is not worth failing a job over.
        print(f"Geocache write failed for {key!r}: {e}")


def write_coordinates(record_id, lat, lng):
    """Attach coordinates to an existing record.

    Conditional on the record existing so a job for a deleted record retires
    quietly instead of resurrecting it as a partial item.
    """
    try:
        table.update_item(
            Key={"record_id": record_id},
            UpdateExpression=(
                "SET lat = :lat, lng = :lng, geo_source = :src"
            ),
            ExpressionAttributeValues={
                ":lat": Decimal(str(lat)),
                ":lng": Decimal(str(lng)),
                ":src": "geocoded",
            },
            ConditionExpression="attribute_exists(record_id)",
        )
        print(f"Pinned record {record_id}")
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            print(f"Record {record_id} no longer exists; dropping geocode job")
            return
        raise
