# API contract — 1

MOUNTING (main.py): every router is included with app.include_router(<module>.router) and NO extra prefix, so the full path is exactly the APIRouter prefix + route path: auth.py → prefix \"/api/auth\", admin.py → \"/api/admin\", org_admin.py → \"/api/org-admin\" (hyphen, not underscore). main.py also defines unauthenticated GET /api/health returning { status: \"healthy\"|\"unhealthy\", version: \"1.0.0\", service: \"RxHive API\", timestamp: ISO, database: \"connected\"|\"not initialized\"|\"disconnected\" } with 503 when unhealthy. Login rate limiting is applied in main.py by mutating auth router's /login route.endpoint with slowapi limiter.limit(\"5/minute\") BEFORE include_router — this works only because include_router rebuilds routes from route.endpoint, and only /login is limited (refresh is not); `original_login = auth.router.routes` is dead code.

SERIALIZATION CONVENTION (app/utils/serializers.py serialize_doc): ObjectIds → strings, datetimes → ISO-8601 with \"Z\" suffix, recursive. CRITICAL: serialize_doc KEEPS the key `_id` (string value) — it does not rename to `id`. So all admin/org-admin CRUD responses expose `_id`, while the hand-built responses (auth /login, /me, and GET /api/admin/organizations/{org_id}/users) expose `id`. A rebuild must preserve this split exactly or normalize it deliberately on both sides.

AUTH MIDDLEWARE (app/auth/middleware.py): require_auth = decode JWT, require type==\"access\", NO DB lookup, NO is_active check. require_superadmin = same + role==\"superadmin\" + DB existence check in superadmins. org_admin.py uses its own inline _require_org_admin (require_auth + role exactly \"admin\" + org_id claim) — superadmins CANNOT call /api/org-admin/* endpoints. There is also an unused require_org_admin in middleware.py (accepts superadmin OR admin) — dead code that no route in these three files imports.

CROSS-CUTTING SECURITY HOLES: (1) Deactivation never revokes sessions — is_active:false (single, bulk, or org cascade) leaves refresh_jti intact and /api/auth/refresh never checks is_active, so a deactivated user can mint fresh access tokens forever; access tokens are also honored until expiry with no DB check for regular users. (2) All search params are interpolated into Mongo $regex unescaped (regex injection / ReDoS). (3) Both reset-password endpoints return the new password in plaintext JSON with no force-change flag. (4) Superadmin bulk change_dept and PUT /users dept_id skip department existence/org-membership validation. (5) Org admin PUT /settings can create slug collisions. (6) Emails are never lowercased — case-variant duplicate accounts possible.

CONVENTION INCONSISTENCIES a rebuild must decide on: pagination envelope {data, total, page, limit} for lists vs bare arrays for dropdown-style endpoints (/organizations/all, /organizations/{id}/users, org-admin /departments, /activity); superadmin stats uses total_depts, org-admin stats uses total_departments; \"active_today\" everywhere actually means currently-online; audit log action naming differs (superadmin \"create_user\" vs org-admin \"user_created\"); org soft-delete vs department hard-delete; member/user counts sometimes include inactive users (superadmin) and sometimes not (org-admin); audit_logs.ip_address always \"\". Dead code: unused imports (Response, serialize_doc in auth.py; math in admin.py), refresh-token cookie fallback (no cookie ever set), superadmin refresh token generated but never returned by /login.

## POST /api/auth/login
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/auth.py
- auth: none (rate-limited 5/minute via slowapi wrapper applied in main.py)
- request: JSON body (LoginRequest): { email: EmailStr, password: str }. No other fields.
- response: Regular user (200): { access_token: str, refresh_token: str, user: { id: str, email: str, name: str (from display_name), role: str, org_id: str, dept_id: str } }. Superadmin (200): { access_token: str, user: { id: str, email: str, name: str, role: "superadmin" } } — NOTE: no refresh_token field for superadmin. 401 detail: "Invalid email or password" or "Account is deactivated".
- behavior: Checks db.superadmins by email first, then db.users. For users: rejects if is_active is falsy (default True if missing). On success stores refresh_jti on the account doc; for users also sets status="online" and last_seen=now(UTC). Access-token JWT payload for users: user_id, email, role, org_id, dept_id, name; for superadmin: user_id, email, role, name (no org_id/dept_id). BUGS: (1) superadmin response omits refresh_token even though it is created and its jti stored — superadmin sessions can never refresh (the frontend must re-login); (2) rate limiting is applied in main.py by mutating route.endpoint before include_router — works but is fragile and order-dependent; `original_login = auth.router.routes` in main.py is dead code; (3) a user doc missing org_id/dept_id raises KeyError → 500; (4) `Response` and `serialize_doc` imports in auth.py are unused (dead code).

## POST /api/auth/refresh
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/auth.py
- auth: none (validated by refresh token itself)
- request: JSON body: { refresh_token: str } — read manually via request.json(). Falls back to cookie "refresh_token" only if the body is not valid JSON; DEAD CODE: no endpoint ever sets that cookie.
- response: 200: { access_token: str, refresh_token: str }. 401 details: "Refresh token required", "Invalid refresh token", "Refresh token has been revoked".
- behavior: Decodes token, requires payload.type == "refresh". Verifies stored refresh_jti matches on db.superadmins (if role==superadmin) or db.users. Rotates: issues new access+refresh tokens carrying all prior claims except exp/type/jti/iat, and stores the new jti (single-session semantics — old refresh token is invalidated). SECURITY BUG: does NOT check user.is_active — a deactivated user whose refresh_jti was never cleared can refresh indefinitely (deactivation via admin endpoints never clears refresh_jti). BUG: malformed user_id in payload makes ObjectId() throw → unhandled 500. No rate limit on this endpoint (only /login is limited).

## POST /api/auth/logout
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/auth.py
- auth: user (require_auth — any valid access token, JWT-only, no DB check)
- request: No body. Bearer access token only.
- response: 200: { message: "Logged out successfully" }
- behavior: Sets refresh_jti to None on superadmins or users collection (revokes refresh). For non-superadmin also sets status="offline" and last_seen=now(UTC). Access token itself remains valid until expiry (no blacklist).

## GET /api/auth/me
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/auth.py
- auth: user (require_auth)
- request: No params. Bearer access token.
- response: Superadmin: { id: str, email: str, name: str, role: "superadmin" }. User: { id: str, email: str, name: str (display_name), role: str, org_id: str, dept_id: str, avatar_url: str|null, about: str|null, status: str (default "offline") }. 404 "User not found" if doc gone.
- behavior: Fresh DB lookup on every call (superadmins or users collection based on token role). Note: hand-built response uses key `id` (unlike serialize_doc-based endpoints which use `_id`). Does not check is_active — a deactivated user with an unexpired access token still gets a 200.

## GET /api/admin/stats
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin (require_superadmin — role claim check + DB existence check of superadmin doc)
- request: None.
- response: { total_orgs: int, total_depts: int, total_users: int, active_today: int, recent_activity: [audit log docs via serialize_doc: { _id: str, actor_id: str, actor_type: str, action: str, target: str, details: object, ip_address: str (always ""), timestamp: ISO-8601 Z string }] } (10 most recent).
- behavior: Global counts across all orgs. MISNOMER: active_today is actually count of users with status=="online" right now, not active-today. ip_address in audit logs is always empty string (never captured — dead field).

## GET /api/admin/organizations
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Query: page: int (default 1, ge=1), limit: int (default 10, 1-100), search: str (default "", regex on name, case-insensitive, UNESCAPED — regex injection possible), sort: str (default "created_at"; whitelisted to name|created_at|slug else falls back to created_at), order: str (default "desc"; anything except "desc" means asc).
- response: { data: [ { _id: str, name: str, slug: str, logo_url: str|null, created_by: str, created_at: ISO Z, is_active: bool, dept_count: int, user_count: int } ], total: int, page: int, limit: int }. NOTE key is `_id`, not `id`.
- behavior: Paginated list including inactive orgs. user_count counts ALL users (active + inactive) — inconsistent with /organizations/all which counts only active. N+1 count queries per org (perf). search value goes straight into $regex (ReDoS / injection risk).

## POST /api/admin/organizations
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (CreateOrganization): { name: str (min 2, max 100, required), logo_url: str|null (optional) }.
- response: 201-style 200: serialized org doc { _id: str, name: str, slug: str, logo_url: str|null, created_by: str, created_at: ISO Z, is_active: true }. 400 "Organization name already exists" on slug collision.
- behavior: Slug generated as lowercase non-alphanumeric→hyphen; uniqueness enforced on slug (so "Acme Inc" and "acme-inc!" collide). Writes audit log action=create_organization. No validation of logo_url format.

## GET /api/admin/organizations/all
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: None.
- response: Bare JSON array (NOT a {data,...} envelope): [ { _id: str, name: str, slug: str, logo_url, created_by: str, created_at: ISO Z, is_active: true, user_count: int (active users only), dept_count: int } ] sorted by name asc.
- behavior: Only is_active:true orgs. Used as an unpaginated dropdown source. Declared BEFORE /organizations/{org_id} so routing is correct (order-dependent — must be preserved in a rebuild).

## GET /api/admin/organizations/{org_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: org_id (Mongo ObjectId string).
- response: Serialized org doc: { _id: str, name, slug, logo_url, created_by: str, created_at: ISO Z, is_active: bool }. 400 "Invalid organization ID", 404 "Organization not found".
- behavior: Plain fetch, no counts. Returns inactive orgs too.

## PUT /api/admin/organizations/{org_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (UpdateOrganization), all optional: { name: str (2-100), logo_url: str, is_active: bool }. None values are stripped — you cannot null out logo_url.
- response: Serialized updated org doc (same shape as GET). 400 "No fields to update" / "Organization name already exists" / "Invalid organization ID", 404 "Organization not found".
- behavior: Renaming regenerates slug and checks slug uniqueness against other orgs. Side effects: is_active=false cascades users.update_many({org_id}) → is_active:false; is_active=true blanket-reactivates ALL the org's users — BUG: users who were individually deactivated before the org was suspended get silently reactivated (individual deactivation state is destroyed). Deactivation does NOT clear users' refresh_jti, so their sessions survive (see /api/auth/refresh security bug). Audit log update_organization with raw update_data.

## DELETE /api/admin/organizations/{org_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: org_id.
- response: { message: "Organization deactivated" }. 400 invalid id, 404 not found.
- behavior: Soft delete only: sets org is_active:false and all its users is_active:false. Departments, conversations, messages are untouched. Sessions not revoked (refresh_jti kept — same security gap). Audit log delete_organization.

## GET /api/admin/departments
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Query: org_id: str (optional filter, 400 "Invalid org_id" if malformed), page (default 1), limit (default 10, max 100), search: str (unescaped regex on name).
- response: { data: [ { _id: str, org_id: str, name: str, description: str|null, created_at: ISO Z, member_count: int } ], total: int, page: int, limit: int }.
- behavior: member_count counts ALL users in dept (active + inactive) — inconsistent with org-admin's version which counts active only. Sorted created_at desc, not configurable. N+1 counts.

## POST /api/admin/departments
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (CreateDepartment): { org_id: str (required), name: str (2-100, required), description: str|null (optional) }.
- response: Serialized dept doc: { _id: str, org_id: str, name, description, created_at: ISO Z }. 400 "Invalid org_id"/"Department already exists in this organization", 404 "Organization not found".
- behavior: Validates org exists (even if inactive). Name uniqueness enforced per-org, exact case-sensitive match. Audit log create_department.

## GET /api/admin/departments/{dept_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: dept_id.
- response: Serialized dept doc { _id, org_id, name, description, created_at } — no member_count. 400 "Invalid department ID", 404 "Department not found".
- behavior: Plain fetch.

## PUT /api/admin/departments/{dept_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (UpdateDepartment), all optional: { name: str (2-100), description: str }. None values stripped — cannot clear description.
- response: Serialized updated dept doc. 400 "Invalid department ID"/"No fields to update"/"Department name already exists in this organization", 404 "Department not found".
- behavior: On rename, checks per-org name uniqueness. Audit log update_department.

## DELETE /api/admin/departments/{dept_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: dept_id.
- response: { message: "Department deleted" }. 400 "Invalid department ID" or "Cannot delete department: {n} active users", 404 "Department not found".
- behavior: HARD delete (delete_one) — inconsistent with org soft-delete. Only blocked by ACTIVE users; inactive users keep a dangling dept_id (their org_name/dept_name lookups then return "Unknown"). Audit log delete_department.

## GET /api/admin/users
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Query: org_id: str (optional, 400 if malformed), dept_id: str (optional, 400 if malformed), search: str (unescaped regex $or over display_name and email), status: str ("active"→is_active:true, "inactive"→is_active:false, anything else ignored), page (default 1), limit (default 10, max 100), sort (whitelist display_name|email|created_at|last_seen else created_at), order ("desc" default else asc).
- response: { data: [ { _id: str, org_id: str, dept_id: str, email, display_name, avatar_url: str|null, role: "admin"|"member", status: str, last_seen: ISO Z|null, about: str|null, created_by: str, created_at: ISO Z, is_active: bool, org_name: str, dept_name: str } ], total, page, limit }. password_hash and refresh_jti explicitly popped. org_name/dept_name fall back to "Unknown".
- behavior: N+1: two extra queries per user for org/dept names (perf). Key is `_id` not `id`.

## POST /api/admin/users
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (CreateUser): { org_id: str (required), dept_id: str (required, must belong to org), email: EmailStr (required), display_name: str (2-100, required), password: str (min 6, required), role: "admin"|"member" (enum, default "member") }.
- response: Serialized new user doc minus password_hash, plus org_name: str and dept_name: str: { _id: str, org_id: str, dept_id: str, email, display_name, avatar_url: null, role, status: "offline", last_seen: null, about: null, created_by: str, created_at: ISO Z, is_active: true, org_name, dept_name }. 400 "Invalid org_id"/"Invalid dept_id"/"Email already in use", 404 "Organization not found"/"Department not found in this organization".
- behavior: Email uniqueness checked against BOTH users and superadmins collections (exact-case; no lowercasing — "A@x.com" and "a@x.com" are distinct accounts, and login is exact-match too). Password stored via hash_password. Does not check org is_active — can create users in a deactivated org. Audit log create_user.

## GET /api/admin/users/{user_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: user_id.
- response: Same single-user shape as list rows (serialized doc minus password_hash/refresh_jti, plus org_name, dept_name). 400 "Invalid user ID", 404 "User not found".
- behavior: Plain fetch with org/dept name enrichment.

## PUT /api/admin/users/{user_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (UpdateUser), all optional: { display_name: str (2-100), dept_id: str, role: "admin"|"member", is_active: bool }. None values ignored. Email and password NOT updatable here.
- response: Updated user in same enriched shape (minus password_hash/refresh_jti, plus org_name/dept_name). 400 "Invalid user ID"/"Invalid dept_id"/"No fields to update", 404 "User not found".
- behavior: BUG: dept_id is only checked for ObjectId validity — NOT that the department exists or belongs to the user's org; can point a user at a nonexistent or cross-org department. SECURITY GAP: setting is_active=false does not clear refresh_jti or status, so the user keeps working until access-token expiry and can refresh forever. Audit log update_user with stringified values.

## POST /api/admin/users/{user_id}/reset-password
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: No body. Path: user_id.
- response: { temporary_password: str } — 12 chars from [A-Za-z0-9!@#$%]. 400 "Invalid user ID", 404 "User not found".
- behavior: Overwrites password_hash with a generated password and RETURNS IT IN PLAINTEXT in the response (by design — admin relays it out-of-band). No force-change-on-next-login flag exists. Does not revoke existing sessions (refresh_jti untouched). Audit log reset_password (logs the target email in details).

## POST /api/admin/users/bulk-action
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: JSON (BulkAction): { user_ids: [str] (required), action: "deactivate"|"activate"|"change_dept" (required), dept_id: str|null (required only for change_dept) }. Malformed ObjectIds in user_ids are silently skipped.
- response: { message: "{n} users deactivated" | "{n} users activated" | "{n} users moved" }. 400 "No valid user IDs"/"dept_id required for change_dept"/"Invalid dept_id"/"Invalid action".
- behavior: BUG: change_dept does NOT verify the target department exists, nor that it belongs to the same org as each user — can bulk-move users into a nonexistent department or across organizations. deactivate has the same session-revocation gap as PUT /users. Audit logs bulk_deactivate/bulk_activate/bulk_change_dept with modified counts.

## GET /api/admin/organizations/{org_id}/users
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/admin.py
- auth: superadmin
- request: Path: org_id. 400 "Invalid org ID" if malformed.
- response: Bare array grouped by department: [ { id: str, name: str, users: [ { id: str, display_name: str, email: str, avatar_url: str|null, role: str (default "member") } ] } ] — NOTE: this endpoint uses key `id` (hand-built), unlike the serialize_doc endpoints which use `_id`.
- behavior: Departments sorted by name asc; only is_active:true users, sorted display_name asc. Nonexistent org returns [] rather than 404. Used for cross-org contact pickers. N+1 user query per department.

## GET /api/org-admin/stats
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin (_require_org_admin: require_auth + role must be exactly "admin" + org_id claim present; superadmin tokens are REJECTED here)
- request: None.
- response: { total_users: int, active_today: int, total_departments: int, total_conversations: int } — NOTE different field names from superadmin stats (total_departments vs total_depts).
- behavior: All counts scoped to token's org_id. active_today again actually means status=="online" right now. total_conversations counts conversations with org_id + is_active:true. Org scoping comes solely from the JWT claim — no DB re-check that the admin is still active or still an admin (a demoted/deactivated org admin keeps admin API access until token expiry, and indefinitely via refresh — security gap).

## GET /api/org-admin/activity
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: None.
- response: Bare array of up to 10 serialized audit logs: [ { _id: str, actor_id: str, actor_type: str, action: str, target: str, details: { org_id: str, ... }, ip_address: "", timestamp: ISO Z } ].
- behavior: Filters audit_logs on details.org_id == org_id (string compare). Only catches logs whose details embed org_id as a string — org-admin-written logs always do; superadmin logs only sometimes (create_user/create_department include it, update/delete org actions do not), so the org activity feed is incomplete by design/accident.

## GET /api/org-admin/users
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: Query: dept_id: str (optional; malformed value SILENTLY IGNORED — no 400, unlike superadmin version), search: str (unescaped regex $or over display_name/email), status: "active"|"inactive" (else ignored), page (default 1), limit (default 10, max 100). No sort/order params (fixed created_at desc).
- response: { data: [ { _id: str, org_id: str, dept_id: str, email, display_name, avatar_url, role, status, last_seen: ISO Z|null, about, created_by: str, created_at: ISO Z, is_active: bool, dept_name: str } ], total, page, limit }. password_hash/refresh_jti popped. NO org_name field (unlike superadmin list).
- behavior: Always scoped to token org_id. N+1 dept lookup per user.

## POST /api/org-admin/users
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: JSON (OrgCreateUser, defined inline in this file): { dept_id: str (required, must be in admin's org), email: EmailStr (required), display_name: str (2-100, required), password: str (min 6, required), role: str (default "member"; validated at runtime to "admin"|"member" — plain str, not enum) }. No org_id field — taken from token.
- response: Serialized new user doc minus password_hash, plus dept_name: str (no org_name). Same field set as superadmin create. 400 "Invalid department ID"/"Email already in use"/"Role must be 'admin' or 'member'", 404 "Department not found in your organization".
- behavior: Org admin CAN create other org admins (role="admin" allowed). Email uniqueness checked against users AND superadmins. Role validation happens after the email checks. Audit log action "user_created" (different naming convention from superadmin's "create_user").

## GET /api/org-admin/users/{user_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: Path: user_id. 400 "Invalid user ID" if malformed.
- response: Serialized user doc minus password_hash/refresh_jti, plus dept_name. 404 "User not found" (also returned for users in OTHER orgs — correct tenant isolation via {_id, org_id} query).
- behavior: Properly org-scoped fetch.

## PUT /api/org-admin/users/{user_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: JSON (OrgUpdateUser), all optional: { display_name: str, dept_id: str, role: str, is_active: bool }. No length validation on display_name (unlike superadmin's 2-100). Invalid role values (not "admin"/"member") are SILENTLY ignored, not 400.
- response: Updated serialized user doc minus password_hash/refresh_jti, plus dept_name. 400 "Invalid user ID"/"Invalid department ID", 404 "User not found".
- behavior: dept_id IS validated to belong to the admin's org (better than the superadmin version). BUG: that validation's `raise HTTPException(400, 'Department not found in your organization')` sits inside a try whose `except Exception` catches it and re-raises as "Invalid department ID" — wrong error message for a valid-format-but-wrong-org dept. BUG: no "No fields to update" guard — an empty body succeeds and still writes an audit log with empty details. Org admin can deactivate themselves or demote other admins; deactivation again does not revoke sessions. Audit log "user_updated".

## POST /api/org-admin/users/{user_id}/reset-password
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: No body. Path: user_id.
- response: { temporary_password: str } (12 chars, plaintext in response). 400 "Invalid user ID", 404 "User not found".
- behavior: Org-scoped ({_id, org_id} lookup). Same plaintext-return and no-session-revocation caveats as the superadmin version. Audit log "password_reset". Note: an org admin can reset ANOTHER org admin's password — lateral account takeover within the org is possible by design.

## GET /api/org-admin/departments
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: None. No pagination (unlike superadmin version).
- response: Bare array: [ { _id: str, org_id: str, name: str, description: str|null, created_at: ISO Z, member_count: int } ] sorted name asc.
- behavior: member_count counts only is_active:true users — inconsistent with superadmin /api/admin/departments which counts all users.

## POST /api/org-admin/departments
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: JSON (OrgCreateDept): { name: str (2-100, required), description: str|null (optional) }. org_id from token.
- response: Serialized dept doc { _id, org_id, name, description, created_at }. 400 "Department already exists".
- behavior: Per-org name uniqueness (exact case-sensitive). Audit log "dept_created".

## PUT /api/org-admin/departments/{dept_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: JSON (OrgUpdateDept), all optional: { name: str, description: str }. NOTE: no min/max length on name here (unlike superadmin's 2-100).
- response: Serialized updated dept doc. 400 "Invalid department ID", 404 "Department not found".
- behavior: Org-scoped lookup. BUG: rename does NOT check name uniqueness within the org (superadmin version does) — duplicate department names possible via this path. No empty-body guard; audit log "dept_updated" fires even with no changes.

## DELETE /api/org-admin/departments/{dept_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: Path: dept_id.
- response: { message: "Department deleted" }. 400 "Invalid department ID" or "Cannot delete: {n} active users in this department" (different wording from superadmin's "Cannot delete department: {n} active users"), 404 "Department not found".
- behavior: Hard delete, org-scoped, blocked only by active users (inactive users left with dangling dept_id). Audit log "dept_deleted".

## GET /api/org-admin/settings
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: None.
- response: Serialized org doc: { _id: str, name: str, slug: str, logo_url: str|null, created_by: str, created_at: ISO Z, is_active: bool }. 404 "Organization not found".
- behavior: Returns own org's full doc.

## PUT /api/org-admin/settings
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/org_admin.py
- auth: org_admin
- request: JSON (OrgSettingsUpdate), all optional: { name: str, logo_url: str }. No length validation on name.
- response: Serialized updated org doc (same shape as GET /settings).
- behavior: Renaming regenerates slug inline (same regex as superadmin) but BUG: does NOT check slug uniqueness against other orgs — an org admin can rename their org to collide with another org's slug, breaking the superadmin-side uniqueness invariant. Empty name after strip is still accepted (e.g. name="!" yields empty slug). No empty-body guard; audit log "org_settings_updated" fires regardless.
