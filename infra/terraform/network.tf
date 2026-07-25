# ---------------------------------------------------------------------------
# Network: one VPC, one public subnet for the app host, two private subnets for
# RDS.
#
# There is deliberately NO NAT gateway. It costs ~$32/mo plus data processing,
# and nothing in the private subnets needs outbound internet: RDS pulls no
# packages and phones nowhere. The only thing that egresses is the EC2 host,
# and it sits in the public subnet behind an Elastic IP.
# ---------------------------------------------------------------------------

# AZs are derived, never hardcoded, so this stack applies cleanly in any region.
# The opt-in filter drops Local Zones / Wavelength zones, which do not support
# RDS subnet groups and would break the apply if they happened to sort first.
data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"

  # Both required so the RDS instance is reachable by its DNS name from the
  # EC2 host (RXHIVE_DATABASE_URL uses the endpoint hostname, not an IP).
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "rxhive-${var.environment}"
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "rxhive-${var.environment}"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# --- Public subnet (EC2) -----------------------------------------------------

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.0.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name        = "rxhive-${var.environment}-public"
    Project     = "rxhive"
    Environment = var.environment
    Tier        = "public"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "rxhive-${var.environment}-public"
    Project     = "rxhive"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# --- Private subnets (RDS) ---------------------------------------------------

# Two of them, in two different AZs, purely because an RDS DB subnet group
# requires at least two AZs even for a single-AZ instance. They share the VPC's
# implicit main route table (local routes only) — no route to the internet.
resource "aws_subnet" "private" {
  count = 2

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, 10 + count.index) # 10.20.10.0/24, 10.20.11.0/24
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name        = "rxhive-${var.environment}-private-${count.index + 1}"
    Project     = "rxhive"
    Environment = var.environment
    Tier        = "private"
  }
}

# ---------------------------------------------------------------------------
# Security group: application host
# ---------------------------------------------------------------------------

resource "aws_security_group" "app" {
  name        = "rxhive-app"
  description = "RX HIVE app host: Caddy TLS + LiveKit signalling and media"
  vpc_id      = aws_vpc.main.id

  # Rules are separate aws_vpc_security_group_*_rule resources below, so adding
  # or removing a rule never replaces this group (and therefore never has to
  # detach it from the running instance).
  tags = {
    Name        = "rxhive-app"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# HTTP — needed even though the app is HTTPS-only: Let's Encrypt's HTTP-01
# challenge hits :80, and Caddy redirects everything else to :443.
resource "aws_vpc_security_group_ingress_rule" "app_http" {
  security_group_id = aws_security_group.app.id
  description       = "HTTP (ACME HTTP-01 challenge + redirect to HTTPS)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"

  tags = {
    Name        = "rxhive-app-http"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# HTTPS — the single origin: / -> web, /api -> api, /livekit -> LiveKit signal.
resource "aws_vpc_security_group_ingress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "HTTPS (web, /api, /livekit signal - all one origin)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"

  tags = {
    Name        = "rxhive-app-https"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# LiveKit ICE/TCP fallback (livekit.yaml: rtc.tcp_port). Used by clients on
# networks that block UDP entirely. Without it those users get no media at all.
resource "aws_vpc_security_group_ingress_rule" "app_livekit_tcp" {
  security_group_id = aws_security_group.app.id
  description       = "LiveKit WebRTC TCP fallback (rtc.tcp_port)"
  ip_protocol       = "tcp"
  from_port         = 7881
  to_port           = 7881
  cidr_ipv4         = "0.0.0.0/0"

  tags = {
    Name        = "rxhive-app-livekit-tcp"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# LiveKit WebRTC media (livekit.yaml: rtc.port_range_start/end = 50000-50100).
#
# THIS RULE IS LOAD-BEARING. WebRTC media never travels over the signalling
# websocket — the browser negotiates ICE candidates over /livekit (443) and then
# sends RTP straight to these UDP ports. If the range is closed the call will
# appear to connect, participants will join the room, and then nobody will see
# or hear anything: the classic "connects but no media" failure. It cannot be
# fronted by an ALB/NLB path rule either, which is why the SFU is on the box
# with a public Elastic IP rather than behind a load balancer.
resource "aws_vpc_security_group_ingress_rule" "app_livekit_udp" {
  security_group_id = aws_security_group.app.id
  description       = "LiveKit WebRTC media - calls connect but carry no media if closed"
  ip_protocol       = "udp"
  from_port         = 50000
  to_port           = 50100
  cidr_ipv4         = "0.0.0.0/0"

  tags = {
    Name        = "rxhive-app-livekit-udp"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# Optional SSH. Absent by default — see var.ssh_allowed_cidr; SSM Session
# Manager is the intended path in and needs no inbound rule.
resource "aws_vpc_security_group_ingress_rule" "app_ssh" {
  count = var.ssh_allowed_cidr == null ? 0 : 1

  security_group_id = aws_security_group.app.id
  description       = "SSH (break-glass; prefer SSM Session Manager)"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.ssh_allowed_cidr

  tags = {
    Name        = "rxhive-app-ssh"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# Egress everything: the host pulls container images, OS updates, ACME certs,
# and talks to S3/SSM over their public endpoints.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "All outbound (image pulls, OS updates, ACME, S3, SSM)"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"

  tags = {
    Name        = "rxhive-app-egress"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# ---------------------------------------------------------------------------
# Security group: database
# ---------------------------------------------------------------------------

resource "aws_security_group" "db" {
  name        = "rxhive-db"
  description = "RX HIVE RDS PostgreSQL - reachable only from the app host"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name        = "rxhive-db"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# Source is the app SG, not a CIDR: the rule keeps working if the instance is
# replaced and gets a new private IP, and it can never accidentally widen to
# the whole subnet. Combined with the private subnets and
# publicly_accessible = false on the DB, Postgres has no route from the
# internet at all.
resource "aws_vpc_security_group_ingress_rule" "db_postgres" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from the app host only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.app.id

  tags = {
    Name        = "rxhive-db-postgres"
    Project     = "rxhive"
    Environment = var.environment
  }
}

# RDS never initiates connections, but an SG with no egress rule at all still
# needs one defined for the ENI; scoped to the VPC rather than the internet.
resource "aws_vpc_security_group_egress_rule" "db_vpc_only" {
  security_group_id = aws_security_group.db.id
  description       = "Intra-VPC only; RDS has no reason to reach the internet"
  ip_protocol       = "-1"
  cidr_ipv4         = aws_vpc.main.cidr_block

  tags = {
    Name        = "rxhive-db-egress"
    Project     = "rxhive"
    Environment = var.environment
  }
}
