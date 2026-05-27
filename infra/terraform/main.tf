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
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

variable "account_id" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "webhook_url" {
  type    = string
  default = ""
}
