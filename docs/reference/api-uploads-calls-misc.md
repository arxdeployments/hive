# API contract — 4

ROUTER MOUNTING (/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/main.py): all routers are included with NO extra prefix at include_router time — each APIRouter carries its own full prefix: uploads → "/api", calls → "/api/calls", search → "/api", cross_org → "/api/admin/cross-org-groups", contacts → "/api/users", validation → "/api/admin/validate", dev → "/api/dev"; also auth ("/api/auth"), admin, conversations, messages, groups, org_admin, and the websocket router (app.websocket.endpoint). Mount order: auth, admin, validation, conversations, messages, contacts, dev, groups, uploads, search, cross_org, org_admin, calls, ws. CRITICAL MOUNTING BUG: the login rate-limit patch loops over auth.router.routes looking for route.path == "/login", but APIRouter(prefix="/api/auth") stores routes with path "/api/auth/login", so the condition NEVER matches and the "5/minute" limiter is never applied — login has NO rate limiting (and even if it matched, reassigning route.endpoint after route construction wouldn't rebind Starlette's cached handler). CORS: explicit origins from settings.CORS_ORIGINS, falls back to allow_origins=["*"] WITH allow_credentials=True when unset (dev warning only) — invalid per spec but a footgun. Security headers middleware adds X-Content-Type-Options/X-Frame-Options/X-XSS-Protection/Referrer-Policy (no CSP, no HSTS). SHARED HELPERS: app/utils/serializers.py serialize_doc recursively stringifies ObjectIds and datetimes but PRESERVES the "_id" key name (frontend must read `_id` on serialize_doc-based responses e.g. calls history/link/scheduled and cross-org groups, but `id` on hand-built responses e.g. contacts/search/profile — inconsistent). _serialize_datetime assumes naive datetimes are UTC and emits trailing "Z". AUTH DEPENDENCIES (app/auth/middleware.py): require_auth = valid JWT access token, returns raw JWT payload (user_id, org_id?, role, type) with NO DB check — deactivated/deleted users keep API access until token expiry; require_superadmin re-verifies against db.superadmins; require_org_admin accepts role in [superadmin, admin] with no DB or org check. CROSS-CUTTING SECURITY: (1) GET /api/uploads/{filename} is fully unauthenticated file serving; (2) every $regex search endpoint (search q, contacts search, cross-org list search) interpolates user input unescaped — regex injection/ReDoS; (3) /api/dev/seed-chat-data is live in prod; (4) TURN credentials hardcoded; (5) duplicate "$or" dict key in /api/search conversations query drops org scoping. PAGINATION CONVENTIONS: mixed — {data, total, page, limit} (calls history, cross-org list), {data, total, has_more} (media), bare arrays (contacts, scheduled calls). MISC: PUT /api/users/profile lives in search.py; uploads have no DB records so orphan cleanup is impossible; call_history participant user_ids are plain strings while all other collections use ObjectIds.

## POST /api/upload
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/uploads.py
- auth: require_auth (any authenticated user; payload unused beyond gating)
- request: multipart/form-data with single field `file` (UploadFile, required). Allowed image exts: .jpg .jpeg .png .gif .webp (max 16MB); allowed doc exts: .pdf .doc .docx .xls .xlsx .ppt .pptx .txt .csv .zip (max 100MB).
- response: {"file_id": str(uuid4), "filename": <original client filename>, "file_url": "/api/uploads/<uuid><ext>", "file_type": "image"|"document", "file_size": int bytes, "mime_type": str} plus, for images only, "thumbnail_url": "/api/uploads/<uuid>_thumb.jpg" (falls back to file_url if Pillow thumbnail generation fails). Errors: 400 "No file provided" / "File type not supported" / "Image too large (max 16MB)" / "File too large (max 100MB)".
- behavior: Saves raw bytes to backend/uploads/<uuid><ext> on local disk (dir auto-created). Generates 200px JPEG thumbnail via PIL for images (RGBA/P flattened onto #1A1A1A background, quality 80). No DB record is created for the upload — files are orphaned metadata-wise. SECURITY: validation is extension-only (no magic-byte sniffing); mime_type trusts client Content-Type first (`file.content_type or _get_mime(ext)`). Whole file read into memory (`await file.read()`) — a 100MB doc buffers fully in RAM. No org/conversation scoping on uploads.

## GET /api/uploads/{filename}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/uploads.py
- auth: NONE — completely unauthenticated
- request: Path param `filename` (str). No query params.
- response: FileResponse with media_type from extension map (default application/octet-stream), headers Content-Disposition: `inline; filename=<filename>` if image ext or filename contains "_thumb", else `attachment; filename=<filename>`; Cache-Control: public, max-age=31536000. Errors: 403 "Access denied" (path escape), 404 "File not found".
- behavior: Serves any file in the uploads dir to ANYONE who knows/guesses the URL — SECURITY HOLE: no auth, no membership check; uuid4 names are the only protection, and file_url/thumbnail_url values are stored in messages so any leaked URL is world-readable forever (1-year cache). Path traversal guard uses `os.path.abspath(join).startswith(os.path.abspath(UPLOAD_DIR))` — BUG: missing trailing os.sep in the startswith check, so a sibling dir like `<parent>/uploadsXYZ` would pass the prefix test. Content-Disposition interpolates raw filename into the header unsanitized (header-injection shape; Starlette will reject CR/LF but quotes/commas are not escaped).

## GET /api/conversations/{conv_id}/media
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/uploads.py
- auth: require_auth + conversation membership (find_one on {_id, participants.user_id: ObjectId(user)})
- request: Path param `conv_id` (str, must be valid ObjectId else 400 "Invalid conversation ID"). Query: `type` (str, default "image"), `page` (int, default 1, ge=1), `limit` (int, default 30, 1..100).
- response: {"data": [{"message_id": str, "media_url": str|null, "thumbnail_url": str|null, "filename": str (taken from message `content` field, default ""), "file_size": int (default 0), "sender_name": str ("Unknown" if sender doc missing), "created_at": ISO-8601 str with Z}], "total": int, "has_more": bool ((skip+limit) < total)}. 404 "Conversation not found" if not a participant.
- behavior: Lists a conversation's media messages: query {conversation_id, type: <type param>, is_deleted: {$ne: true}}, sorted created_at desc, paginated. `type` is not validated against an allowlist, so type=text works and returns text messages reshaped as media items. N+1: one users.find_one per message for sender_name. Does not respect per-user `deleted_for` (delete-for-me messages still appear in media grid).

## GET /api/calls/history
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: Query: `page` (int, default 1, ge=1), `limit` (int, default 20, 1..100), `filter` (str, default "all"; recognized: "missed" → status=missed AND initiator.user_id != me; "incoming" → initiator.user_id != me; "outgoing" → initiator.user_id == me; anything else = all).
- response: {"data": [serialize_doc(call_history doc) — keeps Mongo field names incl. "_id" (stringified), plus computed "direction": "outgoing"|"incoming" and "other_participant": <first participant dict where user_id != me>|null], "total": int, "page": int, "limit": int}.
- behavior: Reads db.call_history matching {"participants.user_id": user_id} where user_id is the raw JWT STRING, not ObjectId — this only works because the WS call_manager writes participant user_ids as strings; inconsistent with every other collection which stores ObjectIds. Sorted started_at desc. No org scoping (fine, calls are per-user). Response docs expose whatever call_manager stored (typically _id, call_id, call_type, initiator {user_id, display_name}, participants [{user_id, display_name, avatar_url}], status, started_at, ended_at, duration, seen_by).

## GET /api/calls/missed-count
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: No params.
- response: {"count": int}
- behavior: count_documents on call_history where participants.user_id == <me as string>, status == "missed", initiator.user_id != me, and seen_by does not contain me. Used for the missed-calls badge.

## POST /api/calls/mark-seen
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: No body.
- response: {"message": "Marked as seen"}
- behavior: update_many $addToSet user_id (string) into `seen_by` on EVERY call_history doc the user participates in (not just missed ones) — harmless over-marking; clears the missed badge.

## GET /api/calls/ice-servers
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: No params.
- response: {"iceServers": [{"urls": str}, ... 5 Google STUN entries, {"urls": [str, str, str], "username": "openrelayproject", "credential": "openrelayproject"}]} — exact WebRTC RTCIceServer shape.
- behavior: Returns hardcoded STUN (stun.l.google.com:19302 .. stun4) plus the public openrelay.metered.ca TURN relay with hardcoded shared credentials. ISSUE: openrelay is a free public service (unreliable/deprecated) and credentials are baked into source — production needs its own TURN with per-session credentials.

## POST /api/calls/create-link
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: JSON body CreateLinkRequest: {"call_type": str, default "video"} — value not validated against an enum.
- response: {"code": "xxxx-xxxx-xxxx" (3 groups of 4 lowercase letters, secrets-random), "url": "/call/<code>", "call_type": str (echoed)}
- behavior: Inserts db.call_links doc {code, creator_id: ObjectId, call_type, created_at, is_active: true}. No uniqueness check on code (collision chance negligible: 26^12). Links never expire and are never deactivated anywhere in this file.

## GET /api/calls/link/{code}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: Path param `code` (str).
- response: serialize_doc(call_links doc): {"_id": str, "code": str, "creator_id": str, "call_type": str, "created_at": ISO str, "is_active": true}. 404 "Call link not found" if missing/inactive.
- behavior: Looks up {code, is_active: true}. Any authenticated user from ANY org can resolve any link — acceptable for meet-style links but leaks creator_id across orgs.

## POST /api/calls/schedule
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: JSON body ScheduleCallRequest: {"title": str (required), "description": str|null, "start_time": str ISO (required), "end_time": str|null, "call_type": str default "video", "reminder_minutes": int default 15, "participant_ids": [str] default []}.
- response: serialize_doc of inserted doc: {"_id": str, "title": str, "description": str|null, "call_type": str, "call_link_code": str (generated xxxx-xxxx-xxxx), "start_time": ISO str, "end_time": ISO str|null, "reminder_minutes": int, "creator_id": str, "participant_ids": [str], "org_id": str|null, "status": "scheduled", "created_at": ISO str}.
- behavior: Inserts db.scheduled_calls. BUGS: datetime.fromisoformat(body.start_time/end_time) raises unhandled ValueError → 500 on malformed input; a naive ISO string (no offset) is stored and later compared/assumed UTC, so local-time strings shift. participant_ids are converted to ObjectId with no existence/org-membership validation (invalid hex → unhandled bson error → 500; you can 'invite' users from other orgs). call_link_code is generated but NO call_links doc is inserted, so GET /api/calls/link/{code} will 404 for scheduled-call codes. No notification/WS event to participants.

## GET /api/calls/scheduled
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth
- request: No params.
- response: Bare JSON array (no wrapper) of serialize_doc(scheduled_calls docs) — same fields as POST /schedule response.
- behavior: Finds {$or: [{creator_id: me}, {participant_ids: me}], status: "scheduled", start_time: {$gte: now UTC}} sorted start_time asc. Past/ended calls silently disappear; nothing ever transitions status off "scheduled", and there is no cancel/update endpoint.

## POST /api/calls/ended
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/calls.py
- auth: require_auth (plus body.user_id must equal JWT user_id else 403 "Cannot end call for another user")
- request: JSON body CallEndedBeacon: {"call_id": str, "user_id": str}. Intended for navigator.sendBeacon on tab close.
- response: {"message": "OK"} always (even if call not found).
- behavior: Looks up the in-memory call in call_manager; if present, sends WS {"type": "call:ended", "call_id": str, "reason": "disconnected", "duration": <seconds>} to every OTHER participant then call_manager.end_call(). NOTE: sendBeacon cannot set an Authorization header, so with require_auth this beacon fails in real tab-close usage unless the frontend uses fetch keepalive with the header — likely broken as a beacon. Doesn't verify the caller is actually a participant of the call (any user can end any call they know the id of, sending fake call:ended to its participants — user_id check only prevents impersonation of the beacon sender, not membership).

## GET /api/search
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/search.py
- auth: require_auth
- request: Query: `q` (str, min_length=1, default "" — explicit q= empty triggers 422; omitted q uses default and returns empty buckets), `types` (str CSV, default "conversations,contacts,messages").
- response: {"conversations": [{"id": str, "name": str, "type": str, "avatar_url": str|null}], "contacts": [{"id": str, "display_name": str, "email": str, "avatar_url": str|null, "department": str ("" if none)}], "messages": [{"message_id": str, "conversation_id": str, "conversation_name": str, "content_snippet": str (first 200 chars), "sender_name": str, "created_at": ISO str}]} — always all three keys, each bucket max 5 items. All buckets empty if token has no org_id (superadmin).
- behavior: Three sub-searches, each gated on org_id in token. BUG: the conversations query dict literal defines "$or" TWICE — the second {name regex} $or silently overwrites the first org-scoping $or, so cross-org/org filtering is dropped (participant filter still limits blast radius, but archived-conv naming aside, a user's cross-org convs match regardless of allowed_org_ids). Falls back to matching direct convs by other-participant display_name (org-scoped users only). SECURITY: `q` and `search` are interpolated raw into $regex with "i" option — regex injection / ReDoS (e.g. q=(a+)+$). Message search runs regex over content of ALL user conversations' text messages (unindexed, collection scan), does not respect deleted_for, and does N+1 conv+sender lookups per hit. Direct-chat name resolution compares p["user_id"] != user_oid correctly (ObjectId).

## PUT /api/users/profile
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/search.py
- auth: require_auth
- request: JSON body ProfileUpdate: {"display_name": str|null (trimmed, 1..50 chars else 400), "about": str|null (≤140 chars else 400, then trimmed), "avatar_url": str|null (NO validation — any string accepted, incl. javascript:/data: URIs or arbitrary external URLs)}. At least one field required else 400 "No fields to update".
- response: {"id": str, "email": str, "display_name": str, "about": str (default ""), "avatar_url": str|null, "role": str|null, "status": str (default "offline"), "org_name": str ("" if none), "dept_name": str ("" if none), "org_id": str, "dept_id": str}.
- behavior: Misfiled in search.py. $set on db.users then re-reads user + dept + org for the response. BUG: response builds str(user["org_id"]) and str(user["dept_id"]) with direct key access — 500 KeyError if the user doc lacks dept_id/org_id (e.g. seeded or superadmin-ish accounts). No WS broadcast, so other users' cached contact names/avatars go stale until refresh. display_name length check runs before strip for the >50 case but after strip for <1 (minor: a 51-char name with trailing spaces that trims to ≤50 is still rejected).

## GET /api/admin/cross-org-groups
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin (JWT role==superadmin + DB re-check in superadmins collection)
- request: Query: `page` (int, default 1, ge=1), `limit` (int, default 10, 1..100), `search` (str, default "" — raw regex, injectable), `status` (str, default "active"; "active"→is_active:true, "archived"→is_active:false, other→both).
- response: {"data": [enriched group], "total": int, "page": int, "limit": int}. Enriched group = serialize_doc(conversation) — includes "_id": str, "type": "cross_org", "org_id": null, "cross_org": true, "allowed_org_ids": [str], "name", "description", "avatar_url", "purpose_tag", "created_by": str, "created_at", "last_message_at", "pinned_by": [], "is_active", "admin_only_messages" — PLUS overwritten "participants": [{"user_id": str, "display_name": str, "email": str, "avatar_url": str|null, "role": str (default "member"), "org_name": str ("Unknown" fallback), "org_id": str, "status": str (default "offline")}], "organizations": [{"id": str, "name": str}], "member_count": int, "last_message": {"content": str, "sender_name": str ("System" fallback), "created_at": ISO str, "type": str (default "text")}|null.
- behavior: Paginates conversations where {type: "cross_org", cross_org: true}, sorted created_at desc. Heavy N+1 enrichment (orgs, users, per-user org, last message + its sender) per group.

## POST /api/admin/cross-org-groups
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: JSON body CreateCrossOrgGroup: {"name": str (required, non-empty after strip), "description": str|null, "avatar_url": str|null, "purpose_tag": str default "Project", "org_ids": [str] (required, ≥2, each a valid active org else 400/404), "members": [dict] (required, ≥2 raw dicts of shape {"user_id": str, "role": "admin"|"member"}; untyped List[dict] so extra keys pass through)}.
- response: Enriched group object (same exact shape as list endpoint's items). Errors: 400 "Group name required" / "At least 2 organizations required" / "Invalid org ID: <id>" / "At least 2 members required" / "User <name> does not belong to a selected organization" / "At least 1 admin required" / "At least 1 member required from <org>"; 404 "Organization not found: <id>".
- behavior: Creates conversation {type: "cross_org", org_id: null, cross_org: true, allowed_org_ids, name, description, avatar_url, purpose_tag, participants: [{user_id, role, joined_at, unread_count: 0}], created_by, created_at, last_message_at, pinned_by: [], is_active: true, admin_only_messages: false}. Inserts a system message 'Cross-org group <name> was created' plus one 'Admin added <display_name>' per member (N inserts), updates last_message_at, WS-sends {"type": "conversation_created", "conversation": <enriched>} to every member, and writes an audit_logs doc (action "cross_org_group_created", ip_address always ""). QUIRKS: invalid/unknown member user_ids are silently skipped (a group can end up smaller than requested); the ≥2-members check counts raw input before that filtering, so a group can be created with only 1 actual participant if the other id was bogus (as long as the surviving one is admin and per-org coverage passes).

## GET /api/admin/cross-org-groups/{group_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path param `group_id` (str ObjectId else 400 "Invalid group ID").
- response: Enriched group object (exact shape as list items). 404 "Group not found".
- behavior: find_one {_id, type: "cross_org"} (active or archived) then enrich.

## PUT /api/admin/cross-org-groups/{group_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path param `group_id`. JSON body UpdateCrossOrgGroup: {"name": str|null (stripped), "description": str|null, "avatar_url": str|null, "purpose_tag": str|null, "is_active": bool|null} — all optional; empty-string name is NOT rejected (strip of "" stored).
- response: Enriched group object re-read after update. 400 "Invalid group ID", 404 "Group not found".
- behavior: $set of provided fields. If name changed, inserts system message "Group name changed to '<name>'" (but does NOT bump last_message_at). Broadcasts {"type": "conversation_updated", "conversation_id": str, "updates": <raw updates dict>} to the conversation's connected members. If is_active set false: WS {"type": "removed_from_conversation", "conversation_id"} to every participant (archive UX). If is_active true and was inactive: WS {"type": "conversation_created", "conversation": <enriched>} to every participant. Audit log "cross_org_group_updated" with stringified updates. NOTE: broadcast_to_conversation happens BEFORE archive/unarchive member notifications and sends the raw updates dict (contains only primitives here, safe).

## POST /api/admin/cross-org-groups/{group_id}/members
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path param `group_id`. JSON body AddMembersRequest: {"members": [dict] — each {"user_id": str, "role": str default "member"}}.
- response: Enriched group object. 400 "Invalid group ID", 404 "Group not found" (only active groups matched).
- behavior: Skips already-present/invalid/inactive users silently. If a new member's org is not in allowed_org_ids it is AUTO-ADDED via $addToSet (silently widens the group's org scope — arguably surprising). $push participants {user_id, role, joined_at, unread_count: 0} and bumps last_message_at; inserts one system message "Admin added <name>" per new member (inserted BEFORE the participant push). WS: {"type": "conversation_created", "conversation": enriched} to each NEW member; {"type": "member_added", "conversation_id": str, "conversation": enriched} to each PRE-EXISTING participant (from the stale pre-update participant list). Audit log "cross_org_member_added" {added: [str ids]}.

## DELETE /api/admin/cross-org-groups/{group_id}/members/{user_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path params `group_id`, `user_id` (both ObjectId strings else 400 "Invalid ID").
- response: {"message": "<display_name> removed"} (name "Unknown" if user doc missing). 404 "Group not found".
- behavior: $pull the participant, insert system message "Admin removed <name>", bump last_message_at. WS: {"type": "removed_from_conversation", "conversation_id"} to the removed user; broadcast {"type": "member_removed", "conversation_id": str, "user_id": str, "removed_by": str} to the conversation. Audit "cross_org_member_removed". BUGS: no check the user was actually a participant (removing a non-member still logs/system-messages "Admin removed"); dead code block computing org_has_members does nothing (acknowledged in comment) — a group can be left with zero members of some org, violating the creation invariant, and can even drop below 2 members/lose its last admin.

## POST /api/admin/cross-org-groups/{group_id}/archive
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path param `group_id`. No body — TOGGLES current state.
- response: {"is_active": bool (the NEW state)}. 400 "Invalid group ID", 404 "Group not found".
- behavior: Flips is_active. On archive: WS {"type": "removed_from_conversation", "conversation_id"} to all participants. On unarchive: WS {"type": "conversation_created", "conversation": enriched} to all participants. NOTE: unlike other mutations here, NO audit log entry and no system message.

## DELETE /api/admin/cross-org-groups/{group_id}
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/cross_org.py
- auth: require_superadmin
- request: Path param `group_id`.
- response: {"message": "Group deleted"}. 400 "Invalid group ID", 404 "Group not found".
- behavior: SOFT delete only — sets is_active: false (identical effect to archiving; messages and conversation doc are retained forever, and the /archive toggle can silently resurrect a "deleted" group). WS {"type": "removed_from_conversation"} to all participants; audit "cross_org_group_deleted".

## GET /api/users/contacts
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/contacts.py
- auth: require_auth
- request: Query: `search` (str, default "" — raw $regex on display_name OR email, case-insensitive, injectable).
- response: Bare JSON array: [{"id": str, "display_name": str, "email": str, "avatar_url": str|null, "department_name": str ("Unknown" if dept missing), "status": str (default "offline"), "last_seen": ISO str|null}]. Returns [] if token has no org_id.
- behavior: Lists ALL active users in the caller's org except self, sorted display_name asc. NO pagination — full org roster in one response (scales badly). N+1 departments.find_one per user. Field name is "department_name" here but the same concept is "department" in /api/search contacts bucket — inconsistent naming the frontend must handle.

## GET /api/admin/validate/org-name
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/validation.py
- auth: require_superadmin
- request: Query: `name` (str, required), `exclude_id` (str, optional — invalid ObjectId silently ignored).
- response: {"available": bool}
- behavior: Slugifies name via re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-') and checks organizations for an existing doc with that slug (excluding exclude_id). NOTE: the slug algorithm here must stay in sync with whatever admin.py uses at creation time; empty-name input yields slug "" and matches any org with empty slug.

## GET /api/admin/validate/user-email
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/validation.py
- auth: require_superadmin
- request: Query: `email` (str, required). No exclude_id support (unlike org-name), so edit flows re-validating an unchanged email will report unavailable.
- response: {"available": bool}
- behavior: Exact-match (case-SENSITIVE) find_one on both db.users and db.superadmins — BUG: Foo@x.com vs foo@x.com are treated as different, so duplicate emails differing only by case pass validation if creation also doesn't normalize.

## POST /api/dev/seed-chat-data
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/routes/dev.py
- auth: require_superadmin
- request: No body.
- response: On success: {"conversations_created": int, "messages_created": int, "details": [{"org": str, "participants": [str, str], "messages": int, "unread_for_user_b": int, "pinned_for_user_b": bool, "time_range": "today"|"yesterday"|"week"}]}. If <2 active users: 200 with {"error": str, "users_found": int, "hint": str} (error returned with 200 status).
- behavior: Dev/test seeding endpoint MOUNTED IN PRODUCTION main.py with no environment gate — a superadmin (or attacker with a superadmin token) can spam fake direct conversations and up to ~91 canned messages per org pair into live data. Per org with ≥2 users: creates up to 5 direct conversations between distinct user pairs (skipping pairs that already have an active direct conv) with configs (55 msgs/pinned/week, 12/yesterday, 5 msgs 4 unread/today, 1 msg 1 unread/today, 18 msgs 3 unread/week), alternating senders, randomized timestamps clamped to now, read_by seeded for sender, delivered_to for both. Sets pinned_by and per-participant unread_count on user_b.

## GET /api/health
- file: /Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/main.py
- auth: none
- request: No params.
- response: {"status": "healthy"|"unhealthy", "version": "1.0.0", "service": "RxHive API", "timestamp": ISO str, "database": "connected"|"not initialized"|"disconnected"} — 200 when healthy, 503 otherwise.
- behavior: Pings Mongo via db_client.admin.command("ping"). Defined directly in main.py after all routers.
