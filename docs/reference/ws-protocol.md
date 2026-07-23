# 0

# RxHivexx WebSocket Protocol Catalog

Sources (read in full):
- `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/websocket/manager.py`
- `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/websocket/endpoint.py`
- `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/websocket/call_manager.py`
- `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/backend/app/websocket/call_handler.py`
- `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/frontend/src/services/websocket.js`

---

## 1. Connection + Authentication

**URL:** `{ws|wss}://{host}/api/ws?token={JWT_access_token}`

Client builds it from `process.env.REACT_APP_BACKEND_URL || window.location.origin`; `wss` if the backend URL starts with `https`. The JWT goes in the **query string** (`token` param) — note this leaks tokens into server/proxy access logs.

Server-side handshake (`endpoint.py`):
1. **Origin check** (before accept): if `settings.CORS_ORIGINS` is set and not `*`, the `Origin` header must be in the comma-separated allowlist, else close `4003 "Origin not allowed"`.
2. **Token required**: missing token → close `4001 "Token required"` (without accepting).
3. **JWT validation**: `decode_token(token)`; payload must have `"type": "access"`. Invalid → accept then close `4001 "Invalid token"`. Claims used: `user_id`, `org_id`, `name`.
4. Missing `user_id` claim → accept then close `4001 "Invalid token payload"`.
5. On success: `accept()`, register in ConnectionManager, then server sends:
   ```json
   {"type": "connected", "user_id": "<uid>", "timestamp": "<iso8601>"}
   ```

**Close codes:** `4000` = superseded by newer connection (new tab); `4001` = auth failure (client clears localStorage tokens and hard-redirects to `/login`); `4003` = origin rejected; `1000` = intentional client disconnect.

**Server-side receive loop limits:**
- `receive_text` with 65s timeout; if no `ping` received for >60s, the server breaks the loop (connection dropped).
- Max inbound message size 10KB → `{"type":"error","detail":"Message too large"}`.
- Rate limit: 60 messages/min per connection → `{"type":"error","detail":"Rate limited"}` (message is dropped, connection kept).
- **Bug:** the inner `try` only catches `asyncio.TimeoutError`. A frame that is invalid JSON, or valid JSON with a missing/non-string `"type"` (`msg_type.startswith` on `None` → `AttributeError`), propagates to the outer `except Exception` and silently kills the whole connection.

---

## 2. Message Types — Client → Server

All frames are JSON objects with a `type` discriminator.

| type | Fields | Semantics |
|---|---|---|
| `ping` | — | Heartbeat. Server replies `pong` and refreshes its 60s liveness timer. |
| `message` | `conversation_id`, `content`, `msg_type` (client always sends `"text"`; default `"text"`), `temp_id`, `reply_to` (message id or null) | Send chat message. Server sanitizes content, validates sender is an active participant, enforces org isolation (`conv.org_id` vs token `org_id`, unless `conv.cross_org`), enforces `admin_only_messages` for group/cross_org (role must be `creator`/`admin`). Persists to `messages`, updates `conversations.last_message_at`, acks sender, fans out `new_message`, tracks `delivered_to`/unread. |
| `typing_start` | `conversation_id` | Broadcast `typing` with `is_typing: true` to other participants. Not persisted. |
| `typing_stop` | `conversation_id` | Same with `is_typing: false`. |
| `read_receipt` | `conversation_id`, `last_read_message_id` | Marks all messages in the conversation with `created_at <= that message`, not sent by the reader, as read (`$addToSet read_by`); resets reader's `unread_count` to 0; broadcasts `messages_read`. **Security hole: no participant/org validation — any authenticated user can mark any conversation read by id.** |
| `call:initiate` | `callee_id`, `call_type` (`"voice"`\|`"video"`, default voice), optionally `conversation_id` (only echoed to callee) | Start 1:1 call. See §4. |
| `call:accept` | `call_id` | Accept ringing call. |
| `call:decline` | `call_id` | Decline; ends call, notifies caller, saves history, inserts system message. |
| `call:cancel` | `call_id` | Caller cancels; others get `call:cancelled`. |
| `call:end` | `call_id` | End the call; others get `call:ended`; history + system message saved. |
| `call:busy` | `call_id` | Callee reports busy; server relays `call:busy` to initiator and ends the call. (Client `websocket.js` never sends this — if used, it's from callStore elsewhere.) |
| `call:toggle_media` | `call_id`, `media_type` (`"audio"`\|`"video"`), `enabled` (bool) | Relayed to other participants as `call:media_toggle`. |
| `call:group_initiate` | `conversation_id`, `call_type` | Start a group call on a conversation. |
| `call:join` | `call_id` | Join an active group call (6-participant cap). |
| `webrtc:offer` | `call_id`, `target_id`, `sdp` | Blind relay: server stamps `from_id = sender` and forwards the whole frame to `target_id`. |
| `webrtc:answer` | `call_id`, `target_id`, `sdp` | Same relay. |
| `webrtc:ice-candidate` | `call_id`, `target_id`, `candidate` | Same relay. |

Routing note: the endpoint dispatches anything whose `type` starts with `call:` or `webrtc:` to `handle_call_message(user_id, data, manager)`.

---

## 3. Message Types — Server → Client

### Connection / heartbeat / errors
- `{"type":"connected","user_id","timestamp"}` — post-auth confirmation.
- `{"type":"pong","timestamp"}` — heartbeat reply.
- `{"type":"error","detail", ["temp_id"]}` — validation/rate errors. `temp_id` present on message-send failures so the client can reconcile the optimistic message (client currently only logs it).

### Messaging
- **`message_ack`** (to sender): `{"type":"message_ack","temp_id","message_id","created_at","status":"sent"}`. Client replaces the optimistic message (matched by `temp_id`, searched across all conversations) with `_id = message_id`.
- **`new_message`** (to each other participant): 
  ```json
  {"type":"new_message","message":{"_id","conversation_id","sender_id","sender_name","type","content","created_at","read_by":[],"delivered_to":[],"status":"delivered","reply_to":<id|null>}}
  ```
  Client: adds to store, bumps conversation preview; if not the active conversation → increments unread, plays a Web Audio beep, shows a browser Notification; if active → immediately sends `read_receipt`.
- **`message_status`** (to sender, after fan-out, only if ≥1 recipient was online): `{"type":"message_status","message_id","status":"delivered","delivered_to":[user_id,...]}`.
- **`messages_read`** (broadcast, excluding reader): `{"type":"messages_read","conversation_id","reader_id","last_read_message_id"}`. Client marks every message up to that id (not sent by `reader_id`) as `status:"read"`.

### Typing / presence
- **`typing`**: `{"type":"typing","conversation_id","user_id","user_name","is_typing":bool}`. Client auto-clears the indicator after 4s if no stop arrives.
- **`presence`** (sent to every distinct conversation partner on connect/disconnect): `{"type":"presence","user_id","status":"online"|"offline","last_seen":<iso|null>}` (`last_seen` only populated for offline).

### Conversation lifecycle (handled by the client; **emitted from REST route handlers, not from the websocket module** — they are part of the client-facing protocol):
- `conversation_created` — `{"conversation": <full conversation object with _id>}`
- `conversation_updated` — `{"conversation_id","updates":{...partial fields}}`
- `member_added` — `{"conversation_id","conversation":{participants:[...] ,...}}`
- `member_removed` — `{"conversation_id","user_id"}` (removed user's id)
- `removed_from_conversation` — `{"conversation_id"}` (sent to the removed user)
- `role_changed` — `{"conversation_id","user_id","new_role"}`
- `member_left` — `{"conversation_id","user_id"}`
- `reaction_update` — `{"message_id","conversation_id","reactions":[...]}`
- `message_deleted` — `{"message_id","conversation_id"}` (client blanks content, sets `is_deleted:true`)

### Call signaling (server → client)
- `call:incoming` — `{"call_id","caller":{"id","display_name","avatar_url"},"call_type","conversation_id"}`; group variant adds `"is_group":true,"group_name"`.
- `call:ringing_started` — `{"call_id","callee_id"}` (to caller; client stores the server-assigned `call_id` if its state is `outgoing_ringing`).
- `call:accepted` — `{"call_id","accepter_id"}` (to caller only).
- `call:declined` — `{"call_id"}` (to caller).
- `call:cancelled` — `{"call_id"}` (to non-cancelling participants; also sent when a ringing caller disconnects).
- `call:ended` — `{"call_id","reason":"normal"|"disconnected","duration":<seconds>}`.
- `call:missed` — to caller `{"call_id"}`; to callee `{"call_id","caller":{...},"call_type"}` (30s ring timeout, or callee disconnect while ringing).
- `call:busy` — `{"call_id"}` (callee already in a call, or relayed busy).
- `call:unavailable` — `{"call_id"}` (callee offline).
- `call:error` — `{"message"}`.
- `call:media_toggle` — `{"call_id","user_id","media_type","enabled"}`.
- `call:group_started` — `{"call_id","conversation_id"}` (to initiator).
- `call:group_active` — `{"call_id","conversation_id","participants":[{id,display_name,avatar_url}],"call_type"}` (to all other conversation members).
- `call:group_already_active` — `{"call_id","conversation_id"}`.
- `call:group_participants` — `{"call_id","participants":[{"id","display_name","avatar_url"}]}` (to a joiner: everyone already joined).
- `call:participant_joined` — `{"call_id","participant":{"id","display_name","avatar_url"}}`.
- `call:full` — `{"call_id","message":"Call is full (6/6 participants)"}`.
- `call:participant_left` — `{"participant_id"}` — **handled by client but NEVER emitted by the backend** (dead handler).
- `call:group_ended` — `{"conversation_id"}` — **handled by client but NEVER emitted by the backend** (dead handler).
- `webrtc:offer` / `webrtc:answer` / `webrtc:ice-candidate` — relayed inbound frame with `from_id` added: `{"type","call_id","target_id","from_id","sdp"|"candidate"}`.

---

## 4. Connection Registry (`manager.py`)

`ConnectionManager` singleton (`manager`):
- `active_connections: Dict[user_id_str, WebSocket]` — **one connection per user; last connection wins**. On a second connect the old socket is closed with `4000 "New connection opened"`.
- `_heartbeat_tasks: Dict[str, asyncio.Task]` — **dead code**: popped/cancelled in `disconnect()` but never populated anywhere.
- `connect(user_id, ws)`: registers, sets Mongo `users.status="online"` + `last_seen`, broadcasts `presence` "online" to all distinct partners across the user's active conversations.
- `disconnect(user_id)`: deregisters, sets `status="offline"` + `last_seen`, broadcasts `presence` "offline" with `last_seen`.
- `send_to_user(user_id, data) -> bool`: `send_json`; on exception evicts the entry and returns False. Return value doubles as the delivery signal (drives `delivered_to` vs `unread_count`).
- `broadcast_to_conversation(conversation_id, data, exclude_user)`: loads the conversation from Mongo **on every call** and `send_to_user`s each participant (no membership caching, no is_active/org checks).
- `is_online(user_id)`: dict membership.

**Architecture constraint:** purely in-process dicts (also `CallManager`'s state) — a single-worker deployment only; no Redis/pubsub, so it cannot scale horizontally. Multi-tab behavior is destructive: tab B kicks tab A with code 4000, and since the client does not treat 4000 as intentional, tab A auto-reconnects and kicks tab B — **two open tabs fight in a reconnect loop indefinitely**.

---

## 5. Call Signaling Flow (and what's broken)

### 1:1 flow (happy path)
1. Caller → `call:initiate {callee_id, call_type}`. Server checks: both users exist; **org isolation** (caller.org_id must equal callee.org_id → else `call:error`); callee busy → `call:busy` + history `"busy"`; callee offline → `call:unavailable` + history `"no_answer"`; caller already in call → `call:error`.
2. Server creates `call_id = uuid4()`, `CallState(status="ringing")`; callee ← `call:incoming`; caller ← `call:ringing_started`; a 30s ring timer starts.
3. Ring timeout: both sides ← `call:missed`, history `"missed"`, missed-call system message inserted into the direct conversation.
4. Callee → `call:accept {call_id}` → status `connected`, `answered_at` set, ring timer cancelled; caller ← `call:accepted {accepter_id}`. Client-side, the **caller** then invokes the global `window._rxhiveStartWebRTC(callId, callType, accepterId, userId, true)` to create the offer; SDP/ICE flows via the `webrtc:*` relay (`target_id`/`from_id` addressing, `sdp`/`candidate` payloads).
5. Either side → `call:end` → peers ← `call:ended {reason:"normal", duration}`; history status `"answered"` (if answered) else `"cancelled"`; call system message (`📞/📹`, duration `m:ss`) inserted.
6. `call:decline` → caller ← `call:declined`; history `"declined"`; declined system message.
7. Mid-call disconnect (socket drop): endpoint `finally` block — if ringing: initiator-drop → others ← `call:cancelled`; callee-drop → initiator ← `call:missed`; if connected: others ← `call:ended {reason:"disconnected",duration}`. Then `end_call`. **No call history is saved on the disconnect path.**

### Group flow ("mesh")
1. Initiator → `call:group_initiate {conversation_id, call_type}`. Rejected if a group call already exists on that conversation (`call:group_already_active`) or initiator is busy. Org isolation vs the conversation's org (unless `cross_org`). Call is created **immediately `connected`** (`answered_at` set), registered in `group_calls[conversation_id]`.
2. Online members ← `call:incoming (is_group:true, group_name)`; all members ← `call:group_active`; initiator ← `call:group_started`.
3. Member → `call:join {call_id}` → capped at 6 joined participants (`call:full`); joiner ← `call:group_participants` (already-joined list); existing participants ← `call:participant_joined`.
4. Client mesh negotiation: on `call:group_participants`, the joiner calls `meshCallManager.addPeer(id)` + `createOfferForPeer(id)` for **each** existing participant and sends `webrtc:offer {call_id, target_id, sdp}`; peers answer via `webrtc:answer`; ICE via `webrtc:ice-candidate`. Fan-out is full-mesh (N×(N−1) peer connections). Routing between mesh (`meshCallManager`) and 1:1 (`webrtcManager`) is decided per-frame by `callStore.isGroupCall`.

### What's broken / defective in call signaling
- **One participant leaving/disconnecting kills the whole group call.** `call:end` and the endpoint disconnect-cleanup both call `cm.end_call(call_id)` and emit `call:ended` to everyone — there is no per-participant "leave" path. The backend never sends `call:participant_left` or `call:group_ended` even though the client has handlers for both.
- **No ring timeout for group calls**; the "cancel ring timer for this user" pop in `call:join` operates on the per-call timer dict (and no timer was ever started), so unanswered group invites ring forever client-side.
- **No authorization on call control**: `call:accept`, `call:decline`, `call:end`, `call:cancel`, `call:busy`, `call:toggle_media`, and `call:join` never verify the sender is a participant of the call (or, for `call:join`, a member of the conversation / same org). Anyone with a `call_id` can join, end, or accept a call.
- **`webrtc:*` relay is a blind unicast forwarder**: no check that `from_id` and `target_id` share a call — any authenticated user can push arbitrary SDP/ICE frames to any user id.
- **`call:accepted` only goes to the initiator**; in multi-party scenarios other participants aren't informed. The caller-side WebRTC bootstrap depends on the fragile global `window._rxhiveStartWebRTC`.
- **`call:missed` is sent to the caller too**, and the client's `call:missed` handler unconditionally increments `missedCallCount` — the *caller's* badge increments for their own unanswered call.
- **`accept_call` marks the call `connected` for anyone**, cancels the ring timer, without confirming the accepter was the callee.
- Group call `call:group_active` is sent to all members regardless of online state (silently dropped for offline), and no group call history is saved (`save_call_history` is only invoked on 1:1 paths).
- **State is all in-memory** (`active_calls`, `user_calls`, `ring_timers`, `group_calls`) — a backend restart strands every client mid-call with no recovery signal.

(These, plus the WebRTC mesh itself, are what the rebuild replaces with LiveKit; the messaging/typing/presence/read-receipt events above are the surface to preserve verbatim.)

---

## 6. Client Reconnection Behavior (`websocket.js`)

- Singleton `RxHiveWebSocket` (`wsClient`). `connect(token)` is idempotent while CONNECTING/OPEN.
- **Heartbeat:** client sends `{"type":"ping"}` every 30s; expects `pong` within 10s or it calls `ws.close()` to force a reconnect. (Server independently drops if no ping for >60s.)
- **Backoff:** on any non-intentional close, reconnect after `min(1000 * 2^attempts, 30000)` ms — 1s, 2s, 4s, … capped at 30s, **infinite retries**; attempt counter resets to 0 on successful open.
- **Auth failure (close code 4001):** no reconnect — clears `access_token`, `refresh_token`, `user` from localStorage and hard-redirects to `/login`. **There is no token refresh on the WS path**: an expired access token during a reconnect boots the user to login.
- **Code 4000 (superseded)** is *not* treated as intentional → the kicked tab reconnects and the two tabs kick each other in a loop (see §4).
- **Offline queueing:** `send()` while not OPEN pushes to `messageQueue`; the entire queue is flushed FIFO on the next open (a failed `_rawSend` re-queues). Stale typing/ping events get replayed too.
- **Resync:** if the open is a reconnect (`reconnectAttempts > 0`), the client re-fetches `GET /api/conversations` via the REST client and replaces the conversation list — messages missed while offline are only recovered when a conversation is (re)opened.
- `disconnect()` sets `_intentionalClose`, closes with `1000 "User disconnected"`, suppressing reconnect. Store flags `wsConnecting` / `wsConnected` in `chatStore` drive the UI connection indicator.