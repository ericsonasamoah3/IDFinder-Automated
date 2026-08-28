resource "aws_s3_bucket" "uploads" {
  bucket = "${var.project_name}-uploads-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-old-uploads"
    status = "Enabled"

    # An explicit empty filter is required once the config has more than one
    # rule; without it the provider rejects the unfiltered rule.
    filter {}

    # ID photos aren't needed indefinitely once a record is stale. Adjust
    # if you want to keep them longer.
    expiration {
      days = 180
    }
  }

  rule {
    id     = "expire-staged-uploads"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    # Staging objects are deleted by the worker as soon as a job completes.
    # Anything still here after a day belongs to a job that died before
    # finishing -- most likely one now sitting in the dead-letter queue. Keep
    # it a day so a DLQ redrive can still find its bytes, then reclaim it.
    expiration {
      days = 1
    }
  }
}

data "aws_caller_identity" "current" {}
