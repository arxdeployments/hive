###############################################################################
# Stateful backing services: RDS PostgreSQL and the S3 attachment bucket.
#
# These are the two containers from infra/docker-compose.yml (postgres, minio)
# that are deliberately NOT run on the EC2 box: anything holding durable state
# lives in a managed service so the instance stays disposable.
###############################################################################

# One stack-lifetime random suffix. S3 bucket names are globally unique, and RDS
# final-snapshot identifiers must not collide with a snapshot left behind by a
# previous incarnation of this stack, so both borrow it.
resource "random_id" "bucket_suffix" {
  byte_length = 4
}

###############################################################################
# RDS PostgreSQL 16
###############################################################################

# Both private subnets: RDS requires a subnet group spanning >= 2 AZs even for a
# single-AZ instance, because that is what makes a later failover/Multi-AZ
# promotion possible without rebuilding the instance.
resource "aws_db_subnet_group" "main" {
  name       = "rxhive-${var.environment}"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Project     = "rxhive"
    Environment = var.environment
    Name        = "rxhive-${var.environment}"
  }
}

resource "aws_db_instance" "main" {
  identifier = "rxhive-${var.environment}"

  engine = "postgres"
  # Major version only: AWS resolves this to the latest available 16.x at create
  # time and auto_minor_version_upgrade keeps it patched from there. Pinning a
  # minor version here would just create drift every time AWS deprecates one.
  engine_version              = "16"
  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name = "rxhive"
  # The API's first Alembic migration runs `CREATE EXTENSION citext` (the users
  # table stores emails as CITEXT for case-insensitive uniqueness). On RDS only
  # the master user carries rds_superuser, so the app MUST connect as this user
  # for the boot-time `alembic upgrade head` to succeed — do not hand the app a
  # narrower role without pre-creating the extension.
  username = "rxhive"
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  # Reachable only from the app security group inside the VPC. The API is the
  # sole client; operators tunnel in via SSM Session Manager on the EC2 box.
  publicly_accessible = false
  multi_az            = false

  backup_retention_period = 7
  # UTC. Backup and maintenance windows must not overlap, and both are placed in
  # the small hours of the lowest-traffic day for a clinic-hours workload.
  backup_window           = "07:00-08:00"
  maintenance_window      = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot   = true

  # Never silently discard the data on destroy: take a final snapshot, and in
  # prod refuse the destroy outright until someone flips this off deliberately.
  deletion_protection       = var.environment == "prod"
  skip_final_snapshot       = false
  final_snapshot_identifier = "rxhive-${var.environment}-final-${random_id.bucket_suffix.hex}"

  # Performance Insights and enhanced monitoring are billable extras that buy
  # little on a t4g.small; CloudWatch's default RDS metrics are enough here.
  performance_insights_enabled = false
  monitoring_interval          = 0

  # Version/parameter changes wait for the maintenance window instead of
  # bouncing the database under live traffic.
  apply_immediately = false

  tags = {
    Project     = "rxhive"
    Environment = var.environment
    Name        = "rxhive-${var.environment}"
  }
}

###############################################################################
# S3 attachment bucket (replaces the minio container)
###############################################################################

resource "aws_s3_bucket" "attachments" {
  bucket = "rxhive-${var.environment}-attachments-${random_id.bucket_suffix.hex}"

  tags = {
    Project     = "rxhive"
    Environment = var.environment
    Name        = "rxhive-${var.environment}-attachments"
  }
}

# Attachments are the one piece of user data with no other copy anywhere;
# versioning makes an accidental or malicious delete recoverable.
resource "aws_s3_bucket_versioning" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Attachments are only ever served through /api/media/*, which checks
# membership and then redirects to a presigned URL that expires in 300s
# (RXHIVE_PRESIGN_EXPIRY_SECONDS). The bucket itself must therefore never be
# publicly readable — all four blocks on, including the two that stop a future
# bucket policy or ACL from re-opening it.
resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  # A large upload that dies halfway leaves billable parts behind forever and
  # they are invisible in the console object listing. Reap them after a week.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# The API hands the browser a presigned S3 URL and the browser fetches it
# directly from the S3 origin — a different origin from the app. Without this
# CORS rule every <img>/fetch of an attachment fails the preflight and images
# render broken, even though the URL itself is valid. GET/HEAD only: uploads go
# through the API (storage.put_object runs server-side), so the browser never
# needs to write to S3.
resource "aws_s3_bucket_cors_configuration" "attachments" {
  bucket = aws_s3_bucket.attachments.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["https://${var.domain_name}"]
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type", "Content-Disposition"]
    max_age_seconds = 3000
  }
}
