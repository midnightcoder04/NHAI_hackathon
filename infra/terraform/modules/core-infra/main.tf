# ============================================================================
# core-infra module
#
# Provisions:
#   - VPC with public + private subnets across 2 AZs (for RDS Multi-AZ)
#   - Internet Gateway + NAT Gateway for private subnet outbound access
#   - Cognito Identity Pool with guest (unauthenticated) identities enabled
#   - Least-privilege IAM role for unauthenticated identities:
#       - execute-api:Invoke on POST /sync/batch and PUT /sync/images/presign
#       - s3:PutObject on the face-images bucket images/ prefix
#
# Production hardening path:
#   Replace allow_unauthenticated_identities with developer-authenticated
#   identities (Cognito User Pools + Play Integrity / App Attest) once the
#   API is production-ready. Update the principal in the trust policy from
#   "cognito-identity.amazonaws.com" condition unauthenticated → authenticated.
# ============================================================================

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------
resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "nhai-vpc" }
}

# ---------------------------------------------------------------------------
# Internet Gateway
# ---------------------------------------------------------------------------
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "nhai-igw" }
}

# ---------------------------------------------------------------------------
# Public subnets (one per AZ)
# ---------------------------------------------------------------------------
resource "aws_subnet" "public" {
  count                   = length(var.public_subnet_cidrs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "nhai-public-${count.index + 1}" }
}

# ---------------------------------------------------------------------------
# Private subnets (one per AZ — hosts RDS Multi-AZ standby)
# ---------------------------------------------------------------------------
resource "aws_subnet" "private" {
  count             = length(var.private_subnet_cidrs)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = { Name = "nhai-private-${count.index + 1}" }
}

# ---------------------------------------------------------------------------
# Public route table
# ---------------------------------------------------------------------------
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = { Name = "nhai-rt-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# NAT Gateway (single AZ — upgrade to per-AZ for production HA)
# ---------------------------------------------------------------------------
resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "nhai-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "nhai-nat-gw" }

  depends_on = [aws_internet_gateway.main]
}

# ---------------------------------------------------------------------------
# Private route table (routes outbound through NAT)
# ---------------------------------------------------------------------------
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }

  tags = { Name = "nhai-rt-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Cognito Identity Pool (guest / unauthenticated identities)
# ---------------------------------------------------------------------------
resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = "nhai_identity_pool"
  allow_unauthenticated_identities = true
  # Production upgrade: set to false and add developer-authenticated identity
  # providers (Cognito User Pool + Play Integrity / App Attest verification).

  tags = { Name = "nhai-identity-pool" }
}

# ---------------------------------------------------------------------------
# IAM role for unauthenticated (guest) identities
# ---------------------------------------------------------------------------
data "aws_iam_policy_document" "cognito_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.main.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

resource "aws_iam_role" "unauthenticated" {
  name               = "nhai-cognito-unauthenticated"
  assume_role_policy = data.aws_iam_policy_document.cognito_assume_role.json
}

# Least-privilege policy: only the two sync API routes + S3 PutObject on images/
data "aws_iam_policy_document" "unauthenticated_policy" {
  statement {
    sid     = "AllowSyncAPIRoutes"
    effect  = "Allow"
    actions = ["execute-api:Invoke"]
    resources = [
      "arn:aws:execute-api:${var.aws_region}:${var.account_id}:${var.api_gateway_arn_prefix}/*/POST/sync/batch",
      "arn:aws:execute-api:${var.aws_region}:${var.account_id}:${var.api_gateway_arn_prefix}/*/PUT/sync/images/presign",
    ]
  }

  statement {
    sid     = "AllowFaceImageUpload"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${var.face_images_bucket_arn}/images/*",
    ]
  }
}

resource "aws_iam_role_policy" "unauthenticated" {
  name   = "nhai-unauthenticated-policy"
  role   = aws_iam_role.unauthenticated.id
  policy = data.aws_iam_policy_document.unauthenticated_policy.json
}

# Attach the role to the identity pool
resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    unauthenticated = aws_iam_role.unauthenticated.arn
  }
}
