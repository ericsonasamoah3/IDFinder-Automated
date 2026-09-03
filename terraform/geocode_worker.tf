# ---------------------------------------------------------------------------
# idfinder_geocode_worker -- resolves a typed address, off the request path
#
# Packaged with source_dir rather than source_file: this is the one Lambda in
# the repo with two source files (handler.py plus the swappable geocoder.py).
# Everything else here stays a single file with no dependencies.
# ---------------------------------------------------------------------------

data "archive_file" "geocode_worker_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambdas/geocode_worker"
  output_path = "${path.module}/build/idfinder_geocode_worker.zip"

  # __pycache__ from a local run would otherwise land in the zip and churn
  # the source hash on every apply.
  excludes = ["__pycache__"]
}

resource "aws_iam_role" "geocode_worker_lambda" {
  name               = "${var.project_name}-geocode-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "geocode_worker_basic" {
  role       = aws_iam_role.geocode_worker_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "geocode_worker_permissions" {
  name = "${var.project_name}-geocode-worker-permissions"
  role = aws_iam_role.geocode_worker_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        # UpdateItem only: the worker attaches coordinates to a record that
        # already exists. It has no business creating or reading records.
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.records.arn
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem"]
        Resource = aws_dynamodb_table.geocache.arn
      },
      {
        Effect = "Allow"
        # The standalone GeoPlaces API has no per-resource ARN to scope to --
        # there is no place-index resource to name, which is precisely why it
        # was chosen over the older provisioned index.
        Action   = ["geo-places:Geocode"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        # Required by the event source mapping, which polls on the function's
        # behalf rather than the function calling SQS itself.
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.geocode_jobs.arn
      },
    ]
  })
}

resource "aws_lambda_function" "geocode_worker" {
  function_name    = "${var.project_name}-geocode-worker"
  role             = aws_iam_role.geocode_worker_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.13"
  timeout          = 30 # queue visibility_timeout_seconds is 6x this
  filename         = data.archive_file.geocode_worker_zip.output_path
  source_code_hash = data.archive_file.geocode_worker_zip.output_base64sha256

  environment {
    variables = {
      TABLE_NAME             = aws_dynamodb_table.records.name
      GEOCACHE_NAME          = aws_dynamodb_table.geocache.name
      GEOCODE_BIAS_COUNTRIES = var.geocode_bias_countries
    }
  }
}

resource "aws_cloudwatch_log_group" "geocode_worker" {
  name              = "/aws/lambda/${aws_lambda_function.geocode_worker.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_event_source_mapping" "geocode_worker" {
  event_source_arn = aws_sqs_queue.geocode_jobs.arn
  function_name    = aws_lambda_function.geocode_worker.arn
  batch_size       = 10

  # Without this, one bad job forces redelivery of the whole batch --
  # re-geocoding addresses that already succeeded, on a metered API.
  function_response_types = ["ReportBatchItemFailures"]
}
