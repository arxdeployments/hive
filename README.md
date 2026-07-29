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
├─ ios/        SwiftUI iOS app (Xcode 16+) — same backend, no mobile API
├─ infra/      docker-compose, Caddy, LiveKit config
└─ docs/       handoff spec + API reference
```

`backend/`, `frontend/` and `ios/` are fully self-contained: they share no code
and talk only over the documented HTTP/WebSocket API, so each can be built,
tested, and deployed on its own.

## Clients, and who may use which

| | Web (`frontend/`) | iOS (`ios/`) |
|---|---|---|
| Super admin | **yes** — the only place the admin portal exists | **never** |
| Org admin (`admin`) | yes | only if granted |
| Member | yes | only if granted |

Mobile access is a **per-user grant issued by a super admin**, not a role. A
member or org admin cannot sign in to the iOS app until someone approves their
account individually, at **Admin → Users** in the web portal (inline per-row
toggle, edit-drawer control, a field on user creation, bulk grant/revoke, and an
Approved / Not-approved filter).

Enforced in `backend/app/api/auth.py:_assert_mobile_allowed`, re-checked on every
request via a signed `client` claim and again on refresh — so revoking access ends
the phone's session immediately. Revoking does **not** end that user's web session:
`refresh_tokens.client` records which client opened each session, and only mobile
ones are revoked. Both refusals are `403` with a user-facing sentence, never `401`,
so "not approved yet" can never be mistaken for "wrong password".

Covered by [`backend/tests/test_mobile_access.py`](backend/tests/test_mobile_access.py).
See [`ios/README.md`](ios/README.md) for the app itself.

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

**LiveKit SFU** — required for voice and video calls. Nothing else needs it, so
it is easy to forget; without it every call fails at the moment of connecting.
Its key/secret **must** match the API's `RXHIVE_LIVEKIT_API_KEY` / `_SECRET`:

```bash
LIVEKIT_KEYS="devkey: devsecret-at-least-32-characters-long" \
  livekit-server --dev            # ws://localhost:7880
```

**Backend** (needs Postgres + Redis; MinIO for attachments; LiveKit for calls):

```bash
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env
.venv/bin/alembic upgrade head
.venv/bin/python -m app.seed
.venv/bin/uvicorn app.main:app --reload
```

Confirm the whole stack, calls included, in one request:

```bash
curl -s localhost:8000/api/health
# {"status":"healthy", "database":"connected", "redis":"connected",
#  "livekit":"connected", "calls_available":true, ...}
```

`livekit` is reported separately from `status` on purpose: messaging works
without the SFU, so a stopped LiveKit leaves the API `healthy` with
`"livekit":"unreachable"` and `"calls_available":false`.

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

# Frontend: Playwright E2E — boots the web server, waits for a healthy API
cd frontend && npm run test:e2e

# Against an already-running stack (faster local loop):
E2E_NO_SERVER=1 npm run test:e2e
```

The backend suite includes an explicit tenant-isolation gate proving org A can
never read org B (messages, reactions, forwards, search, admin portals, calls,
attachments).

The E2E suite asserts cross-user delivery lands **within 5 seconds** — a budget
the 15s conversation poll cannot satisfy, so a broken WebSocket fails the test
instead of silently degrading to polling. `tests/global-setup.js` fails loudly
if the API isn't healthy, rather than letting a dead stack surface as opaque
locator timeouts.

All E2E traffic shares one source IP, so raise the login budget for those runs:
`RXHIVE_RATE_LIMIT_LOGIN=200` (rate limits are settings-tunable per scope).

## Troubleshooting: "the call won't connect"

**Symptom** — the call rings, the other side answers, then it drops or stays
silent/black. Messaging is unaffected.

**Check, in this order:**

1. `curl -s localhost:8000/api/health` → is `"livekit":"connected"`?
   - `unreachable` — livekit-server isn't running (or isn't listening where the
     API expects). Start it with the command above.
   - `not_configured` — `RXHIVE_LIVEKIT_URL` is unset, or it's a browser-only
     path like `/livekit`; set `RXHIVE_LIVEKIT_HEALTH_URL` to the server-side
     address (docker compose already does).
2. Read the toast in the browser — each cause has its own message:
   | Toast | Cause |
   |---|---|
   | Call server unreachable — check that LiveKit is running | SFU down/unreachable from the browser |
   | Microphone blocked. Allow microphone access… | the browser denied mic permission |
   | Your microphone is in use by another app | another app holds the device |
   | Camera blocked — continuing with audio only | camera failed; the call is live, audio-only |
   | That call is no longer active | the call ended before this side joined |
3. Open the browser console: every join failure logs
   `[call:<context>] join failed (<reason>)` with the underlying LiveKit or
   `getUserMedia` error.
4. Still failing? The SFU key/secret must match the API's exactly
   (`LIVEKIT_KEYS="<key>: <secret>"` vs `RXHIVE_LIVEKIT_API_KEY`/`_SECRET`) —
   a mismatch surfaces as the SFU rejecting the token, not as a network error.
   In production also confirm the UDP media range is open (see below).

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
