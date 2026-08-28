# ---------------------------------------------------------------------------
# Image-save job queue
#
# POST /save enqueues here instead of writing the archive inline, so a slow
# or failing S3 write no longer holds the browser request open, and a job
# that fails is retried rather than disappearing into a 500 the user never
# sees again.
#
# The image itself does NOT travel in the message -- SQS caps a message at
# 256KB and uploads here reach 8MB. The producer stages the bytes at
# incoming/<uuid>.jpg and the message carries a pointer ("claim check").
# ---------------------------------------------------------------------------

# Jobs that fail MAX_RECEIVES times land here instead of being retried
# forever or dropped. Nothing consumes this -- it is a holding pen to be
# inspected, fixed, and redriven (SQS console -> Start DLQ redrive).
resource "aws_sqs_queue" "save_dlq" {
  name = "${var.project_name}-save-dlq"

  # Longer than the main queue: a job only arrives here after it has already
  # failed repeatedly, and it needs to survive long enough to be noticed.
  message_retention_seconds = 1209600 # 14 days, the SQS maximum

  sqs_managed_sse_enabled = true
}

resource "aws_sqs_queue" "save_jobs" {
  name = "${var.project_name}-save-jobs"

  # Must exceed the worker's timeout, or SQS redelivers a message that is
  # still being processed and the job runs twice. 6x the function timeout is
  # the figure AWS recommends.
  visibility_timeout_seconds = 180

  message_retention_seconds = 345600 # 4 days

  sqs_managed_sse_enabled = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.save_dlq.arn
    maxReceiveCount     = var.save_job_max_receives
  })
}

# Lets the DLQ's messages be redriven back to the source queue from the
# console once whatever broke has been fixed.
resource "aws_sqs_queue_redrive_allow_policy" "save_dlq" {
  queue_url = aws_sqs_queue.save_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.save_jobs.arn]
  })
}
