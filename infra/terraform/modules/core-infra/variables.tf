variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
}

variable "account_id" {
  type        = string
  description = "AWS account ID"
}

variable "face_images_bucket_arn" {
  type        = string
  description = "ARN of the S3 face-images bucket (used in IAM policy)"
}

variable "api_gateway_arn_prefix" {
  type        = string
  description = "Partial ARN prefix for the API Gateway, e.g. arn:aws:execute-api:ap-south-1:123456789012:abcdef1234"
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC"
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for public subnets (one per AZ)"
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  type        = list(string)
  description = "CIDR blocks for private subnets (one per AZ, used for RDS)"
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "availability_zones" {
  type        = list(string)
  description = "Availability zones to deploy subnets into"
  default     = ["ap-south-1a", "ap-south-1b"]
}
