terraform {
  required_version = ">= 1.7"

  backend "s3" {
    bucket         = "nhai-terraform-state"
    key            = "001-offline-facial-recognition/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "nhai-terraform-locks"
    encrypt        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Input variables
# ---------------------------------------------------------------------------

variable "aws_region" {
  type        = string
  description = "AWS region for all resources"
  default     = "ap-south-1"
}

variable "account_id" {
  type        = string
  description = "AWS account ID"
}

variable "db_password" {
  type        = string
  sensitive   = true
  description = "RDS PostgreSQL master password"
}

variable "webhook_url" {
  type        = string
  description = "Optional webhook URL for sync.batch.completed events (FR-017)"
  default     = ""
}

# ---------------------------------------------------------------------------
# Module: serverless
# (created first so face_images_bucket_arn is available for core-infra)
# ---------------------------------------------------------------------------

module "serverless" {
  source = "./modules/serverless"

  aws_region        = var.aws_region
  account_id        = var.account_id
  db_host           = module.database.db_host
  db_name           = "nhai"
  db_user           = "nhai_app"
  db_password       = var.db_password
  db_port           = 5432
  webhook_url       = var.webhook_url
  lambda_subnet_ids = module.core_infra.private_subnet_ids
  lambda_vpc_id     = module.core_infra.vpc_id
}

# ---------------------------------------------------------------------------
# Module: core-infra
# ---------------------------------------------------------------------------

module "core_infra" {
  source = "./modules/core-infra"

  aws_region             = var.aws_region
  account_id             = var.account_id
  face_images_bucket_arn = module.serverless.face_images_bucket_arn
  # Wildcard suffix — the role only constrains path-level; API GW ID is passed
  # in the resource string so we use "*" here for the API GW ID segment to
  # avoid a circular dependency. Tighten to the actual ID post-deploy.
  api_gateway_arn_prefix = "*"
}

# ---------------------------------------------------------------------------
# Module: database
# ---------------------------------------------------------------------------

module "database" {
  source = "./modules/database"

  vpc_id                   = module.core_infra.vpc_id
  private_subnet_ids       = module.core_infra.private_subnet_ids
  lambda_security_group_id = module.serverless.lambda_security_group_id
  db_name                  = "nhai"
  db_user                  = "nhai_app"
  db_password              = var.db_password
  db_instance_class        = "db.t3.micro"
  multi_az                 = false # enable for production
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "api_gateway_url" {
  description = "Base URL of the HTTP API Gateway — set as AWS_API_GATEWAY_URL in mobile/.env.local"
  value       = module.serverless.api_gateway_url
}

output "cognito_identity_pool_id" {
  description = "Cognito Identity Pool ID — set as AWS_COGNITO_IDENTITY_POOL_ID in mobile/.env.local"
  value       = module.core_infra.cognito_identity_pool_id
}

output "face_images_bucket" {
  description = "Name of the S3 bucket for face images"
  value       = module.serverless.face_images_bucket_name
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = module.database.db_endpoint
  sensitive   = true
}
