# RX HIVE — Production Deployment

The whole stack ships as Docker images orchestrated by `infra/docker-compose.yml`.
For v1 a single VM/VPS with Docker is the target; nothing here assumes Kubernetes.

## 1. Prerequisites

- A Linux host with Docker + Docker Compose v2.
- A domain pointed at the host (for automatic HTTPS via the bundled Caddy).
- Open ports: 80/443 (web/API), and the LiveKit media range **50000–50100/udp**
  plus **7881/tcp** (WebRTC fallback) reachable from clients.

## 2. Secrets

```bash
cd infra
cp .env.example .env
# Generate strong values:
openssl rand -hex 32       # → RXHIVE_SECRET_KEY
openssl rand -hex 32       # → LIVEKIT_API_SECRET (32+ chars)
# Strong POSTGRES_PASSWORD, MINIO_ROOT_PASSWORD, RXHIVE_SEED_SUPERADMIN_PASSWORD
```

The API **refuses to boot** in production (`RXHIVE_ENVIRONMENT=production`, the
compose default) if `RXHIVE_SECRET_KEY`, `LIVEKIT_API_SECRET`, or
`RXHIVE_S3_SECRET_KEY` is a known placeholder or shorter than 32 characters.
This is intentional — it prevents shipping the demo signing key.

For a real domain, set `SITE_ADDRESS=chat.yourco.com`; Caddy provisions TLS
automatically and `RXHIVE_COOKIE_SECURE=true` (the default) makes cookies Secure.

### Web Push (optional but recommended)

```bash
docker compose run --rm api python -m app.tools.vapid
# copy the three RXHIVE_VAPID_* lines into infra/.env
```

## 3. Boot

```bash
docker compose -f infra/docker-compose.yml up --build -d
```

On first boot the API applies Alembic migrations and seeds the super-admin.
Visit `https://your-domain`, sign in, rotate the super-admin password in-app,
then create organizations/departments/users from the admin portal.

## 4. Scaling

All shared state lives in Postgres and Redis, so the API is stateless:

```bash
# more API workers per container:
API_WORKERS=4 docker compose up -d api
# or scale to multiple API containers behind Caddy:
docker compose up -d --scale api=3
```

Realtime fan-out (Redis pub/sub), presence, rate limiting, and call state all
work identically across any number of workers/instances — verified by the
multi-worker delivery test.

## 5. Object storage & LiveKit in the cloud

- **MinIO → S3**: point `RXHIVE_S3_ENDPOINT`/keys at a real S3 bucket; no code
  change (same S3 API). Set `RXHIVE_S3_PUBLIC_ENDPOINT` to the bucket/CDN origin.
- **LiveKit**: self-hosted here; to move to LiveKit Cloud, set
  `RXHIVE_LIVEKIT_URL` and the cloud key/secret and drop the `livekit` service.
  Behind NAT, keep `use_external_ip: true` in `infra/livekit.yaml`.

## 6. Observability

- `GET /api/health` — liveness/readiness (checks Postgres + Redis); 200/503.
- `GET /api/metrics` — request counters, average latencies, live socket count.
  Super-admin authentication required (it maps your private API surface).
- Structured JSON access logs (request id, method, route template, status, ms)
  on stdout — ship to your aggregator. No query strings or bodies are logged.
- Every response carries an `X-Request-ID` for correlation.

## 7. Backups

- **Postgres** is the source of truth: `pg_dump` on a schedule (the `pgdata`
  volume holds live data). Test restores.
- **MinIO** (`miniodata` volume) holds attachments — back up the bucket.
- Redis is ephemeral (presence, pub/sub, rate-limit windows); no backup needed.

## 8. Upgrades

```bash
git pull
docker compose -f infra/docker-compose.yml up --build -d
```

Migrations run automatically on API start. Alembic migrations are additive and
reversible; review `backend/alembic/versions/` before a major upgrade.

## 9. CI/CD

`.github/workflows/ci.yml` runs lint + typecheck + migrations + pytest for the
backend, lint + build for the frontend, and builds both Docker images on every
push. Wire a deploy step (SSH `docker compose pull && up -d`, or your platform's
deploy action) onto the `main` branch after CI passes.
