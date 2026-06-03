variable "aws_region" {
  type        = string
  description = "AWS region"
}

variable "account_id" {
  type        = string
  description = "AWS account ID"
}

variable "lambda_source_dir" {
  type        = string
  description = "Absolute path to the Lambda source directory (will be zipped)"
  default     = "../../infra/lambda/sync-engine/dist"
}

variable "db_host" {
  type        = string
  description = "RDS instance endpoint (hostname)"
}

variable "db_name" {
  type        = string
  description = "PostgreSQL database name"
  default     = "nhai"
}

variable "db_user" {
  type        = string
  description = "PostgreSQL user name"
  default     = "nhai_app"
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL password"
}

variable "db_port" {
  type        = number
  description = "PostgreSQL port"
  default     = 5432
}

variable "webhook_url" {
  type        = string
  description = "Optional webhook URL for sync.batch.completed events (FR-017)"
  default     = ""
}

variable "lambda_subnet_ids" {
  type        = list(string)
  description = "Subnet IDs for the Lambda function (private subnets with NAT)"
}

variable "lambda_vpc_id" {
  type        = string
  description = "VPC ID in which the Lambda runs"
}
