variable "vpc_id" {
  type        = string
  description = "VPC in which to launch the RDS instance"
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the DB subnet group (≥2 for Multi-AZ)"
}

variable "lambda_security_group_id" {
  type        = string
  description = "Security group ID of the Lambda function (granted inbound on 5432)"
}

variable "db_name" {
  type        = string
  description = "PostgreSQL database name"
  default     = "nhai"
}

variable "db_user" {
  type        = string
  description = "PostgreSQL master user name"
  default     = "nhai_app"
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "PostgreSQL master user password (stored in Secrets Manager)"
}

variable "db_instance_class" {
  type        = string
  description = "RDS instance class"
  default     = "db.t3.micro"
}

variable "db_allocated_storage" {
  type        = number
  description = "Allocated storage in GB"
  default     = 20
}

variable "multi_az" {
  type        = bool
  description = "Enable Multi-AZ for RDS (recommended for production)"
  default     = false
}
