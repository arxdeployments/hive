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
  engine_version = "16"

  # DERIVED, not hardcoded, because these two settings are not independent. RDS
  # takes the pre-upgrade and post-upgrade snapshots that make a minor-version
  # upgrade reversible ONLY when retention > 0. At 0 an unattended Sunday upgrade
  # of this instance has no rollback point, no PITR to fall back on, and no way
  # to revert the engine — and multi_az is false, so it is the only copy.
  #
  # This was a hardcoded `true` carrying a WARNING that told the operator to set
  # it to false by hand if they ever ran at 0. Production then ran at 0 —
  # variables.tf documents `-var 'db_backup_retention_period=0'` as the Free plan
  # fallback and that is what was applied — with this still true: precisely the
  # combination the warning existed to prevent. An invariant spanning two
  # attributes cannot be held by a comment addressed to whoever changes one of
  # them; it has to be an expression.
  #
  # At 0 this switches auto-upgrade off, which means minor engine patches stop
  # arriving on their own: take a manual snapshot and apply them deliberately.
  # That is the correct trade at 0 — an unrevertable automatic upgrade of an
  # unbackuppable database is a worse exposure than a late patch.
  auto_minor_version_upgrade  = var.db_backup_retention_period > 0
  allow_major_version_upgrade = false

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  # Storage autoscaling. Unset (the default, 0) the volume is FIXED at
  # allocated_storage, and a full one does not slow the database down — it puts
  # the instance into `storage-full`, where every write fails until an operator
  # modifies the instance and waits for it to come back. There is no CloudWatch
  # alarm anywhere in this stack, so the first symptom is the API being down.
  #
  # Reaching full is a matter of time rather than of load, because nothing in the
  # app prunes the tables that only ever grow: refresh_tokens gains a row per
  # login AND per rotation (access tokens last 15 minutes, so one active session
  # mints a row four times an hour and expired rows are never deleted), and
  # audit_logs, notifications and uploads are swept by nothing at all —
  # app/db/models.py notes a cleanup job "can" purge unclaimed uploads, and none
  # exists. Retention policy for those tables is a separate decision; this is the
  # cheap half, and it turns a hard outage into a bill.
  #
  # Costs nothing at rest: RDS only grows the volume when it is actually near
  # full, and never shrinks it back.
  max_allocated_storage = var.db_max_allocated_storage

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

  # Days of automated backups. See var.db_backup_retention_period — the default
  # is 1 rather than 7 because an AWS Free plan account rejects 7 outright:
  #   FreeTierRestrictionError: The specified backup retention period exceeds
  #   the maximum available to free tier customers.
  #
  # At 1 point-in-time recovery still works at full ~5-minute granularity and
  # only the reach-back window shrinks to a rolling ~24 hours. At 0 there is no
  # PITR at all and no automated snapshots — see the WARNING below.
  backup_retention_period = var.db_backup_retention_period

  # UTC. Backup and maintenance windows must not overlap, and both are placed in
  # the small hours of the lowest-traffic day for a clinic-hours workload.
  # The backup window is only honoured while retention > 0.
  backup_window         = "07:00-08:00"
  maintenance_window    = "sun:08:30-sun:09:30"
  copy_tags_to_snapshot = true

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

  lifecycle {
    # RDS rejects a max equal to allocated_storage, and the rejection arrives
    # from the API mid-apply rather than from the plan. Catch it at plan time.
    precondition {
      condition     = var.db_max_allocated_storage == 0 || var.db_max_allocated_storage > var.db_allocated_storage
      error_message = "db_max_allocated_storage must be 0 (autoscaling off) or strictly greater than db_allocated_storage."
    }
  }
}

# A warning, not a failed plan. On an AWS Free plan account 0 may be the only
# retention RDS will accept, and refusing to apply would leave the operator
# unable to manage the stack at all. What must not happen is running that way
# without it being said out loud on every plan: at 0 there are no automated
# snapshots and no point-in-time recovery, so a bad migration, a wrong DELETE or
# a destroyed instance is permanent — and multi_az is false, so this is the sole
# copy of every message, user and audit record in the product.
check "database_can_be_restored" {
  assert {
    condition     = var.environment != "prod" || var.db_backup_retention_period > 0
    error_message = <<-EOT
      rxhive-${var.environment} has automated backups DISABLED
      (db_backup_retention_period = 0): no point-in-time recovery, no automated
      snapshots, and a single-AZ instance. auto_minor_version_upgrade is derived
      from this and is therefore OFF, so minor engine patches now need a manual
      snapshot and a deliberate apply.

      Raise db_backup_retention_period to 1 or more as soon as the account plan
      allows it, and re-check with:
        aws rds describe-db-instances --db-instance-identifier rxhive-${var.environment} \
          --query 'DBInstances[0].BackupRetentionPeriod'
    EOT
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
