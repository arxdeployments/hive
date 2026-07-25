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
}

# --- Compute -----------------------------------------------------------------

variable "instance_type" {
  description = <<-EOT
    EC2 instance type for the all-in-one app host. t3.large (2 vCPU / 8 GiB) is
    the floor: the box runs api (uvicorn, 2 workers), web, caddy, redis and the
    LiveKit SFU simultaneously, and LiveKit media mixing is CPU-bound.
  EOT
  type        = string
  default     = "t3.large"
}

# --- Database ----------------------------------------------------------------

variable "db_instance_class" {
  description = "RDS PostgreSQL instance class. db.t4g.small (Graviton) is the cheapest class that still supports the workload."
  type        = string
  default     = "db.t4g.small"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage in GB (gp3)."
  type        = number
  default     = 20
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
  description = "Optional email for CloudWatch alarm notifications. Null disables alerting."
  type        = string
  default     = null
}
