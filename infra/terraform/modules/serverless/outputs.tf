output "api_gateway_url" {
  description = "Base URL of the HTTP API Gateway (v2)"
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_gateway_id" {
  description = "API Gateway ID (used in IAM resource ARNs)"
  value       = aws_apigatewayv2_api.main.id
}

output "lambda_function_arn" {
  description = "ARN of the sync-engine Lambda function"
  value       = aws_lambda_function.sync_engine.arn
}

output "lambda_security_group_id" {
  description = "Security group ID attached to the Lambda function"
  value       = aws_security_group.lambda.id
}

output "sqs_queue_url" {
  description = "URL of the SQS FIFO queue"
  value       = aws_sqs_queue.sync_queue.url
}

output "sqs_queue_arn" {
  description = "ARN of the SQS FIFO queue"
  value       = aws_sqs_queue.sync_queue.arn
}

output "face_images_bucket_name" {
  description = "Name of the S3 face-images bucket"
  value       = aws_s3_bucket.face_images.bucket
}

output "face_images_bucket_arn" {
  description = "ARN of the S3 face-images bucket"
  value       = aws_s3_bucket.face_images.arn
}
