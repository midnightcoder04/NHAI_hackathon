# ============================================================================
# database module
#
# Provisions:
#   - RDS PostgreSQL 15 (db.t3.micro) in private subnets
#   - Security group: allows inbound 5432 from Lambda SG only
#   - Secrets Manager secret for DB password
# ============================================================================

# ---------------------------------------------------------------------------
# Secrets Manager — DB password
# ---------------------------------------------------------------------------
resource "aws_secretsmanager_secret" "db_password" {
  name                    = "nhai/rds/db-password"
  description             = "RDS PostgreSQL master password for NHAI sync engine"
  recovery_window_in_days = 7

  tags = { Name = "nhai-rds-password" }
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id = aws_secretsmanager_secret.db_password.id
  secret_string = jsonencode({
    username = var.db_user
    password = var.db_password
    dbname   = var.db_name
  })
}

# ---------------------------------------------------------------------------
# Security group — RDS
# ---------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name        = "nhai-rds-sg"
  description = "Allow inbound PostgreSQL from Lambda SG only"
  vpc_id      = var.vpc_id

  ingress {
    description     = "PostgreSQL from Lambda"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.lambda_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow all outbound"
  }

  tags = { Name = "nhai-rds-sg" }
}

# ---------------------------------------------------------------------------
# DB subnet group (requires ≥2 subnets in different AZs for Multi-AZ)
# ---------------------------------------------------------------------------
resource "aws_db_subnet_group" "main" {
  name        = "nhai-db-subnet-group"
  description = "Private subnets for NHAI RDS"
  subnet_ids  = var.private_subnet_ids

  tags = { Name = "nhai-db-subnet-group" }
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL 15
# ---------------------------------------------------------------------------
resource "aws_db_instance" "main" {
  identifier              = "nhai-postgres"
  engine                  = "postgres"
  engine_version          = "15"
  instance_class          = var.db_instance_class
  allocated_storage       = var.db_allocated_storage
  storage_type            = "gp3"
  storage_encrypted       = true

  db_name  = var.db_name
  username = var.db_user
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az               = var.multi_az
  publicly_accessible    = false
  skip_final_snapshot    = true   # set to false for production
  deletion_protection    = false  # set to true for production
  backup_retention_period = 7

  # Performance Insights for query diagnostics (free tier)
  performance_insights_enabled = true

  tags = { Name = "nhai-postgres" }
}
