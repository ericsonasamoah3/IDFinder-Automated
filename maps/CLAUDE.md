# IDFinder1 — Map Layer

Adds a public map to IDFinder1: **red pins for lost IDs, green pins for found IDs**.

This file covers the map feature specifically. Everything outside it (matching, OCR,
SMS, Cognito) already exists and works — do not refactor it while building this.

---

## Non-negotiable constraints

**Free tier is a hard requirement, not a preference.** This account previously got
locked when a free trial ran out. Verified status as of the last check:

| Service | Status |
|---|---|
| Lambda | Always free — 1M req + 400k GB-s/month |
| DynamoDB | Always free — 25 GB, 25 RCU/WCU |
| DynamoDB Streams | Always free — 2.5M read requests/month |
| SQS | Always free — 1M requests/month |
| CloudFront | Always free — **100 GB + 1M requests/month** (Free plan, no per-request overage; next tier is $15/mo flat) |
| S3 | **12 months only** — 5 GB, 20k GET, 2k PUT |
| API Gateway | **12 months only** — 1M calls/month |
| Amazon Location | **3 months only** — then metered |

Rules that follow from this:

- The **high-volume path must never be a metered API.** Map tiles are hundreds of
  requests per map view; they go to CloudFront as byte-range reads of one static file.
- The **low-volume path** (geocoding, once per report) is the only place a metered
  API is acceptable — and it must be cached, **including its failures**.
- The map must never call API Gateway, Lambda, or DynamoDB. It reads static files only.
- Do not add: OpenSearch, Aurora, NAT Gateway, ElastiCache, Kinesis, AppSync,
  a second ALB, or any always-on compute. If a design seems to need one, stop and ask.

**Pre-existing cost leak, out of scope but do not make worse:** the OCR path runs
ALB + ECS Fargate, neither of which has a free tier (~£15–20/month for the ALB alone).
Don't attach anything new to it.

**Re-verify the free-tier table before the first `apply`.** AWS changed the CloudFront
free tier once already and this account has been suspended once. The whole design leans
on the CloudFront row being correct; confirm it rather than trusting this file.

---

## Architecture — settled, do not redesign

```
[ Use my location ]  ──lat/lng──┐
[ Drag a pin      ]  ──lat/lng──┤
[ Type an address ]  ──text─────┴──▶ API Gateway ──▶ Lambda backend (POST /IDfinder)
                                                          │  coords stored inline; NO geocode here
                                                          ▼
                                                   idfinder-records
                                                          │
                            a typed address also enqueues │
                                                          ▼
                                                  SQS geocode-jobs
                                                          │
                                                          ▼
                                              Lambda geocode-worker ─────┐
                                                          │              │ look up, then write back
                                                          │              ▼
                                                          │     idfinder-geocache
                                                          │              │ on a miss only
                                                          │              ▼
                                                          │     Amazon Location GeoPlaces
                                                          │              │ cache the result, hit or miss
                                                          │◀─────────────┘
                                                          │  UpdateItem: lat, lng, geo_source
                                                          ▼
                                                   idfinder-records
                                                          │
                                                   DynamoDB Streams
                                                          ▼
                                                   geojson-builder
                                                          │  skip matched, fuzz to 250m grid
                                                          ▼
                                    S3 idfinder-map ──▶ CloudFront ──▶ Map view (MapLibre)
```

**Corrected during implementation.** Earlier drafts of this file put the
geocode step in `save-worker`, on the assumption that it wrote the record. It
does not: `save-worker` only archives the ID photo to S3. The record is written
by `idfinder_backend.py` from `POST /IDfinder`, on a completely separate path
from the image upload.

The principle survives the correction intact -- no metered call on the request
path -- but it needed its own queue and consumer to hold, because the Lambda
that owns the record is the request-path one. Hence `geocode-jobs` and
`idfinder_geocode_worker`, both new.

Decisions already made and their reasons — **do not relitigate without asking**:

- **PMTiles, not a tile server.** The whole tile pyramid lives in one `.pmtiles`
  object; MapLibre requests byte ranges of it. No per-tile compute, nothing metered
  per tile. This is the single most important cost decision in the feature.
- **Static GeoJSON pins, not a query API.** `geojson-builder` rewrites the pin files
  on every record change. A viewport-query API (geohash GSI, OpenSearch) was
  considered and rejected — it costs money and this dataset is small.
- **Geocoding runs in `save-worker`, never in `save`.** See below; this one is
  load-bearing and was changed deliberately.
- **Geocoding is cached forever-ish** (30-day TTL), **misses included** (7-day TTL),
  and kept behind a small interface so the provider can be swapped when the Amazon
  Location allowance lapses.
- **GPS and pin-drop skip geocoding entirely.** They already produce coordinates.
  The more users tap "use my location", the less allowance is consumed.

### Why geocoding is on a queue and not in the request path

`idfinder_save.py`'s module docstring is explicit that it does "the fast, request-path
work only", and the SQS split exists so that "a slow or failing S3 write no longer holds
the browser request open". A geocode is a third-party call that can be slow,
rate-limited, or down. Putting one inside a request handler gives back exactly the
property that split was introduced to buy.

So the split runs by location source, not by handler:

- **device / manual** already carry coordinates. `POST /IDfinder` validates them and
  writes them straight onto the record. Zero external calls, zero added latency. The pin
  is live the moment the report is filed.
- **geocoded** stores `address_raw`, no coordinates, and enqueues to `geocode-jobs`.
  `idfinder_geocode_worker` resolves it and issues an `UpdateItem`.

**A consequence to accept:** a typed-address report exists without coordinates between
the 201 and the worker finishing, so its pin appears a moment later. The response carries
`pin_pending: true` so the form can say so. Device and dragged-pin reports have no such
gap.

**And a consequence to lean on:** because the pin files are rebuilt from a Streams event
rather than by whoever wrote the record, neither path has to know the map exists.

---

## Repo layout

```
frontend/src/
  pages/MapPage.tsx            # NEW — the map view
  components/LocationPicker.tsx # NEW — the 3-way input used by both report forms
  lib/mapStyle.ts              # NEW — MapLibre style + pmtiles protocol registration
  pages/ReportLost.tsx         # EDIT — mount LocationPicker
  pages/ReportFound.tsx        # EDIT — mount LocationPicker

lambdas/
  backend/idfinder_backend.py  # EDIT — accept location_input, store coords inline,
                               #        enqueue typed addresses, reject precise
                               #        free-text locations (privacy rule 5)
  geocode_worker/
    handler.py                 # NEW — SQS consumer, cache-first resolve
    geocoder.py                # NEW — the swappable provider call
  geojson_builder/
    handler.py                 # NEW — single file, no dependencies (see below)
  save/, save_worker/          # UNCHANGED — the image path never touched location

terraform/
  geocache.tf                  # NEW — idfinder-geocache table + geocode-jobs queue/DLQ
  geocode_worker.tf            # NEW — Lambda + SQS event source mapping
  geojson_builder.tf           # NEW — Lambda + Streams event source mapping
  map_delivery.tf              # NEW — idfinder-map bucket + CloudFront + OAC
  billing_alarm.tf             # NEW — the CloudWatch billing alarm from the DoD
  dynamodb.tf                  # EDIT — enable streams on idfinder-records
  lambda.tf                    # EDIT — backend gains sqs:SendMessage + queue URL
  amplify.tf                   # EDIT — inject VITE_MAP_CDN
```

**Packaging: single `.py` files, no `requirements.txt`.** Every Lambda in this repo is
zipped with `archive_file` over one `source_file` (see `terraform/lambda.tf`). Nothing
here needs a dependency beyond `boto3`, which the runtime already provides. Do not
introduce a build step for one Lambda — if something genuinely needs a third-party
package, stop and ask, because it changes how the whole repo packages.

`geocode_worker/` has two files (handler plus the swappable geocoder), so its
`archive_file` uses `source_dir` with `excludes = ["__pycache__"]`. That is the only
packaging change; every other Lambda stays on `source_file`.

---

## Data model

### `idfinder-records` — new attributes (all optional, older records lack them)

| Attribute | Type | Notes |
|---|---|---|
| `lat` | N | WGS84, full precision. **Never served to the public map.** |
| `lng` | N | as above |
| `geo_source` | S | `device` \| `geocoded` \| `manual` |
| `geo_accuracy_m` | N | from `coords.accuracy` when `geo_source = device` |
| `address_raw` | S | what the user typed, when they typed one |

**The attribute is `geo_source`. There is no `geo_precision`.** An earlier draft of the
board used that name; it is wrong and has been removed. If you find it anywhere, it is
stale.

No new GSI. The map reads a static file, not the table.

**Enable DynamoDB Streams** with `stream_view_type = "NEW_AND_OLD_IMAGES"`.

### `idfinder-geocache` — new table

- PK: `normalised_address` (S)
- Attributes: `lat` (N), `lng` (N), `provider` (S), `cached_at` (N), `resolved` (BOOL)
- TTL attribute: `expires_at`
- Billing: `PAY_PER_REQUEST`
- No GSI, no PITR (it's a cache — it can be rebuilt)

**Negative results must be cached too.** A hit sets `resolved = true` and
`expires_at = now + 30 days`. A lookup the provider could not resolve sets
`resolved = false`, no `lat`/`lng`, and `expires_at = now + 7 days`. Without this, one
unresolvable address resubmitted in a loop is a free way to drain a metered allowance —
the cache only protects you if it remembers the failures as well as the successes.

The shorter negative TTL exists because a miss can become a hit later (new address data,
a fixed typo upstream), while a hit rarely stops being true.

Normalisation must be deterministic or the cache never hits:

```python
def normalise(address: str) -> str:
    s = unicodedata.normalize("NFKD", address).casefold()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()
```

---

## The three location inputs

`LocationPicker.tsx` renders all three and emits one shape:

```ts
type LocationInput =
  | { source: 'device';   lat: number; lng: number; accuracy_m: number }
  | { source: 'manual';   lat: number; lng: number }
  | { source: 'geocoded'; address: string }
```

Rules:

- Geolocation needs **HTTPS** — fine on Amplify, breaks on `http://localhost` in some
  browsers. Test with `vite --https` or accept the fallback path locally.
- Permission is denied often. **Never block submit on it.** The address field stays
  usable at all times, and a denial is not an error state.
- Last interaction wins. If the user taps "use my location" then drags the pin,
  `source` becomes `manual`.
- Do **not** reverse-geocode just to display a pretty address. It's a metered call
  for cosmetics. Show the pin.

---

## Lambda contracts

### `idfinder_backend` — `POST /IDfinder` (edit)

Accepts the `LocationInput` above in the request body. **It does not geocode.**

```
device / manual -> validate lat/lng in range, reject NaN and 0,0,
                   store lat, lng, geo_source (+ geo_accuracy_m for device)
geocoded        -> store address_raw only, then enqueue {record_id, address}
                   onto geocode-jobs
```

A malformed `location_input` is dropped rather than raising: a location is a
nice-to-have, and refusing to file a lost-ID report because a browser sent an odd
accuracy value would be the wrong trade. The enqueue is best-effort for the same
reason — it happens after the write, so a queue outage costs a pin, not a report.

The free-text `location` field is validated here too. See privacy rule 5.

### `idfinder_geocode_worker` (new)

Resolves coordinates, then updates the record.

Only typed addresses reach this queue — device and manual never do, so there is no
"is this already resolved" branch to get wrong.

```
key = normalise(address)
hit = geocache.get(key)
if hit and hit.resolved:       use hit lat/lng
elif hit and not hit.resolved: unresolvable, do NOT call the provider
else:
    result = geocode(address)          # one provider call
    write to the cache, resolved true or false, TTL per the table above
    use it if it resolved
```

Keep the provider call behind one function so it can be swapped:

```python
# lambdas/geocode_worker/geocoder.py
def geocode(address: str) -> tuple[float, float] | None: ...
```

Then `UpdateItem` the record with `lat`, `lng` and `geo_source = "geocoded"`, conditional
on the record still existing so a job for a deleted record retires quietly instead of
resurrecting it as a partial item.

If geocoding fails or returns nothing, **leave the record exactly as it is** — saved,
listed, matchable, just unpinned. A report without a pin is far better than a lost
report. Do not fail the message and do not send it to the DLQ for this: an unresolvable
address is a normal outcome, not an error. `geocoder.py` swallows provider errors and
returns `None` for the same reason.

Idempotency holds: re-running a message re-reads the cache and writes the same values.

### `geojson-builder` (new)

- Trigger: DynamoDB Streams on `idfinder-records`, `batch_size = 25`,
  `maximum_batching_window_in_seconds = 30` (batch up bursts — this rewrites whole files)
- Runtime `python3.13`, timeout 60s, memory 512 MB
- Reads all records with coordinates, splits by `record_type`, writes two files:
  - `s3://idfinder-map/pins/lost.geojson`
  - `s3://idfinder-map/pins/found.geojson`

**Matched records leave the map.** Only records whose `status` is still pending get a
feature. A returned ID is not a lost ID, and without this rule the map accumulates
resolved reports forever until it is unreadable and every rebuild gets slower. The record
itself is untouched; it just stops being a pin.

**Fuzzing is mandatory** (see Privacy below):

```python
import math

GRID_M = 250.0

def fuzz(lat: float, lng: float) -> tuple[float, float]:
    lat_step = GRID_M / 111_320.0
    lng_step = GRID_M / (111_320.0 * max(math.cos(math.radians(lat)), 0.01))
    return (round(lat / lat_step) * lat_step,
            round(lng / lng_step) * lng_step)
```

Each feature carries **only** `record_id` and `record_type`. No names, no ID numbers,
no contact details, no exact coordinates. The pin file is public.

**A note on the rebuild:** this handler scans the whole table on every batch. That is
fine at this dataset's size and is bounded to roughly two scans a minute by the 30s
batching window. It stops being fine somewhere in the low tens of thousands of records —
at which point the answer is an incremental rebuild, not a bigger scan. Ordering is
handled by Streams: one shard is processed serially, so two rebuilds cannot interleave
and write a stale file. If the table ever grows enough to split shards, revisit this.

---

## Frontend

Stack is already React + TypeScript + Vite + Tailwind on Amplify. Keep the existing
claim-ticket visual system; the map is a page inside it, not a new design language.

```
npm i maplibre-gl pmtiles protomaps-themes-base
```

```ts
import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'

const protocol = new Protocol()
maplibregl.addProtocol('pmtiles', protocol.tile)
// source url: `pmtiles://${import.meta.env.VITE_MAP_CDN}/basemap.pmtiles`
```

Pins as two clustered GeoJSON sources:

```ts
map.addSource('lost',  { type: 'geojson', data: `${CDN}/pins/lost.geojson`,
                         cluster: true, clusterRadius: 50 })
// circle-color: red  #bd0909 for lost, green #087429 for found
```

**Turn clustering on from day one.** A few hundred pins in one city are unreadable
without it, and retrofitting it means reworking the click handlers.

Click a pin → read `record_id` off the feature → open the existing record view.

New env var: `VITE_MAP_CDN` (the CloudFront domain). Follow the existing
`cognitoConfig.ts` pattern — **warn and degrade, never throw at module import.**
A missing env var must not blank the whole app (this exact bug cost a debugging
session once already).

---

## Terraform conventions

Match what's already in the repo:

- AWS provider `~> 6.0`, Terraform CLI `>= 1.10.0`
- Region `eu-north-1`; state bucket `local-shop-design-app-tfstate-258506450105` (us-east-1)
- Lambda runtime `python3.13`
- Keep DynamoDB's deprecated `hash_key` / `range_key` syntax. **Do not migrate to
  `key_schema`** — v6's new syntax has open upstream bugs causing destructive GSI
  recreation and perpetual drift. This is deliberate.

New IAM, and where it goes:

- `save` gains **nothing**. It does not touch the geocache or Amazon Location.
- `save_worker` gains `dynamodb:GetItem`/`PutItem` on `idfinder-geocache`, and the
  narrowest GeoPlaces action that works on the place index.
- `geojson_builder` gains `dynamodb:Scan` plus `DescribeStream`/`GetRecords`/
  `GetShardIterator`/`ListStreams` on `idfinder-records`, and `s3:PutObject` on
  `idfinder-map`.

CloudFront specifics that are easy to get wrong:

- The origin must be **S3 with OAC** (Origin Access Control), bucket stays private.
- **Range requests must work** — use a cache policy that includes the `Range` header
  in the cache key, or PMTiles silently fetches the whole file and blows the budget.
- CORS on the bucket must allow `GET`/`HEAD`, allow the `Range` request header, and
  expose `Content-Range`, `Content-Length`, `Accept-Ranges`.
- Two cache behaviours: `basemap.pmtiles` long TTL (immutable, versioned filename),
  `pins/*` short TTL (60s).

Bucket `idfinder-map` is **public-read via CloudFront only** — no public bucket ACL,
no website hosting, block public access stays on.

`billing_alarm.tf` holds an `aws_cloudwatch_metric_alarm` on the `EstimatedCharges`
metric with an SNS action to your own address. It must exist and be applied **before**
any of the rest of this goes live, not after. It has its own file so it cannot be lost in
a partial apply of the map resources.

---

## Deploy

Primary flow is local, matching current practice:

```
terraform init
terraform apply
```

GitHub Actions is secondary. Deploys happen from **Windows PowerShell**:

- No bash heredocs in `local-exec`. Use `local_file` + single-line commands.
  This already broke once.
- Always run `terraform validate` before `apply` — it has caught real bugs here
  (self-referencing `logout_urls`, undeclared IAM roles).

The basemap file is uploaded **once, by hand, outside Terraform**:

```
# take a city/county extract, NOT all of Great Britain — S3 free tier is 5 GB
aws s3 cp basemap.pmtiles s3://idfinder-map/basemap.pmtiles
```

Get extracts from https://maps.protomaps.com or build with `pmtiles extract`.

---

## Privacy rules

These are requirements, not suggestions.

1. **Public coordinates are always fuzzed to the 250m grid.** An exact map of where
   found IDs are sitting is a target list for a fraudulent claimant; exact lost
   locations leak the reporter's movements.
2. Precise `lat`/`lng` are revealed **only** to a matched, verified pair — through
   the existing notification path, never through a public file.
3. The GeoJSON files contain `record_id` and `record_type` only.
4. The existing rule stands: `GET /IDfinder` never returns `reporter_email` or
   `reporter_phone` to any caller, matched or not.
5. **The free-text `location` field must be coarsened, or rule 1 is theatre.**
   `location` is in `PUBLIC_FIELDS` in `lambdas/backend/idfinder_backend.py`, it is
   required at submit, and it goes to any unauthenticated caller. Today a user can type
   "outside 14 Foo Street" into it. Fuzzing the coordinate to 250m while publishing that
   string next to the same `record_id` protects nothing — the precise location is still
   public, just in a different field.

   This must be fixed in the same change as the map, not after it. The map is what makes
   the leak easy to exploit at scale: before the map you had to read records one at a
   time; after it you have a browsable index.

   **Recommended fix, unless you say otherwise:** keep `location` as a free-text *area*
   field, relabel it in both report forms ("Area or neighbourhood — not a street
   address"), and stop treating it as the precise location now that a real coordinate
   exists. Validate on submit and reject anything matching a street-number pattern.

   **The open decision is yours:** whether existing records — written under the old
   labelling, and possibly already holding street addresses — get backfilled, truncated,
   or left alone. Ask before touching stored data.

---

## Definition of done

- [ ] All three inputs produce a correct record; denying location permission still submits
- [ ] `POST /IDfinder` makes no geocode call and no geocache call — verify in the
      backend Lambda's CloudWatch logs
- [ ] A device or dragged-pin report is pinned immediately, with no queue round trip
- [ ] Typing the same address twice makes exactly **one** Amazon Location call
- [ ] An address the provider cannot resolve is cached as a miss, and resubmitting it
      makes **zero** further Amazon Location calls until the 7-day TTL lapses
- [ ] A geocode failure still saves the report, just without a pin, and does not DLQ
- [ ] `geojson-builder` fires on write and pins appear within ~60s
- [ ] A record whose status becomes `matched` disappears from the pin files on the next rebuild
- [ ] Public GeoJSON contains no coordinate finer than the 250m grid, and no PII
- [ ] The public `location` string cannot be more precise than the fuzzed pin (rule 5)
- [ ] Map loads with the network tab showing **206 Partial Content** responses for
      `basemap.pmtiles` — a `200` means range requests are misconfigured and you are
      shipping the whole file per view
- [ ] Clustering works at low zoom; clicking a pin opens the right record
- [ ] `terraform validate` clean, `terraform plan` shows no drift on a second run
- [ ] A CloudWatch billing alarm exists **and has been applied** before any of this goes live
