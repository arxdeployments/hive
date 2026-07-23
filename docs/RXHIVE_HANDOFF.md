# RX HIVE — Engineering Handoff & Build Spec

> **Purpose of this document.** This is a complete, self-contained handoff for building RX HIVE to production. It was produced after a deep 16-pass analysis of three prior code versions. A new engineer or AI session should be able to start from this document alone, with only the **RxHivexx** codebase present for reference. Read this top-to-bottom before writing any code.
>
> **Visual companion (optional):** an interactive version of this plan (architecture diagrams, schema, Gantt) lives at
> `https://claude.ai/code/artifact/edc3e914-89ce-4f8d-a5d5-0f256ae1e774`

---

## 0. How to use this document (read first)

1. **Only RxHivexx is provided for reference.** Two other prior versions (`mmmmmmmhive`, `RxHivey`) were evaluated and **rejected** — do not look for them or reuse them. All file paths in this document are relative to the RxHivexx project root (the folder containing `backend/` and `frontend/`).
2. **This is a salvage-and-rebuild, not a fix-in-place and not a from-scratch rewrite.** Sections 2 and 5 define exactly what to keep, rebuild, and build new.
3. **The database is changing from MongoDB to PostgreSQL.** This is a firm decision (see §4, §6).
4. **Start at §12 (Phase 0 checklist)** once you've absorbed §1–§11.
5. Treat RxHivexx as a **reference/spec**, not code to copy wholesale. Its domain model, API shapes, admin portals, and frontend UX are valuable; its data-access layer, realtime core, and calling stack are being rebuilt.

---

## 1. Project context

**RX HIVE** is an internal enterprise chat tool (think Slack/WhatsApp for a single company), for the owner's organization (rhythmrx.ai). Target feature set:

- 1:1 and group messaging
- Message reactions, replies/quoting
- Attachments: images, **video**, audio, and many document formats
- Voice + video calling (1:1 and group), screen share
- A **super-admin portal** and **org/department management**
- Individual user accounts with role-based access
- Multi-tenant: strict **organization isolation** (users in org A must never see org B's data)
- Mobile support (later — PWA first, native app post-v1)

**History:** The original was built with an AI app-builder (Emergent) and abandoned as too buggy — "more mistakes than development." Three versions were generated. This handoff is the plan to rebuild it properly.

---

## 2. The decision: salvage RxHivexx

Three versions were analyzed. **RxHivexx** is the chosen base (~40% of the way to the target product):

| Version | Size | Verdict |
|---|---|---|
| **RxHivexx** | ~21.7k LOC | **CHOSEN BASE.** Right multi-tenant model (orgs→depts→users), most complete features, only build with calling code, most coherent frontend. |
| mmmmmmmhive | ~20.9k LOC | REJECTED. A from-scratch consumer "Discord clone" — no org/tenant concept at all, no admin UI, unauthenticated realtime layer. |
| RxHivey | ~7.2k LOC | REJECTED. Auth + admin dashboard only. No chat/sockets/uploads. |

RxHivexx's defects are mostly **narrow, well-located contract bugs and a security punch-list** (fixable), *plus* two subsystems (realtime + calling) that are **architecturally wrong and must be rebuilt, not patched**.

### Keep / Rebuild / Build-new

**KEEP & refine (carries forward):**
- The domain model (orgs, departments, users, conversations, roles) — as the PostgreSQL spec
- The REST API contract — ~70 endpoints' routes & shapes stay stable so the frontend keeps working
- The **super-admin portal** (org/dept/user CRUD, password resets, bulk ops) — the strongest part of the build
- The **org-admin portal** (scoped user & department management)
- The **frontend shell & UX** — virtualized message list, optimistic sends, image lightbox, emoji picker, skeletons, empty states
- The design language — dark/emerald "Obsidian Emerald" system (see `design_guidelines.md` in RxHivexx)

**REBUILD (architectural, don't debug):**
- Data layer — Motor/MongoDB → **SQLAlchemy 2.0 (async) on PostgreSQL**
- Realtime fan-out — in-process Python dicts → **Redis pub/sub** (enables >1 worker; today it's single-node only)
- Calling — hand-rolled 6-person WebRTC mesh + free public TURN → **LiveKit SFU**
- File storage — local disk → **S3-compatible object store** (MinIO), served via authed presigned URLs
- Auth session — tokens in localStorage → **httpOnly cookies + a refresh-token table** (revocable)
- Frontend build — deprecated CRA/craco → **Vite**

**BUILD NEW (absent today):**
- Video + audio attachments, expanded document formats
- Message editing; working delete-for-me
- Automated test suite (pytest + Playwright) — there are **zero** real tests today
- Deployment: Docker, CI/CD, env templates, observability
- Push notifications (Web Push in v1)
- PWA (manifest + service worker) as the mobile stepping-stone

---

## 3. Target stack

| Layer | Choice | Notes |
|---|---|---|
| API framework | **FastAPI** + Pydantic v2 | Keep — genuine strength |
| Database | **PostgreSQL 16** | Firm decision (migrating off MongoDB) |
| ORM / migrations | **SQLAlchemy 2.0 async** (asyncpg) + **Alembic** | Versioned migrations replace ad-hoc index creation |
| Realtime | Native **WebSocket** + **Redis pub/sub** | Keep client WS; back registry/presence with Redis |
| Voice/video | **LiveKit** (SFU), self-hosted first | Replaces mesh + public TURN; unlocks group calls, screen share |
| Object storage | **S3-compatible (MinIO** self-host → S3 in cloud) | Same S3 API both places |
| Frontend | **React 19 + Vite** + Zustand + Tailwind + Radix | Migrate off CRA; prune ~2.9k LOC of unused shadcn components |
| Auth | JWT access (short-lived) + refresh in **httpOnly cookies** | Refresh persisted & revocable; re-check `is_active` on refresh |
| Search | **PostgreSQL full-text (tsvector)** | Native FTS for v1; dedicated engine later if needed |
| Deploy | **Docker + Docker Compose** + GitHub Actions CI | Single VM/VPS for v1; K8s only if scale demands |

---

## 4. Roles (4 total)

1. **Super Admin** — platform-level; full org/department/user CRUD, password resets, bulk ops, cross-org groups. (In current code: a separate `superadmins` collection — unify into `users` with a platform role in Postgres.)
2. **Org Admin** — manages users/departments within their own organization only.
3. **Member** — regular user.
4. **Group roles** (creator / admin / member) — a second RBAC layer *inside* group conversations.

Enforcement today is via FastAPI dependencies. In the rebuild, add a single injected **tenant-guard dependency** that scopes every query to `current_user.org_id` — this closes the cross-tenant IDOR bug class by construction (see §7, §8).

---

## 5. Repository structure (REQUIRED)

**Hard requirement from the owner:** frontend and backend code live in **fully separate, self-contained top-level folders**, so human developers can open, run, test, and review either side independently. No shared code folder couples them — they communicate only over the documented HTTP/WebSocket API.

```
rxhive/
├─ backend/            # FastAPI (Python) — runs independently
│  ├─ app/
│  │  ├─ api/          # routers (auth, admin, messages, conversations, calls…)
│  │  ├─ core/         # config, security, deps, tenant guard
│  │  ├─ db/           # SQLAlchemy models, session
│  │  ├─ services/     # business logic (send, calls, uploads…)
│  │  ├─ realtime/     # websocket + Redis pub/sub
│  │  └─ schemas/      # Pydantic request/response models
│  ├─ alembic/         # versioned migrations
│  ├─ tests/           # pytest (unit + tenant-isolation)
│  ├─ requirements.txt
│  ├─ Dockerfile
│  └─ .env.example
├─ frontend/           # React 19 + Vite — runs independently
│  ├─ src/
│  │  ├─ pages/        # route screens (chat, login, admin, org-admin…)
│  │  ├─ components/   # chat, calls, layout, shared
│  │  ├─ services/     # api client, websocket, livekit client
│  │  ├─ stores/       # Zustand state
│  │  └─ lib/          # utils, hooks
│  ├─ public/          # manifest, favicon, PWA assets
│  ├─ tests/           # Playwright e2e
│  ├─ package.json
│  ├─ Dockerfile
│  └─ .env.example
├─ infra/              # docker-compose.yml, reverse proxy, deploy config
├─ docs/               # this handoff, ADRs, API reference
└─ README.md           # one-command local start
```

Each of `backend/` and `frontend/` must be buildable, testable, and containerizable in isolation. This layout can later split into two repos with zero refactoring.

---

## 6. PostgreSQL data model

The current MongoDB collections map cleanly to a normalized relational schema. Embedded arrays become join tables.

### Collection → table mapping

| MongoDB today | PostgreSQL target | Key change |
|---|---|---|
| `superadmins` | `users` (platform role) | Unify into one users table |
| `organizations` | `organizations` | Direct; `slug` unique, `is_active` |
| `departments` | `departments` | FK to org; unique `(org_id, name)` |
| `users` | `users` | FKs to org & dept; `role` enum; `password_hash` |
| `conversations.participants[]` | `conversation_participants` | Embedded array → join table (role, last_read, pin) |
| `messages.reactions[]` | `message_reactions` | Embedded → join table, unique `(message,user,emoji)` |
| `messages` (media_url inline) | `messages` + `message_attachments` | Attachments normalized (fixes the dropped-media_url bug by design) |
| `messages.deleted_for[]` | `message_deletions` | Delete-for-me becomes a filterable relation |
| `call_history`, `scheduled_calls`, `call_links` | same + `call_participants` | Participants normalized out |
| `audit_logs`, `notifications` | same | Add `jsonb` payload columns |
| *(none — stateless refresh today)* | `refresh_tokens` | **NEW** — enables logout/deactivation to actually revoke sessions |

### Core tables (essential columns)

- **organizations**(id uuid PK, name, slug uniq, logo_url, is_active bool, created_at)
- **departments**(id uuid PK, org_id FK, name, description, created_at) — unique (org_id, name)
- **users**(id uuid PK, org_id FK null, dept_id FK null, email citext uniq, display_name, password_hash, role enum[superadmin,org_admin,member], is_active bool, last_seen_at)
- **conversations**(id uuid PK, org_id FK null, type enum[direct,group,cross_org], name null, avatar_url null, created_by FK, last_message_at)
- **conversation_participants**(conversation_id FK, user_id FK, role enum[creator,admin,member], last_read_at, is_pinned bool, joined_at) — PK (conversation_id, user_id)
- **messages**(id uuid PK, conversation_id FK, sender_id FK, type enum[text,image,video,audio,file,system], content text, reply_to_id FK null (self), edited_at null, created_at) — index (conversation_id, created_at desc)
- **message_attachments** *(NEW)*(id uuid PK, message_id FK, url, thumbnail_url null, filename, mime_type, file_size bigint)
- **message_reactions**(message_id FK, user_id FK, emoji, created_at) — PK (message_id, user_id, emoji)
- **message_deletions**(message_id FK, user_id FK) — delete-for-me
- **call_history**(id, org_id, type, status, started_at, ended_at) + **call_participants**(call_id FK, user_id FK, joined_at, left_at)
- **scheduled_calls**, **call_links**(code uniq)
- **audit_logs**(id, org_id, actor_id, action, target_type, target_id, metadata jsonb, created_at)
- **notifications**(id, user_id FK, type, payload jsonb, is_read bool, created_at)
- **refresh_tokens** *(NEW)*(id uuid PK, user_id FK, token_hash, expires_at, revoked_at null)

**Tenant isolation by construction:** every tenant-scoped table carries `org_id`; a single injected dependency adds `org_id = current_user.org_id` to every query. Optionally enable Postgres Row-Level Security for defense-in-depth.

**Data migration:** the current app stores only seeded/demo data — there is **no production dataset to preserve**. The cutover is a clean schema build; a one-off idempotent script re-seeds the super-admin.

---

## 7. Known defects in RxHivexx (verify against code; fix in rebuild)

The Emergent builder's `plan.md` / `test_result.md` **overstate completeness** — every claim below was confirmed against the actual code. File paths are relative to the RxHivexx root.

### Broken feature contracts (both sides exist, wiring is wrong)
- **Attachments broken E2E:** composer POSTs only `{content, type, temp_id}` and drops `media_url` → images/docs save blank and break on reload. `frontend/src/components/chat/MessageComposer.js:113`. Also the HTTP send path never broadcasts over WebSocket, so media never reaches recipients live. `backend/app/routes/messages.py:109-204`.
- **Replies broken:** `reply_to` is never forwarded from the composer → replies save with no reply. `frontend/src/components/chat/MessageComposer.js:14,76`.
- **Group calls broken:** the initiator never acquires local media or registers mesh signaling callbacks → can never connect. `frontend/src/services/websocket.js:359`.
- **Screen-share button** has no onClick handler (dead UI). `frontend/src/components/calls/ActiveCallView.js`.
- **Delete-for-me** is recorded but never filtered on read → deleted messages reappear. `backend/app/routes/messages.py`.
- **Message editing** absent (field stored, no endpoint/UI). **No video/audio** upload types (`backend/app/routes/uploads.py:16-17`).
- **Superadmin login omits `refresh_token`** → 15-minute forced logout. `backend/app/routes/auth.py:41-50`.

### Architecture ceiling
- **All WebSocket connections + call state live in in-process dicts** → single-node only; a 2nd worker splits users, a restart drops calls. `backend/app/websocket/manager.py:18`, `backend/app/websocket/call_manager.py:31-34`. → **Move to Redis.**
- Calling uses a **free public TURN** (`openrelay.metered.ca`, shared creds). `backend/app/routes/calls.py`. → **Replace with LiveKit.**
- **Zero automated tests.** ~2.9k LOC of unused shadcn components in `frontend/src/components/ui/`. Emergent branding + 3rd-party script still in `frontend/public/index.html`.

---

## 8. Security punch-list (all must close before deploy)

Real scaffolding exists (bcrypt(12), pinned JWT alg, sanitization, RBAC deps), but two headline claims ("isolation on every query", "login rate limiting") are **false in code**.

| Finding | Severity | Evidence (RxHivexx path) | Fix |
|---|---|---|---|
| Cross-tenant IDOR — forward & react look up messages by id, no org/membership check | **Critical** | `backend/app/routes/messages.py:322, :259` | Tenant guard + membership check on every message action |
| Login rate limiter is dead code (wrong route path, never runs) | **Critical** | `backend/app/main.py:58-62` | Redis-backed rate limit on auth + sensitive routes |
| Unauthenticated file serving (any file fetchable by URL) | High | `backend/app/routes/uploads.py:110-129` | Object store + short-lived presigned URLs behind auth |
| Deactivated users never revoked (refresh ignores `is_active`) | High | `backend/app/routes/auth.py:95-140` | Refresh-token table + `is_active` check on refresh |
| Tokens in localStorage (XSS-exfiltratable) | High | `frontend/src/contexts/AuthContext.js:41-45` | httpOnly + Secure + SameSite cookies |
| Unauthenticated WebRTC signaling relay (SDP/ICE to arbitrary users) | High | `backend/app/websocket/call_handler.py:386-390` | Superseded by LiveKit scoped tokens |
| Permissive CORS default (`*` with credentials) | Medium | `backend/app/main.py:31-44` | Explicit allowlist from env; fail closed |
| No password policy enforced (validator never called; min length 6) | Medium | `backend/app/utils/security.py:17-27` | Enforce on all set-password paths |
| Regex injection / ReDoS + duplicate `$or` dropping isolation clause | Medium | `backend/app/routes/search.py:31-42` | Parameterized Postgres FTS |
| Emergent branding + 3rd-party script in production shell | Low | `frontend/public/index.html` | Strip; set real title/manifest/favicon |

A dedicated security review runs again at the end (Phase 5) as a go/no-go gate.

---

## 9. Feature roadmap (v1 scope)

| Feature | Today | v1 action |
|---|---|---|
| 1:1 messaging | Works | Keep (re-home on unified send path) |
| Group chat | Works | Keep |
| Reactions | Works but unsafe | Add membership check |
| Replies / quoting | Broken | Fix (forward reply_to) |
| Image attachments | Broken | Fix (carry media_url; normalized table) |
| Video / audio attachments | Absent | Build |
| Document formats (many) | 10 types, broken | Expand + fix |
| Voice/video calls (1:1) | Wired, fragile | Rebuild on LiveKit |
| Group calls | Broken | Rebuild on LiveKit |
| Screen share | Dead button | Build (native to SFU) |
| Read receipts / typing / presence | Works | Keep (fan-out via Redis) |
| Message editing | Absent | Build |
| Search | Works but unsafe | Postgres FTS |
| Super-admin portal | Strong | Keep |
| Org / department mgmt | Works | Keep |
| Push notifications | Absent | Build (Web Push) |
| Mobile app | None | PWA in v1; native post-v1 |
| Threads | Absent | Post-v1 (reply pointers exist) |

---

## 10. Phased build plan (~13–16 engineer-weeks to production v1)

Sequenced so risk retires early and something demonstrable exists at every step. Each phase has an **exit gate** — do not proceed until it passes.

### Phase 0 — Foundation & cutover (~1.5 wk)
- Monorepo per §5 structure; migrate frontend CRA → Vite; strip Emergent branding/scripts; real title/favicon/manifest
- `docker-compose` for Postgres 16, Redis, MinIO, API, web — **one command to run everything**
- SQLAlchemy 2.0 async + Alembic baseline; typed settings; `.env.example` for both apps
- **Auth hardening first:** httpOnly cookies, refresh-token table, `is_active` revocation, working rate limiter, password policy
- CI skeleton: lint + typecheck + build on every push
- **Exit gate:** stack boots from one command; login issues httpOnly cookies; CI green.

### Phase 1 — Postgres data layer (~2.5 wk)
- Full schema & models from §6; enums, indexes, FKs, Alembic migrations
- **Tenant guard** dependency scoping every query to the caller's org; optional RLS
- Port endpoints (auth, admin, org-admin, conversations, contacts, validation) onto SQLAlchemy — **API contract unchanged** so the frontend keeps working
- Idempotent seed script (super-admin + reference data)
- **Exit gate:** admin portals fully functional on Postgres; cross-tenant access provably blocked by an automated test.

### Phase 2 — Messaging core, made real (~2 wk)
- **Unified send service:** persist + broadcast on one path
- Fix contracts: attachments carry media_url/thumbnail/filename; replies forward reply_to; delete-for-me filters correctly
- Attachments → MinIO/S3 with presigned authed URLs + server-side thumbnails; add video/audio + expanded doc types
- Message editing endpoint + UI; read receipts via `last_read_at`
- **Exit gate:** send an image, a video, a reply, an edit — all persist and appear for the recipient on reload.

### Phase 3 — Realtime on Redis (~2 wk)
- Redis pub/sub fan-out; connection registry & presence out of process
- **Multi-worker proof:** run 2+ API instances; two users on different workers exchange messages live
- Reconnection done right: token refresh on reconnect, cursor-based resync, no spurious logout
- Authenticated, org-scoped subscriptions for every event
- **Exit gate:** messaging correct across two workers; killing one instance doesn't drop the other's users.

### Phase 4 — Calling via LiveKit (~3 wk)
- Self-hosted LiveKit SFU in the stack; backend mints scoped room tokens
- Rebuild call UI on the LiveKit client: 1:1, group, screen share, active speaker
- Lifecycle & history: join/leave/end correct; call history & missed-call counts wired; scheduling
- Retire mesh + public TURN + hand-rolled signaling
- **Exit gate:** a 5-person group video call with screen share holds up; call history records correctly.

### Phase 5 — Harden, test, polish & ship (~2.5 wk)
- Test suite: pytest (API + isolation) + Playwright (critical flows)
- Security review as a go/no-go gate; close the full §8 list
- UX repair: touch/long-press message actions, failed-send retry, wire the Settings toggles, accessibility & focus states
- PWA: manifest, service worker, Web Push
- Deploy: production images, CD pipeline, observability (logs/metrics/error tracking), staging → prod
- **Exit gate:** deployed to production, monitored, with a green test suite and a passed security review.

---

## 11. Open decisions (recommended defaults — confirm or change)

| Decision | Recommended default | Why |
|---|---|---|
| Calling infra | LiveKit, self-hosted first | No per-minute cost; data in-house; can move to LiveKit Cloud later |
| Object storage | MinIO self-hosted → S3 in cloud | Same S3 API; no code change to switch |
| Hosting | Single VM/VPS + Docker Compose for v1 | Fastest path to deployed; K8s only if scale demands |
| Mobile | PWA in v1, native (React Native) post-v1 | PWA ships with the web app |
| Team size | 1–2 engineers | Timeline assumes 1 focused eng; a 2nd on Phases 2–3 compresses ~2–3 wk |

---

## 12. First actions for the new session (Phase 0 checklist)

1. **Confirm the open decisions in §11** with the owner (or proceed on the recommended defaults).
2. **Initialize a clean git repository** at the new project root (the current code is NOT in git).
3. **Scaffold the §5 structure:** create `backend/`, `frontend/`, `infra/`, `docs/` (move this file into `docs/`).
4. **Backend skeleton:** FastAPI app, SQLAlchemy 2.0 async engine + Alembic init, typed settings, `.env.example`, Dockerfile.
5. **Frontend skeleton:** Vite + React 19, port the RxHivexx `src/` (prune unused `components/ui`), `.env.example`, Dockerfile.
6. **`infra/docker-compose.yml`:** Postgres 16 + Redis + MinIO + backend + frontend — bootable with one command.
7. **Auth hardening (do this in Phase 0, not later):** httpOnly-cookie sessions, `refresh_tokens` table, `is_active` re-check on refresh, a *working* Redis-backed rate limiter, enforced password policy.
8. **CI:** GitHub Actions running lint + typecheck + build for both apps.
9. Meet the Phase 0 exit gate before touching messaging.

---

## 13. Working principles (avoid the original build's failure mode)

The original failed because features were claimed "done" without verification, so regressions piled up. To prevent a repeat:

- **Verify every feature end-to-end** (frontend → backend → DB → back to another user) before calling it done. Don't trust that both sides "exist" — the classic RxHivexx bug is both sides existing with a broken contract between them.
- **Write tests alongside each phase, not at the end.** Every ported endpoint gets a contract test; tenant isolation gets an explicit test that proves org A can't read org B.
- **Keep the REST API contract stable** through the Postgres port so the salvaged frontend keeps working; a contract test per endpoint catches silent drift.
- **Don't expand scope mid-phase.** Threads, custom emoji, advanced moderation are explicitly post-v1. Ship a solid v1, then iterate.
- **Never claim completeness you haven't demonstrated.** If something is stubbed or unverified, say so.

---

## 14. Reference index (RxHivexx files worth reading first)

- `backend/app/models/schemas.py` — current domain shapes (small; good starting spec)
- `backend/app/database.py` — current collections & indexes (maps to §6 tables)
- `backend/app/routes/` — the ~70 endpoints to preserve as the API contract (admin.py, auth.py, conversations.py, messages.py, groups.py, org_admin.py, uploads.py, calls.py, search.py, cross_org.py, contacts.py, validation.py)
- `backend/app/websocket/` — the realtime + calling code being **replaced** (manager.py, endpoint.py, call_manager.py, call_handler.py)
- `frontend/src/pages/` and `frontend/src/components/` — the UI being kept
- `frontend/src/services/websocket.js`, `meshCallManager.js`, `webrtcManager.js` — realtime/calling being **replaced**
- `design_guidelines.md` — the visual system to preserve
- `plan.md`, `test_result.md` — the builder's own claims: **read for orientation, trust nothing without verifying against code**

---

*End of handoff. Start at §12.*
