# Where the build stands

Snapshot for anyone picking this up (or forking the session). Repo is clean at
`5a79b39`; all phases P0–P5 of the handoff plan are implemented.

## Restart the local stack

Nothing here auto-starts. From the repo root:

```bash
# Postgres (brew service) + Redis + MinIO
brew services start postgresql@17
redis-server --daemonize yes --port 6379
MINIO_ROOT_USER=rxhive MINIO_ROOT_PASSWORD=rxhive-dev \
  minio server /opt/homebrew/var/minio --address :9000 --console-address :9001 &

# LiveKit SFU — key/secret MUST match the API's
LIVEKIT_KEYS="devkey: devsecret-at-least-32-characters-long" \
  livekit-server --config /tmp/livekit-dev.yaml &     # see infra/livekit.yaml for the shape

# API
cd backend && export RXHIVE_LIVEKIT_API_KEY=devkey \
  RXHIVE_LIVEKIT_API_SECRET=devsecret-at-least-32-characters-long \
  RXHIVE_LIVEKIT_URL=ws://127.0.0.1:7880 \
  RXHIVE_S3_ENDPOINT=http://localhost:9000 RXHIVE_S3_PUBLIC_ENDPOINT=http://localhost:9000 \
  RXHIVE_S3_ACCESS_KEY=rxhive RXHIVE_S3_SECRET_KEY=rxhive-dev RXHIVE_RATE_LIMIT_LOGIN=200
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 &

# Web
cd frontend && npx vite --port 5173 --host 127.0.0.1 &
```

Or one command via Docker: `docker compose -f infra/docker-compose.yml up --build`.

Local super-admin: `admin@rhythmrx.ai` / `ChangeMe-Dev-Password1`.

## Tests

```bash
cd backend  && .venv/bin/pytest -q                      # 51 passing
cd frontend && E2E_NO_SERVER=1 npx playwright test      # 4 passing (needs stack up)
python scripts/check_contracts.py                       # frontend→backend route drift
```

## Verified in a real browser

Auth (cookies/CSRF/rate limit), messaging incl. live WebSocket delivery,
attachments through presigned redirects, tenant isolation, both admin portals
(full CRUD, bulk ops, reset-password, 4-step cross-org wizard), and 1:1 video
calling against a real SFU with media confirmed on both sides.

## NOT yet verified in a browser

Ranked by risk, given that every one of the four bugs below was invisible to
lint, typecheck, build, and backend tests:

1. **Chat interaction modals** — message edit, react, forward, delete-for-me /
   delete-for-everyone, message info. Cheapest sweep, decent odds of a find.
2. **Screen share** — wired and reachable, but automating `getDisplayMedia`
   headless needs `--auto-select-desktop-capture-source` and is unreliable.
3. **Group calls (3+)** — the join path is now correct by construction but has
   no test.
4. **PWA install + Web Push** — service worker registers; push delivery to a
   real endpoint is untested (needs VAPID keys configured).

## Bugs found by browser verification (all fixed)

Each passed every static check and the backend suite:

| Bug | Impact |
|---|---|
| `wsClient.connect()` gated on a localStorage token that cookie auth never sets | WebSocket never connected; "realtime" was a 15s poll |
| `POST /api/notifications/unsubscribe` vs API's `DELETE …/subscribe` | Push unsubscribe silently 404'd |
| `call:accepted` sent only to the caller | Callee never joined the SFU; every 1:1 call silent/black on one side |
| Flex child `min-height:auto` overflowing the call overlay | End Call button 186px below the fold — user could not hang up |

## Method that found them

Drive the real UI in a browser, instrument `XMLHttpRequest` + `fetch` to record
every 4xx/5xx and uncaught error, then **verify effects server-side** (DB rows,
audit trail, SFU logs) rather than trusting the UI. A green-looking screen
proves nothing — the WebSocket bug looked perfect because polling covered it.

Two cautions, both of which cost time here:

- Select by `data-testid`, never visible text. Two buttons read "Create User";
  clicking by text hit the wrong one and silently reset a form — producing the
  exact signature of a real contract bug ("no API call, nothing created").
- A dead stack surfaces as unexplained locator timeouts. `tests/global-setup.js`
  now fails loudly instead.

## Known gaps (not bugs)

- Org-admin screens and the call UI lack `data-testid` coverage that the
  super-admin pages have — hardest surface to test, most likely to regress.
- `scripts/check_contracts.py` catches path drift only, not response-shape
  drift (wrong field names). Extending it would catch the `media_url`/`reply_to`
  class of bug statically.
