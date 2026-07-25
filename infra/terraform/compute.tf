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

  # eth0 is the pre-built ENI below, not one EC2 creates at launch, so the
  # Elastic IP is already on the box the moment it powers on (see the ENI
  # comment). subnet_id / vpc_security_group_ids move to the ENI — EC2 does not
  # accept them here as well.
  network_interface {
    network_interface_id = aws_network_interface.app.id
    device_index         = 0
  }

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

  # Attaching the ENI is not enough on its own: Terraform is free to launch the
  # instance while the address is still being associated. user_data starts the
  # moment the box boots and immediately opens long-lived connections (dnf, git
  # clone), and a public-IP change mid-flight kills them and leaves a
  # half-provisioned host. Ordering the association first makes boot
  # deterministic — the final address is present before any of that runs.
  depends_on = [aws_eip_association.app]

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
# Primary network interface
#
# Created up front, and used as the instance's eth0, purely so the Elastic IP
# can be attached BEFORE anything boots. An EIP cannot be handed to RunInstances
# directly; associating it to an already-running instance swaps the public
# address out from under a box that is mid-bootstrap. Attaching it to a
# detached ENI and then launching onto that ENI removes the window entirely.
#
# Note this also turns off the subnet's map_public_ip_on_launch for this host:
# auto-assign only applies to an interface EC2 builds at launch, so the EIP is
# now the one and only public address this instance ever has. That is the
# point — LiveKit's rtc.use_external_ip discovery cannot latch a temporary
# address that no longer exists.
#
# The ENI outlives the instance (delete_on_termination defaults to false for a
# pre-existing interface), so a deliberate instance replacement keeps both the
# private address and the EIP association.
# ---------------------------------------------------------------------------
resource "aws_network_interface" "app" {
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.app.id]

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

# Associated to the interface rather than to the instance, so this can (and
# must) happen while the instance does not exist yet. aws_instance.app takes an
# explicit depends_on against this resource.
resource "aws_eip_association" "app" {
  network_interface_id = aws_network_interface.app.id
  allocation_id        = aws_eip.app.id
}
