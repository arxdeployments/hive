# ---------------------------------------------------------------------------
# Input variables. Everything has a sensible default except `domain_name`,
# which cannot be guessed and which Caddy needs in order to issue a
# Let's Encrypt certificate.
# ---------------------------------------------------------------------------

variable "region" {
  description = "AWS region to deploy into. Availability zones are derived from this, never hardcoded."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name. Tags every resource and namespaces the SSM parameter path."
  type        = string
  default     = "prod"

  # This is not only a tag. data.tf gates RDS deletion_protection on it being
  # EXACTLY "prod" — the one place the value changes behaviour rather than
  # labelling something. Any other spelling silently ships the production
  # database with deletion protection off, and nothing in the plan says so: the
  # line just reads `deletion_protection = false`.
  #
  # "production" is the spelling most likely to be reached for, because it is the
  # one the application itself uses (RXHIVE_ENVIRONMENT=production in
  # user_data.sh.tftpl, and config.py's is_production compares against
  # "production"). Constraining the set makes the mismatch impossible instead of
  # invisible.
  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment must be one of: prod, staging, dev. data.tf gates RDS deletion_protection on the exact string \"prod\", so \"production\" would silently disable it."
  }
}

# --- Compute -----------------------------------------------------------------

variable "instance_type" {
  description = <<-EOT
    EC2 instance type for the all-in-one app host. The box runs api (uvicorn,
    2 workers), web, caddy, redis and the LiveKit SFU simultaneously, and
    LiveKit media mixing is CPU-bound, so 2 vCPU / 8 GiB is the floor.

    Default is m7i-flex.large: 2 vCPU / 8 GiB / x86_64 — identical resources to
    the t3.large this originally specified, and on the AWS Free Tier eligible
    list for accounts created on or after 2025-07-15. That matters because a
    "Free plan" account (accountPlanType FREE) REJECTS non-eligible instance
    types outright rather than billing for them, so t3.large fails at apply
    with a FreeTierRestrictionError. x86_64 also keeps compute.tf's existing
    al2023-ami-kernel-default-x86_64 SSM lookup correct — the t4g.* eligible
    types are arm64 and would additionally require switching that parameter.

    Eligible types for a Free plan account (verify against your own account
    with: aws ec2 describe-instance-types --filters
    Name=free-tier-eligible,Values=true):
      t3.micro, t3.small, t4g.micro, t4g.small, c7i-flex.large, m7i-flex.large
    Only m7i-flex.large meets the 8 GiB floor.

    On a Paid plan account, t3.large remains a valid, slightly cheaper choice.
  EOT
  type        = string
  default     = "m7i-flex.large"
}

# --- Database ----------------------------------------------------------------

variable "db_instance_class" {
  description = <<-EOT
    RDS PostgreSQL instance class.

    Default is db.t4g.micro (2 vCPU / 1 GiB). AWS Free plan accounts may only
    create db.t3.micro or db.t4g.micro RDS instances — db.t4g.small, the
    original default here, is rejected at apply with a FreeTierRestrictionError
    even though it is the cheapest class that comfortably fits the workload.

    This is a real downgrade, not a free win: 1 GiB of RAM instead of 2. It is
    adequate for low single-digit concurrent users. On a Paid plan account set
    db_instance_class = "db.t4g.small" in terraform.tfvars.
  EOT
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GB (gp3). 20 GB is both the gp3 minimum for PostgreSQL and the documented Free Tier storage figure."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = <<-EOT
    Upper bound (GB) for RDS storage autoscaling. 0 disables autoscaling and
    pins the volume at db_allocated_storage, which is the RDS default and what
    this stack ran with: a full volume then means `storage-full`, where every
    write fails until an operator modifies the instance by hand.

    Must be 0, or at least 10% greater than db_allocated_storage: that is an RDS
    requirement, not a rounding allowance, and it is enforced by the API
    mid-apply rather than by the plan. So against the default 20 GB allocation
    the smallest accepted value is 22, not 21. data.tf carries a precondition
    that catches it at plan time.

    100 GB against a 20 GB allocation is five times the headroom for a volume
    nothing prunes. Autoscaling is not itself billable and RDS only grows the
    volume when it is genuinely near full, so this costs nothing until it is
    needed; note that it never shrinks back, so growth is one-way.
  EOT
  type        = number
  default     = 100

  validation {
    condition     = var.db_max_allocated_storage == 0 || (var.db_max_allocated_storage >= 20 && var.db_max_allocated_storage <= 65536)
    error_message = "db_max_allocated_storage must be 0 (disabled) or between 20 and 65536 GB."
  }
}

variable "db_backup_retention_period" {
  description = <<-EOT
    Days of RDS automated backups. Non-zero is what enables point-in-time
    recovery; 0 disables automated backups AND PITR entirely.

    Default is 1, not 7, because a Free plan account rejects 7 with:
      FreeTierRestrictionError: The specified backup retention period exceeds
      the maximum available to free tier customers.

    AWS does not publish the numeric cap for Free plan accounts anywhere — the
    RDS free-tier page states instance classes and engines only. 1 is chosen
    because it is the RDS API/CLI default, so it is the value most likely to be
    permitted. If apply still rejects 1, drop to 0 with:
      terraform apply -var 'db_backup_retention_period=0'
    and read the warning on auto_minor_version_upgrade in data.tf before you do.

    At 1, PITR keeps its full ~5-minute granularity; only the reach-back
    shrinks from 7 days to a rolling ~24 hours. At 0 there is no PITR at all.
    On a Paid plan account, set this back to 7.
  EOT
  type        = number
  default     = 1

  validation {
    condition     = var.db_backup_retention_period >= 0 && var.db_backup_retention_period <= 35
    error_message = "db_backup_retention_period must be between 0 and 35 days."
  }
}

# --- DNS / TLS ---------------------------------------------------------------

variable "domain_name" {
  description = <<-EOT
    Public domain the app is served from, e.g. "chat.rhythmrx.ai". This is
    passed to Caddy as SITE_ADDRESS so it can obtain a Let's Encrypt cert. The
    whole app (web, /api, /livekit) is served from this ONE origin, which is why
    RXHIVE_CORS_ORIGINS stays empty — auth is same-origin httpOnly cookies plus
    an X-Requested-With CSRF header. An A record for this name must point at the
    Elastic IP BEFORE the first boot, or the ACME HTTP-01 challenge fails.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a bare hostname such as chat.example.com — no scheme, port or trailing slash."
  }
}

# --- Access ------------------------------------------------------------------

variable "ssh_allowed_cidr" {
  description = <<-EOT
    CIDR allowed to reach port 22. Default null creates NO SSH rule at all:
    the instance profile carries the SSM policy, so shell access goes through
    Session Manager, which needs no open port, no key pair and leaves an
    auditable trail. Only set this (to a specific office/VPN CIDR, never
    0.0.0.0/0) if Session Manager is unavailable.
  EOT
  type        = string
  default     = null

  validation {
    condition     = var.ssh_allowed_cidr == null || can(cidrhost(coalesce(var.ssh_allowed_cidr, "10.0.0.0/8"), 0))
    error_message = "ssh_allowed_cidr must be null or a valid CIDR block such as 203.0.113.4/32."
  }
}

# --- Application source ------------------------------------------------------

variable "repo_url" {
  description = "Git URL the instance clones at first boot to get infra/docker-compose.yml and the app source."
  type        = string
  default     = "https://github.com/rhythmrx/rxhive.git"
}

variable "branch" {
  description = "Git branch to deploy."
  type        = string
  default     = "main"
}

# --- Ops ---------------------------------------------------------------------

variable "alert_email" {
  description = "RESERVED — not yet wired. No CloudWatch alarms exist in this stack, so setting this has no effect. Left declared so adding alarms later does not change the variable interface."
  type        = string
  default     = null
}
