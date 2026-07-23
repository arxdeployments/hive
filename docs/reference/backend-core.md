# 2

# RxHivexx Backend Core Analysis (MongoDB -> Postgres rebuild reference)

Files read completely: `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/main.py`, `config.py`, `database.py`, `models/schemas.py` (+ empty `models/__init__.py`), `auth/jwt.py`, `auth/passwords.py`, `auth/middleware.py` (+ empty `auth/__init__.py`), `utils/security.py`, `utils/serializers.py`, `utils/seed.py` (+ empty `utils/__init__.py`). Because document field names are established at insert time in routes/websocket code (models/schemas.py contains only request-validation Pydantic models), I also read the insert sites in `routes/auth.py`, `admin.py`, `org_admin.py`, `calls.py`, `conversations.py`, `messages.py`, `groups.py`, `cross_org.py`, `dev.py`, `search.py`, and `websocket/endpoint.py`, `call_handler.py`, `call_manager.py`.

## 1. MongoDB collections, indexes, document fields

Indexes are created in `database.py:create_indexes()` on startup. 11 collections referenced in code:

### users
Indexes: `email` (unique); compound `(org_id ASC, dept_id ASC)`; compound `(org_id ASC, is_active ASC)`.
Fields (insert in `routes/admin.py` ~L460-475 and `routes/org_admin.py` ~L167-182, identical shape):
- `_id` ObjectId
- `org_id` ObjectId, `dept_id` ObjectId
- `email` str, `password_hash` str (bcrypt), `display_name` str
- `avatar_url` str|null, `about` str|null (max 140 via profile update in search.py)
- `role` str: "admin" | "member" (superadmin is a SEPARATE collection, not a users role)
- `status` str: "offline" | "online" (set on login/logout)
- `last_seen` datetime|null
- `created_by` ObjectId (superadmin or org-admin id), `created_at` datetime, `is_active` bool
- `refresh_jti` str|null — set on login/refresh, nulled on logout (single active refresh token per user)

### superadmins
Indexes: `email` (unique).
Fields (insert in `utils/seed.py`): `_id`, `email`, `password_hash`, `name` (note: `name`, NOT `display_name`), `created_at`. Plus `refresh_jti` set on login.

### organizations
Indexes: `slug` (unique); `name` (non-unique).
Fields (insert in `routes/admin.py`): `_id`, `name`, `slug` (generated: lowercase, non-alphanumerics -> `-`, stripped), `logo_url` str|null, `created_by` ObjectId, `created_at` datetime, `is_active` bool.

### departments
Indexes: `org_id`; compound unique `(org_id ASC, name ASC)`.
Fields: `_id`, `org_id` ObjectId, `name`, `description` str|null, `created_at`. (No is_active, no created_by.)

### conversations
Indexes: compound `(participants.user_id ASC, type ASC)` (multikey into embedded array); compound `(org_id ASC, last_message_at DESC)`.
Fields (inserts in conversations.py, groups.py, cross_org.py, messages.py forward-to-contact, dev.py):
- `_id`, `type` str: "direct" | "group" | "cross_org"
- `org_id` ObjectId (null for cross_org)
- `name` str|null (null for direct), `description` str|null (group/cross_org only), `avatar_url` str|null
- `participants`: array of embedded docs `{user_id: ObjectId, role: "member"|"admin"|"creator", joined_at: datetime, unread_count: int}` — per-participant unread counters live HERE, incremented via `$inc participants.$.unread_count`
- `cross_org` bool, `allowed_org_ids` ObjectId[] (populated only for cross_org)
- `purpose_tag` (cross_org only)
- `created_by` ObjectId, `created_at`, `last_message_at` datetime (updated on every message)
- `pinned_by` ObjectId[] (users who pinned the conversation)
- `is_active` bool (soft delete)
- `admin_only_messages` bool (group/cross_org only; absent on direct)

### messages
Indexes: compound `(conversation_id ASC, created_at DESC)`.
Fields (inserts in messages.py, conversations.py, groups.py, cross_org.py, websocket/endpoint.py, websocket/call_handler.py, dev.py):
- `_id`, `conversation_id` ObjectId, `sender_id` ObjectId (system call-messages use sentinel ObjectId `000000000000000000000000`)
- `type` str: "text" | "system" | media types from client (`body.type`)
- `content` str (sanitized with bleach via `sanitize_text`)
- `media_url` str|null, `thumbnail_url` str|null, `file_size`, `filename` (last three only present on REST-sent messages; WS-sent and system messages omit thumbnail_url/file_size/filename — field presence is inconsistent across insert sites)
- `reply_to` ObjectId|null
- `reactions`: array of `{user_id: ObjectId, emoji: str, created_at: datetime}` (toggle via $pull/$push)
- `read_by`: array of `{user_id: ObjectId, read_at: datetime}` (sender pre-added)
- `delivered_to`: array of `{user_id: ObjectId, delivered_at: datetime}` (sender pre-added)
- `is_deleted` bool, `deleted_for` ObjectId[] (delete-for-me), `is_forwarded` bool (only on forwarded messages)
- `created_at` datetime, `edited_at` datetime|null

### audit_logs
Indexes: `timestamp`; `actor_id`.
Fields (log_audit in admin.py / org_admin.py / cross_org.py): `_id`, `actor_id` ObjectId, `actor_type` str ("superadmin" | "org_admin"), `action` str (e.g. "create_organization", "create_user", "user_created", "dept_created"), `target` str, `details` dict, `ip_address` str (ALWAYS empty string — never populated), `timestamp` datetime.

### notifications
Indexes: compound `(user_id ASC, is_read ASC)`. **Dead collection — indexed but never inserted/read anywhere in the codebase.**

### call_history
Indexes: `call_id` (unique); compound `(participants.user_id ASC, started_at DESC)`.
Fields (`websocket/call_manager.py:save_call_history`): `_id`, `call_id` str (uuid), `call_type` str ("voice"|"video"), `is_group` bool, `status` str ("answered"|"missed"|"declined"...), `conversation_id` ObjectId|null, `initiator` dict (shape `{user_id, ...}` from participants_data), `participants` array of dicts (contain `user_id` — note: stored as strings from WS layer, NOT ObjectIds, yet the index targets `participants.user_id`), `started_at`, `answered_at` datetime|null, `ended_at` datetime, `duration` int (seconds), `org_id` ObjectId|null, `created_at`, `seen_by` array (user-id strings).

### scheduled_calls
Indexes: compound `(creator_id ASC, start_time ASC)`; `participant_ids` (multikey).
Fields (`routes/calls.py:schedule_call`): `_id`, `title`, `description` str|null, `call_type` str (default "video"), `call_link_code` str, `start_time` datetime (parsed `fromisoformat`), `end_time` datetime|null, `reminder_minutes` int (default 15), `creator_id` ObjectId, `participant_ids` ObjectId[], `org_id` ObjectId|null, `status` str ("scheduled"), `created_at`.

### call_links
Indexes: `code` (unique).
Fields (`routes/calls.py:create_call_link`): `_id`, `code` str (gen_call_code), `creator_id` ObjectId, `call_type` str (default "video"), `created_at`, `is_active` bool.

## 2. JWT scheme (`auth/jwt.py`, `config.py`, `routes/auth.py`)
- Library: PyJWT. Algorithm: **HS256**, secret `settings.JWT_SECRET`.
- Access token: claims = caller-supplied data + `exp` (now UTC + **15 min**, `ACCESS_TOKEN_EXPIRE_MINUTES`) + `type: "access"`. No `iat`, no `iss`, no `aud`, no `sub`.
- Refresh token: same data + `exp` (now + **7 days**, `REFRESH_TOKEN_EXPIRE_DAYS`) + `type: "refresh"` + `jti` (uuid4). Returns `(token, jti)`; jti persisted on the user/superadmin doc as `refresh_jti` for revocation (one valid refresh token per account; logout sets it to None).
- Claim payload for regular users (login): `user_id` (str ObjectId), `email`, `role` ("admin"/"member"), `org_id` (str), `dept_id` (str), `name` (display_name).
- Claim payload for superadmins: `user_id`, `email`, `role: "superadmin"`, `name` — **no org_id/dept_id**.
- `decode_token` returns dict or **None** on expiry/invalid (never raises).
- Token transport:
  - REST: `Authorization: Bearer <token>` header via FastAPI `HTTPBearer` (auth/middleware.py). No cookies are ever SET by the server.
  - Refresh endpoint (`POST /api/auth/refresh`): reads `refresh_token` from JSON body first; falls back to `refresh_token` **cookie** only if body parsing fails — but nothing in the backend ever sets that cookie, so the cookie path is vestigial. Refresh rotates both tokens and the stored jti. New token data = old payload minus `exp`/`type`/`jti`/`iat`.
  - WebSocket (`/api/ws`): token passed as **query parameter** `?token=`, must be `type == "access"`.
- Login responses (wire format): user login returns `{access_token, refresh_token, user: {id, email, name, role, org_id, dept_id}}`. **Superadmin login returns `{access_token, user: {id, email, name, role}}` — the refresh_token is generated and its jti stored but NEVER returned to the client (bug: superadmin sessions cannot refresh).** `models/schemas.py:TokenResponse` (`{access_token, user}`) exists but is not enforced as response_model.

## 3. Auth dependencies (`auth/middleware.py`)
- `require_auth`: Bearer token -> decode -> requires `type == "access"`. Returns raw payload dict. **No DB lookup — does not check user existence or `is_active`; deactivated users keep access for up to 15 min.**
- `require_superadmin`: same decode + `role == "superadmin"` + DB check `superadmins.find_one({_id})` (403 if missing).
- `require_org_admin`: decode + `role in ["superadmin", "admin"]`. **No DB check, no org scoping.** Note: `routes/org_admin.py` does NOT use this — it defines its own `_require_org_admin` (role == "admin" only, requires org_id claim; superadmin explicitly excluded).
- 401 detail "Invalid or expired token"; 403 details "Super admin access required" / "Super admin not found" / "Admin access required". HTTPBearer itself yields 403 "Not authenticated" when the header is absent (FastAPI default, `auto_error=True`).

## 4. Serializer conventions (`utils/serializers.py`)
- `serialize_doc(doc)`: recursive; ObjectId -> `str`, datetime -> ISO-8601 UTC with `Z` suffix, nested dicts/lists handled (ObjectIds inside lists stringified; dicts recursed). All other values pass through.
- **`_id` stays `_id`** — serialize_doc does NOT rename to `id`. The wire format therefore mixes conventions: raw serialized docs expose `_id` (string), while hand-built payloads (login `user`, `/me`, enriched participants) use `id`. Postgres rebuild must preserve `_id` string keys wherever `serialize_doc` output is returned.
- `_serialize_datetime`: naive datetimes assumed UTC; `dt.isoformat().replace("+00:00", "Z")` -> e.g. `2026-07-23T10:15:30.123456Z`. Microsecond precision preserved. None -> None.
- Sensitive-field stripping is manual and per-route: `password_hash` / `refresh_jti` popped in some handlers (e.g. org_admin user routes) — serialize_doc itself does NOT strip them, so any route returning a raw user doc without popping leaks the bcrypt hash.

## 5. Seed data (`utils/seed.py`, plus `routes/dev.py`)
- `seed_superadmin()` runs at every startup (lifespan). If `SUPERADMIN_EMAIL` or `SUPERADMIN_PASSWORD` env vars are unset it prints "[SEED] ... skipping seed" and does nothing. Otherwise upserts-by-existence one superadmin doc: `{email, password_hash (bcrypt), name (SUPERADMIN_NAME, default "Super Admin"), created_at}`. **No hardcoded default credentials in code — they come entirely from env.** No demo orgs/departments/users are seeded here.
- Demo data lives in `POST /api/dev/seed-chat-data` (routes/dev.py, superadmin-gated): does NOT create orgs or users; it takes existing active users, pairs them per-org, and creates up to 5 direct conversations per org with canned text messages (55/12/5/1/18 messages, some unread, one pinned), timestamps randomized over today/yesterday/last week. Skips pairs that already have a conversation.

## 6. CORS / middleware / rate limiter (`main.py`) and its bugs
- CORS: `CORS_ORIGINS` env (comma-separated). If empty or "*": warns and uses `allow_origins=["*"]` **together with `allow_credentials=True`** — the wildcard+credentials combo (dev fallback) is invalid per spec/browsers. Allowed methods GET/POST/PUT/DELETE/OPTIONS; headers Content-Type, Authorization.
- Security-headers middleware: adds X-Content-Type-Options=nosniff, X-Frame-Options=DENY, X-XSS-Protection, Referrer-Policy on every response. No HSTS/CSP.
- Rate limiter: slowapi `Limiter(key_func=get_remote_address)` set on `app.state.limiter` + `RateLimitExceeded` handler. Then a loop tries to wrap the login endpoint with `limiter.limit("5/minute")`:
  - **BUG (fatal): the loop matches `route.path == "/login"`, but the auth router has prefix `/api/auth`, so every route's path is `/api/auth/login` etc. The condition never matches — the login rate limit is NEVER applied.** No endpoint in the app is actually rate-limited.
  - Even had it matched: mutating `route.endpoint` on an already-constructed APIRoute is fragile (FastAPI caches the built handler in `route.app`; it only works here by accident because `include_router` re-registers using `route.endpoint` afterwards).
  - `original_login = auth.router.routes` is dead code.
  - `get_remote_address` keys on direct peer IP — behind a reverse proxy all clients share the proxy IP (no X-Forwarded-For handling).
- WebSocket endpoint has its own in-loop limits: 10KB max message, 60 msgs/min per connection, Origin-header check against CORS_ORIGINS (skipped entirely when CORS_ORIGINS unset/"*", and skipped when Origin header absent — non-browser clients bypass it).
- `GET /api/health`: pings Mongo admin command; 200 `{status:"healthy", version:"1.0.0", service:"RxHive API", timestamp, database:"connected"}` or 503 with status "unhealthy".

## 7. Settings / env vars (`config.py`)
Pydantic BaseSettings + python-dotenv (`load_dotenv()`, `env_file=".env"`, `extra="allow"`):
- `MONGO_URL` (default `mongodb://localhost:27017`)
- `DB_NAME` (default `rxhive`)
- `JWT_SECRET` (default "" -> replaced at import time with `secrets.token_urlsafe(64)` + warning; tokens don't survive restarts, and multi-worker deployments get DIFFERENT secrets per worker)
- `JWT_ALGORITHM` = "HS256" (hardcoded, but overridable via env since it's a BaseSettings field)
- `ACCESS_TOKEN_EXPIRE_MINUTES` = 15, `REFRESH_TOKEN_EXPIRE_DAYS` = 7, `BCRYPT_ROUNDS` = 12 (all env-overridable via BaseSettings)
- `CORS_ORIGINS` (default "", comma-separated origins)
- `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` (defaults "" -> seed skipped), `SUPERADMIN_NAME` (default "Super Admin")

## Extra wire-format notes for the rebuild
- Passwords: bcrypt via the `bcrypt` package directly (not passlib), 12 rounds, utf-8. `utils/security.py:validate_password` enforces 8+ chars w/ upper+lower+digit, but `models/schemas.py:CreateUser` only enforces `min_length=6` — enforcement depends on which route validates.
- `utils/security.py` also provides `sanitize_text` (bleach strip-all-tags; applied to message content), `generate_secure_password(14)`, `sanitize_filename` (path-traversal guard).
- Login flow checks `superadmins` collection first, then `users`; deactivated users get 401 "Account is deactivated". Login sets `status:"online"` + `last_seen`; logout sets `status:"offline"` + `last_seen` and nulls `refresh_jti`.
- `GET /api/auth/me` user response adds `avatar_url`, `about`, `status` (default "offline").
- Profile self-update (`search.py`) constrains display_name 1-50 chars and about <=140 chars — different from CreateUser's 2-100.
