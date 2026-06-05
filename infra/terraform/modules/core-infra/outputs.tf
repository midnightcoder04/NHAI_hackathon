output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets (used for RDS Multi-AZ)"
  value       = aws_subnet.private[*].id
}

output "cognito_identity_pool_id" {
  description = "Cognito Identity Pool ID for the mobile app"
  value       = aws_cognito_identity_pool.main.id
}

output "unauthenticated_role_arn" {
  description = "ARN of the IAM role assigned to unauthenticated (guest) identities"
  value       = aws_iam_role.unauthenticated.arn
}
