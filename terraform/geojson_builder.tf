# ---------------------------------------------------------------------------
# idfinder_geojson_builder -- rebuilds the public pin files on every change
#
# Triggered by DynamoDB Streams on the records table rather than being called
# by anything. That means a pin appears whether the coordinate arrived inline
# (device GPS, dragged pin) or later from the geocode worker, without either
# path having to know the map exists.
# ---------------------------------------------------------------------------

data "archive_file" "geojson_builder_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambdas/geojson_builder/handler.py"
  output_path = "${path.module}/build/idfinder_geojson_builder.zip"
}

resource "aws_iam_role" "geojson_builder_lambda" {
  name               = "${var.project_name}-geojson-builder-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "geojson_builder_basic" {
  role       = aws_iam_role.geojson_builder_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "geojson_builder_permissions" {
  name = "${var.project_name}-geojson-builder-permissions"
  role = aws_iam_role.geojson_builder_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        # Scan only. The builder reads every record but must never write one
        # -- it is a projection of the table, not an owner of it.
        Action   = ["dynamodb:Scan"]
        Resource = aws_dynamodb_table.records.arn
      },
      {
        Effect = "Allow"
        # Read the change stream. This is a separate ARN from the table's.
        Action = [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ]
        Resource = aws_dynamodb_table.records.stream_arn
      },
      {
        Effect = "Allow"
        # Scoped to the pins prefix. The builder has no reason to touch
        # basemap.pmtiles, which is uploaded by hand and must not be
        # overwritten by an automated job.
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.map.arn}/pins/*"
      },
    ]
  })
}

resource "aws_lambda_function" "geojson_builder" {
  function_name    = "${var.project_name}-geojson-builder"
  role             = aws_iam_role.geojson_builder_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.13"
  timeout          = 60
  memory_size      = 512
  filename         = data.archive_file.geojson_builder_zip.output_path
  source_code_hash = data.archive_file.geojson_builder_zip.output_base64sha256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.records.name
      MAP_BUCKET = aws_s3_bucket.map.bucket
    }
  }
}

resource "aws_cloudwatch_log_group" "geojson_builder" {
  name              = "/aws/lambda/${aws_lambda_function.geojson_builder.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_event_source_mapping" "geojson_builder" {
  event_source_arn  = aws_dynamodb_table.records.stream_arn
  function_name     = aws_lambda_function.geojson_builder.arn
  starting_position = "LATEST"

  # Each invocation rewrites both files in full, so the goal is fewer, larger
  # invocations. A burst of reports collapses into one rebuild instead of one
  # per record.
  batch_size                         = 25
  maximum_batching_window_in_seconds = 30

  # A record the builder cannot handle would otherwise block its shard and
  # stall every later rebuild behind it.
  bisect_batch_on_function_error = true
  maximum_retry_attempts         = 3
}
