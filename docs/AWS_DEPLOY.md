# RX HIVE on AWS — operator runbook

Deploys RX HIVE to **one EC2 instance + RDS PostgreSQL + one S3 bucket**. Everything
is provisioned by Terraform in `infra/terraform/`. Read this top to bottom the first
time; the steps are ordered because the DNS step must happen before the TLS step.

```
                        Route 53 / your DNS
                       chat.example.com ── A ──▶ Elastic IP
                                                    │
   ┌────────────────────────────────────────────────┴──────────────────────────┐
   │ EC2 t3.large (public subnet, Amazon Linux 2023)   docker compose          │
   │                                                                           │
   │   caddy  :80 :443  ──▶ /        web (nginx SPA)                           │
   │                    ──▶ /api     api (FastAPI + uvicorn; WS is /api/ws)    │
   │                    ──▶ /s3      S3 attachment reads, kept same-origin     │
   │                    ──▶ /livekit livekit :7880 (signal)                    │
   │                                                                           │
   │   redis (presence, pub/sub, rate limits, LiveKit node state)              │
   │   livekit  :7881/tcp  +  :50000-50100/udp  ◀── media, direct from clients │
   └───────────┬────────────────────────────────────────────┬──────────────────┘
               │ 5432 (private subnet, app SG only)         │ HTTPS
        ┌──────▼───────────────────┐              ┌─────────▼──────────────┐
        │ RDS PostgreSQL 16        │              │ S3 bucket              │
        │ db.t4g.small, 20 GB gp3  │              │ attachments, private   │
        └──────────────────────────┘              └────────────────────────┘
```

Two containers from the dev stack are **not** deployed: `postgres` (replaced by RDS)
and `minio` (replaced by S3). The production compose file is
`infra/docker-compose.prod.yml`; `infra/docker-compose.yml` remains the local-dev stack.

---

## 1. What gets created, and what it costs

| Resource | Spec | Est. $/month |
|---|---|---|
| EC2 instance | `t3.large` (2 vCPU, 8 GB), on-demand | ~$60 |
| EBS root volume | 40 GB gp3 (`compute.tf`) | ~$3.20 |
| Elastic IP | 1 public IPv4 | ~$3.60 |
| RDS PostgreSQL 16 | `db.t4g.small`, single-AZ, 20 GB gp3, 7-day backups | ~$25 |
| S3 bucket | attachments; a few GB + requests | ~$1–5 |
| VPC, subnets, IGW, route tables, security groups | 2 AZs, no NAT gateway | $0 |
| SSM Parameter Store (SecureString), IAM roles | standard tier | $0 |
| Data transfer out | chat text is tiny; **WebRTC media is not** | $2–20+ |
| **Total** | | **~$90–110/month** |

Notes:

- **Estimates only, and region-dependent.** Figures are us-east-1 on-demand list
  prices. Check the AWS pricing calculator for your region before you commit.
- There is **no NAT gateway** by design — that single resource would add ~$33/month
  plus data processing. The app instance sits in a public subnet with an Elastic IP
  (it must be internet-reachable for WebRTC anyway); RDS sits in private subnets and
  needs no outbound internet.
- All public IPv4 addresses are billed hourly since Feb 2024, hence the EIP line.
- Data transfer is the one line that can surprise you: every video call minute that
  the SFU relays leaves the box as egress. Ten concurrent 1:1 video calls, 8 hours a
  day, is roughly 100–200 GB/month (~$9–18).

Everything is tagged `Project=rxhive` and `Environment=<var.environment>`, so a cost
allocation tag report will break the bill out cleanly.

---

## 2. Prerequisites

Have all of these ready **before** you run Terraform.

1. **AWS account + credentials.** An IAM principal that can create VPC, EC2, RDS, S3,
   IAM and SSM resources. Verify: `aws sts get-caller-identity`.
2. **AWS CLI v2**, configured with a default region:
   `aws configure` (or `export AWS_REGION=us-east-1`).
3. **Session Manager plugin** — this is how you get a shell on the box, because SSH
   is closed. Install it now, not during an incident:
   <https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html>
   Verify: `session-manager-plugin --version`.
4. **Terraform >= 1.5.** Verify: `terraform version`.
5. **A registered domain you can add an A record to.** A subdomain is fine
   (`chat.example.com`). You need DNS control — not just a domain someone else
   manages — because certificate issuance depends on it.
6. **A git remote the instance can clone.** This is a real decision, make it now:

| Option | How it works | When to pick it |
|---|---|---|
| **Public repo** (GitHub/GitLab) | `user_data` runs `git clone https://…` with no auth. Simplest. | Only if you are certain the repo contains no secrets. This repo's `.gitignore` excludes `.env` and `*.pem`, but audit your own history before making anything public. |
| **Private repo + deploy key** | Generate an SSH key, add the public half as a read-only deploy key on the repo, put the private half in SSM SecureString; the bootstrap fetches it, writes `~/.ssh/id_ed25519` and clones over SSH. | Default recommendation. One extra secret to manage, zero exposure. |
| **AWS CodeCommit** | Mirror the repo into CodeCommit; the instance clones with `git-remote-codecommit` using its instance role — no key material at all. | Best if you want zero long-lived git credentials. Note CodeCommit is closed to new AWS accounts, so this may not be available to you. |

> **Only the first option works as shipped.** `user_data.sh.tftpl` runs a bare
> `git clone --depth 1 --branch <branch> <repo_url>` with no credential handling at all
> — no key fetch, no `git-remote-codecommit` install. Choosing either private option
> means adding those steps to that template (and, for the deploy key, an SSM parameter
> and an `ssm:GetParameter` grant for it) before the first apply. Terraform will succeed
> either way; the instance will simply fail at the clone and never bring the stack up.

   The repo currently has **no git remote configured** (`git remote -v` is empty).
   Push it somewhere and record the clone URL before continuing.

7. **Decisions to write into `terraform.tfvars`:** the AWS region, the domain name and
   the git clone URL. That is the whole required set — see §3.1. There is no ACME
   contact variable (`Caddyfile.prod` declares no `email`, so Caddy registers an
   anonymous ACME account and Let's Encrypt sends no expiry notices), and no
   superadmin-email variable either — the seed address defaults to
   `admin@rhythmrx.ai` and is overridden through SSM, not tfvars (§4).

---

## 3. Deploy

### 3.1 Configure

```bash
cd /path/to/rxhive/infra/terraform
cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars
```

The example file marks exactly **three** variables as required, and those are the
only ones you must set:

```hcl
region      = "us-east-1"
domain_name = "chat.example.com"
repo_url    = "https://github.com/yourorg/rxhive.git"
```

Strictly, `domain_name` is the only variable in `variables.tf` with no default at
all — `terraform apply` prompts for it and nothing else. `region` and `repo_url` do
have defaults (`us-east-1` and `https://github.com/rhythmrx/rxhive.git`), but both
defaults are almost certainly wrong for you, which is why the example treats them as
required. Everything else is commented out in the example and optional:
`environment` (default `prod`; it gates RDS deletion protection and namespaces the
SSM path), `branch` (`main`), `instance_type` (`t3.large`), `db_instance_class`
(`db.t4g.small`), `db_allocated_storage` (`20`) and `ssh_allowed_cidr` (default
`null` = port 22 closed entirely; see §8).

> `alert_email` is also declared in `variables.tf`, but it is **wired to nothing** —
> this stack creates no CloudWatch alarms. Setting it has no effect.

Do **not** put secrets in this file. Terraform generates the JWT signing key, the
LiveKit API key and secret, the database password and the initial superadmin
password with `random_password`/`random_string`, and stores them as SSM SecureString
parameters under `/rxhive/<environment>/`. The instance reads them at boot with its
instance role and renders `/opt/rxhive/infra/.env` (root-owned, mode 0600).

> **Terraform state contains those generated secrets in cleartext.** Use an encrypted
> S3 backend with a DynamoDB lock table, or at minimum keep `terraform.tfstate` out of
> git and off shared drives. It is as sensitive as the `.env` file itself.

### 3.2 Allocate the IP first, so DNS can propagate while the rest builds

This ordering exists for one reason: **Caddy requests a Let's Encrypt certificate the
first time it starts, and that request fails if your domain does not already resolve
to this instance.** Getting the A record in early removes the race entirely.

```bash
terraform init
terraform plan          # read it; expect ~35-45 resources, 0 to destroy
terraform apply -target=aws_eip.app
terraform output -raw public_ip
```

### 3.3 Create the DNS A record now

In your DNS provider, create:

```
chat.example.com.   A   300   <public_ip from the previous step>
```

Wait until it actually resolves, from a resolver that is not your local cache:

```bash
dig +short chat.example.com @1.1.1.1
dig +short chat.example.com @8.8.8.8
# both must print the Elastic IP before you continue
```

A 300-second TTL keeps a mistake cheap to fix. If the name has never existed before,
propagation is usually under a minute; if you are re-pointing an existing record with
a long TTL, you may wait as long as the old TTL.

### 3.4 Apply the rest

```bash
terraform apply
```

Takes roughly 10–15 minutes, dominated by RDS provisioning (~8 min). When it finishes:

```bash
terraform output
```

The outputs you will use:

| Output | Used for |
|---|---|
| `app_url` | `https://chat.example.com` — the only URL users need |
| `health_check_url` | `https://chat.example.com/api/health` |
| `public_ip` | the Elastic IP (the A record target) |
| `dns_record_required` / `dns_record_instructions` | the A record to create, as an object and as a sentence |
| `instance_id` | `aws ssm start-session --target <this>` |
| `connect_command` | ready-made `ssm` (and, if enabled, `ssh`) connect strings |
| `db_endpoint` | RDS `host:port`, for manual psql/snapshot work |
| `s3_bucket` | attachment bucket name |
| `web_push_setup` | a manual-step reminder: Web Push stays off until you store VAPID keys — see §10 |

There is **no** output for the SSM path. It is always `/rxhive/<environment>` —
`/rxhive/prod` with the default `environment` — hardcoded in `compute.tf` as the
`ssm_prefix` template variable and in each parameter name in `secrets.tf`. Use that
literal path wherever this runbook reads a parameter.

### 3.5 Watch the first boot

The instance clones the repo, renders `infra/.env` from SSM, and runs
`docker compose --env-file infra/.env -f infra/docker-compose.prod.yml up -d --build
--remove-orphans`. The image build takes 5–10 minutes on a t3.large; the API is not
reachable before it completes.

```bash
aws ssm start-session --target $(terraform output -raw instance_id)

# on the instance:
sudo tail -f /var/log/rxhive-bootstrap.log         # the bootstrap's own log (mode 0600)
sudo tail -f /var/log/cloud-init-output.log        # same output via cloud-init
cd /opt/rxhive
sudo docker compose -f infra/docker-compose.prod.yml ps       # all services Up
sudo docker compose -f infra/docker-compose.prod.yml logs -f caddy
```

You are waiting for a Caddy log line containing `certificate obtained successfully`.
The API logs should show Alembic migrations applying (`Running upgrade -> 09c892c227fc`,
then `09c892c227fc -> bdbf829f823f`, which is head today) and then
`[seed] superadmin created: …`.

The bootstrap also installs a `rxhive.service` systemd unit that brings the same
compose stack up on boot, and it finishes by polling the `api` container's health for
up to five minutes and logging `api health: healthy`.

### 3.6 If the certificate does not issue

Caddy retries on its own with a growing backoff, so a transient failure heals itself —
but fix the cause first, then force a retry. Work through this in order:

1. **Does the name resolve to this box?**
   `dig +short chat.example.com @1.1.1.1` must equal `terraform output -raw public_ip`.
   Wrong or empty is the cause about 80% of the time.
2. **Is port 80 reachable from the internet?** Let's Encrypt validates over HTTP-01 on
   port 80 — HTTPS alone is not enough, and the challenge comes from Let's Encrypt's
   servers, not from you.
   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' http://chat.example.com/
   ```
   A hang or refusal means the security group, or a corporate egress filter, is in the
   way. Confirm the SG:
   ```bash
   aws ec2 describe-security-groups --group-ids <app_sg_id> \
     --query 'SecurityGroups[0].IpPermissions[?FromPort==`80`]'
   ```
3. **Read the actual ACME error** — it names the problem:
   ```bash
   sudo docker compose -f infra/docker-compose.prod.yml logs caddy | grep -iE 'acme|challenge|error'
   ```
4. **Force a retry** once the cause is fixed:
   ```bash
   sudo docker compose -f infra/docker-compose.prod.yml restart caddy
   ```

**Do not restart in a loop.** Let's Encrypt rate-limits to 5 failed validations per
hostname per hour, and 50 certificates per registered domain per week. Burn through
those and you are locked out for an hour (or a week) regardless of what you fix. If you
need to iterate, point Caddy at the LE staging CA first: `infra/Caddyfile.prod` has no
global options block, so add one as the **very first** thing in the file, above the
`{$SITE_ADDRESS}` line —

```caddyfile
{
	acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
}
```

— then `restart caddy`, get a successful staging issuance (the browser will warn about
the untrusted staging root, which is expected), remove the block and restart again.

---

## 4. First login

The superadmin is seeded on the API's first boot (`python -m app.seed`, run from the
`api` container's start command) from `RXHIVE_SEED_SUPERADMIN_EMAIL` /
`RXHIVE_SEED_SUPERADMIN_PASSWORD`.

- **Email:** `admin@rhythmrx.ai`, unless you created the *optional* SSM parameter
  `/rxhive/prod/superadmin_email` before the first boot. There is no tfvars variable
  for this: `secrets.tf` never creates that parameter, and the bootstrap reads it as
  optional and falls back to the built-in default when it is absent.
- **Password:** generated by Terraform as `random_password.superadmin` and stored as
  the SSM SecureString **`/rxhive/<environment>/superadmin_password`** — note the
  leaf name is `superadmin_password`, not `seed_superadmin_password`, and that there
  is no `ssm_parameter_prefix` output to interpolate. Read it with the literal path:

```bash
aws ssm get-parameter \
  --name "/rxhive/prod/superadmin_password" \
  --with-decryption --query 'Parameter.Value' --output text
```

(Substitute your `environment` if you changed it from the `prod` default. Without
`--with-decryption` the call succeeds but returns the ciphertext, not the password.)

Sign in at `https://chat.example.com` and **change the password in-app immediately**
(profile menu → Settings → Change Password, which calls `POST /api/auth/change-password`
and revokes every other session), then create your organizations, departments and
users from the admin portal.

Two things worth knowing about the seed:

- It is **idempotent and non-destructive**: `seed()` looks the email up
  case-insensitively and returns early if a user already has it, so it creates the
  superadmin only once and never rewrites an existing password. Rotating in-app is
  therefore permanent — a redeploy will not reset it back to the SSM value. (If both
  env vars are empty the seed logs `superadmin credentials not set — skipping` and
  does nothing.)
- The SSM parameter is therefore only a *bootstrap* credential. After you have rotated
  it in-app, the parameter value is stale; treat it as such. `secrets.tf` deliberately
  sets `lifecycle { ignore_changes = [value] }` on it so no later `terraform apply`
  churns it — which also means Terraform will never "re-generate" a lost password for
  you. Recovering from that means updating the hash in the database by hand.

---

## 5. Verification checklist

Run all six. Each one exercises a dependency the others do not.

**1. Health endpoint — Postgres, Redis and the SFU in one request**

```bash
curl -sS https://chat.example.com/api/health | jq
```

Expected:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "service": "RxHive API",
  "timestamp": "2026-07-25T14:30:00Z",
  "database": "connected",
  "redis": "connected",
  "livekit": "connected",
  "calls_available": true
}
```

`"livekit"` deliberately never affects the `healthy`/`unhealthy` verdict — messaging
works without the SFU, only calls break. So `"status":"healthy"` with
`"calls_available": false` is a real failure state that returns HTTP 200. Check the
field, not just the status code.

**2. TLS and the redirect**

```bash
curl -sSI https://chat.example.com/ | head -1          # HTTP/2 200
curl -sSI http://chat.example.com/  | head -2          # 308 → https://
openssl s_client -connect chat.example.com:443 -servername chat.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates                  # issuer = Let's Encrypt, not self-signed
```

**3. Log in and send a message.** Open the app in two browsers (or one normal + one
private window), sign in as two different users, and send a message between them. It
must appear on the other side **without a refresh** — that proves the WebSocket
(`wss://chat.example.com/api/ws`, served by Caddy's `handle /api/*` route) and Redis
pub/sub are both working. If it only appears after a reload, the WebSocket is not
connecting.

**4. Upload an image attachment.** Send an image and confirm the thumbnail renders
inline and full-size opens. This is the only check that exercises S3 end to end
(upload → presign → browser fetch). If the bubble is broken/blank, open the browser
console — see the S3/CSP row in §9.

**5. Place a 1:1 video call between the two browsers.** Confirm you see and hear the
other side **in both directions**, then hang up from both ends.

> **A call that connects but carries no audio or video is almost always a blocked UDP
> range.** Signalling runs over the same TLS connection as the app, so the call UI will
> happily show "connected" while media never flows. Verify:
> ```bash
> aws ec2 describe-security-groups --group-ids <app_sg_id> \
>   --query 'SecurityGroups[0].IpPermissions[?ToPort==`50100`]'
> # expect udp 50000-50100 from 0.0.0.0/0
> ```
> and, on the instance, that LiveKit picked up the *public* address rather than the
> VPC-private one:
> ```bash
> sudo docker compose -f infra/docker-compose.prod.yml logs livekit | grep -i 'external\|node ip'
> # must print the Elastic IP
> ```
> If it prints `10.x.x.x`, `rtc.use_external_ip` is not taking effect and every ICE
> candidate you hand out is unroutable.

**6. Restart resilience.** `sudo reboot` the instance, wait ~3 minutes, and re-run
check 1. Two mechanisms should bring it back: every service is `restart: unless-stopped`
and Docker is enabled at boot, and the bootstrap also installed `rxhive.service`
(`systemctl is-enabled rxhive` → `enabled`), which reconciles the stack after
`docker.service`. If it does not come back by itself, fix that now rather than
discovering it during an outage.

---

## 6. Operations

### Get a shell

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
sudo -i && cd /opt/rxhive
```

There is no SSH unless you set `ssh_allowed_cidr`. If Session Manager cannot connect,
the instance has lost outbound access to the SSM endpoints or the SSM agent is down —
check the instance status checks in the console first.

Every compose command below runs from `/opt/rxhive`. The canonical invocation passes
the generated env file explicitly, exactly as the bootstrap and the `rxhive.service`
unit do — the compose file uses `${VAR:?...}` guards throughout, and which directory
compose searches for a default `.env` has changed between releases, so an implicit
lookup can fail every guard at once:

```bash
docker compose --env-file infra/.env -f infra/docker-compose.prod.yml <subcommand>
```

### Deploy a new version

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
sudo -i
cd /opt/rxhive
git pull
docker compose --env-file infra/.env -f infra/docker-compose.prod.yml up -d --build
```

- Alembic migrations run automatically as part of the `api` container's start command,
  before uvicorn binds. A failed migration means the API container exits — check its
  logs before assuming the app is fine.
- This is a **single box with no blue/green**: expect 30–90 seconds of 502s while the
  API container is replaced, plus build time before that. Deploy off-peak.
- Review `backend/alembic/versions/` before a major upgrade.
- Roll back by checking out the previous commit and re-running the same `up -d --build`.
  Note that migrations are not auto-reverted; a rollback across a migration needs
  `alembic downgrade` run deliberately.
- The bootstrap clones with `--depth 1`, so `/opt/rxhive` is a shallow single-branch
  checkout. `git pull` works, but there is no history to roll back *to* — fetch it first
  (`git fetch --unshallow`) if you may need to check out an older commit.

### Read logs

```bash
cd /opt/rxhive
docker compose -f infra/docker-compose.prod.yml logs -f api      # app + access logs (JSON)
docker compose -f infra/docker-compose.prod.yml logs -f caddy    # TLS, ACME, proxy errors
docker compose -f infra/docker-compose.prod.yml logs -f livekit  # SFU, ICE, room events
docker compose -f infra/docker-compose.prod.yml logs --since 15m api | grep '"status":5'
sudo tail -100 /var/log/rxhive-bootstrap.log                     # first-boot provisioning
```

Every API response carries an `X-Request-ID`; access logs are structured JSON with the
same id, so a user-reported error can be traced from a browser network tab to a log
line. `GET /api/metrics` exposes request counters, average latencies and live socket
count if you want a quick dashboard — it requires a super-admin session, so scrape it
with super-admin credentials, not anonymously.

### Restart

```bash
docker compose -f infra/docker-compose.prod.yml restart api      # one service
docker compose -f infra/docker-compose.prod.yml up -d            # reconcile everything
docker compose -f infra/docker-compose.prod.yml down && \
docker compose -f infra/docker-compose.prod.yml up -d            # full cycle
```

`sudo systemctl restart rxhive` does the same reconcile through the unit the bootstrap
installed (`up -d --remove-orphans`, no rebuild).

**`restart` does not re-read `.env`** — it restarts the process inside the existing
container, which keeps the environment it was created with. After any change to
`infra/.env` you need `up -d --force-recreate <service>`.

Restarting `redis` is safe: it holds presence, pub/sub, rate-limit windows and LiveKit
node state — all reconstructible, and persistence is off (`--save "" --appendonly no`),
so there is nothing on disk to lose. Users flicker offline for a moment. Restarting
`livekit` drops every call in progress.

### Take a manual RDS snapshot (do this before every schema-changing deploy)

```bash
aws rds create-db-snapshot \
  --db-instance-identifier rxhive-prod \
  --db-snapshot-identifier rxhive-prod-manual-$(date +%Y%m%d-%H%M)

aws rds wait db-snapshot-available \
  --db-snapshot-identifier rxhive-prod-manual-<same-suffix>
```

Manual snapshots are kept until you delete them and are billed as storage.

### How backups and PITR work

- **Automated backups**: a daily snapshot plus continuous transaction logs, retained
  **7 days** (`backup_retention_period = 7`), taken during the configured backup window.
  Snapshots are storage-only-billed above the size of the instance's data.
- **Point-in-time recovery**: anywhere within the retention window, to ~5-minute
  granularity. Restore always creates a **new** instance — it never overwrites the
  existing one:
  ```bash
  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier rxhive-prod \
    --target-db-instance-identifier rxhive-prod-restore \
    --restore-time 2026-07-25T14:30:00Z \
    --db-subnet-group-name <same subnet group> \
    --vpc-security-group-ids <db sg id>
  ```
  Then point `RXHIVE_DATABASE_URL` at the new endpoint, verify, and retire the old
  instance. **There is no SSM parameter for the DSN** — the bootstrap assembles it from
  the Terraform-supplied endpoint plus the `db_password` parameter and writes it into
  `/opt/rxhive/infra/.env`. Edit the `RXHIVE_DATABASE_URL` line in that file directly
  (and `POSTGRES_HOST` alongside it) and `up -d --force-recreate api`; note the next
  bootstrap re-run regenerates the file from the Terraform values, so make the change
  permanent in Terraform once the restore is confirmed.
- **Automated backups are deleted when the instance is deleted** unless you take a
  final snapshot. `deletion_protection` is already on whenever `environment = "prod"`,
  and `skip_final_snapshot = false` unconditionally — leave both.
- **S3**: attachments live only in S3. Bucket **versioning is already enabled** by
  `data.tf`, so an accidental delete is recoverable; the only lifecycle rule configured
  is one that aborts incomplete multipart uploads after 7 days, so add your own rule if
  you want noncurrent versions expired. Add cross-region replication only if your RPO
  demands it.
- **Redis**: ephemeral by design. No backup needed, ever.
- **Test a restore before you need one.** A backup you have never restored is a hope.

### Rotate a secret

There is **no rotation script**. `infra/.env` is written in exactly one place —
`terraform/user_data.sh.tftpl`, whose rendered copy cloud-init leaves on the box at
`/var/lib/cloud/instance/user-data.txt`. Rotation is therefore: write the new value to
SSM, then get that file rewritten and the affected containers recreated so they pick up
the new environment.

The parameter leaf names are fixed by `secrets.tf` — `db_password`, `secret_key`,
`livekit_api_key`, `livekit_api_secret`, `superadmin_password` — plus the three optional
ones the bootstrap also reads: `superadmin_email`, `vapid_public_key`,
`vapid_private_key`.

**1. Put the new value in SSM.**

```bash
aws ssm put-parameter --name "/rxhive/prod/secret_key" --type SecureString \
  --value "$(openssl rand -hex 32)" --overwrite
```

**2. Re-render `.env` and reconcile the stack**, on the instance:

```bash
aws ssm start-session --target $(terraform output -raw instance_id)
sudo -i

# Re-runs the whole bootstrap: it is idempotent by design — it re-reads every
# parameter, rewrites /opt/rxhive/infra/.env and reconciles compose.
bash /var/lib/cloud/instance/user-data.txt

# The step above already ran `up -d`, which recreates a container whose resolved
# config changed. --force-recreate makes that unconditional. Either way a plain
# `restart` is NOT enough: it reuses the container's existing environment.
cd /opt/rxhive
docker compose --env-file infra/.env -f infra/docker-compose.prod.yml up -d \
  --force-recreate api
```

Be aware of what step 2 also does: it runs `git fetch`/`git reset --hard` onto
`var.branch` and `up -d --build --remove-orphans`, so it deploys whatever is at the head
of that branch. If you do not want that, edit the single line in `/opt/rxhive/infra/.env`
by hand instead and then force-recreate:

```bash
sudo -i
# The bootstrap wrote AWS_REGION into the same file; the CLI on the box has no
# default region configured, so pass it explicitly.
REGION=$(grep '^AWS_REGION=' /opt/rxhive/infra/.env | cut -d= -f2)
NEW=$(aws ssm get-parameter --name "/rxhive/prod/secret_key" --with-decryption \
        --region "$REGION" --query 'Parameter.Value' --output text)
sed -i "s|^RXHIVE_SECRET_KEY=.*|RXHIVE_SECRET_KEY=$NEW|" /opt/rxhive/infra/.env
cd /opt/rxhive && docker compose --env-file infra/.env \
  -f infra/docker-compose.prod.yml up -d --force-recreate api
```

Per-secret notes:

- **`secret_key`** → `RXHIVE_SECRET_KEY`. Invalidates every issued JWT; all users are
  logged out. Only `api` needs recreating.
- **`livekit_api_secret`** (and `livekit_api_key`) → recreate `api` **and** `livekit`
  together, or token signing and verification disagree and every call fails. Both read
  the same `.env`.
- **`db_password`** is the RDS *master* password and Terraform owns it. Changing the SSM
  parameter alone does nothing — the database still expects the old one, and the next
  `terraform apply` will push `random_password.db_master` back. Rotate it through
  Terraform (or `aws rds modify-db-instance --master-user-password`, then update the
  parameter to match), and re-render `.env` afterwards.
- **`superadmin_password`** is bootstrap-only. Once the account exists the seed never
  touches it again, so rotating this parameter changes nothing — change the password
  in-app instead.

---

## 7. Scaling

**This is a single box.** One instance runs the web tier, the API, Redis and the SFU.
It is the right shape for launch and for a few hundred users, and it has exactly one
of everything — including one point of failure. Grow in this order; each step is
strictly more work than the one before it, so do not skip ahead.

**Step 0 — know what saturates first.** Watch CPU (`docker stats`), the live socket
count from `/api/metrics`, and RDS `CPUUtilization` / `DatabaseConnections` in
CloudWatch. In practice the SFU's CPU and the box's egress bandwidth run out well
before Postgres does. Messaging is cheap; media is not.

**Step 1 — go bigger.** Change `instance_type` to `t3.xlarge` (or `c6i.xlarge` if
calls are the bottleneck — media relaying is CPU-bound, not memory-bound) and
`terraform apply`. Terraform stops, resizes and starts the instance; the Elastic IP
survives because it is attached to a standalone ENI, not to the instance, and all data
survives with it. Raise `API_WORKERS` at the same time (rule of thumb: 2× vCPU) — it is
written as a literal `API_WORKERS=2` by `user_data.sh.tftpl`, so change it there for new
hosts, or edit `infra/.env` and force-recreate `api` on this one. Downtime is a couple
of minutes. This buys a lot and costs an afternoon.

**Step 2 — split state out, then run more than one API.** The API is already
**stateless**: every piece of shared state lives in Postgres (durable data), Redis
(presence, pub/sub fan-out, rate-limit windows) or S3 (attachments). Nothing is held on
the instance's disk, and realtime delivery, presence and rate limiting are verified to
work identically across multiple workers and processes. So:
   1. Move Redis to **ElastiCache** (single node is fine to start) and point
      `RXHIVE_REDIS_URL` at it — note it is pinned to `redis://redis:6379/0` in
      `docker-compose.prod.yml`, so that line has to change too, not just `.env`.
      LiveKit uses the same Redis — update the `redis.address` key in
      `infra/livekit.prod.yaml`.
   2. Put an **ALB** in front, with a target group on the instances' port 80 and a
      health check on `/api/health`. Terminate TLS at the ALB with an ACM certificate;
      Caddy then serves plain HTTP behind it (`SITE_ADDRESS=:80`) and stops doing ACME.
      Keep `RXHIVE_TRUST_PROXY=true` — the real client IP now arrives via the ALB's
      `X-Forwarded-For`.
   3. Run the api/web/caddy containers on 2+ instances in an autoscaling group across
      two AZs. Sticky sessions are **not** required, including for WebSockets.

**Step 3 — LiveKit onto its own instance.** Media is the noisy neighbour: it burns CPU
and bandwidth in bursts and will starve the API on a shared box. Give it a dedicated
instance with its own Elastic IP and the same UDP/TCP ports open, then repoint the two
LiveKit URLs. The browser-facing one is set in `.env` as **`RXHIVE_LIVEKIT_PUBLIC_URL`**
(compose maps it onto the container's `RXHIVE_LIVEKIT_URL`), so put
`wss://livekit.example.com` there; `RXHIVE_LIVEKIT_HEALTH_URL` — the server-side address
the `/api/health` probe GETs — is hardcoded to `http://livekit:7880` in
`docker-compose.prod.yml` and has to be edited there. For multi-node LiveKit, every node
must share one Redis — which you already did in step 2.

**Step 4 — the database.** Scale up first (`db.t4g.medium`, then `large`). Chat is
write-heavy, so read replicas help less than you would hope; spend on **Multi-AZ**
instead, which buys automatic failover rather than throughput. Consider connection
pooling (RDS Proxy or pgbouncer) only once you are running many API processes — each
uvicorn worker keeps its own SQLAlchemy pool, and the connection count multiplies fast.

---

## 8. Security notes

- **No SSH by default.** No key pair is attached, and the port-22 ingress rule is
  created only when `var.ssh_allowed_cidr` is non-null — which it is not unless you set
  it, so out of the box port 22 is closed. Administrative access is **SSM Session
  Manager**, via the instance's IAM role (`AmazonSSMManagedInstanceCore`) — access is
  granted and revoked with IAM, every session is logged in CloudTrail, and there is no
  key material to leak or rotate. Setting `ssh_allowed_cidr` opens the port to that CIDR
  as a break-glass path; it still gets you no key pair, so you would have to add one.
- **Minimal ingress.** The app security group allows only: `80/tcp` and `443/tcp`
  (web + ACME), `7881/tcp` (WebRTC TCP fallback for clients behind restrictive
  firewalls) and `50000-50100/udp` (WebRTC media). LiveKit's signal port `7880` is
  **not** exposed — it is reached only through Caddy's `/livekit` route, on the same
  origin and the same TLS certificate as the app.
- **The database is not on the internet.** RDS lives in private subnets with
  `publicly_accessible = false`, and its security group accepts `5432` **only from the
  app security group** — not from a CIDR block. Storage is encrypted at rest. To run
  psql against it, open a session on the app instance and connect from there.
- **The S3 bucket blocks all public access** (all four block-public-access flags on),
  has no bucket policy granting anonymous reads, is encrypted server-side (AES256) and
  has versioning enabled. Attachments are never served directly: a request goes to
  `/api/media/<id>`, which checks that the caller is a member of the conversation, and
  only then redirects to a **presigned URL valid for 300 seconds**. That URL is
  rewritten to the same-origin `/s3` path before it reaches the browser, so the bucket
  host is not even exposed. A leaked URL expires in five minutes; a leaked object key on
  its own is useless.
- **Secrets live in SSM Parameter Store as SecureString**, encrypted with KMS and
  readable only by the instance role. They are rendered into
  `/opt/rxhive/infra/.env` (root-owned, mode 0600) at boot. **No secret is ever
  committed to git** — `.env` and `*.pem` are gitignored at the repo root, and
  `infra/terraform/.gitignore` excludes `*.tfstate*` and `*.tfvars` (whitelisting only
  `terraform.tfvars.example`). `terraform.tfvars` contains no secret values anyway. The
  one thing that *does* contain secrets is the Terraform state file: keep it in an
  encrypted S3 backend.
- **The API refuses to boot with a weak configuration.** In production it validates
  `RXHIVE_SECRET_KEY` and `RXHIVE_LIVEKIT_API_SECRET` against a list of known
  placeholder values and a 32-character minimum, and raises at startup if either fails.
  `RXHIVE_S3_SECRET_KEY` joins that list **only when static S3 credentials are actually
  configured** (either of the S3 key vars non-empty) — leaving both empty is the
  instance-role path this deployment uses, and the validator skips them. This is
  deliberate: it makes "we shipped the demo signing key" impossible rather than merely
  unlikely.
- **Auth is same-origin cookies, not bearer tokens.** Sessions are httpOnly + Secure +
  `SameSite=Lax` cookies (`RXHIVE_COOKIE_SECURE=true`), and every mutating request must carry
  an `X-Requested-With` header, which a cross-site form cannot set. Because everything
  is served from one origin, **`RXHIVE_CORS_ORIGINS` stays empty** — no cross-origin
  request is permitted at all. Do not add an origin there "to make something work";
  that reopens the hole the design closes.
- **Interactive API docs are disabled in production** (`/docs`, `/redoc`,
  `/openapi.json` all return 404) so the schema is not an enumeration surface.
- **S3 credentials: there are none.** No IAM user and no access key exists anywhere in
  this stack. `docker-compose.prod.yml` pins `RXHIVE_S3_ACCESS_KEY` and
  `RXHIVE_S3_SECRET_KEY` to the empty string, which is the exact condition
  `backend/app/services/storage.py` tests: with both empty it builds the client with
  minio's `IamAwsProvider`, pulling short-lived credentials from the EC2 instance
  metadata service. (They are pinned rather than omitted because the code defaults are
  the dev `rxhive`/`rxhive-dev` pair, which would 403 against real S3.) The instance
  role is bucket-scoped: `GetObject`/`PutObject`/`DeleteObject` on `arn:…:<bucket>/*`
  plus `ListBucket` on the bucket — `ListBucket` is there because `ensure_bucket()`
  issues a `HeadBucket` at start-up. Credentials rotate automatically and are useless
  off the box. This is also why `http_put_response_hop_limit = 2` on the instance: a
  container is one extra hop from `169.254.169.254`. IMDSv2 is required
  (`http_tokens = "required"`), so an SSRF in the app cannot fetch them with a plain GET.
- **Keep the instance patched:** `sudo dnf upgrade --refresh && sudo reboot` on a
  schedule, or enable SSM Patch Manager.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **Certificate not issued** — browser warns "not secure", Caddy logs ACME errors | The domain did not resolve to the Elastic IP when Caddy first started, or port 80 is unreachable from Let's Encrypt | `dig +short <domain> @1.1.1.1` must equal `terraform output -raw public_ip`; `curl -I http://<domain>/` from outside must respond; confirm the SG allows `80/tcp` from `0.0.0.0/0`; then `docker compose -f infra/docker-compose.prod.yml restart caddy`. Mind the LE rate limit — 5 failed validations per hostname per hour. Use the staging CA to iterate. |
| **Calls connect but there is no audio or video** (black tiles, silence, one side or both) | UDP `50000-50100` blocked, or LiveKit advertising a private IP | Check the SG has `udp 50000-50100` from `0.0.0.0/0`; check `docker compose -f infra/docker-compose.prod.yml logs livekit \| grep -i external` prints the **Elastic IP**, not `10.x.x.x` — `rtc.use_external_ip: true` in `infra/livekit.prod.yaml` (the production SFU config; `infra/livekit.yaml` is the dev one and is not mounted here) is what makes ICE candidates routable from behind NAT. Also confirm `7881/tcp` is open for clients on UDP-hostile networks. A corporate firewall on the *client* side blocking UDP produces the same symptom for that user only. |
| **Call fails immediately; `/api/health` shows `"livekit":"unreachable"`, `calls_available:false`** | SFU container down, or `RXHIVE_LIVEKIT_HEALTH_URL` wrong | `docker compose -f infra/docker-compose.prod.yml ps livekit`; restart it. The health URL must be the *server-side* address `http://livekit:7880` — the browser-facing `/livekit` path is not resolvable from inside the API process. |
| **Everyone can call but tokens are rejected** | `LIVEKIT_API_KEY`/`_SECRET` differ between the `api` and `livekit` containers | They come from the same `.env`; if you rotated one, **recreate** both services together (`up -d --force-recreate api livekit`) — a plain `restart` reuses the old environment. |
| **502 from Caddy** | The upstream container is down or still starting — most often `api` exited because a migration failed or config validation raised | `docker compose -f infra/docker-compose.prod.yml ps` (look for `Exited`), then `… logs api --tail 100`. During a `--build` deploy a 502 for 30–90s is expected. |
| **DB connection refused / timeout**; health shows `"database":"disconnected"` | RDS not reachable from the instance, or the URL is wrong | From the instance (the host is in `.env` as `POSTGRES_HOST`, and `terraform output -raw db_endpoint` gives the same value as `host:port` from your workstation): `sudo nc -zv "$(grep '^POSTGRES_HOST=' /opt/rxhive/infra/.env \| cut -d= -f2)" 5432`. If it hangs, the DB security group is not allowing the app SG on 5432. Check `RXHIVE_DATABASE_URL` uses the `postgresql+asyncpg://` scheme and the RDS endpoint hostname (not `postgres`, the dev container name). If the error mentions SSL or "no encryption", append `?ssl=require` — RDS PostgreSQL 15+ sets `rds.force_ssl=1` by default. |
| **`permission denied to create extension "citext"`** on first migration | Connecting as a non-master database role | The first migration runs `CREATE EXTENSION IF NOT EXISTS citext`, which needs `rds_superuser`. Connect as the RDS **master user** created by Terraform. Do not swap in a limited app role until after the extension exists. |
| **API refuses to boot** — logs show `RXHIVE_SECRET_KEY is a known placeholder` or `must be at least 32 characters` | A placeholder or short secret reached production | Intentional guard. Set a real value: `openssl rand -hex 32`, write it to the SSM parameter, re-render `.env` and recreate `api` (see "Rotate a secret" in §6). Applies to `RXHIVE_SECRET_KEY` and `RXHIVE_LIVEKIT_API_SECRET` always, and to `RXHIVE_S3_SECRET_KEY` only if either S3 key var is non-empty — an **empty** value counts as a placeholder, which is why the two S3 keys must be left empty together for the instance-role path. |
| **Password/URL parse errors on boot** | A DB password containing characters that are special in a URL (`@`, `/`, `#`, `:`) | Should not occur as shipped: `random_password.db_master` restricts `override_special` to the URL-unreserved set `-_.~`, and the bootstrap percent-encodes both the user and the password with `urllib.parse.quote` before assembling the DSN. If you set the password by hand, keep both properties — and do the encoding in `user_data.sh.tftpl`, which is the single place the DSN is built. |
| **Images/attachments do not load** — broken thumbnails; console shows `Refused to load the image … Content Security Policy` | `frontend/nginx.conf` sets `img-src 'self' data: blob:`, and CSP is enforced against *redirect targets*: `/api/media/<id>` answers 307 to a presigned URL, so a cross-origin target is blocked. | This is already solved in the shipped config and should not need changing — confirm it is intact rather than inventing a new scheme. `docker-compose.prod.yml` sets `RXHIVE_S3_PUBLIC_ENDPOINT=/s3`, `storage.rewrite_to_public()` swaps the signed URL's host for that path so the redirect stays same-origin, and `Caddyfile.prod`'s `handle_path /s3/*` proxies to `{$S3_BUCKET_HOST}` with `header_up Host {$S3_BUCKET_HOST}` — that header is load-bearing, since SigV4 signs `Host` and forwarding your own domain yields `SignatureDoesNotMatch`. Check what a presigned URL actually looks like (from `/opt/rxhive`): `docker compose -f infra/docker-compose.prod.yml exec api python -c "import asyncio; from app.services.storage import presign_get; print(asyncio.run(presign_get('probe.jpg')))"` — it must start with `/s3/` (the key need not exist; presigning never touches the object). If it starts with `https://<bucket>.s3.…`, `RXHIVE_S3_PUBLIC_ENDPOINT` is empty or overridden. (`rewrite_to_public` parses the URL rather than string-replacing a prefix, precisely so virtual-hosted-style AWS URLs are rewritten correctly.) |
| **Attachment *download* fails** (thumbnail renders, download button does not) | A download that goes cross-origin needs S3 CORS on top of CSP | Not expected with the shipped `/s3` same-origin proxy — chase the CSP row above first. `data.tf` already creates a bucket CORS rule (`GET`/`HEAD` from `https://<domain_name>`, all headers, `ETag`/`Content-Length`/`Content-Type`/`Content-Disposition` exposed), so if you moved to a direct-to-S3 endpoint the rule exists; verify with `aws s3api get-bucket-cors --bucket $(terraform output -raw s3_bucket)` and that its origin matches the domain you actually serve. |
| **Upload returns 403** | The instance role is missing a permission, or the bucket name in `RXHIVE_S3_BUCKET` does not match the Terraform-created bucket | There is no static access key to check — the app uses the EC2 instance role. Compare the bucket with `terraform output -raw s3_bucket`. The inline role policy needs `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `<bucket>/*` and `s3:ListBucket` on `<bucket>`. A 403 on *every* S3 call, including start-up's `HeadBucket`, usually means IMDS is unreachable from the container instead — check `http_put_response_hop_limit = 2` is still set on the instance. |
| **Messages only appear after a page refresh** | The WebSocket is not connecting through Caddy | The app connects to **`/api/ws`** (`frontend/src/services/websocket.js` builds `wss://<origin>/api/ws`; the endpoint is declared as `@router.websocket("/api/ws")` in `backend/app/realtime/hub.py`) — look for that path in the browser network tab, status 101. It is carried by the `handle /api/*` route in `infra/Caddyfile.prod`, not by the vestigial `handle /ws*` block, which nothing uses. Then confirm `redis` is healthy — fan-out between workers goes through Redis pub/sub. |
| **Login returns 429** | Per-IP rate limiter (10 login attempts/60s by default) | Expected under load testing or when many users share one NAT IP. Raise `RXHIVE_RATE_LIMIT_LOGIN`. Also confirm `RXHIVE_TRUST_PROXY=true` — without it every request appears to come from Caddy's IP and one user's retries throttle everyone. |
| **Logged out on every page load** | Cookies not being set | Requires HTTPS with a valid certificate, because `RXHIVE_COOKIE_SECURE=true`. Fix the certificate first — do not "solve" this by setting the flag to false. |
| **`aws ssm start-session` cannot connect** | SSM agent down, or the instance lost outbound internet | Check EC2 instance status checks and that the instance still has a public IP and a default route to the IGW. Reboot from the console as a last resort — the stack comes back on its own. |

---

## 10. Web Push (VAPID) — off until you provision it

**Nothing in Terraform creates VAPID keys, so a fresh deployment ships with Web Push
disabled** — they are EC P-256 keypairs, which `random_password` cannot produce. This is
a supported state, not a broken one. `terraform output web_push_setup` prints the same
procedure with your region and environment already substituted in; this section is the
longer version, with what "disabled" actually means.

What "off" actually means:

- `RXHIVE_VAPID_PUBLIC_KEY` / `RXHIVE_VAPID_PRIVATE_KEY` default to empty, and the
  bootstrap reads them as *optional* SSM parameters, so an absent parameter is not a
  boot failure.
- `backend/app/services/push.py` returns immediately when `vapid_private_key` is empty,
  so message sends are unaffected — push is simply never dispatched.
- `GET /api/notifications/vapid-key` returns `{"public_key": ""}`, and the browser side
  (`frontend/src/lib/pwa.js`) throws `Push is not configured on the server` when a user
  tries to enable notifications. The service worker still registers; only push is off.
- Everything else keeps working: in-app toasts, message delivery itself, and the desktop
  `Notification` popups the WebSocket handler raises for an open-but-unfocused tab. Push
  is only what reaches a user whose tab is **closed**.

To turn it on:

**1. Generate a keypair.** The generator lives in the backend image at
`backend/app/tools/vapid.py`, so run it inside the `api` container (or in the backend
virtualenv locally — it only needs `cryptography`):

```bash
cd /opt/rxhive
docker compose --env-file infra/.env -f infra/docker-compose.prod.yml \
  exec api python -m app.tools.vapid
```

It prints three lines, ready to paste:

```
RXHIVE_VAPID_PUBLIC_KEY=<base64url, uncompressed P-256 point>
RXHIVE_VAPID_PRIVATE_KEY=<base64url, 32-byte scalar>
RXHIVE_VAPID_SUBJECT=mailto:admin@rhythmrx.ai
```

**2. Store them.** Store the **values only** — strip the `RXHIVE_VAPID_…=` prefix the
tool prints, or the app will hand browsers a key that starts with `RXHIVE_` and every
subscription attempt fails. The private key is a secret; the public key is not, but keep
them together. The parameter leaf names the bootstrap looks for are fixed:

```bash
aws ssm put-parameter --name "/rxhive/prod/vapid_public_key"  --type SecureString \
  --value "<public value>"  --overwrite
aws ssm put-parameter --name "/rxhive/prod/vapid_private_key" --type SecureString \
  --value "<private value>" --overwrite
```

`RXHIVE_VAPID_SUBJECT` is **not** read from SSM and is not written into `.env`; it
falls back to the code default `mailto:admin@rhythmrx.ai`. If you want a different
contact address, add it to the compose file's `api` environment.

**3. Re-render `.env` and recreate `api`**, exactly as in "Rotate a secret" (§6). The
keys are only read at settings load, so the container must be recreated, not restarted.

**4. Verify.** As a signed-in user, `GET /api/notifications/vapid-key` must return a
non-empty `public_key`; then enable notifications in the app, close the tab, and have
someone message you.

Two caveats worth knowing before you commit to this:

- **Rotating the keypair invalidates every existing subscription.** Browsers bind a
  subscription to the application server key it was created with, so every user has to
  re-subscribe. Generate once and keep it.
- The server POSTs to the push endpoint the browser supplies. `validate_push_endpoint`
  rejects anything that is not HTTPS to a public address, so this is not an SSRF vector,
  but it does mean the instance needs outbound HTTPS — which it has.

---

## Appendix: where each setting comes from

| Env var (`RXHIVE_` prefix) | Value in this deployment | Source |
|---|---|---|
| `RXHIVE_ENVIRONMENT` | `production` | `.env` (bootstrap) and compose |
| `RXHIVE_DATABASE_URL` | `postgresql+asyncpg://rxhive:<pw>@<db_endpoint host>:5432/rxhive` | assembled by the bootstrap: SSM `db_password` + Terraform host/db/user |
| `RXHIVE_REDIS_URL` | `redis://redis:6379/0` | compose (container on the same box) |
| `RXHIVE_SECRET_KEY` | 64 random lowercase alphanumerics | SSM SecureString `secret_key` |
| `RXHIVE_COOKIE_SECURE` | `true` | `.env` + compose |
| `RXHIVE_TRUST_PROXY` | `true` (Caddy is the only ingress) | `.env` + compose |
| `RXHIVE_CORS_ORIGINS` | *empty* — single origin, do not set | `.env` + compose |
| `API_WORKERS` | `2` (uvicorn worker count) | `.env` |
| `RXHIVE_S3_ENDPOINT` | `https://s3.<region>.amazonaws.com` | compose, from `AWS_REGION` in `.env` |
| `RXHIVE_S3_BUCKET` / `_REGION` | Terraform-created bucket, deploy region | `.env` (bootstrap, from Terraform) |
| `RXHIVE_S3_ACCESS_KEY` / `_SECRET_KEY` | **both empty** — selects instance-role credentials | compose (pinned to `""`) |
| `RXHIVE_S3_PUBLIC_ENDPOINT` | `/s3` — keeps presigned URLs same-origin | compose |
| `RXHIVE_LIVEKIT_URL` | `/livekit` (browser resolves against the site origin) | compose, from `RXHIVE_LIVEKIT_PUBLIC_URL` in `.env` |
| `RXHIVE_LIVEKIT_HEALTH_URL` | `http://livekit:7880` (server-side probe) | compose (hardcoded) |
| `RXHIVE_LIVEKIT_API_KEY` / `_API_SECRET` | shared with the SFU via `LIVEKIT_KEYS` | SSM SecureString `livekit_api_key` / `livekit_api_secret` |
| `RXHIVE_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` | *empty* unless you provision them — see §10 | optional SSM `vapid_public_key` / `vapid_private_key` |
| `RXHIVE_SEED_SUPERADMIN_EMAIL` | `admin@rhythmrx.ai` unless overridden | optional SSM `superadmin_email` (no tfvars variable) |
| `RXHIVE_SEED_SUPERADMIN_PASSWORD` | bootstrap admin password | SSM SecureString `superadmin_password` |
| `SITE_ADDRESS` | your domain — this is what makes Caddy do ACME | tfvars `domain_name` → `.env` |
| `S3_BUCKET_HOST` | `<bucket>.s3.<region>.amazonaws.com` — Caddy's `/s3` upstream | compose |
