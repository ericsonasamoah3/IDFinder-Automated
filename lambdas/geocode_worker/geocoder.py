"""The one place that talks to a geocoding provider.

Everything else in the map layer goes through `geocode()`. That is deliberate:
Amazon Location's allowance is a 3-month new-account offer, not always-free
(see maps/CLAUDE.md), so this will need swapping for another provider before
long. Keeping the provider call behind a single function with a boring
signature means that swap is one file, not a search across the codebase.

To swap providers, reimplement `geocode()` and keep the contract:

    address in  ->  (lat, lng) out, or None if it could not be resolved

`None` is a normal outcome, not an error. A bad address must not raise: the
caller caches the miss and saves the report without a pin.
"""

import os

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# The standalone GeoPlaces API, not the older place-index resource. It needs
# no provisioned index, which is one less always-on thing to pay for.
_client = boto3.client("geo-places", region_name=os.environ.get("AWS_REGION"))

# Biases results toward the area the app actually serves. Without it, "High
# Street" can resolve to any of several hundred countries.
BIAS_COUNTRIES = [
    c.strip().upper()
    for c in os.environ.get("GEOCODE_BIAS_COUNTRIES", "GBR").split(",")
    if c.strip()
]


def geocode(address):
    """Resolve a free-text address to (lat, lng), or None.

    Returns None both when the provider finds nothing and when it errors.
    The distinction does not matter to the caller -- either way there is no
    coordinate to store, and either way retrying immediately would just burn
    another metered call.
    """
    query = (address or "").strip()
    if not query:
        return None

    try:
        result = _client.geocode(
            QueryText=query,
            MaxResults=1,
            Filter={"IncludeCountries": BIAS_COUNTRIES} if BIAS_COUNTRIES else {},
        )
    except (ClientError, BotoCoreError) as e:
        # Logged, not raised. A provider outage should not send reports to
        # the DLQ -- the record is already saved, it just has no pin yet.
        print(f"Geocode provider call failed for {query!r}: {e}")
        return None

    items = result.get("ResultItems") or []
    if not items:
        return None

    # GeoPlaces returns Position as [longitude, latitude] -- GeoJSON order,
    # which is the reverse of how the rest of this codebase says "lat, lng".
    # Getting this backwards puts every pin in the wrong hemisphere.
    position = items[0].get("Position") or []
    if len(position) != 2:
        return None

    lng, lat = float(position[0]), float(position[1])

    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        print(f"Geocode returned an out-of-range position for {query!r}: {position}")
        return None

    return (lat, lng)
