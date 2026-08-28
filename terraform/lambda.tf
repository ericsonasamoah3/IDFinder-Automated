# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------

data "archive_file" "backend_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambdas/backend/idfinder_backend.py"
  output_path = "${path.module}/build/idfinder_backend.zip"
}

data "archive_file" "ocr_process_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambdas/ocr_process/ocr_backend.py"
  output_path = "${path.module}/build/ocr_backend.zip"
}

data "archive_file" "save_worker_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambdas/save_worker/idfinder_save_worker.py"
  output_path = "${path.module}/build/idfinder_save_worker.zip"
}

data "archive_file" "save_zip" {
  type        = "zip"
  source_file = "${path.module}/../lambdas/save/idfinder_save.py"
  output_path = "${path.module}/build/idfinder_save.zip"
}

# ---------------------------------------------------------------------------
# IAM - shared basic execution policy
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ---- idfinder_backend (DynamoDB CRUD + matching + SNS) --------------------

resource "aws_iam_role" "backend_lambda" {
  name               = "${var.project_name}-backend-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "backend_basic" {
  role       = aws_iam_role.backend_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "backend_permissions" {
  name = "${var.project_name}-backend-permissions"
  role = aws_iam_role.backend_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query",
          "dynamodb:Scan",
        ]
        Resource = [
          aws_dynamodb_table.records.arn,
          "${aws_dynamodb_table.records.arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = "*" # SNS direct-to-phone-number publish has no fixed ARN to scope to
      },
    ]
  })
}

resource "aws_lambda_function" "backend" {
  function_name    = "${var.project_name}-backend"
  role             = aws_iam_role.backend_lambda.arn
  handler          = "idfinder_backend.lambda_handler"
  runtime          = "python3.13"
  timeout          = 15
  filename         = data.archive_file.backend_zip.output_path
  source_code_hash = data.archive_file.backend_zip.output_base64sha256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.records.name
      MATCH_INDEX_NAME = "match-index"
      SMS_ENABLED      = var.sms_enabled ? "true" : "false"
    }
  }
}

# ---- idfinder_process (OCR proxy) -----------------------------------------

resource "aws_iam_role" "process_lambda" {
  name               = "${var.project_name}-process-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "process_basic" {
  role       = aws_iam_role.process_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "process" {
  function_name    = "${var.project_name}-process"
  role             = aws_iam_role.process_lambda.arn
  handler          = "ocr_backend.lambda_handler"
  runtime          = "python3.13"
  timeout          = 29 # API Gateway HTTP API caps integrations at ~30s, so anything longer is unreachable; ocr_backend.py uses a matching 25s client timeout
  filename         = data.archive_file.ocr_process_zip.output_path
  source_code_hash = data.archive_file.ocr_process_zip.output_base64sha256

  environment {
    variables = {
      # The ocr123 image is a SageMaker-style inference container: it serves
      # GET /ping for health and POST /invocations for work. Pointing at "/"
      # returned 404 from the container itself.
      CONTAINER_URL = "http://${aws_lb.ocr.dns_name}/invocations"
      # Access-Control-Allow-Origin only accepts one value (or "*"), so this
      # only works correctly with the default single "*" entry. If you set
      # cors_allowed_origins to multiple specific origins, you'd need the
      # Lambda to reflect the request's Origin header instead of using this
      # env var directly -- not implemented here since "*" is fine for a
      # public, unauthenticated endpoint like this one.
      ALLOWED_ORIGIN = var.cors_allowed_origins[0]
    }
  }
}

# ---- idfinder_save (S3 upload) ---------------------------------------------

resource "aws_iam_role" "save_lambda" {
  name               = "${var.project_name}-save-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "save_basic" {
  role       = aws_iam_role.save_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "save_permissions" {
  name = "${var.project_name}-save-permissions"
  role = aws_iam_role.save_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        # GetObject is for head_object, which the save Lambda uses to check
        # whether a name is already taken before writing -- without it the
        # check raises 403 instead of 404 and every upload gets a suffix.
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.uploads.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage"]
        Resource = aws_sqs_queue.save_jobs.arn
      },
    ]
  })
}

resource "aws_lambda_function" "save" {
  function_name    = "${var.project_name}-save"
  role             = aws_iam_role.save_lambda.arn
  handler          = "idfinder_save.lambda_handler"
  runtime          = "python3.13"
  timeout          = 15
  filename         = data.archive_file.save_zip.output_path
  source_code_hash = data.archive_file.save_zip.output_base64sha256

  environment {
    variables = {
      BUCKET_NAME    = aws_s3_bucket.uploads.bucket
      ALLOWED_ORIGIN = var.cors_allowed_origins[0]
      SAVE_QUEUE_URL = aws_sqs_queue.save_jobs.id
    }
  }
}

# ---------------------------------------------------------------------------
# API Gateway (HTTP API) -- all three routes are public. No Cognito
# authorizer: Cognito login is only used client-side to gate the report
# pages (ProtectedRoute in the frontend); the actual privacy fix is that
# idfinder_backend.py never returns reporter_email/reporter_phone at all,
# to any caller. See idfinder1.md decision log / module docstring.
# ---------------------------------------------------------------------------

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.cors_allowed_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["Content-Type"]
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = var.environment
  auto_deploy = true
}

# ---- /IDfinder -> backend lambda ----

resource "aws_apigatewayv2_integration" "backend" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.backend.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "backend_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /IDfinder"
  target    = "integrations/${aws_apigatewayv2_integration.backend.id}"
}

resource "aws_apigatewayv2_route" "backend_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /IDfinder"
  target    = "integrations/${aws_apigatewayv2_integration.backend.id}"
}

resource "aws_lambda_permission" "backend_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.backend.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---- /process -> OCR process lambda ----

resource "aws_apigatewayv2_integration" "process" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.process.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "process_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /process"
  target    = "integrations/${aws_apigatewayv2_integration.process.id}"
}

resource "aws_lambda_permission" "process_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.process.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---- /save -> S3 upload lambda ----

resource "aws_apigatewayv2_integration" "save" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.save.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "save_post" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /save"
  target    = "integrations/${aws_apigatewayv2_integration.save.id}"
}

resource "aws_lambda_permission" "save_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.save.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ---------------------------------------------------------------------------
# Lambda log groups
#
# Lambda auto-creates these on first invoke with retention set to "never
# expire", which quietly accumulates cost forever. Declaring them here pins
# retention to 14 days, matching the ECS log group in ecs.tf.
#
# The import blocks below adopt the groups Lambda already created -- without
# them, apply fails with ResourceAlreadyExistsException. They are safe to
# delete once the first apply has run and the groups are in state.
# ---------------------------------------------------------------------------

import {
  to = aws_cloudwatch_log_group.backend
  id = "/aws/lambda/${var.project_name}-backend"
}

import {
  to = aws_cloudwatch_log_group.process
  id = "/aws/lambda/${var.project_name}-process"
}

import {
  to = aws_cloudwatch_log_group.save
  id = "/aws/lambda/${var.project_name}-save"
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/aws/lambda/${aws_lambda_function.backend.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "process" {
  name              = "/aws/lambda/${aws_lambda_function.process.function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "save" {
  name              = "/aws/lambda/${aws_lambda_function.save.function_name}"
  retention_in_days = 14
}

# ---------------------------------------------------------------------------
# idfinder_save_worker -- SQS consumer that does the actual archiving
#
# Split out from the /save request path so a slow or failing S3 write does
# not hold the browser request open, and so a failed job is retried by SQS
# and lands in the DLQ rather than disappearing into a 500.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "save_worker_lambda" {
  name               = "${var.project_name}-save-worker-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "save_worker_basic" {
  role       = aws_iam_role.save_worker_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "save_worker_permissions" {
  name = "${var.project_name}-save-worker-permissions"
  role = aws_iam_role.save_worker_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        # GetObject for the copy source, PutObject for the final object and
        # the JSON sidecar, DeleteObject to clear the staged upload.
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.uploads.arn}/*"
      },
      {
        Effect = "Allow"
        # Required by the event source mapping, which polls on the
        # function's behalf rather than the function calling SQS itself.
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
        ]
        Resource = aws_sqs_queue.save_jobs.arn
      },
    ]
  })
}

resource "aws_lambda_function" "save_worker" {
  function_name    = "${var.project_name}-save-worker"
  role             = aws_iam_role.save_worker_lambda.arn
  handler          = "idfinder_save_worker.lambda_handler"
  runtime          = "python3.13"
  timeout          = 30 # queue visibility_timeout_seconds is 6x this
  filename         = data.archive_file.save_worker_zip.output_path
  source_code_hash = data.archive_file.save_worker_zip.output_base64sha256

  environment {
    variables = {
      BUCKET_NAME = aws_s3_bucket.uploads.bucket
    }
  }
}

resource "aws_cloudwatch_log_group" "save_worker" {
  name              = "/aws/lambda/${aws_lambda_function.save_worker.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_event_source_mapping" "save_worker" {
  event_source_arn = aws_sqs_queue.save_jobs.arn
  function_name    = aws_lambda_function.save_worker.arn
  batch_size       = 10

  # Without this, one bad job in a batch forces redelivery of the whole
  # batch, including jobs that already wrote their objects. The handler
  # returns batchItemFailures to name only the messages that actually failed.
  function_response_types = ["ReportBatchItemFailures"]
}
