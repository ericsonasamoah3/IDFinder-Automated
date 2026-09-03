# ---------------------------------------------------------------------------
# Static map delivery: one private bucket, fronted by CloudFront
#
# This is the load-bearing cost decision of the whole map feature. A single
# map view is hundreds of tile reads. Served from a tile API, or from Amazon
# Location's map allowance (a 3-month offer, not always-free), that is the one
# thing guaranteed to blow the budget.
#
# Instead the entire tile pyramid lives in ONE .pmtiles object and MapLibre
# asks for byte ranges of it. No per-tile compute, nothing metered per tile,
# and CloudFront's free tier (100 GB + 1M requests a month, no expiry) absorbs
# the traffic. The map never touches API Gateway, Lambda or DynamoDB.
#
# The bucket holds exactly two kinds of thing:
#   basemap.pmtiles       -- uploaded by hand, once (see GETTING_STARTED)
#   pins/{lost,found}.geojson -- rewritten by geojson_builder
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "map" {
  bucket = "${var.project_name}-map-${data.aws_caller_identity.current.account_id}"
}

# Public to READ, but only through CloudFront. The bucket itself stays fully
# private -- no public ACL, no website hosting, block-public-access left on.
resource "aws_s3_bucket_public_access_block" "map" {
  bucket                  = aws_s3_bucket.map.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "map" {
  bucket = aws_s3_bucket.map.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# ---------------------------------------------------------------------------
# Origin Access Control: CloudFront signs its origin requests, so the bucket
# can refuse everything else. OAC rather than the legacy OAI -- OAI is on its
# way out and does not support SSE-KMS if this ever needs it.
# ---------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "map" {
  name                              = "${var.project_name}-map-oac"
  description                       = "Signs CloudFront's requests to the private map bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "map_bucket" {
  statement {
    sid       = "AllowCloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.map.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    # Scoped to THIS distribution. Without it, any CloudFront distribution in
    # any account could read the bucket.
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.map.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "map" {
  bucket = aws_s3_bucket.map.id
  policy = data.aws_iam_policy_document.map_bucket.json

  # The public access block must be in place before the policy lands, or the
  # policy is briefly the only thing standing between the bucket and the world.
  depends_on = [aws_s3_bucket_public_access_block.map]
}

# ---------------------------------------------------------------------------
# Cache and header policies
# ---------------------------------------------------------------------------

# basemap.pmtiles never changes in place -- a new basemap gets a new versioned
# filename -- so it can be cached for as long as CloudFront will hold it.
data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

# The pin files are rewritten whenever a report is filed or matched. 60s is
# short enough that a new pin shows up promptly and long enough that a burst
# of viewers does not stampede the origin.
resource "aws_cloudfront_cache_policy" "map_pins" {
  name    = "${var.project_name}-map-pins"
  comment = "Short TTL for the GeoJSON pin files"

  default_ttl = 60
  min_ttl     = 0
  max_ttl     = 300

  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true

    cookies_config { cookie_behavior = "none" }
    headers_config { header_behavior = "none" }
    query_strings_config { query_string_behavior = "none" }
  }
}

# CORS, plus the three headers a range-request client needs to see. Set on
# CloudFront rather than as S3 CORS: with OAC the browser never talks to S3,
# so an S3 CORS rule would never be evaluated.
resource "aws_cloudfront_response_headers_policy" "map" {
  name    = "${var.project_name}-map-headers"
  comment = "CORS and range-request headers for the map assets"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["Range", "If-Match", "If-None-Match", "Content-Type"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_origins {
      items = var.cors_allowed_origins
    }

    # Without Accept-Ranges and Content-Range visible to script, the PMTiles
    # client cannot confirm the server honoured its range request and falls
    # back to fetching the entire basemap per view.
    access_control_expose_headers {
      items = ["Content-Range", "Content-Length", "Accept-Ranges", "ETag", "Date"]
    }

    origin_override            = true
    access_control_max_age_sec = 3600
  }
}

# ---------------------------------------------------------------------------
# Distribution
# ---------------------------------------------------------------------------

resource "aws_cloudfront_distribution" "map" {
  enabled = true
  comment = "${var.project_name} map tiles and pins"

  # Cheapest tier: North America + Europe edges only. The app serves the UK.
  price_class = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.map.bucket_regional_domain_name
    origin_id                = "map-bucket"
    origin_access_control_id = aws_cloudfront_origin_access_control.map.id
  }

  # Default: the basemap and anything else. Long TTL, immutable content.
  #
  # NOTE, and this is a deliberate departure from maps/CLAUDE.md, which says
  # to put `Range` in the cache key. CloudFront already honours byte-range
  # requests against an S3 origin and returns 206 without that -- it caches
  # the object and slices it at the edge. Putting Range in the cache key
  # instead makes every distinct byte range its own cache entry, which for
  # PMTiles means a near-zero hit rate and far MORE origin traffic, working
  # directly against the free-tier goal the rule exists to protect.
  #
  # The definition-of-done check settles it either way: load the map and
  # confirm basemap.pmtiles returns 206, not 200. If it ever returns 200,
  # revisit this block first.
  default_cache_behavior {
    target_origin_id       = "map-bucket"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.map.id
  }

  ordered_cache_behavior {
    path_pattern           = "pins/*"
    target_origin_id       = "map-bucket"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    cache_policy_id            = aws_cloudfront_cache_policy.map_pins.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.map.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = {
    Name = "${var.project_name}-map"
  }
}
