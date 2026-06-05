# ============================================================================
# serverless module
#
# Provisions:
#   - S3 bucket for face images (versioned, all public access blocked)
#   - SQS FIFO queue (nhai-sync-queue.fifo) + DLQ (nhai-sync-dlq.fifo)
#   - Lambda function (Node.js 20, 512 MB, 300 s) — sync-engine
#   - HTTP API Gateway v2 with POST /sync/batch + PUT /sync/images/presign
#     routes, AWS_IAM authorization
#   - Lambda SQS event source mapping (batch size 1)
#   - Lambda security group + IAM role
# ============================================================================

# ---------------------------------------------------------------------------
# S3 — face images bucket (T062)
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "face_images" {
  bucket = "nhai-face-images-${var.account_id}"

  tags = { Name = "nhai-face-images" }
}

resource "aws_s3_bucket_versioning" "face_images" {
  bucket = aws_s3_bucket.face_images.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "face_images" {
  bucket = aws_s3_bucket.face_images.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# SQS FIFO — dead-letter queue
# ---------------------------------------------------------------------------
resource "aws_sqs_queue" "sync_dlq" {
  name                        = "nhai-sync-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true

  tags = { Name = "nhai-sync-dlq" }
}

# ---------------------------------------------------------------------------
# SQS FIFO — main queue
# ---------------------------------------------------------------------------
resource "aws_sqs_queue" "sync_queue" {
  name                        = "nhai-sync-queue.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  visibility_timeout_seconds  = 300 # matches Lambda timeout
  message_retention_seconds   = 86400 # 1 day

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.sync_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "nhai-sync-queue" }
}

# ---------------------------------------------------------------------------
# Lambda — IAM role
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "nhai-sync-engine-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Managed policy: basic Lambda execution (CloudWatch Logs) + VPC networking
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "lambda_policy" {
  # SQS — send (HTTP path: enqueue batch)
  statement {
    sid     = "SQSSendMessage"
    effect  = "Allow"
    actions = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.sync_queue.arn]
  }

  # SQS — consume (event-source-mapping path)
  statement {
    sid    = "SQSConsume"
    effect = "Allow"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [
      aws_sqs_queue.sync_queue.arn,
      aws_sqs_queue.sync_dlq.arn,
    ]
  }

  # S3 — face images
  statement {
    sid    = "S3FaceImages"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:HeadObject",
    ]
    resources = ["${aws_s3_bucket.face_images.arn}/*"]
  }
}

resource "aws_iam_role_policy" "lambda_policy" {
  name   = "nhai-sync-engine-policy"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_policy.json
}

# ---------------------------------------------------------------------------
# Lambda — security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "lambda" {
  name        = "nhai-lambda-sg"
  description = "Outbound-only security group for the sync-engine Lambda"
  vpc_id      = var.lambda_vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound (RDS, SQS, S3 via NAT)"
  }

  tags = { Name = "nhai-lambda-sg" }
}

# ---------------------------------------------------------------------------
# Lambda — function
# ---------------------------------------------------------------------------

# Package the dist/ directory into a zip for deployment
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.module}/lambda_sync_engine.zip"
}

resource "aws_lambda_function" "sync_engine" {
  function_name    = "nhai-sync-engine"
  description      = "NHAI offline facial recognition — cloud sync engine"
  role             = aws_iam_role.lambda_exec.arn
  runtime          = "nodejs20.x"
  handler          = "handler.handler"
  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  memory_size      = 512
  timeout          = 300

  vpc_config {
    subnet_ids         = var.lambda_subnet_ids
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = {
      AWS_ACCOUNT_ID     = var.account_id
      SQS_QUEUE_URL      = aws_sqs_queue.sync_queue.url
      FACE_IMAGES_BUCKET = aws_s3_bucket.face_images.bucket
      DB_HOST            = var.db_host
      DB_NAME            = var.db_name
      DB_USER            = var.db_user
      DB_PASSWORD        = var.db_password
      DB_PORT            = tostring(var.db_port)
      WEBHOOK_URL        = var.webhook_url
    }
  }

  tags = { Name = "nhai-sync-engine" }
}

# ---------------------------------------------------------------------------
# Lambda — SQS event source mapping (batch size 1 for FIFO ordering)
# ---------------------------------------------------------------------------
resource "aws_lambda_event_source_mapping" "sqs" {
  event_source_arn = aws_sqs_queue.sync_queue.arn
  function_name    = aws_lambda_function.sync_engine.arn
  batch_size       = 1
  enabled          = true

  function_response_types = ["ReportBatchItemFailures"]
}

# ---------------------------------------------------------------------------
# API Gateway v2 (HTTP API)
# ---------------------------------------------------------------------------
resource "aws_apigatewayv2_api" "main" {
  name          = "nhai-sync-api"
  protocol_type = "HTTP"
  description   = "NHAI cloud sync API — offline facial recognition"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

# Lambda integration (proxy)
resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.sync_engine.invoke_arn
  payload_format_version = "2.0"
}

# Routes — AWS_IAM authorization
resource "aws_apigatewayv2_route" "sync_batch" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "POST /sync/batch"
  authorization_type = "AWS_IAM"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "presign" {
  api_id             = aws_apigatewayv2_api.main.id
  route_key          = "PUT /sync/images/presign"
  authorization_type = "AWS_IAM"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

# Allow API Gateway to invoke the Lambda function
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.sync_engine.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
