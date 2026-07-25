# RX HIVE

Internal enterprise chat for rhythmrx.ai — 1:1 & group messaging, reactions,
replies, image/video/audio/document attachments, voice + video + group calls
with screen share, a super-admin portal, org/department management, and strict
multi-tenant isolation.

Rebuilt from the RxHivexx prototype per [`docs/RXHIVE_HANDOFF.md`](docs/RXHIVE_HANDOFF.md):
PostgreSQL + SQLAlchemy 2.0 async, Redis pub/sub realtime (horizontally
scalable), LiveKit SFU calling, S3-compatible object storage, httpOnly-cookie
auth with revocable refresh tokens.

```
rxhive/
├─ backend/    FastAPI (Python 3.12) — runs independently
├─ frontend/   React 19 + Vite — runs independently
├─ infra/      docker-compose, Caddy, LiveKit config
└─ docs/       handoff spec + API reference
```

`backend/` and `frontend/` are fully self-contained: they share no code and talk
only over the documented HTTP/WebSocket API, so either can be built, tested, and
deployed on its own.

## One-command local stack

```bash
cd infra
cp .env.example .env          # then edit every secret
docker compose up --build     # Postgres, Redis, MinIO, LiveKit, API, web, Caddy
```

Open http://localhost. The API runs migrations and seeds the super-admin
(`RXHIVE_SEED_SUPERADMIN_EMAIL` / `_PASSWORD`) on first boot. Sign in, then
create organizations, departments, and users from the admin portal.

## Running each side independently

**Backend** (needs Postgres + Redis; MinIO for attachments; LiveKit for calls):

```bash
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env
.venv/bin/alembic upgrade head
.venv/bin/python -m app.seed
.venv/bin/uvicorn app.main:app --reload
```

**Frontend** (proxies `/api` → `localhost:8000` in dev):

```bash
cd frontend
npm install
cp .env.example .env
npm run dev            # http://localhost:5173
```

## Tests

```bash
# Backend: pytest against a real Postgres + Redis (rxhive_test DB)
cd backend && .venv/bin/pytest -q

# Frontend: Playwright E2E against a running stack
cd frontend && npm run test:e2e
```

The backend suite includes an explicit tenant-isolation gate proving org A can
never read org B (messages, reactions, forwards, search, admin portals, calls,
attachments).

## Production notes

- Put the whole thing behind the bundled Caddy (`infra/Caddyfile`) or your own
  TLS-terminating proxy; set `SITE_ADDRESS` to your domain for automatic HTTPS
  and `RXHIVE_COOKIE_SECURE=true`.
- Generate a real JWT secret (`openssl rand -hex 32` → `RXHIVE_SECRET_KEY`) and
  a LiveKit key/secret. The API refuses to boot in production with the dev
  secret.
- Web Push: generate a VAPID keypair with `python -m app.tools.vapid` and set
  the three `RXHIVE_VAPID_*` vars.
- LiveKit needs its media ports reachable by clients; set `use_external_ip` and
  open the UDP range in `infra/livekit.yaml` / your firewall.
- Run multiple API workers freely — all shared state (sessions, presence,
  realtime fan-out, call state) lives in Postgres and Redis.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the full production checklist
and [`docs/API.md`](docs/API.md) for the endpoint reference.
