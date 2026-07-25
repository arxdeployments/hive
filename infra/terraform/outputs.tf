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

output "db_endpoint" {
  description = "RDS PostgreSQL endpoint (host:port). Reachable only from the app security group; the password lives in SSM, not here."
  value       = aws_db_instance.main.endpoint
}

output "s3_bucket" {
  description = "S3 bucket holding attachments (replaces the MinIO container)."
  value       = aws_s3_bucket.attachments.bucket
}
