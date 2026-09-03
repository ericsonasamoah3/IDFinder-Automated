# ---------------------------------------------------------------------------
# Address -> coordinate cache, and the queue that feeds it
#
# Amazon Location's geocode allowance is a 3-month new-account offer, not
# always-free. Every call avoided here is one that still costs nothing after
# the offer lapses, so the cache is not an optimisation -- it is the thing
# that keeps this affordable.
# ---------------------------------------------------------------------------

resource "aws_dynamodb_table" "geocache" {
  name         = "${var.project_name}-geocache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "normalised_address"

  attribute {
    name = "normalised_address"
    type = "S"
  }

  # Entries expire on their own: hits after 30 days, misses after 7 (the
  # worker sets expires_at per entry -- see lambdas/geocode_worker/handler.py).
  # Without TTL this table only ever grows, and a stale coordinate for a
  # re-numbered street would stay wrong forever.
  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  # No PITR, deliberately: this is a cache. Losing it costs a few re-geocodes,
  # not data. Paying to back it up would be paying to protect something whose
  # whole purpose is to be cheaply rebuildable.

  tags = {
    Name = "${var.project_name}-geocache"
  }
}

# ---------------------------------------------------------------------------
# Geocode job queue
#
# POST /IDfinder enqueues here instead of geocoding inline. A geocode is a
# third-party call on the request path otherwise, and the report form should
# never wait on one -- the same reasoning that put image archiving on SQS.
# ---------------------------------------------------------------------------

resource "aws_sqs_queue" "geocode_dlq" {
  name = "${var.project_name}-geocode-dlq"

  # As with the save DLQ: a job only lands here after repeated failures, so
  # it needs to survive long enough for someone to notice it.
  message_retention_seconds = 1209600 # 14 days, the SQS maximum

  sqs_managed_sse_enabled = true
}

resource "aws_sqs_queue" "geocode_jobs" {
  name = "${var.project_name}-geocode-jobs"

  # Must exceed the worker's timeout or SQS redelivers a message that is
  # still being worked on, and the job geocodes twice -- which on a metered
  # API means paying twice.
  visibility_timeout_seconds = 180

  message_retention_seconds = 345600 # 4 days

  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.geocode_dlq.arn
    maxReceiveCount     = var.geocode_job_max_receives
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "geocode_dlq" {
  queue_url = aws_sqs_queue.geocode_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.geocode_jobs.arn]
  })
}
