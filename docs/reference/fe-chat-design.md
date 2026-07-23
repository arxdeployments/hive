# 6

# RxHivexx Frontend Chat Code — Complete Audit

All paths relative to `/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/frontend/src/` unless absolute. All code is plain JS React (CRA), Tailwind arbitrary-value classes (no token system in code), zustand for state, framer-motion, sonner toasts, lucide-react icons, react-virtuoso, emoji-picker-react, axios.

## 1. Architecture overview

- `pages/Chat.js` — top-level split view. Connects `wsClient` on mount with `localStorage.access_token`, disconnects on unmount. Mobile (<768px) uses slide-in panel switching (`showMessages` state); desktop renders `ChatSidebar` (300/360px) + `ChatPanel` side by side inside `ChatErrorBoundary`. Also: iOS visualViewport `--vh` lock, global touchmove prevention except `.scrollable-area`, document-title unread badge, Ctrl/Cmd+K (focus search via DOM querySelector) and Ctrl/Cmd+N (click new-chat button via DOM), notification-permission banner gated by `rxhive_notif_asked` localStorage key.
- `stores/chatStore.js` — zustand store: `conversations[]`, `activeConversationId`, `messages{convId: []}`, `contacts[]`, `typingUsers{convId: {userId: name}}`, `wsConnected`, `wsConnecting`. Actions: `addMessage` (dedupes by `_id` only), `addOptimisticMessage` (no dedupe), `replaceOptimisticMessage(convId, tempId, real)` (matches on `temp_id`), `setMessages`, `prependMessages`, `updateMessageStatus`, `setTyping`, `bumpConversation` (updates `last_message`/`last_message_at`, re-sorts pinned-first then `last_message_at` desc), `incrementUnread`, `clearUnread`.
- `services/websocket.js` — singleton `RxHiveWebSocket`. URL: `ws(s)://<REACT_APP_BACKEND_URL host>/api/ws?token=<JWT>` (token in query string). Heartbeat ping every 30s, 10s pong timeout then force-close; exponential backoff reconnect (2^n s, max 30s); close code 4001 = auth failure → clears localStorage and hard-redirects to /login; offline sends are pushed to `messageQueue` and flushed on reconnect; on reconnect re-fetches `/api/conversations`.
- `api/client.js` — axios instance, Bearer token from localStorage, 401 interceptor with refresh-token queue (`POST /api/auth/refresh {refresh_token}`), hard redirect to /login on refresh failure.

## 2. Per-component detail

### MessageComposer (`components/chat/MessageComposer.js`)
- Props: `{ conversationId, onSend, disabled }` (line 14). **Note: `ChatPanel` passes `replyTo` (ChatPanel.js:505) which is NOT in the destructured props — silently ignored. `disabled` is never actually passed by ChatPanel.**
- State: `text`, `showAttachMenu`, `showEmoji`, `uploading`, `uploadProgress`, `dragOver`, `previewImages[{file,url,name}]`, `previewCaption`; refs: textarea, 2 hidden file inputs, `typingRef`, `typingTimerRef`.
- Behaviors:
  - Auto-grow textarea to max 120px; Enter sends, Shift+Enter newline.
  - Typing: `wsClient.sendTypingStart(conversationId)` on first keystroke, auto `sendTypingStop` after 3s idle, stop on send and on unmount.
  - Text send (lines 71–79): generates `tempId = uuidv4()`, calls `onSend(text, tempId)` (optimistic) then **always** `wsClient.sendMessage(conversationId, text, tempId)` — regardless of connection state (queued if offline).
  - Attachments: image picker (accept `image/*`, max 5, 16MB const declared but never enforced), doc picker (`.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip`, 100MB const never enforced), drag-drop (images → preview modal, docs → immediate upload), clipboard paste of images.
  - Upload: `POST {backendUrl}/api/upload` multipart field `file`, raw `fetch` with manual Bearer header (no axios interceptor/refresh). Response fields consumed: `file_type`, `filename`, `file_url`, `thumbnail_url`.
  - `sendMediaMessage` (lines 104–122): msgType = `'image'` or `'file'`; content = filename (file) or caption (image); optimistic via `onSend(content, tempId, msgType, uploadResult.file_url, uploadResult.thumbnail_url)`, then `POST /api/conversations/{id}/messages` with body **`{ content, type, temp_id }` only**.
  - Multi-image send: each image is a separate message; caption attached only to the first; `uploadProgress` is per-file-count, not byte progress (fetch cannot report progress).
  - Mic button renders when text is empty but has **no onClick** — voice notes are dead UI (line 430–443).
  - Emoji picker appends emoji to end of text (not at cursor).

### ChatPanel (`components/chat/ChatPanel.js`)
- Props: `{ conversationId, onBack, isMobile }`.
- State: `loading`, `hasMore`, `loadingMore`, `showScrollDown`, `showGroupInfo`, `contextMenu{message,position}`, `replyTo`, `reactionPicker`, `forwardMsg`, `msgInfo`, `deleteConfirm{message,forEveryone}`, `showConvSearch`, `showContactInfo`, `atBottom`; refs: `virtuosoRef`, `prevMsgCountRef`.
- Initial load: `GET /api/conversations/{id}/messages?limit=50` → `{messages, has_more}`; also `PUT /api/conversations/{id}/read` + `clearUnread`.
- Read receipts: effect (115–126) — when last message is from someone else with a real `_id`, sends WS `read_receipt {conversation_id, last_read_message_id}` (duplicates the receipt already sent by websocket.js:183 for active-conversation `new_message`).
- Virtualization: `react-virtuoso` `<Virtuoso data={items} initialTopMostItemIndex={items.length-1} followOutput="smooth" atBottomStateChange startReached={loadMore}>`. `items` array is rebuilt every render, interleaving `{type:'date'}` separators (day boundary) and `{type:'message', isOwn, showSenderName}` entries. `showSenderName` when sender changes or day changes.
- Pagination: `startReached` → `GET .../messages?before=<oldest._id>&limit=50` → `prependMessages`. **No `firstItemIndex` management — Virtuoso's required prepend protocol is not followed, so loading older messages causes scroll-position jumps.**
- Optimistic send `handleSend(content, tempId, msgType='text', mediaUrl, thumbnailUrl)` (162–213): builds message `{_id: tempId, temp_id, conversation_id, sender_id, sender_name: user.name, type, content, media_url, thumbnail_url, created_at, status:'sending', read_by:[], delivered_to:[]}`, `addOptimisticMessage`, scrolls to LAST, `bumpConversation` (hardcodes `type:'text'` at 191). If `!wsConnected`: HTTP fallback `POST .../messages {content, type:'text', temp_id}` (198 — type hardcoded), replaces optimistic with response or marks `status:'failed'`. If WS connected the ack path in websocket.js handles replacement. Clears `replyTo` after send (212).
- Context menu: right-click → `MessageContextMenu`; actions: reply (sets replyTo), react (opens ReactionPicker at **hardcoded** `{x:300,y:300}`, line 229), forward, info (`GET /api/conversations/messages/{id}/info`), delete_me / delete_all → confirm dialog → `DELETE /api/conversations/messages/{id}?for_everyone=<bool>`; delete-for-me removes locally, delete-for-everyone relies solely on the WS `message_deleted` broadcast to update the sender's own view.
- Reactions: badge click and picker both `POST /api/conversations/messages/{id}/react {emoji}` — no optimistic update; UI updates only on WS `reaction_update`.
- Header: presence/last-seen text, typing dots, cross-org badge, voice/video call buttons that `require()` websocket/callStore inline and send `call:initiate` / `call:group_initiate`; disabled-styling reads `useCallStore.getState()` during render (non-reactive — stale until re-render).
- Admin-only groups: composer replaced with a banner when `conversation.admin_only_messages` and my role isn't creator/admin.

### MessageBubble (`components/chat/MessageBubble.js`)
- Props: `{ message, isOwn, showSenderName, isGroup, currentUserId, onContextMenu, onReactionClick, onReplyClick }`. Memoized with custom comparator (185–191) checking only `_id`, `status`, `temp_id`, `is_deleted`, and JSON-stringified `reactions` — **`content`, `media_url`, `reply_to_message` changes never re-render**.
- Renders: deleted placeholder, `type:'system'` centered text, forwarded label (`is_forwarded`), sender name + hashed color avatar for group messages, reply block from `message.reply_to_message` (`{_id, sender_name, content, type, is_deleted}`; click → `onReplyClick(replyMsg._id)` scroll-to-original), body by type (ImageBubble / DocumentBubble / plain `<p>` — **no linkification; `utils/helpers.js linkifyText` exists but is dead code**), timestamp + StatusIcon for own messages (`sending`=Clock, `sent`=single check, `delivered`=double check, `read`=blue #53BDEB double check), aggregated reaction badges (emoji+count, highlight when `userIds` contains `currentUserId`, title = user names).

### ImageBubble / DocumentBubble / FullscreenImageViewer
- `ImageBubble.js`: images = `message.media_urls || [message.media_url]`; returns **null when both absent** (line 93). Grid layouts for 1–5 images; caption = `message.caption` or `message.content` (unless content startsWith `/api/` — legacy-data guard, line 91). Click opens `FullscreenImageViewer`. `thumbnail_url` is never used anywhere for rendering.
- `DocumentBubble.js`: filename = `message.content || message.filename`; per-extension icon/color map; size from `message.file_size`; click creates `<a download target=_blank>` from `media_url` (prefixed with `REACT_APP_BACKEND_URL` when relative).
- `FullscreenImageViewer.js`: props `{images, initialIndex, onClose, senderName, timestamp}`; prev/next arrows, thumbnail strip, keyboard Esc/arrows (via focused div), download via fetch→blob. Wrapped in `AnimatePresence` inside itself, so exit animation never plays (unmounted by parent conditional).

### ConversationList
- `ChatSidebar.js`: props `{onSelectConversation, isMobile, onBack}`. `GET /api/conversations?search=&filter=` debounced 300ms **and re-polled every 15s** (poll overwrites store — can clobber optimistic ordering/unread state). Tabs: Chats/Calls (emoji icons in tab labels — violates the design guideline banning emoji icons); filters all/unread/groups (server-side). New chat: `POST /api/conversations/direct {participant_id}`; new group modal; global search dropdown; profile drawer; logout. Missed-call badge reads `useCallStore.getState()` non-reactively.
- `ConversationItem.js`: memoized (default shallow compare). Shows other-participant name/status for direct, last-message preview (`You:` / `sender_name:` prefixes, photo/doc emoji), typing dots from `typingUsers`, unread badge, pin icon, cross-org globe, timestamp formatting.
- `GlobalSearchResults.js`: `GET /api/search?q=&types=conversations,contacts,messages`, debounced 400ms; result shapes: conversations `{id,name,type}`, contacts `{id,display_name,department}`, messages `{message_id,conversation_id,sender_name,content_snippet,conversation_name,created_at}`. Selecting a message only opens the conversation — no scroll-to-message.
- `ConversationSearch.js` (in-chat): `POST /api/conversations/{id}/messages/search?q=...` (POST with querystring), debounced 400ms; navigates matches via `onScrollToMessage(match.message_id)` — only works if the message is within the currently loaded window (silently no-ops for older messages).

### Modals / panels
- `MessageContextMenu.js`: items filtered by `showFor`: all / text-only (copy) / own (info) / own_recent (delete-for-everyone, 60-minute window computed client-side). Copy uses `navigator.clipboard`. **"Star" item exists but ChatPanel's `handleContextAction` has no `star` case — it silently does nothing** (MessageContextMenu.js:11 vs ChatPanel.js:222–248).
- `ReactionPicker.js`: 6 quick emoji + "+" to full EmojiPicker; positioned at `position.y - 50`.
- `ReplyPreview.js`: shown above composer; sender name, truncated content or "📷 Photo", image thumb; X clears.
- `MessageInfoModal.js`: renders `{sent_at, delivered_to[{user_name,delivered_at}], read_by[{user_name,read_at}], pending[{user_name}]}`.
- `ForwardModal.js`: `POST /api/conversations/messages/forward {message_id, conversation_ids, contact_ids}`; recipients from store conversations (first 10) + `GET /api/users/contacts`.
- `GroupInfoPanel.js`: edit name/desc (`PUT /api/conversations/{id}/group`), admin-only toggle, member list with roles (creator/admin/member; crown/shield), role change (`PUT .../members/{id}/role {role}`), remove member (`DELETE .../members/{id}`), add members (reuses NewChatModal one-at-a-time; `POST .../members {user_ids:[id]}`), leave (`POST .../leave`); cross-org groups are read-only ("Managed by administrator"). All mutations rely on WS `conversation_updated`/`member_*` events to refresh UI (no local optimistic update; the member "Message" menu item does nothing but close the menu, line 279–284).
- `ContactInfoPanel.js`: direct chats only; `GET /api/conversations/{id}/media?type=image&limit=9` for shared media grid; voice/video call buttons send `call:initiate` **without `conversation_id`** (unlike ChatPanel's header buttons which include it).
- `NewChatModal.js` / `CreateGroupModal.js`: contact list from `GET /api/users/contacts?search=` (debounced); group creation `POST /api/conversations/group {name, description, member_ids}` (min 2 members); 2-step wizard; avatar upload UI is placeholder only.
- `ProfileDrawer.js`: `GET /api/auth/me`; `PUT /api/users/profile {display_name | about | avatar_url}`; avatar via `POST /api/upload` (raw fetch again).
- `TypingIndicator.js`, `DateSeparator.js`, `EmptyChat.js`, `ConnectionBanner.js` (connecting = amber banner, connected flash 2s; **not rendered anywhere in the chat tree — Chat.js/ChatPanel never mount it, so the WS status UI is dead code**).

## 3. Exact API / WS payload contract used by the frontend

REST (axios `client`, all Bearer-authenticated):
- `GET /api/conversations` params `{search, filter}` → `{data: [conversation]}`
- `POST /api/conversations/direct {participant_id}` → conversation
- `POST /api/conversations/group {name, description, member_ids}` → conversation
- `GET /api/conversations/{id}/messages` params `{limit:50, before?:<message _id>}` → `{messages[], has_more}`
- `POST /api/conversations/{id}/messages {content, type, temp_id}` → message
- `PUT /api/conversations/{id}/read`
- `GET /api/conversations/messages/{id}/info` → `{sent_at, delivered_to[], read_by[], pending[]}`
- `POST /api/conversations/messages/{id}/react {emoji}`
- `DELETE /api/conversations/messages/{id}?for_everyone=true|false`
- `POST /api/conversations/messages/forward {message_id, conversation_ids[], contact_ids[]}`
- `POST /api/conversations/{id}/messages/search?q=<q>` → `{matches:[{message_id,...}]}`
- `GET /api/conversations/{id}/media` params `{type:'image', limit:9}` → `{data:[{media_url}]}`
- `GET /api/search` params `{q, types:'conversations,contacts,messages'}`
- `GET /api/users/contacts` params `{search}` → `[{id, display_name, department_name, status}]`
- `PUT /api/users/profile`, `GET /api/auth/me`, `POST /api/auth/refresh {refresh_token}`
- `POST /api/upload` multipart `file` (raw fetch, manual Bearer) → `{file_url, thumbnail_url, file_type, filename}`
- Group mgmt: `PUT /api/conversations/{id}/group`, `POST/DELETE .../members`, `PUT .../members/{uid}/role`, `POST .../leave`

WS client→server (`services/websocket.js`):
- `{type:'message', conversation_id, content, msg_type:'text', temp_id, reply_to}` (sendMessage, line 541–550 — `msg_type` hardcoded `'text'`, `reply_to` param defaults null)
- `{type:'typing_start'|'typing_stop', conversation_id}`
- `{type:'read_receipt', conversation_id, last_read_message_id}`
- `{type:'ping'}`
- Calls: `{type:'call:initiate', callee_id, call_type, conversation_id}`, `{type:'call:group_initiate', conversation_id, call_type}`, `webrtc:offer|answer|ice-candidate {call_id, target_id, sdp|candidate}`

WS server→client handled: `connected`, `pong`, `message_ack {temp_id, message_id, created_at, status}`, `new_message {message}`, `message_status {message_id, status, delivered_to}`, `messages_read {conversation_id, reader_id, last_read_message_id}`, `typing {conversation_id, user_id, user_name, is_typing}` (auto-clear after 4s), `presence {user_id, status, last_seen}`, `conversation_created|conversation_updated {conversation_id, updates}`, `member_added|member_removed|removed_from_conversation|role_changed|member_left`, `reaction_update {message_id, conversation_id, reactions}`, `message_deleted {message_id, conversation_id}`, `error {detail}`, plus the `call:*` and `webrtc:*` families.

Message object fields consumed by UI: `_id, temp_id, conversation_id, sender_id, sender_name, type ('text'|'image'|'file'|'system'), content, media_url, media_urls, thumbnail_url, caption, filename, file_size, created_at, status, read_by, delivered_to, reactions[{emoji,user_id,user_name}], is_deleted, is_forwarded, reply_to_message`.
Conversation fields: `_id, type ('direct'|'group'|'cross_org'), name, description, participants[{user_id, display_name, status, last_seen, role, org_name, avatar_url}], last_message, last_message_at, unread_count, is_pinned, cross_org, admin_only_messages, created_at`.

## 4. Bugs found (file:line)

Critical / feature-breaking:
1. **media_url dropped on media send** — `MessageComposer.js:114–118`: the POST body after upload is `{content, type, temp_id}`; `uploadResult.file_url`, `thumbnail_url`, `filename`, `file_size` are never sent to the API. The persisted message has no media reference; `ImageBubble.js:93` then returns null on reload/receive (empty bubble), `DocumentBubble` gets a dead download link. Sender sees the image only while the optimistic message (which does carry `media_url`, `ChatPanel.js:174`) is alive.
2. **reply_to never sent** — `MessageComposer.js:14` ignores the `replyTo` prop passed at `ChatPanel.js:505`, and `MessageComposer.js:76` calls `wsClient.sendMessage(conversationId, text, tempId)` with 3 args even though `websocket.js:541` accepts a 4th `replyTo` param (always null). The HTTP fallback (`ChatPanel.js:197–199`) also omits it. Replies are sent as plain messages, yet `setReplyTo(null)` at `ChatPanel.js:212` clears the UI as if the reply succeeded. The optimistic message also never includes `reply_to_message`, so no reply block even appears locally.
3. **Duplicate send when offline/reconnecting** — `MessageComposer.js:76` always queues the message via `wsClient.send` (queued when socket closed, `websocket.js:524–530`, flushed on reconnect at 60–63), while `ChatPanel.js:195–207` also POSTs the same `temp_id` over HTTP when `!wsConnected` → same message delivered twice after reconnect (dedupe in store is by `_id` only, and the server will assign two different ids).
4. **Media send double-POSTs when WS is down** — `sendMediaMessage` POSTs (`MessageComposer.js:114`) and its `onSend` call triggers ChatPanel's `!wsConnected` HTTP fallback (`ChatPanel.js:195–207`) which POSTs again with `type` hardcoded to `'text'` (line 198) — the media message is sent twice, once mislabeled as text.
5. **Virtuoso prepend without `firstItemIndex`** — `ChatPanel.js:439–451`: `startReached`+`prependMessages` grows the list from the top without the `firstItemIndex` protocol, causing scroll jumps when loading older messages.

Functional defects:
6. **`bumpConversation` hardcodes `type:'text'`** — `ChatPanel.js:186–192`: sidebar preview shows raw filename/caption instead of "📷 Photo"/"📄 doc" for own media sends.
7. **"Star" menu item is a no-op** — offered in `MessageContextMenu.js:11`, no handler case in `ChatPanel.js:222–248`, no API call anywhere.
8. **ReactionPicker position hardcoded** — `ChatPanel.js:229`: `{x:300, y:300}` instead of the message/click coordinates.
9. **ForwardModal wrong name resolution** — `ForwardModal.js:93`: direct-conversation display name found via `p.user_id !== message.sender_id` (should be the current user's id); forwarding someone else's message shows your own name as the conversation label.
10. **MessageBubble memo comparator too narrow** — `MessageBubble.js:185–191`: ignores `content`, `media_url`, `reply_to_message` — a message whose content/media arrives or changes after first render won't repaint.
11. **Delete-for-everyone has no local/optimistic update** — `ChatPanel.js:266–282` only mutates local state for delete-for-me; sender's view depends entirely on receiving the `message_deleted` broadcast back.
12. **`ConnectionBanner` never mounted** — component exists but no parent renders it; users get no offline/reconnecting indication (`ConnectionBanner.js`, grep confirms no importers).
13. **Mic button dead** — `MessageComposer.js:430–443`: no onClick when `hasText` is false; voice notes unimplemented.
14. **Size limits declared but unenforced** — `MessageComposer.js:11–12` (`MAX_IMAGE_SIZE`, `MAX_DOC_SIZE` unused); oversized files hit the server and fail late.
15. **Search scroll-to-message only works for loaded messages** — `ChatPanel.js:421–426` and `GlobalSearchResults` (no scroll at all); matches outside the 50-message window silently do nothing.
16. **Duplicate read receipts** — both `websocket.js:183` (on active-conv `new_message`) and the `ChatPanel.js:115–126` effect fire for the same message.
17. **15s sidebar poll clobbers store** — `ChatSidebar.js:57–61`: `setConversations` replaces the whole list, racing with WS bumps/unread increments.
18. **Non-reactive `getState()` reads in render** — `ChatPanel.js:382–384/402–404` (call-button disabled styling), `ChatSidebar.js:211–214` (missed-call badge): read zustand outside a hook, so they don't update until an unrelated re-render.
19. **`linkifyText` dead code / no link rendering** — `utils/helpers.js:81–96` returns an HTML string nothing consumes; URLs in messages are inert text (`MessageBubble.js:142–144`).
20. **WS token in URL query string** — `websocket.js:28`: JWT exposed in server/proxy logs (matches the known-defects theme in project memory).
21. **`message_ack` targets active conversation first** — `websocket.js:127–155`: harmless today (falls through to scanning all convs) but assumes the ack belongs to `activeConversationId`; the ack payload carries no `conversation_id`, so a background-conversation ack relies on the linear scan.
22. **Upload path bypasses axios refresh logic** — `MessageComposer.js:88–102` and `ProfileDrawer.js:44–62` use raw fetch with the (possibly expired) access token; a 401 there fails the upload instead of triggering refresh.
23. **`FullscreenImageViewer`/several modals wrap `AnimatePresence` inside the conditionally-rendered component** (e.g. `FullscreenImageViewer.js:39`, `NewChatModal.js:29–32`), so exit animations never run — cosmetic.
24. **Doc uploads show no byte progress** — `uploadProgress` only set to 0 (`MessageComposer.js:150`); fetch cannot stream progress; images show per-file-count percent only.

## 5. Design system summary (`/Users/adhityasathyakuamr/Documents/HIVE/RxHivexx-main/design_guidelines.md`)

Brand: "RxHive" — enterprise-trustworthy, security-forward, matte-black dark-ONLY ops console with emerald precision accents; motion purposeful, never decorative. No light mode, no white backgrounds, no new brand colors.

Color tokens (CSS custom properties, mirrored as Tailwind arbitrary values in code):
- Backgrounds: `--rx-bg #0A0A0A` (app), `--rx-sidebar #0F0F0F`, `--rx-surface #141414` (cards/modals), `--rx-surface-2 #1A1A1A` (inputs, hovers)
- Borders: `--rx-border #1F1F1F`, `--rx-border-2 #2D2D2D` (input borders)
- Text: `--rx-text #F5F5F5` (primary), `--rx-text-muted #A3A3A3`; code also uses #737373/#525252 for dimmer tiers
- Accent: `--rx-primary #10B981` (emerald), hover `#059669`; danger `#EF4444`; warning `#F59E0B`; success = primary
- Radii: card 8px, input 6px, avatar full. Focus ring: `0 0 0 3px rgba(16,185,129,0.25)` + emerald border. Backdrop: `rgba(0,0,0,0.6)` + 4px blur. Shadows: `--rx-shadow-1/2` (the modal shadow `0 0 0 1px rgba(31,31,31,1), 0 18px 60px rgba(0,0,0,0.55)` appears verbatim in NewChatModal/CreateGroupModal).

Typography: Inter for UI (Google Fonts), system mono stack for code; scale from `text-xs` captions (#A3A3A3, never below 12px per WCAG note) up to tracking-tight semibold headings; KPI `text-2xl font-semibold`.

Motion: framer-motion; 200ms micro-interactions, 240–320ms overlays; easing `cubic-bezier(0.2, 0.8, 0.2, 1)` (used verbatim across modals/drawers); modals scale 0.95→1 + fade; drawers slide from right; page transitions fade + slight y-slide; table rows stagger 40ms; no bouncy springs; respect prefers-reduced-motion.

Component conventions:
- shadcn/ui in `components/ui/` is the mandated primitive library (Dialog, Drawer/Sheet, Select, Skeleton, Sonner...) — note the chat components largely hand-roll modals/menus with framer-motion divs instead of using them.
- Buttons: primary `bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] active:scale-[0.98]`; secondary `bg-[#1A1A1A] border-[#2D2D2D]`; ghost transparent→#141414; destructive `bg-[#EF4444]`.
- Inputs: `bg-[#1A1A1A] border-[#2D2D2D] rounded-[6px]`, emerald focus border + ring; floating labels on login.
- Tables: container `#141414` + `#1F1F1F` border, header `#0F0F0F`, row hover `#1A1A1A`; type-to-confirm destructive dialogs (GitHub pattern).
- Sidebar: 260px (admin shell; chat sidebar is 300/360px), active item = 10%-opacity emerald bg + 3px emerald left border (chat's ConversationItem follows this).
- Scrollbars: thin, emerald thumb on `#1A1A1A` track.
- Toasts: sonner, top-right, 4s.
- Testing rule: every interactive element must carry a kebab-case `data-testid` describing role (widely followed in chat code).
- Gradient restriction: gradients only for login background blobs and 4px stat-card top accent; never >20% viewport, never on text areas or small elements; no purple for chat/AI UI.
- Icons: lucide-react only, emoji icons banned (ChatSidebar's 💬/📞 tab icons violate this).
- Exports: components named exports, pages default exports (followed).
- A11y: AA contrast, visible emerald focus, Esc closes overlays, min 40px touch targets.
