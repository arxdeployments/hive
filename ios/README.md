# RX HIVE — iOS

Native SwiftUI client for RX HIVE, talking to the **same backend as the web app**
(`../backend`) over the same HTTP + WebSocket API. No separate mobile API, no
schema fork.

```
ios/
├─ RxHive.xcodeproj/      Xcode 16+ project (synchronized folder — see below)
├─ Info.plist             bundle config, permissions, RXHIVE_API_URL indirection
└─ RxHive/
   ├─ RxHiveApp.swift     @main + RootView (the auth-phase switch)
   ├─ Core/               AppConfig, APIClient, APIError, RxHiveAPI (every endpoint)
   ├─ Models/             Codable wire models + copy-and-mutate helpers
   ├─ Realtime/           WebSocket client + the event vocabulary
   ├─ DesignSystem/       Theme tokens + shared components
   ├─ Features/           Splash, Auth, Conversations, Chat, Media, Calls,
   │                      Contacts, Search, Settings, OrgAdmin
   ├─ Utilities/          RxDate (wire + display date handling)
   └─ Assets.xcassets     accent colour, launch background, app icon slot
```

## Requirements

- **Xcode 16 or later.** The project uses a `PBXFileSystemSynchronizedRootGroup`
  (`objectVersion = 77`), so every file under `RxHive/` is compiled automatically
  and the project file never needs editing when you add one. Xcode 15 cannot open it.
- iOS 17.0 deployment target.
- One Swift package, resolved on first open: **LiveKit**
  ([`client-sdk-swift`](https://github.com/livekit/client-sdk-swift), 2.x) — the
  same SFU client the web app uses via `livekit-client`.

## Running it

1. Start the backend stack (from the repo root):

```bash
cd infra && docker compose up --build
```

2. Point the app at it. The API origin is a **build setting**, not a constant:

| Configuration | `RXHIVE_API_URL` |
|---|---|
| Debug | `http://localhost:8000` |
| Release | `https://rxhive.example.com` ← change before shipping |

Edit it in the target's build settings, or better, in an `.xcconfig`. It reaches
`AppConfig.apiBaseURL` through `Info.plist`. The WebSocket origin is derived from
it (`http`→`ws`, `https`→`wss`), so the two can never disagree.

`AppConfig` **crashes at launch** if the value is missing or malformed. That is
deliberate: a silent fallback to localhost looks exactly like a network outage on
a tester's phone.

3. Simulator runs against `http://localhost:8000` as-is. A **device** needs your
   Mac's LAN address, and a plain-HTTP LAN host needs an ATS exception — add
   `NSExceptionDomains` for that host specifically rather than disabling ATS.

4. Sign in with an account a super admin has **approved for mobile** (below).

## Authentication — why cookies

The backend issues auth as two `httpOnly` cookies, `rx_access` and `rx_refresh`,
and **never** returns a token in a response body (`backend/app/api/auth.py`). It
does accept `Authorization: Bearer` on HTTP requests, but the token to put there
is unobtainable by design — and the WebSocket handshake
(`core/deps.py:get_current_user_ws`) reads the access **cookie**, falling back to a
`?token=` query param only outside production.

So cookies are not the easier option here, they are the only transport that works
for the socket. `URLSession` handles this natively:

- `HTTPCookieStorage.shared` persists cookies that carry a `Max-Age`, so a session
  survives app relaunch exactly as it survives a browser restart.
- `URLSessionWebSocketTask` attaches them to the handshake with no help from us.
- Every request sends `X-Requested-With: XMLHttpRequest`, which the API requires as
  a CSRF header on cookie-authenticated mutations (`main.py:security_headers`).

**Refresh** is single-flight (`APIClient.RefreshCoordinator`). The backend rotates
refresh tokens single-use, so parallel refreshes would have all but one present an
already-consumed token and force a spurious sign-out. A 401 on any call triggers at
most one refresh; everyone who raced into it awaits the same one and replays once.

The access token lasts 15 minutes by default, and the server closes the WebSocket
with code **4001** the moment it expires — so 4001 is the *expected* steady state,
not an error. `RealtimeClient` refreshes and reconnects immediately rather than
backing off, and only signs out if the refresh itself fails.

## Mobile access is granted per user

A super admin must approve each member/admin individually before they can sign in
here. Two rules, enforced server-side:

- **Super admins can never sign in on mobile**, grant or no grant. The admin portal
  is web-only.
- **Everyone else needs `users.mobile_access = true`**, set by a super admin in the
  web portal at **Admin → Users**: an inline "Mobile App" toggle per row, a control
  in the edit drawer, a field on user creation, bulk Grant/Revoke, and an
  Approved / Not-approved filter.

The gate lives in `backend/app/api/auth.py:_assert_mobile_allowed` and is re-checked
on **every request** (via a signed `client` claim in the access token) and on
**refresh** — so revoking access ends the phone's session immediately rather than
whenever the token happens to lapse. Revoking does **not** sign that user out of the
web app: `refresh_tokens.client` records which client opened each session, and only
the mobile ones are revoked.

Both refusals are `403`, never `401`, and the app shows the server's own sentence on
a dedicated screen (`AccessDeniedView`). A member who is simply not approved must not
see "sign-in failed" — they would retype their password, then reset it, then open a
ticket, none of which is the problem.

Backend coverage: `backend/tests/test_mobile_access.py` (20 tests).

## Design system

`DesignSystem/Theme.swift` transcribes the web tokens from
`frontend/src/index.css` exactly — same hexes, same 200ms
`cubic-bezier(0.2, 0.8, 0.2, 1)`, same radii and shadows.

| Token | Value | Role |
|---|---|---|
| `bg` | `#0A0A0A` | app background |
| `sidebar` | `#0F0F0F` | tab bar / nav bar |
| `surface` | `#141414` | cards, sheets, received bubbles |
| `surface2` | `#1A1A1A` | inputs, chips, pressed |
| `border` / `border2` | `#1F1F1F` / `#2D2D2D` | hairlines / input borders |
| `text` / `textMuted` | `#F5F5F5` / `#A3A3A3` | primary / secondary text |
| `primary` / `primaryPressed` | `#10B981` / `#059669` | brand emerald |
| `danger` / `warning` | `#EF4444` / `#F59E0B` | destructive / caution |

The **palette is identical** to the web app. What is redesigned is layout and
interaction, which is where a phone differs from a desktop three-pane app:

- A **tab bar** (Chats / Calls / Contacts / Settings) replaces the web sidebar.
- Message bubbles get an 18pt radius instead of the web's small mouse-targeted ones,
  and message text is 16pt instead of 14 — arm's length, not desk distance.
- 44pt minimum touch targets throughout. The web CSS relaxes to 36px on narrow
  viewports, which is below Apple's guideline; native does not.
- Long-press context menus, swipe actions, and sheets replace right-click menus,
  hover affordances, and modals.
- Sheets use a 20pt radius; an 8pt corner on a full-width sheet reads as a bug.

**Typography:** the web app loads Inter; iOS uses SF Pro, which is metrically close
enough that the two clients read as one product. For exact brand type, drop
`Inter-*.ttf` into `RxHive/Resources/Fonts/`, list them under `UIAppFonts` in
`Info.plist`, and set `Theme.Typography.brandFamily` — nothing else changes.

## What is deliberately absent

These are not gaps in the port; they are things the backend does not support, and
building UI for them would be building dead buttons.

- **Deleting a message.** There is no endpoint — the feature was removed from the
  product (see the note at `backend/app/api/messages.py:452`). The read path still
  renders pre-existing tombstones as "This message was deleted".
- **Remote push notifications.** `push_subscriptions` stores Web Push endpoints and
  `{p256dh, auth}` keys; it cannot hold an APNs device token, and there is no APNs
  sender. In-app banners work; the Settings screen says so plainly instead of
  offering a switch that does nothing.
- **Background incoming calls.** The ring arrives over the app's WebSocket, which
  iOS suspends in the background. Real background ringing needs a PushKit VoIP
  certificate plus a backend that sends VoIP pushes. In-app ringing works.
- **An in-app notification inbox.** The `notifications` table and its two endpoints
  exist but nothing ever writes a row.
- **Super-admin screens.** Super admins cannot sign in here at all.
- **Creating cross-org groups.** Super-admin-only, web portal only. The app displays
  cross-org groups it is a member of, with their purpose tag.
- **Group permissions beyond three toggles.** The wire exposes `edit_info`,
  `add_members`, and `send_messages` only. `send_history`, `invite_via_link` and
  `approve_new_members` are stored but **no read path enforces them** — a member
  added later still sees the full pre-join history — so surfacing them would
  advertise privacy the server does not provide.

## Known backend issue found while porting

`POST /api/livekit/webhook` is **declared but never mounted**: it lives on
`calls.webhook_router` (`backend/app/api/calls.py:39`), and `main.py` includes
`calls.router` but not `calls.webhook_router`. Neither `infra/livekit.yaml` nor
`livekit.prod.yaml` configures a `webhook:` block either.

Consequence: SFU-driven call reconciliation is dead code — `room_finished` never
marks a call answered/ended, and the webhook's `participant_joined` /
`participant_left` publishes never fire. The same two events *are* published from
`services/calls.py` for explicit `call:join` / `call:leave` frames, so participant
tracking partly works.

The iOS client therefore treats the **LiveKit room delegate as authoritative** for
who is in a call, and the WebSocket events as a supplement. That is the more robust
design regardless, but it is a workaround for a real bug: mounting the router and
adding the LiveKit webhook config would fix it for both clients.

## Architecture notes

- **One store for chat state.** `ChatStore` owns conversations *and* messages
  *and* typing *and* presence, and is the single consumer of realtime events. A
  message arriving has to update the list preview, the unread badge, the sort
  position, and the open thread; split across stores, those four drift apart the
  first time an event lands while the thread is closed.
- **Optimistic sends** go over the WebSocket, because its `message_ack` echoes the
  `temp_id` back — which is what lets a placeholder be *replaced* rather than
  duplicated. Attachments go over HTTP: the socket's handler accepts only a bare
  `media_url` and would drop thumbnail/size/filename.
- **Conversation sort** reproduces the server's `ORDER BY` exactly — my pin first,
  then my explicit `pin_order` with NULLS LAST, then recency — so the list does not
  reshuffle when the next page arrives.
- **Wire dates** come back from Python's `isoformat()`, which emits fractional
  seconds *only when microseconds are non-zero*. `RxDate` parses both shapes; a
  single fixed formatter fails on a minority of rows, intermittently, in production
  data only.
- **Unknown enum cases decode to `.unknown`** rather than throwing, so a server that
  gains a message type or call status does not make whole conversations undecodable
  on an older build.

## Verification status

Read this before your first build — it says exactly how far the code has been
checked, and where it hasn't.

**Verified:**

- All 48 Swift sources pass `swiftc -parse`. That is **syntax only**.
- Every `RxHiveAPI` path, query-parameter name and response envelope was checked
  against the FastAPI routers in `../backend`. Four were wrong and are fixed
  (`/starred` and `/pinned` return `{data}` not `{messages}`; `groups-in-common`
  returns `{data}`; `/org-admin/departments` returns a bare array; `/api/search`
  returns reduced row shapes, not full `Conversation`/`Contact` objects).
- `Theme.SenderColor` reproduces the web's group-name hash exactly, checked against
  the JavaScript on **2000 generated UUIDs — 2000/2000 identical**. This matters:
  an all-`Int32` translation of `hash = c + ((hash << 5) - hash)` disagrees with JS
  for roughly 3 in 10 real ids, because only `<<` coerces to 32-bit there.
- Every colour is a `Theme` token; no raw hex exists outside `Theme.swift`.
- `RxHive.xcodeproj/project.pbxproj` parses as a plist, resolves every internal
  reference, and correctly declares the synchronized folder and the LiveKit package.
- Backend: full suite green — **102 passed**, including 20 new
  `test_mobile_access.py` tests, with the migration applied through Alembic and its
  downgrade verified on a scratch database.

**Not verified — expect work here:**

- **Nothing has been type-checked, compiled, or run.** The machine this was written
  on has Command Line Tools only: no Xcode, no iOS SDK. `swiftc -parse` cannot see
  a single type error, so the first `xcodebuild` will find some. The likeliest spots
  are SwiftUI generic inference in the larger view bodies and `@MainActor`
  isolation across the store boundaries.
- **LiveKit is entirely unverified.** `LiveKitSession.swift` is written against
  SDK 2.x's API (`Room(delegate:roomOptions:)`, `setMicrophone(enabled:)`,
  `VideoView`, `Participant.Identity`). Worse than a compile error: every
  `RoomDelegate` method has a default implementation, so a **renamed delegate
  callback fails silently rather than at compile time**. Check participant
  join/leave and track subscription against the SDK version SPM actually resolves.
- No simulator run, so no visual check of layout, no keyboard-avoidance check, and
  no verification that the splash → sign-in hand-off looks as intended.
