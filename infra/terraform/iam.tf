# ============================================================================
# IAM User Policy — GodOfProgramming
#
# Grants permissions required for Terraform deployment:
#   - cognito-identity:CreateIdentityPool
#   - secretsmanager:CreateSecret
# ============================================================================

data "aws_iam_user" "deployer" {
  user_name = "GodOfProgramming"
}

resource "aws_iam_user_policy" "deployer_terraform" {
  name = "terraform-deployment-policy"
  user = data.aws_iam_user.deployer.user_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCognitoIdentityPool"
        Effect = "Allow"
        Action = [
          "cognito-identity:CreateIdentityPool",
          "cognito-identity:DeleteIdentityPool",
          "cognito-identity:DescribeIdentityPool",
          "cognito-identity:UpdateIdentityPool",
          "cognito-identity:TagResource",
          "cognito-identity:UntagResource",
          "cognito-identity:ListIdentityPools",
        ]
        Resource = "arn:aws:cognito-identity:${var.aws_region}:${var.account_id}:identitypool/*"
      },
      {
        Sid    = "AllowSecretsManager"
        Effect = "Allow"
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:PutSecretValue",
          "secretsmanager:UpdateSecret",
          "secretsmanager:TagResource",
          "secretsmanager:UntagResource",
          "secretsmanager:ListSecrets",
        ]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:nhai/*"
      },
      {
        Sid    = "AllowCognitoIdentityRoles"
        Effect = "Allow"
        Action = [
          "cognito-identity:SetIdentityPoolRoles",
          "cognito-identity:GetIdentityPoolRoles",
        ]
        Resource = "*"
      },
    ]
  })
}
