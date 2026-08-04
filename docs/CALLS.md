# Calls: gap analysis, contract, and what makes it robust

Voice and video calling across web (`frontend/`) and iOS (`ios/`), on a LiveKit SFU.
This document is two things: the **gap analysis** of why calls used to fail, and the
**wire contract** any client must implement — including an Android client, which does
not exist in this repository (see [Android](#android)).

---

## 1. Architecture, in one paragraph

Signalling and media are separate, and only signalling touches the API.

```
client ──WebSocket /api/ws──► API ──Redis pub/sub──► API ──WebSocket──► other client
   │           (call:* frames: who is calling whom, accept, hang up)          │
   └────────────────── LiveKit SFU (audio/video, room call_<uuid>) ───────────┘
                              tokens minted by POST /api/calls/{id}/token
```

The API is the single authority on whether a call exists, who is in it, and what state
it is in. Neither client decides anything the other cannot observe, which is what makes
web↔iOS↔Android interoperability a property of contract conformance rather than of
pairwise testing.

---

## 2. Gap analysis: why calls failed

The reported symptoms — *"sometimes the call gets initiated, sometimes it gets
connected, most of the time the call is not received or does not connect"* — were not
one bug. They were six, in three families. Every one of them was decided
**server-side**, which is why no amount of client work had fixed them.

### 2.1 Reachability — "the call is not received"

**A ring was refused whenever the callee had no live WebSocket *at that instant*.**
`initiate_direct_call` called `presence.is_online(callee)` and, if false, immediately
finalised the call as `no_answer` and answered the caller with `call:unavailable`. The
callee's device was never contacted at all.

That check is false far more often than "this person is unavailable":

| Cause | How often |
|---|---|
| iOS app not in the foreground — `RealtimeClient.applicationDidEnterBackground` **deliberately tore the socket down** | every time the user leaves the app |
| The server closes every socket `4001` when the 15-minute access cookie lapses | **every 15 minutes, per user** |
| Wi-Fi ↔ cellular handover, lift, tunnel, laptop lid | seconds at a time, constantly |
| Background browser tab: Chrome throttles timers to ~1/min, so the 30s heartbeat can exceed the server's 65s timeout | routinely |
| Redis blip — `is_online` degrades to `False` | rare, but total |

For an iOS user this meant a call was deliverable **only while they were actively
looking at the app**. That is the single largest cause of the reported behaviour.

**There was no push wake-up for calls.** `dispatch_push_to_users` was called only from
`messaging.py`. A device without a live socket had literally no channel by which to
learn about a call.

**There was no way to ask "what call am I in?"** Every `call:*` frame is a
fire-and-forget publish to a Redis channel. A ring published while the callee's socket
was reconnecting went to a channel with no subscriber and evaporated — permanently,
even though the server went on ringing for the rest of the window. On reconnect both
clients re-read only the missed-call badge.

### 2.2 Survivability — "it connects, then drops"

**A socket drop ended the call instantly.** `hub.py`'s `finally` block called
`handle_user_disconnect`, which called `_end(reason="disconnected")` with **no grace
period whatsoever**. Combined with the 4001-every-15-minutes close above, this means
**every call that outlived the remaining lifetime of the caller's access cookie died
mid-sentence**. Backgrounding the iOS app did the same. So did a two-second dead spot.

**LiveKit's reconnection was neither surfaced nor tolerated.** `RoomEvent.Reconnecting`
/ `Reconnected` were not wired on web at all, and `roomIsReconnecting` /
`roomDidReconnect` were not implemented on iOS. The only handler was `Disconnected` →
**end the call**. iOS was worse: `syncFromRoom` polled `room.connectionState` every
second and treated anything non-connected as `onRoomLost` → hang up. There was no
re-join attempt anywhere.

**Two clients of one user evicted each other.** `mint_token` set the LiveKit identity
to the bare `user.id`. A LiveKit identity must be unique per connection, so the second
connection was disconnected as `DUPLICATE_IDENTITY` — silently, because nothing was
listening for it. Both clients carried elaborate "only the device that pressed Accept
may join the room" guards to avoid tripping it; those guards were load-bearing, and a
page reload mid-call could still evict the reloaded tab's own predecessor.

**"Connecting…" had no timeout.** If `call:accept` never reached the server (web
`send()` returned `false` and only logged; iOS `send()` logged at debug and dropped),
or the reply never came back, both UIs sat on "Connecting…" **forever**. Worse,
`_accept` refused a retried Accept on an already-connected call with
`no_longer_ringing`, so tapping Answer again could not rescue it either.

**Silent refusals.** `_join` returned bare on every rejection path, so a joiner whose
group call had just ended waited on "Connecting…" with nothing to act on.

### 2.2b A socket that dies without an `onclose` — found by the E2E suite

The first two fixes above were written against `_onClose`, and the E2E test in §7 proved
that was not enough. Measured, with a browser context taken offline mid-call:

| t | `/api/ws` `readyState` |
|---|---|
| 0–35s | `1` OPEN |
| 50s | `2` CLOSING |
| 65s | `2` CLOSING — **stuck** |

A WebSocket closed while the network is gone cannot complete its closing handshake, so
it parks in `CLOSING` and **`onclose` never fires**. The old heartbeat made this
unrecoverable rather than merely slow:

```js
if (this.ws && this.ws.readyState === WebSocket.OPEN) {   // ← skips when broken
  this.send({ type: 'ping' });
  this.pongTimeout = setTimeout(() => this.ws.close(), 10000);   // ← wedges in CLOSING
}
```

The guard meant the liveness probe went *quiet* exactly when the socket was dead, and
`close()` produced no event. So nothing set the link state, nothing scheduled a
reconnect, and the client sat there **indefinitely** showing a live call with a duration
timer counting up over dead audio. Over a 70-second outage the socket sent no frame at
all and the console was empty — there was nothing to find in a log.

The same hazard applies to LiveKit's own signal socket, which is why iOS has always
polled `room.connectionState` and the web did not.

Fixed by not trusting the event as the only source:

- `_abandonSocket()` drops the socket **by reference** — handlers detached, `this.ws`
  nulled, state and reconnect driven directly — so a zombie in `CLOSING` cannot wedge
  the state machine.
- The heartbeat treats `readyState !== OPEN` as the failure it is, instead of skipping.
- A `window.addEventListener('offline')` handler flips the link state in ~1s, rather
  than waiting up to 40s for the next ping and its pong timeout.
- `livekitClient._startStateWatchdog()` polls `room.state` once a second, matching what
  iOS already did.

Effect, measured before and after:

| | before | after |
|---|---|---|
| Offline side shows "Connecting…" | **never** | **≤3s** |
| Peer shows "Connecting…" (server relay) | 38s | 38s |
| Call recovers after network returns | 63s | 45s |

### 2.3 Visibility — "no toast, no indication"

Connection quality existed as a coloured dot fed by `RoomEvent.ConnectionQualityChanged`
— **local leg only**, and never relayed. The SFU tells a struggling participant about
its own uplink and tells its peers nothing. So a user whose network was dying looked
perfectly healthy from the other side: a frozen picture, and a duration timer still
counting up over dead audio.

### 2.4 Operability

Ring timeouts were `asyncio` tasks in a module-level dict (`_ring_timers`). Invisible
to other workers, and **lost on any restart** — a deploy mid-ring left the row
`ringing` forever, so the caller heard ringback with no timeout and the call never
reached history.

---

## 3. What changed

### Backend

| Change | Where | Fixes |
|---|---|---|
| Ring regardless of presence; `callee_online` becomes a hint on `call:ringing_started` | `services/calls.initiate_direct_call` | 2.1 |
| Web Push dispatched to a callee with no socket; `kind:"call"` notification is persistent and vibrates | `services/calls._dispatch_call_push`, `public/sw.js` | 2.1 |
| `resume_calls_for` replays the ring (or full state) the instant a socket registers | `services/calls`, `realtime/hub` | 2.1 |
| `GET /api/calls/active` — authoritative resumable state, read from Postgres so it survives a Redis flush | `api/calls`, `services/calls.active_call_state` | 2.1, 2.2 |
| **Link-down grace**: a drop opens a 40s window and notifies peers; the call is resolved only if the user is still gone when it closes | `services/calls.handle_user_link_down` / `_grace_expired` | 2.2 |
| Durable, worker-agnostic deadlines in Redis sorted sets, swept every 2s by every worker | `services/call_deadlines`, `main._call_deadline_sweeper` | 2.4 |
| LiveKit identity is `{user_id}#{device_id}` | `services/calls.identity_for`, `mint_token` | 2.2 |
| Retried Accept on a connected call **replays** `call:accepted` instead of refusing | `services/calls._accept` | 2.2 |
| `call:link_state` inbound → `call:peer_state` relay | `services/calls._relay_peer_state` | 2.3 |
| `_join` answers every refusal with `call:error` | `services/calls._join` | 2.2 |
| A ringing call is joinable only by its initiator | `api/calls.call_token` | correctness |
| `_toggle_media` gated on the call being live | `services/calls._toggle_media` | correctness |
| Pub/sub subscribe happens **before** the socket is registered; re-subscribe if a reconnect raced the unsubscribe | `realtime/hub.LocalRegistry` | lost frames |
| Ring window 30s → 45s | `services/calls.RING_TIMEOUT_SECONDS` | 2.1 |

### Web

- `RoomEvent.Reconnecting` / `SignalReconnecting` / `Reconnected` wired; a final
  `Disconnected` triggers **five bounded re-join attempts** (~23s, inside the server's
  grace window) before the call is declared over.
- `mediaLinkState` / `signalLinkState` / `peerStates` in the store, combined by
  `isCallStalled`; every surface (`ActiveCallView`, `MinimizedCallBanner`) shows
  **"Connecting…"** and never the duration while stalled.
- `CallConnectivityWatcher` — one throttled, edge-triggered source of
  "Poor internet connection" / "Connection lost — reconnecting…" / "Connection
  restored", mounted at App level so it works while the call is minimised.
- `_resumeCallState()` on every socket open **and** on cold load; reconnect ceiling
  drops to 2s while a call is live; `online` / `visibilitychange` / `pageshow` trigger
  an immediate reconnect instead of waiting out the backoff.
- 20s accept timeout; undeliverable call frames now toast instead of only logging.
- `deviceId` persisted in `localStorage` so a reload reclaims the same identity.
- Participants keyed by **user id** with the identity retained, so
  `removeRemoteParticipantByIdentity` cannot delete a live tile after a reload.

### iOS

- `applicationDidEnterBackground` **keeps the socket open during a call** (the `audio`
  background mode keeps the process alive, so there was never anything to pre-empt).
- `LiveKitSession.mediaLink` driven by polled `room.connectionState`;
  `.reconnecting` is a pause, `.disconnected` starts a bounded re-join
  (`onNeedsRejoin`, same ~23s budget) before `onRoomLost` is allowed to fire.
- `CallStore.isStalled` / `isQualityPoor`; `announceConnectivity()` mirrors the web's
  throttled toasts; `ReconnectingBanner` and the minimised pill show "Connecting…".
- `reconcileWithServer()` on every reconnect and on foreground.
- 20s accept timeout; Accept refuses (with a toast) when the socket is down rather
  than starting a "Connecting…" that cannot finish.
- Persistent `deviceID`; room participants keyed by user id via
  `LiveKitSession.userID(of:)`.
- Reconnect backoff ceiling 30s → 2s while a call is live.

### Group calling

Group calls existed but were a closed set decided at second zero, with no way in for
anyone who was not on the ringing screen. What was missing, and where:

| Gap | Where it was | Now |
|---|---|---|
| The roster was fixed when the call started — `_join` admits only users who already hold a `CallParticipant` row, and those rows are created once from the conversation's membership | `services/calls` | `invite_to_call` + `POST /{id}/invite`; both clients have an "Add people" picker |
| Declining a group call did **nothing at all**: group calls are created `connected`, never `ringing`, so `_decline` returned before telling anyone. The decliner kept a roster row marked as still expected | `services/calls._decline` | Per-participant `call:participant_declined`; the call carries on |
| `call:group_active` was published and stored in `activeGroupCalls` and **nothing read it**, so a call was joinable only while its ring was on screen | web `ChatPanel`, iOS `ChatView` | `OngoingGroupCallBar` (web) / `ongoingCallBanner` (iOS) |
| The initiator of every group call held `callId: null` for the entire call — `call:group_initiate` carries a *conversation* id and nothing recorded the call id from `call:group_started`. Media worked (the join is handed the id directly), so this hid: the initiator's own `call:end` went out as `call_id: null` and the server dropped it, and any REST action built `/api/calls/null/...` | web `services/websocket` | The id is adopted from `call:group_started` / `call:group_participants` |
| Both "Add people" buttons were rendered with no `onClick` at all | web `ActiveCallView`, `OutgoingCallScreen` | Wired on the group screens; **removed** from the outgoing screen, where it can never do anything |
| The local screen-share tile showed the camera | web `livekitClient` | `_localScreenStream()` |
| Layout past a handful of people, and no ranking — the active speaker could be off screen | web + iOS grids | Local pinned, then speakers, then live cameras; web caps at 9 visible with a `+N` tile, iOS keeps a lazy scrolling grid (the native idiom, and `adaptiveStream` pauses tracks with no element) |

---

## 4. The contract

Any client implementing this is interoperable with the others. There is no
platform-specific path.

### 4.1 Outbound (client → server), over `/api/ws`

| Frame | Payload | Notes |
|---|---|---|
| `call:initiate` | `callee_id`, `call_type`, `conversation_id?` | 1:1 |
| `call:group_initiate` | `conversation_id`, `call_type` | |
| `call:accept` | `call_id` | 1:1 only |
| `call:join` | `call_id` | group only |
| `call:decline` / `call:cancel` / `call:end` / `call:leave` | `call_id` | |
| `call:toggle_media` | `call_id`, `media_type`, `enabled` | relayed as `call:media_toggle` |
| `call:link_state` | `call_id`, `state?` (`connected`\|`reconnecting`), `quality?` (`excellent`\|`good`\|`poor`\|`unknown`) | relayed as `call:peer_state`; values outside the vocabulary are dropped |

### 4.2 Inbound (server → client)

Unchanged frames are documented in `docs/reference/ws-protocol.md`. New and changed:

- `call:ringing_started` — now also `callee_online: bool`, `ring_timeout: int`.
  `callee_online: false` is a **hint**, not a refusal; the call rings anyway.
- `call:incoming` — now optionally `replayed: true`, `ring_expires_in: float`.
  **Must be idempotent by `call_id`**: it is re-sent on every reconnect while ringing.
- `call:peer_state` — `{call_id, user_id, state?, quality?, grace_seconds?}`. A peer's
  own account of its link. `state: "reconnecting"` ⇒ show "Connecting…".
- `call:resume` — `{call: ActiveCallState|null}`. Sent on connect. Same shape as
  `GET /api/calls/active`.
- `call:error` — now carries `reason` for `not_found`, `not_a_participant`,
  `no_longer_ringing` (+`status`), `not_joinable` (+`status`).
- `call:participants_invited` — `{call_id, invited_by, participants[]}`. Sent to
  everyone **already in** the call when somebody adds people. Render the invitees as
  ringing placeholders; retire each one when they actually appear in the roster.
- `call:participant_declined` — `{call_id, participant_id, participant}`. **Group calls
  only.** One person refusing must not end a call the others are in, so this is a
  per-participant frame, not `call:declined`.
- `call:incoming` — additionally `invited: true` when the ring came from an invite into
  a call already in progress rather than from the call being placed.

### 4.3 REST

`POST /api/calls/{call_id}/token` — body `{device_id?: string}` →
`{token, url, room, identity, reconnect_grace_seconds}`.

`POST /api/calls/{call_id}/invite` — body `{user_ids: [uuid], 1..32}` →
`{invited: [uuid], outcome: {uuid: string}}`. REST rather than a `call:*` frame because
the caller needs the **answer**: `outcome` is per invitee, one of `invited`,
`already_invited`, `unavailable`, `different_org`, `call_full`. A client must report the
refusals individually — a partial result shown as a flat success is how somebody ends up
waiting for a person who was never rung.

Authorisation, all in `services/calls.invite_to_call`: only someone already in the call
may invite (otherwise knowing a call id makes anyone's phone ring), group calls only
(adding a third party to a 1:1 would silently change what two people agreed to be in),
each invitee org-checked against the inviter, and the cap counts everyone joined plus
everyone being added. `already_invited` means **in the room right now** — somebody who
holds a roster row but never answered, or who left, is rung again, because that is the
main reason to invite a person.

`GET /api/calls/active` → `{call: ActiveCallState|null}` where `ActiveCallState` is
`{call_id, status, call_type, is_group, conversation_id, room, initiated_by,
is_initiator, caller, group_name, participants[], joined[], self_joined, started_at,
answered_at, ring_expires_in, peer_links}`.

### 4.4 Rules a client MUST follow

1. **Identity.** Send a stable per-install `device_id`. Treat the room identity as
   `{user_id}#{device_id}` and split on the first `#` to correlate with signalling.
2. **Never join before the server says so.** Request a token only after
   `call:accepted` (1:1) or `call:group_participants` (group). A ringing call returns
   `400` to anyone but its initiator.
3. **Idempotence.** `call:incoming`, `call:accepted` and `call:resume` are all
   replayable. Re-joining a room you are already in must be a no-op.
4. **Reconnection is not a hang-up.** Show "Connecting…", keep the call, re-join with
   a bounded budget that fits inside `reconnect_grace_seconds`. Only end the call when
   that budget is spent.
5. **Resume on connect.** Fetch `GET /api/calls/active` on every socket open and on
   returning to the foreground. Adopt it additively — never end a call because a
   reconcile was slow, only because the server said there is none.
6. **Relay your own link state.** Send `call:link_state` on reconnect and on quality
   change. Without it your peer cannot know you are struggling.
7. **Bound "Connecting…".** ~20s after an Accept with no connection, tell the user.
8. **The room is the roster authority.** The socket contributes avatars and
   not-yet-published participants; the room contributes media. Never let a socket
   frame remove someone the room still reports.
9. **Mirror the front camera only, and only for display.**

   A self-view from the *front* camera is mirrored because people expect a mirror of
   their own face. The *back* camera is pointed at the world, and mirroring the world
   puts every sign, badge and screen in the scene back-to-front. Remote tiles are
   never mirrored: they were already composed the right way round by the sender.

   Two rules follow, and both were broken on iOS:

   - **Never mirror what you publish.** Mirroring is a property of the renderer, not
     of the track. If a client ever flips the capture buffer, every viewer sees
     reversed text and no amount of work at the other end can undo it.
   - **Do not let the call site decide.** Whether the live camera faces front changes
     under a camera flip, and can change without being asked when the platform falls
     back to another device. Ask the frame's own capture device instead. iOS had
     `mirrored: Bool` passed `true` for anything local, which mirrored the back camera
     in both the 1:1 self-view and the group grid; the fix is LiveKit's
     `VideoView.MirrorMode.auto`, which resolves per frame from
     `captureDevice.facingPosition`. Web draws the local tile untransformed, so it was
     already correct. An **Android** client should use the equivalent —
     `SurfaceViewRenderer.setMirror(...)` driven by the active
     `CameraX`/`Camera2` lens facing, re-read on every switch — and must not mirror in
     the capturer or a `VideoProcessor`.

   Aspect ratio is separate and must be a crop, never a stretch: `object-fit: cover`
   on web and `layoutMode = .fill` on iOS for camera tiles, `contain` / `.fit` for a
   screen share. Rotation is the capturer's job on every platform — do not apply a
   rotation of your own on top of it.
10. **Re-join as the user LEFT the call, not as they started it.**

    A re-join built from the original join intent silently undoes every media choice
    made since. On web that intent was captured once, so a camera switched off before a
    tunnel came back on by itself on the far side, and a muted microphone came back
    live — the worse of the two, and not something anyone notices in the second after
    their network returns. Re-join from the *current* state instead.

    Two details that are easy to get backwards:

    - **Publish the microphone and then mute it**, rather than not publishing it. "Muted"
      is a live publication carrying a muted track: peers see a microphone that is off,
      and unmuting later is a local operation. Re-joining with no audio track at all
      leaves the far side seeing no microphone whatsoever.
    - **Pass the camera you were using.** Both SDKs keep the publication alive across a
      mute, and unmuting restores the same device — but when there is no publication to
      unmute (a call joined as voice, a track the SDK dropped, a fresh re-join) they
      build a new track from platform defaults, which means the FRONT camera. Carry the
      chosen camera explicitly: `_cameraOptions` on web, `CameraCaptureOptions(position:)`
      on iOS.
11. **Serialise camera on/off, and tell the peers the state you REACHED.**

    Both SDKs lock internally, so two operations cannot corrupt a publication — but
    they can still finish out of order, and whichever finishes last writes the UI and
    sends `call:toggle_media`. Two taps inside one frame then leave the button, the room
    and the far side disagreeing. Chain the operations so the last tap is the last
    writer, read the target from your own state rather than from a rendered prop (a
    stale read makes every tap in a burst ask for the same thing), and put the state
    actually achieved on the wire — a camera that failed to open must not be announced
    as on. Update the UI optimistically first: reacquiring a camera is slow enough that
    a control which waits for it gets tapped again.

---

## 5. Android

**There is no Android client in this repository** (`ios/` and `frontend/` are the only
clients; no Kotlin, Gradle, or Android sources exist). The requested
`android → ios`, `ios → android`, `android → android` and `android ↔ web` paths
therefore cannot be exercised here.

What has been done instead is to make the requirement satisfiable by construction: the
server is the sole authority, the contract in §4 is platform-neutral and now fully
documented, and both existing clients implement it identically. An Android client built
against §4 — LiveKit Android SDK for media, an OkHttp WebSocket for signalling — will
interoperate with both without server changes. The two things it must add that iOS
still lacks are in §6.

---

## 6. Known remaining limitation: background ringing on mobile

A suspended mobile app cannot ring. On iOS, waking one for a call requires an **APNs
VoIP push (PushKit) reported through CallKit**; `CXProvider.reportNewIncomingCall` from
anything else is grounds for termination by the OS. Android needs an FCM
high-priority data message.

`push_subscriptions` stores **Web Push (VAPID) endpoints only** and has no column for
an APNs or FCM token, so neither can be delivered today. The mitigations now in place:

- the ring window is 45s, and `resume_calls_for` delivers the ring the moment the app
  is opened and its socket registers, so a call is answerable for its whole window
  rather than lost;
- the socket is no longer torn down when the app backgrounds **during** a call, so a
  live call survives the user switching apps;
- web clients — including an installed PWA — *are* woken, via Web Push.

Closing it properly needs: a `device_tokens` table (`user_id`, `platform`, `token`), an
APNs/FCM sender alongside `services/push.py`, a PushKit/FCM registration path in the
apps, and CallKit (iOS) / a foreground service (Android) to present the ring. That is a
feature, not a fix, and is deliberately out of scope here.

---

## 6b. Known latency: how fast the *other* side learns

Asymmetric, and the asymmetry is structural rather than a defect:

- **The affected side** knows in about a second — `offline`, the heartbeat, and the room
  watchdog are all local.
- **Their peer** can only learn from the server, and the server cannot tell a silent
  client from a slow one until `hub.HEARTBEAT_TIMEOUT` (65s) lapses since the last frame
  it received. Measured at ~38s in practice, because clients ping every 25–30s and the
  timeout runs from the last ping.

The call itself is unaffected — it survives, and both sides do show "Connecting…" — but
for up to ~65s the peer's screen is optimistic. `HEARTBEAT_TIMEOUT` cannot simply be
lowered: it has to exceed two client ping intervals or a single lost ping becomes a false
disconnect.

The way to close it is the **LiveKit webhook**, which is already wired
(`POST /api/livekit/webhook`). The SFU detects a participant's media timeout far faster
than the API detects a silent WebSocket, so a `participant_left` arriving while the call
row is still `connected` — and with no `call:leave`/`call:end` from that user — is strong
evidence of a dropped link, and could publish `call:peer_state {state:"reconnecting"}`.
Not done here because `call:participant_left` currently means "remove the tile", and
changing what it implies touches group-call leave semantics that nothing in this work
otherwise goes near.

## 7. Verifying it

```bash
cd backend && .venv/bin/pytest -q tests/test_call_resilience.py tests/test_calls_and_media.py
```

`tests/test_call_resilience.py` covers each gap in §2 directly — ring-without-presence,
ring replay, link-down grace, grace expiry, sweeper-fired deadlines, exclusive deadline
claiming, retried Accept, and the identity round-trip — plus the invite path: who may
invite, group-calls-only, cross-org refusal, the per-invitee outcome, and re-ringing
somebody who left. The suite needs a real Postgres and Redis (see the root README).
**169 backend tests pass**, 51 of them call-related.

The E2E suite needs the stack plus a LiveKit SFU whose key/secret match the API's:

```bash
cd frontend && npx playwright test tests/calling.spec.js tests/group-calling.spec.js
```

Start the API with `RXHIVE_RATE_LIMIT_LOGIN=0` for a full run: the sign-in limiter is 10
per minute **per IP** and every browser context here shares `127.0.0.1`, so a longer suite
429s partway through and the failures surface as "the conversation list never appeared" on
a login page.

**30 E2E tests pass**, 15 of them calls (8 direct, 7 group). The group suite runs three
real browsers against a real SFU, which is the minimum that can tell "the roster works"
from "the roster happens to have one entry"; it covers three-way media, a participant
leaving without ending the call, joining a call already in progress, inviting somebody
from outside the conversation, adding people through the call screen's own button, and an
invitee declining. Two are new and are the ones that earned their
keep — `a ring placed while the callee is offline arrives when they come back` and
`a network drop mid-call shows "Connecting…" on both sides and then recovers`. The
second found §2.2b, which no amount of reading would have: the failure was the *absence*
of an event, and the console was empty.

Note the media caveat in that test: Playwright's `setOffline` goes through CDP network
emulation, which reliably kills HTTP and WebSockets but does not necessarily stop WebRTC's
UDP media. It is therefore a faithful test of the **signalling** half — the half that used
to end the call outright. The media half is covered by the dead-SFU test.

Manual matrix worth walking before a release, per direction (web→web, web→iOS,
iOS→web, iOS→iOS, and each of those in a group):

1. Callee's app **closed/backgrounded** → does it ring on open, inside 45s?
2. **Answer, then turn off Wi-Fi on one side for ~10s** → both sides show
   "Connecting…", a toast appears, and the call resumes on its own.
3. **Leave the network off past 40s** → the call ends cleanly on both sides and lands
   in history with the right duration.
4. **Reload the web tab / relaunch the app mid-call** → the call comes back.
5. **Stay on a call longer than 15 minutes** → it survives the access-cookie refresh.
6. **Sign in on web and iOS as the same user, answer on one** → the other stops
   ringing, and the answering client is not evicted.
7. **Group: add somebody mid-call** → they ring, everyone already in the call sees a
   "Ringing…" tile, and it becomes a real tile when they answer.
8. **Group: have the invitee decline** → the placeholder disappears for everyone and the
   call carries on.
9. **Group: let the ring lapse, then join from the conversation's "Call in progress"
   banner** → media both ways.
10. **Camera off, then off/on again a few times quickly** → the button, your own tile
    and every peer agree at the end, audio never breaks, and a screen share in progress
    keeps going.
11. **Switch to the back camera, turn the camera off, turn it on** → it comes back on
    the BACK camera, not the front.
