# 5

# RxHivexx Frontend: Calling UI + Admin Portals + Layout Shell (complete inventory)

All paths relative to `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/frontend/src/`.

=====================================================================
## 1. CALLING UI SURFACE (to rebuild on LiveKit with same UX)

### 1.1 Component mounting
All 4 call overlays are mounted GLOBALLY in `App.js` (inside AuthProvider, above `<Routes>`), so calls render over any page:
`<IncomingCallOverlay /> <OutgoingCallScreen /> <ActiveCallView /> <MinimizedCallBanner />`. `PermissionPrimer` exists (`components/calls/PermissionPrimer.js`) but is **never mounted anywhere — dead code** (camera/mic pre-permission modal with "Not Now" / "Allow Access" buttons, props `{isOpen, onAllow, onDismiss}`).

### 1.2 State machine — `stores/callStore.js` (zustand)
This is the contract every screen consumes. Fields:
- `callState`: `'idle' | 'outgoing_ringing' | 'incoming_ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended'`
- `callId`, `callType` (`'voice'|'video'`), `isGroupCall` (bool), `conversationId`
- `incomingCaller`: `{ id, display_name, avatar_url }` (also used as the "peer" identity on outgoing/active screens; NOTE: outgoing flows never populate it, so outgoing screen shows generic "Calling" — a quirk to fix in the rebuild)
- `remoteParticipants`: `[{ id, display_name, avatar_url, isMuted, isCameraOff }]` (group calls)
- `isMuted`, `isCameraOn`, `callStartTime`, `callDuration` (seconds, ticked by internal 1s interval), `isMinimized`, `showCallUI`, `missedCallCount`, `activeGroupCalls` (`{[conversationId]: {call_id, participants, call_type}}`), `networkQuality` (set by webrtcManager stats loop: `'excellent'|'good'|'poor'`)

Actions: `initiateCall(callId, callType, isGroup, conversationId)` → outgoing_ringing; `receiveIncomingCall(callId, caller, callType, isGroup, conversationId)`; `acceptCall()` → connecting; `callConnected()` → connected + starts duration timer; `endCall()` → 'ended', auto `resetCall()` after 2s; `resetCall()`; `toggleMute/toggleCamera/toggleMinimize`; `add/remove/updateRemoteParticipant`; `set/removeActiveGroupCall`; `setMissedCallCount`.

### 1.3 Screens

**IncomingCallOverlay** (`components/calls/IncomingCallOverlay.js`) — visible when `callState==='incoming_ringing' && showCallUI`. Full-screen z-9999, green-to-black gradient `linear-gradient(180deg,#1a3a2a 0%,#0A0A0A 40%,#0A0A0A 100%)`. Pulsing 128px avatar (scale 1→1.05 loop), caller name, "Incoming voice/video call" + bouncing 3-dot animation. Two 72px round buttons: red Decline (`data-testid="call-decline-btn"`, sends `{type:'call:decline', call_id}`, resets store) and green Accept (`data-testid="call-accept-btn"`, sends `{type:'call:accept', call_id}` for 1:1 or `{type:'call:join', call_id}` for group, then starts WebRTC). Plays ringtone via `callSounds.playRingtone()` (always, even if user muted notif sounds). This file also defines `startWebRTC()` and exposes it as `window._rxhiveStartWebRTC` for websocket.js to invoke on `call:accepted` — replace with LiveKit `room.connect()`.

**OutgoingCallScreen** (`components/calls/OutgoingCallScreen.js`) — visible when `callState==='outgoing_ringing' && showCallUI`. Same gradient/avatar/dots. Top bar: minimize chevron (toggleMinimize), UserPlus button (non-functional). "Calling"/"Video calling" status. Red 72px End button sends `{type:'call:cancel', call_id}`. "End-to-end encrypted" lock badge at bottom. Plays ringback tone.

**ActiveCallView** (`components/calls/ActiveCallView.js`) — visible for states outgoing_ringing/connecting/connected/ended when `showCallUI && !isMinimized`. Three layouts:
1. *1:1 video connected*: full-black screen, remote `<video>` full-bleed, local PiP 120x160 (sm:150x200) top-right rounded with white/20 border, top gradient bar (minimize chevron + name + status), bottom controls: Mute, Camera, Speaker + red 64px End.
2. *Group connected*: header "Group Call / N participants · duration", `<VideoGrid>` of tiles, controls Mute / Camera(video only) / Speaker + End.
3. *Voice (WhatsApp-style, also renders for ringing/connecting/ended)*: gradient bg, pulsing avatar, name, status ("Ringing…"/"Connecting…" with bouncing dots, mm:ss mono timer when connected, amber "Reconnecting", "Call ended"), control row **More / Video / Speaker / Mute** (14px rounded-2xl pill buttons, active = white bg + dark icon), red 72px End, E2E badge, and a "More" bottom sheet with **Share screen** and **Send message** (both currently no-op buttons).
Controls behavior: End sends `call:cancel` if ringing else `call:end`, cleans up manager, `endCall()`. Mute toggles store + `manager.toggleAudio(enabled)` + sends `{type:'call:toggle_media', call_id, media_type:'audio', enabled}`. Camera same with `media_type:'video'`. Speaker is local UI state only (no routing). Plays `playConnected()`/`playEnded()` on state transitions. Consumes remote streams via `webrtcManager._onRemoteStreamUI` callback + `webrtcManager._latestRemoteStream`, group streams via `meshCallManager.onRemoteStreamAdded/Removed(uid, stream)` → local `Map<uid,stream>`.

**MinimizedCallBanner** (`components/calls/MinimizedCallBanner.js`) — when `callState==='connected' && isMinimized`: fixed 44px top bar, green `#10B981`, pulsing white dot + name + mono duration; click un-minimizes. `data-testid="minimized-call-banner"`.

**VideoGrid** (`components/calls/VideoGrid.js`) — props `{participants:[{id,name,stream,isMuted,isCameraOff}], localStream, localName, isMuted, isCameraOn, activeSpeakerId}`. Local tile first ("You", muted video el). Grid: 1→1x1, 2→2x1, ≤4→2x2, else 3x2. Tile: video or initial-avatar fallback, name gradient label, red MicOff badge when muted, green ring when `id===activeSpeakerId` (activeSpeakerId never passed currently — LiveKit gives this for free).

**CallsTab** (`components/calls/CallsTab.js`) — in-sidebar call history tab (rendered by `components/chat/ChatSidebar.js` when the sidebar tab = 'calls'; tab label shows red badge from `missedCallCount`). Contains: 4 action cards (Start call / New call link / Call a number / Schedule call — last two toast "coming soon"), filter pills `all|missed|incoming|outgoing`, date-grouped (Today/Yesterday/date) history list rows: avatar initial, name (red if missed), direction icon (PhoneIncoming/PhoneOutgoing/PhoneMissed), status text + `duration` m:ss + video icon, relative time; unseen missed calls get red left border (checks `call.seen_by?.includes(user.id)`). Row click re-dials via `{type:'call:initiate', callee_id: other_participant.user_id, call_type}`.
REST used: `GET /api/calls/history?filter=&limit=30` → `{data:[{call_id, call_type, direction, status, duration, started_at, seen_by, other_participant:{user_id, display_name}}]}`; `GET /api/calls/missed-count` → `{count}`; `POST /api/calls/create-link {call_type:'video'}` → `{url}` (copied to clipboard); `GET /api/calls/ice-servers` → `{iceServers}`.

### 1.4 Call entry points (buttons that start calls)
- `components/chat/ChatPanel.js` header: voice btn (`data-testid="header-voice-call-btn"`) and video btn (`header-video-call-btn"`). 1:1 sends `{type:'call:initiate', callee_id, call_type, conversation_id}`; group sends `{type:'call:group_initiate', conversation_id, call_type}`; then `initiateCall(null, type, isGroup, conversationId)`. Buttons disabled-styled when `callState!=='idle'`.
- `components/chat/ContactInfoPanel.js`: voice/video buttons send `{type:'call:initiate', callee_id, call_type}`.
- CallsTab row click (above).

### 1.5 WS signaling protocol the UI speaks (in `services/websocket.js`, single socket at `/api/ws?token=`)
Client→server: `call:initiate {callee_id, call_type, conversation_id?}`, `call:group_initiate {conversation_id, call_type}`, `call:accept {call_id}`, `call:join {call_id}`, `call:decline {call_id}`, `call:cancel {call_id}`, `call:end {call_id}`, `call:toggle_media {call_id, media_type, enabled}`, `webrtc:offer|answer {call_id, target_id, sdp}`, `webrtc:ice-candidate {call_id, target_id, candidate}`.
Server→client handled: `call:incoming {call_id, caller, call_type, is_group, conversation_id}`, `call:ringing_started {call_id}` (stores server-assigned call_id into store — outgoing screens start with callId=null), `call:accepted {call_id, accepter_id}` (caller starts WebRTC as initiator), `call:declined`, `call:ended`, `call:cancelled`, `call:busy`, `call:unavailable`, `call:missed` (resetCall + missedCallCount+1), `call:full {message}` (toast "Call is full (6/6)"), `call:group_started`, `call:group_participants {call_id, participants:[{id,display_name,avatar_url}]}` (joiner offers to each), `call:group_already_active {conversation_id, call_id}`, `call:group_active {conversation_id, call_id, participants, call_type}`, `call:group_ended {conversation_id}`, `call:participant_joined {participant}`, `call:participant_left {participant_id}`, `call:media_toggle {user_id, media_type, enabled}` (updates remote participant isMuted/isCameraOff), plus `webrtc:offer/answer/ice-candidate {from_id, sdp|candidate}` relays.
For LiveKit: everything under `webrtc:*`, ICE servers, perfect-negotiation, and mesh fan-out can be deleted; keep the `call:*` ring/accept/decline/missed-count layer (or move to REST + LiveKit webhooks), keep `call:media_toggle`-equivalent from LiveKit track events.

### 1.6 What UI expects from the managers (replace with LiveKit)
- `services/webrtcManager.js` (1:1): singleton exposing `localStream`, callbacks `onRemoteStream/_onRemoteStreamUI/_latestRemoteStream`, `onConnectionStateChange` (drives `callConnected()` on connected/completed and gives up after 3 ICE restarts), `toggleAudio/toggleVideo(enabled)`, `toggleScreenShare(enabled)` (replaceTrack-based, unused by UI), `flipCamera()` (unused), stats loop every 2s setting `networkQuality` in callStore, screen wake-lock, `cleanup()`. Media constraints: audio EC/NS/AGC; video 1280x720 ideal 30fps facingMode user; video-call fallback to audio-only if camera denied.
- `services/meshCallManager.js` (group, mesh up to 6): `initialize(localStream, iceServers, localUserId)`, `addPeer/removePeer`, offer/answer/ICE handlers, callbacks `onRemoteStreamAdded(uid,stream)`, `onRemoteStreamRemoved(uid)`, `toggleAudio/Video`, `cleanup()`. Group getUserMedia: 640x480.
- `services/callSounds.js`: WebAudio tones — `playRingtone` (repeats 2s), `playRingback` (repeats 3s), `playConnected`, `playEnded`, `playParticipantJoined/Left`, `stopAll`; respects `localStorage 'rxhive_notif_sound'==='false'` mute except ringtone.

=====================================================================
## 2. ADMIN PORTALS

### 2.1 Super-admin portal (`pages/admin/`, routes under `/admin`, guarded by `user.role==='superadmin'`)
Routes: `/admin` Dashboard, `/admin/organizations`, `/admin/departments`, `/admin/users`, `/admin/cross-org-groups`, `/admin/settings` (placeholder "coming soon" page).

**Dashboard** (`Dashboard.js`): 4 stat cards keyed `total_orgs, total_depts, total_users, active_today` + Recent Activity list (`recent_activity: [{_id, action, target, timestamp}]`). API: `GET /api/admin/stats`.

**Organizations** (`Organizations.js`): search box, sortable table (Name, Slug, Departments=`dept_count`, Users=`user_count`, Status toggle-pill, Created, Actions edit/delete), pagination (limit 10, windowed page numbers). Create/Edit modal: single field Organization Name (auto-slug preview, debounced 400ms availability check). Delete modal requires typing the org name; warns it deactivates all users/depts (soft delete).
APIs: `GET /api/admin/organizations?page&limit&search&sort&order` → `{data:[{_id,name,slug,dept_count,user_count,is_active,created_at}], total}`; `GET /api/admin/validate/org-name?name&exclude_id` → `{available}`; `POST /api/admin/organizations {name}`; `PUT /api/admin/organizations/:id {name}` or `{is_active}` (status toggle); `DELETE /api/admin/organizations/:id`.

**Departments** (`Departments.js`): org selector dropdown first (required), then search + table (Department Name, Description, Members=`member_count`, Created, edit/delete). Create/Edit modal: Name* + Description textarea. Delete modal warns if `member_count > 0` ("remove or reassign first").
APIs: `GET /api/admin/departments?org_id&page&limit&search` → `{data:[{_id,name,description,member_count,created_at}], total}`; `POST /api/admin/departments {org_id, name, description|null}`; `PUT /api/admin/departments/:id {name, description|null}`; `DELETE /api/admin/departments/:id`.

**Users** (`Users.js` — the largest page): Filters: org dropdown → dept dropdown (dependent), search (name/email), status pills `null|'active'|'inactive'`; Create User button. **Bulk ops**: row checkboxes + select-all; when selected a bar appears (`data-testid="users-bulk-actions-bar"`) with "Deactivate Selected" / "Activate Selected" → `POST /api/admin/users/bulk-action {user_ids:[...], action:'deactivate'|'activate'}` → `{message}`. Table columns: checkbox, User (avatar initial + display_name), Email, Organization (`org_name`), Department (`dept_name`), Role badge (admin/member), Status dot (is_active), edit pencil.
*Create modal*: Organization*, Department* (dependent dropdown), Email* (debounced availability via `GET /api/admin/validate/user-email?email` → `{available}`), Display Name*, Password with Auto-generate toggle (client-side 12-char generator, copy + regenerate buttons; manual mode min 6 chars), Role radio member/admin (admin = org admin). Submit: `POST /api/admin/users {org_id, dept_id, email, display_name, password, role}`. On success shows password in a 10s toast with Copy action.
*Edit drawer* (slides from right, `data-testid="users-edit-drawer"`): Display Name, Email read-only, Department dropdown, Role member/admin buttons, Active/Inactive toggle, **Reset Password** button → `POST /api/admin/users/:id/reset-password` → `{temporary_password}` shown inline + toast w/ copy. Save: `PUT /api/admin/users/:id {display_name, role, is_active, dept_id?}` (dept_id only when changed).
List API: `GET /api/admin/users?page&limit=10&search&org_id?&dept_id?&status?` → `{data:[{_id, display_name, email, org_id, org_name, dept_id, dept_name, role, is_active}], total}`.

**CrossOrgGroups** (`CrossOrgGroups.js`): search + status pills `active|archived`, table (Group Name, Organizations chips `organizations:[{id,name}]`, Members=`member_count`, Purpose tag colored badge, Status Active/Archived, Created, actions: archive/unarchive toggle + delete). Purpose colors: Project #10B981, Task Force #3B82F6, Committee #A855F7, Custom #A3A3A3.
*4-step create wizard modal*: Step1 Group Name* (max 100) + Description (max 500) + Purpose pill (Project/Task Force/Committee/Custom); Step2 select ≥2 organizations (checkbox cards showing `user_count`/`dept_count`, from `GET /api/admin/organizations/all` → flat array); Step3 select ≥1 member per org — users grouped by department from `GET /api/admin/organizations/:orgId/users` → `[{id, name, users:[{id, display_name, email}]}]` (dept-grouped); Step4 review + assign ≥1 admin from selected members. Submit: `POST /api/admin/cross-org-groups {name, description|null, purpose_tag, org_ids:[...], members:[{user_id, role:'admin'|'member'}]}`. Note the payload drops `org_id` per member (collected in UI as `{user_id, org_id}` but only user_id+role are sent).
Other APIs: `GET /api/admin/cross-org-groups?page&limit&search&status` → `{data, total}`; `POST /api/admin/cross-org-groups/:id/archive` (toggles); `DELETE /api/admin/cross-org-groups/:id` (type-name-to-confirm modal).

### 2.2 Org-admin portal (`pages/OrgAdmin/`, routes under `/org-admin`, guarded `user.role==='admin'`; entered from chat sidebar menu "navigate('/org-admin')")
Routes: `/org-admin` Overview, `/org-admin/users`, `/org-admin/departments`, `/org-admin/settings`.

**OrgAdminDashboard**: stat cards `total_users, active_today, total_departments, total_conversations` + activity list. APIs: `GET /api/org-admin/stats`, `GET /api/org-admin/activity` → `[{action, target, timestamp}]`.

**OrgAdminUsers**: search, native `<select>` dept filter, table (User, Email, Department, Role, Status, edit) with Prev/Next pagination. Create modal (Department* select, Email*, Display Name*, Password w/ auto-generate toggle, Role member/admin): `POST /api/org-admin/users {dept_id, email, display_name, password, role}`. Edit drawer (Name, Email read-only, Department select, Role, Active toggle, Reset Password): `PUT /api/org-admin/users/:id {display_name, role, is_active, dept_id}` (always sends dept_id, unlike super-admin) and `POST /api/org-admin/users/:id/reset-password` → `{temporary_password}`. List: `GET /api/org-admin/users?page&limit=10&search&dept_id?` → `{data, total}`.

**OrgAdminDepartments**: table (Name, Description, Members, edit/delete — delete uses `window.confirm`), create/edit modal (Name*, Description). APIs: `GET /api/org-admin/departments` → flat array `[{_id,name,description,member_count}]` (no pagination); `POST /api/org-admin/departments {name, description|null}`; `PUT /api/org-admin/departments/:id {name, description|null}`; `DELETE /api/org-admin/departments/:id`.

**OrgAdminSettings**: shows org name (inline-editable, Enter saves / Esc cancels), read-only slug and created date. APIs: `GET /api/org-admin/settings` → `{name, slug, created_at}`; `PUT /api/org-admin/settings {name}`.

Note: both portals generate passwords **client-side** and display them in plaintext toasts/UI — flagged behavior to reconsider in rebuild.

=====================================================================
## 3. LAYOUT SHELL

**AdminLayout** (`components/layout/AdminLayout.js`): fixed `Sidebar` + sticky `TopBar` + `<main>` with `<Outlet/>`; `collapsed` state (auto-collapses under 1024px via resize listener); content margin `lg:ml-[72px]` collapsed / `lg:ml-[260px]` expanded; bg `#0A0A0A`, padding p-4 md:p-6.

**Sidebar** (`components/layout/Sidebar.js`): fixed left, h-screen, bg `#0F0F0F`, border-r `#1F1F1F`, 260px expanded / 72px icon-rail collapsed (mobile: slides off-canvas with black/50 overlay). Header 64px: "RxHive" wordmark (green glow) + green "Admin" pill; collapsed shows "Rx". Nav items (lucide icons): Dashboard `/admin` (exact), Organizations, Departments, Users, Cross-Org Groups, Settings. Active style: `bg rgba(16,185,129,0.1)`, 3px green left border, green icon. Collapsed items show hover tooltips; there is dormant support for `disabled` items with a "Soon" badge. Bottom section: avatar-initial + name + email + logout button (`data-testid="sidebar-logout-button"`, calls `logout()` then navigate('/login')).

**TopBar** (`components/layout/TopBar.js`): sticky 64px header, `bg-[#0A0A0A]/80 backdrop-blur`, same dynamic left margin as content. Left: hamburger (`topbar-menu-button`) + page title from hardcoded path→title map. Right: bell button (non-functional, `topbar-notification-button`) + user avatar-initial + name.

**OrgAdminLayout** (`components/org-admin/OrgAdminLayout.js`): self-contained flex shell (not reusing Sidebar/TopBar): 260px aside (has `collapsed` state but no toggle UI wired), header block "O" logo + "Org Admin / Organization Panel", nav: Overview (exact), Users, Departments, Org Settings; bottom "Back to Chat" button → `/chat`. Header row: "Organization Management" title + user avatar/name. Main: p-6 scrollable `<Outlet/>`.

**Routing/guards** (`App.js`): `LoginRedirect` sends superadmin→`/admin`, everyone else→`/chat`; `SuperAdminRoute` renders Access Denied card for non-superadmin; `OrgAdminRoute` redirects non-'admin' to `/chat`; `/settings` = user settings page; `*`→NotFound. Global chrome also includes `OfflineBanner`, sonner `Toaster` (dark, top-right), and the 4 call overlays.

**Design tokens used everywhere**: bg #0A0A0A, surface #141414, surface-2 #1A1A1A, borders #1F1F1F / #2D2D2D, text #F5F5F5, muted #A3A3A3, faint #525252, accent green #10B981 (hover #059669), danger #EF4444, warn #F59E0B; radii 6/8/12px; framer-motion fade/slide transitions; modals: black/60 + 4px blur backdrop, `stopPropagation` pattern; drawers slide from right 400-420px.