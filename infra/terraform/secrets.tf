###############################################################################
# Generated secrets -> SSM Parameter Store (SecureString)
#
# Every secret the stack needs is generated here and written to
# /rxhive/<environment>/ as a SecureString. The EC2 instance reads them at boot
# with its instance role (see iam.tf) and renders infra/.env for docker compose,
# so no secret is ever committed to this repo, baked into an AMI, or left in
# user-data (which is readable by anything that can reach the metadata service).
#
# CAVEAT: random_password / random_string results are stored IN PLAINTEXT in
# Terraform state. The state backend must be encrypted and access-controlled.
###############################################################################

# --- RDS master password -----------------------------------------------------
#
# This value is interpolated straight into the DSN the API consumes:
#   RXHIVE_DATABASE_URL=postgresql+asyncpg://rxhive:<password>@<host>:5432/rxhive
# SQLAlchemy percent-DECODES the userinfo portion of that URL, so any character
# outside the URL-unreserved set would have to be percent-encoded by whoever
# assembles the DSN — and "%" itself would then be ambiguous. RDS separately
# rejects "/", "@", '"' and spaces in master passwords. Limiting
# override_special to the unreserved punctuation satisfies both constraints with
# no encoding step anywhere in the pipeline.
resource "random_password" "db_master" {
  length           = 32
  special          = true
  override_special = "-_.~"
  min_special      = 2
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
}

# --- RXHIVE_SECRET_KEY (JWT signing key) -------------------------------------
#
# backend/app/core/config.py hard-fails at boot in production when this is one
# of the shipped placeholders or shorter than 32 characters. 64 chars of
# lowercase alphanumerics is ~330 bits of entropy and needs no shell quoting in
# the generated .env file.
resource "random_password" "secret_key" {
  length  = 64
  special = false
  upper   = false
}

# --- LiveKit credentials -----------------------------------------------------
#
# docker-compose passes these to the SFU as a single YAML-ish line:
#   LIVEKIT_KEYS: "<key>: <secret>"
# so neither value may contain ":" or whitespace — hence alphanumeric only.
# The secret is also validated by config.py's production check (>= 32 chars).
resource "random_string" "livekit_api_key" {
  length  = 12
  special = false
  upper   = false
}

resource "random_password" "livekit_api_secret" {
  length  = 48
  special = false
}

# --- Initial super-admin password --------------------------------------------
#
# Consumed once, by the idempotent seed the API runs on first boot
# (RXHIVE_SEED_SUPERADMIN_PASSWORD). The app enforces a 10-character minimum;
# 20 URL/env-safe characters clears that comfortably.
resource "random_password" "superadmin" {
  length           = 20
  special          = true
  override_special = "-_.~"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
}

###############################################################################
# SSM parameters
#
# All SecureString, all under one path so the instance role can be scoped to
# exactly that prefix. key_id is left unset, so they are encrypted with the
# AWS-managed alias/aws/ssm key — iam.tf grants kms:Decrypt on that key.
###############################################################################

resource "aws_ssm_parameter" "db_password" {
  name        = "/rxhive/${var.environment}/db_password"
  description = "RDS master password for the rxhive database"
  type        = "SecureString"
  value       = random_password.db_master.result

  tags = {
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "secret_key" {
  name        = "/rxhive/${var.environment}/secret_key"
  description = "RXHIVE_SECRET_KEY - JWT signing key for the API"
  type        = "SecureString"
  value       = random_password.secret_key.result

  tags = {
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "livekit_api_key" {
  name        = "/rxhive/${var.environment}/livekit_api_key"
  description = "RXHIVE_LIVEKIT_API_KEY - LiveKit API key id"
  type        = "SecureString"
  value       = random_string.livekit_api_key.result

  tags = {
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "livekit_api_secret" {
  name        = "/rxhive/${var.environment}/livekit_api_secret"
  description = "RXHIVE_LIVEKIT_API_SECRET - LiveKit API secret"
  type        = "SecureString"
  value       = random_password.livekit_api_secret.result

  tags = {
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_ssm_parameter" "superadmin_password" {
  name        = "/rxhive/${var.environment}/superadmin_password"
  description = "RXHIVE_SEED_SUPERADMIN_PASSWORD - bootstrap only, ROTATE IN-APP after first login"
  type        = "SecureString"
  value       = random_password.superadmin.result

  tags = {
    Project     = "rxhive"
    Environment = var.environment
  }

  # The seed is idempotent: it creates the super-admin only if one does not
  # already exist, and the operator is expected to log in once and rotate the
  # password inside the app. Ignoring `value` means a later apply never churns
  # this parameter (and never clobbers a value an operator rotated by hand),
  # which would otherwise leave SSM advertising a password that no longer works.
  lifecycle {
    ignore_changes = [value]
  }
}

###############################################################################
# Web Push (VAPID) — NOT created here. This is a deliberate, documented gap.
#
# The app reads RXHIVE_VAPID_PUBLIC_KEY / RXHIVE_VAPID_PRIVATE_KEY, and
# user_data.sh.tftpl already picks them up from
# /rxhive/<environment>/vapid_public_key and .../vapid_private_key when they
# exist. The instance role needs no change either: iam.tf grants the whole
# /rxhive/<environment> path, not a per-parameter list.
#
# Terraform cannot generate the values. A VAPID keypair is an EC P-256 key
# serialised as raw base64url (see backend/app/tools/vapid.py), not a random
# string, so random_password would produce something structurally wrong. SSM
# also rejects an empty parameter value, so there is no blank placeholder to
# fall back to either.
#
# Both substitutes would be worse than absence, and that is why neither is
# used: backend/app/services/push.py gates on `not settings.vapid_private_key`,
# so an EMPTY key means "web push disabled" and every send cleanly no-ops. A
# non-empty INVALID key passes that gate — every send then fails at runtime,
# and /api/notifications/vapid-key hands browsers a garbage
# applicationServerKey that breaks subscription itself.
#
# So the keypair stays a manual step, and the `web_push_setup` output in
# outputs.tf prints it after every apply — the failure mode being fixed here is
# that the omission was silent, not that it was manual.
###############################################################################
