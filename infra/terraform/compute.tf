# ---------------------------------------------------------------------------
# Compute: one EC2 host running the whole docker compose stack
# (api, web, caddy, redis, livekit). Postgres and MinIO are NOT run here —
# they are replaced by RDS and S3 respectively.
# ---------------------------------------------------------------------------

# AMI id comes from the AL2023 SSM public parameter rather than a literal, so
# this is region-portable and always the current patched image at create time.
# x86_64 to match the t3 family default; switch to the -arm64 parameter if
# var.instance_type is ever moved to a Graviton (t4g) type.
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_instance" "app" {
  ami           = data.aws_ssm_parameter.al2023.value
  instance_type = var.instance_type

  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.app.id]

  # Defined in iam.tf. Grants SSM Session Manager (so no SSH key or open :22),
  # read access to the SSM parameters holding the app secrets, and S3 access to
  # the attachments bucket.
  iam_instance_profile = aws_iam_instance_profile.app.name

  root_block_device {
    volume_size = 40 # OS + container images + Caddy cert store + redis AOF
    volume_type = "gp3"
    encrypted   = true

    tags = {
      Name        = "rxhive-${var.environment}-root"
      Project     = "rxhive"
      Environment = var.environment
    }
  }

  # IMDSv2 required: the instance profile can read secrets from SSM, so a
  # server-side request forgery in the app must not be able to fetch
  # credentials from the metadata service with a plain GET.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # containers reach IMDS through the docker bridge
  }

  # The template is maintained separately (user_data.sh.tftpl). It installs
  # docker, clones the repo, pulls secrets from SSM into infra/.env and brings
  # the compose stack up.
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    repo_url = var.repo_url
    branch   = var.branch
    region   = var.region

    # S3 replaces the minio container: RXHIVE_S3_BUCKET / _REGION, with the
    # real AWS endpoint and credentials from the instance profile.
    s3_bucket = aws_s3_bucket.attachments.bucket

    # "host:port" — drops straight into
    # RXHIVE_DATABASE_URL=postgresql+asyncpg://user:pass@<db_endpoint>/<db_name>
    db_endpoint = aws_db_instance.main.endpoint
    db_name     = aws_db_instance.main.db_name
    db_user     = aws_db_instance.main.username

    # Root path for the SecureString parameters the boot script reads
    # (RXHIVE_SECRET_KEY, the DB password, LIVEKIT_API_SECRET, the seed
    # superadmin password, VAPID keys). Must match the prefix iam.tf grants
    # ssm:GetParametersByPath on.
    ssm_prefix = "/rxhive/${var.environment}"

    # Caddy's SITE_ADDRESS. A bare domain (no scheme) is what makes Caddy
    # request a Let's Encrypt certificate automatically.
    site_address = var.domain_name
  })

  # Deliberately false. user_data only ever runs on the FIRST boot, so a change
  # here is a change to the bootstrap recipe for the *next* host — it must not
  # silently terminate the running instance, which would drop the redis AOF,
  # the Caddy certificate store and every in-flight call. To roll out a new
  # bootstrap, apply the change (a no-op on the live box) and then either
  # re-run the relevant steps over SSM or replace the instance deliberately
  # with `terraform apply -replace=aws_instance.app`.
  user_data_replace_on_change = false

  lifecycle {
    # Same reasoning: AWS ships a new AL2023 AMI roughly monthly, and the SSM
    # parameter tracks it. Without this, an unrelated `terraform apply` weeks
    # later would notice the drifted ami and destroy/recreate the production
    # host. OS patching is done in place (dnf) instead; instance replacement is
    # an explicit, planned operation.
    ignore_changes = [ami]
  }

  tags = {
    Name        = "rxhive-${var.environment}-app"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# ---------------------------------------------------------------------------
# Elastic IP
#
# The address must be stable for two independent reasons:
#   1. The DNS A record for var.domain_name points at it, and Caddy's ACME
#      renewal breaks the moment DNS stops resolving to this host.
#   2. LiveKit runs with rtc.use_external_ip: true, so it discovers this public
#      address and hands it to clients inside ICE candidates. An address that
#      changed on stop/start would leave clients trying to send media to an
#      address that is no longer ours.
# ---------------------------------------------------------------------------
resource "aws_eip" "app" {
  domain = "vpc"

  # An EIP cannot be allocated into a VPC that has no internet gateway yet.
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name        = "rxhive-${var.environment}-app"
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_eip_association" "app" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app.id
}
