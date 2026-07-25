# ---------------------------------------------------------------------------
# Outputs — what a human needs after `terraform apply`.
# ---------------------------------------------------------------------------

output "public_ip" {
  description = "Elastic IP of the app host. Stable across stop/start; LiveKit advertises it in ICE candidates."
  value       = aws_eip.app.public_ip
}

# The one manual step. Caddy cannot obtain a certificate until the name
# resolves here, so create this record and let it propagate BEFORE (or
# immediately after) the first boot. If the box came up first, Caddy retries on
# its own — no redeploy needed.
output "dns_record_required" {
  description = "DNS A record you must create at your registrar before TLS can be issued."
  value = {
    name  = var.domain_name
    type  = "A"
    value = aws_eip.app.public_ip
    ttl   = 300
  }
}

output "dns_record_instructions" {
  description = "Human-readable version of the DNS record to create."
  value       = "Create an A record:  ${var.domain_name}  ->  ${aws_eip.app.public_ip}  (TTL 300). Then browse to https://${var.domain_name} and sign in with RXHIVE_SEED_SUPERADMIN_EMAIL."
}

output "app_url" {
  description = "Single origin serving the SPA, /api, /ws and /livekit."
  value       = "https://${var.domain_name}"
}

output "health_check_url" {
  description = "Reports database/redis/livekit status. First stop when debugging a deploy."
  value       = "https://${var.domain_name}/api/health"
}

output "instance_id" {
  description = "EC2 instance id of the app host."
  value       = aws_instance.app.id
}

output "connect_command" {
  description = "Shell into the host. SSM needs no open port and no key pair; the SSH form only works if var.ssh_allowed_cidr was set."
  value = {
    ssm = "aws ssm start-session --region ${var.region} --target ${aws_instance.app.id}"
    ssh = var.ssh_allowed_cidr == null ? "(no SSH rule - set var.ssh_allowed_cidr to enable, or use the ssm command above)" : "ssh ec2-user@${aws_eip.app.public_ip}"
  }
}

# Web Push is the one thing Terraform cannot provision (see the block at the
# end of secrets.tf). Printing the step on every apply is the actual fix: with
# no keypair in SSM the stack still boots green and reports healthy, push just
# never fires, and nothing anywhere says so.
output "web_push_setup" {
  description = "MANUAL STEP — Web Push stays silently disabled until a VAPID keypair is stored in SSM."
  value       = <<-EOT
    Web Push is NOT provisioned by Terraform (VAPID keys are EC P-256 keypairs,
    which Terraform cannot generate). Until the two parameters below exist, the
    app runs normally and push notifications simply never arrive.

    1. Generate the keypair:
         cd backend && python -m app.tools.vapid
       It prints RXHIVE_VAPID_PUBLIC_KEY=<pub> and RXHIVE_VAPID_PRIVATE_KEY=<priv>.
       Store the values only — not the RXHIVE_... = prefix.

    2. Write them to SSM (leaf names must match exactly; the instance role
       already covers this path):
         aws ssm put-parameter --region ${var.region} --type SecureString \
           --name /rxhive/${var.environment}/vapid_public_key  --value '<pub>'
         aws ssm put-parameter --region ${var.region} --type SecureString \
           --name /rxhive/${var.environment}/vapid_private_key --value '<priv>'

    3. Re-render infra/.env and restart the stack on the box:
         aws ssm start-session --region ${var.region} --target <instance_id>
         sudo bash /var/lib/cloud/instance/user-data.txt

    Verify: GET https://${var.domain_name}/api/notifications/vapid-key (as a
    logged-in user) must return a non-empty public_key.
  EOT
}

output "db_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port). Reachable only from the app security group; the password lives in SSM, not here."
  value       = aws_db_instance.main.endpoint
}

output "s3_bucket" {
  description = "S3 bucket holding attachments (replaces the MinIO container)."
  value       = aws_s3_bucket.attachments.bucket
}
