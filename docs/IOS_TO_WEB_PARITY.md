# RX HIVE — iOS → Web parity brief

> **What this is.** The iOS client was built after the web client and, in the course of that work,
> a number of behaviours were implemented on iOS that the web does not have. This document lists
> those and only those, so the web client can be brought level.
>
> **How it was produced.** Every item below was found by reading both codebases, then independently
> re-verified by a second pass whose job was to *disprove* it by finding a web implementation. 37
> candidates were raised; 4 were thrown out because the web already had the capability. What remains
> is 33 verified gaps. Section 1 lists 53 things that are **already on the web** — read it first.

---

## 0. Rules of engagement

Read these before touching anything. They exist because the audit found several traps.

1. **Do not re-implement anything in Section 1.** The web already has a real microphone-driven
   waveform, 1x/1.5x/2x playback, pause/resume/preview recording, one-audio-at-a-time enforcement,
   and a backend-rasterised PDF reader. Several of these are *better* structured than the iOS
   versions. The iOS build copied the web here, not the other way round.

2. **iOS is not automatically the reference.** Where the two clients differ by deliberate design,
   this document says so and gives both sides. Item 4 is the clearest case: iOS decodes a sent voice
   note to draw its true envelope; the web deliberately refuses to and draws a flat progress row
   instead, on the grounds that inventing amplitude for a clinical recording is a lie and that
   decoding every clip in a thread is not worth the bandwidth. **That is a judgement call about a
   medical product, not an oversight.** Decide it deliberately; do not "fix" it by reflex.

3. **A phone gesture is not always a desktop interaction.** Hold-to-talk, swipe-to-lock and
   slide-to-cancel are all implementable with Pointer Events, but a mouse-hold is a poor primary
   interaction. Add them for coarse pointers and keep the existing click flow for fine pointers,
   rather than replacing one with the other.

4. **Respect the existing web architecture.** The web composer, recorder hook and player are
   well-factored. Most of these ports are "thread one more thing through", not "rewrite the
   component". Where a structural change is genuinely required, the item says so.

5. **Nothing here needs a backend change.** Every gap is client-side. The endpoints, the schema and
   the socket protocol are already shared and already sufficient.

---

## 1. Already on the web — do not re-port

Verified present, with file:line proof. If you are about to build one of these, stop and read the file named.

- PAUSE AND RESUME INTO ONE CONTINUOUS RECORDING — fully implemented, by a different mechanism. Web keeps one MediaRecorder and one chunk array alive across `pause()`/`resume()` (frontend/src/hooks/useAudioRecorder.js:182-238), so Send uploads a single continuous file exactly as iOS's stitched export does. `stop()` even resumes a paused recorder first because "Chrome fires onstop without flushing the final buffered chunk" otherwise (useAudioRecorder.js:247-250). Wired to a Pause button at AudioRecorderBar.jsx:92-101 and a Resume mic button at :115-126. Only the RELIABILITY of the mid-pause preview differs (see the Safari moov-atom gap); the pause/resume capability itself is not missing.
- PREVIEW PLAYBACK WITH A SCRUBBER BEFORE SENDING — present. AudioRecorderBar.jsx:78-88 renders the very same `AudioPlayer` the sent bubble uses, keyed on the object URL, for both the `paused` and `preview` stages. That player carries play/pause (AudioPlayer.jsx:131-141), a draggable/clickable seek surface (`PeaksWaveform` with `onSeek`, AudioPlayer.jsx:147-153 and Waveform.jsx:274-295, including ArrowLeft/ArrowRight keyboard seeking at :292-295), and a live duration readout. For the pre-send preview the src IS a `blob:` URL, so the waveform there is the clip's REAL decoded envelope (Waveform.jsx:164-190) — the flat-bar problem applies only to sent bubbles.
- DELETE / DISCARD — present at every stage. The red `Trash2` button at AudioRecorderBar.jsx:46-56 is rendered unconditionally (not gated on stage), wired to `recorder.cancel()` via MessageComposer.jsx:762, which also clears `sendAfterStopRef`. `cancel()` (useAudioRecorder.js:255-274) sets a `discardRef` so `onstop` throws the audio away instead of promoting it to a preview, revokes the object URL, and stops the MediaStream tracks.
- LIVE INPUT-DRIVEN WAVEFORM WHILE RECORDING — present, and it is REAL microphone data, not an animation. `LiveWaveform` (frontend/src/components/chat/Waveform.jsx:44-144) creates an `AudioContext`, hangs an `AnalyserNode` (fftSize 512) off `createMediaStreamSource(stream)`, and each frame reads `analyser.getByteTimeDomainData(buf)` and pushes `Math.min(1, rmsOf(buf) * 3.2)` (Waveform.jsx:96-99) where `rmsOf` is a genuine root-mean-square over the time-domain buffer (Waveform.jsx:35-42). Drawn on Canvas via requestAnimationFrame with a fixed 38ms push cadence so scroll speed is refresh-rate independent, and it closes the AudioContext on teardown (:132). Functionally the same thing as iOS's `recorder.averagePower(forChannel: 0)` sampling at 60ms (AudioRecorder.swift:328-339). Mounted at AudioRecorderBar.jsx:76.
- PLAYBACK SPEED CYCLING 1x / 1.5x / 2x — present and complete. `const RATES = [1, 1.5, 2]` at AudioPlayer.jsx:30, `cycleRate` wrapping with modulo at :97-99, button at :154-169 showing `{rate}x` with a distinct active style when != 1. It goes further than iOS in one respect: it sets `preservesPitch` AND the Safari-prefixed `webkitPreservesPitch` (AudioPlayer.jsx:93-94), and re-applies the rate on src change because "a new <audio> src resets playbackRate to 1" (:84-95). Only the PLACEMENT differs — see the leading-control gap.
- ONE-AUDIO-AT-A-TIME ENFORCEMENT — present. A module-level `const playing = new Set()` of `<audio>` elements (AudioPlayer.jsx:32), with `pauseOthers(self)` iterating and pausing every other element (:34-38), called from the `play` event handler (:63). Every AudioPlayer registers on mount and deletes on unmount (:56, :80). Deliberately a module registry rather than a context "so a bubble deep in a virtualised list needs no provider above it" (:20-22) — the direct analogue of iOS's `.rxAudioAttachmentStarted` NotificationCenter broadcast (MediaAttachmentViews.swift:538-541, 768). Because the recorder preview uses the same AudioPlayer, the preview is in the same registry too.
- REMAINING-WHILE-PLAYING / TOTAL-WHILE-IDLE DURATION — present and identical. AudioPlayer.jsx:126: `const shown = isPlaying || position > 0 ? Math.max(0, total - position) : total;` with the comment naming it as the WhatsApp behaviour. iOS's `shownTime` (MediaAttachmentViews.swift:454-456) is the same expression and its comment credits the web player as the source.
- SERVER-SENT DURATION PREFERRED OVER THE DECODER'S — present. AudioPlayer.jsx:47-51 prefers a finite `fallbackDuration` and falls back to `intrinsic` only when that is a finite positive number, with `onMeta` explicitly guarding Infinity/NaN at :59-62. Passed from the bubble as `message.duration ?? message.attachments?.[0]?.duration` (MessageBubble.jsx:343). Matches iOS's `total` computed property (MediaAttachmentViews.swift:442-445).
- MIC PERMISSION AND CAPABILITY ERROR HANDLING — present and arguably richer than iOS's. `micErrorMessage(err)` (frontend/src/utils/audioFormat.js:73-85) maps NotAllowedError/SecurityError, NotFoundError/OverconstrainedError and NotReadableError to distinct actionable messages; `canRecordAudio()` (:48-58) additionally checks `window.isSecureContext` and hides the mic entirely when recording is impossible (MessageComposer.jsx:871-873).
- THE .m4a EXTENSION DISCIPLINE — present, and it is the ORIGIN of the iOS behaviour, not a copy of it. `CANDIDATES` in frontend/src/utils/audioFormat.js:28-35 orders audio/mp4→.m4a first, and the file's docstring (:5-24) explains that the backend classifies by extension and `.webm` is in VIDEO_EXTS, hence `.weba` as the last-resort name. AudioRecorder.swift:8-14 cites this exact file by name.
- MICROPHONE RELEASE ON EVERY EXIT PATH — present. `releaseStream()` (useAudioRecorder.js:68-79) clears the tick interval and calls `t.stop()` on every track, and an unmount effect (:85-88) runs it plus revokes the preview object URL, with the same reasoning iOS gives for `recorder.cancel()` on background (MessageComposer.swift:167-169).
- PDF page-1 preview inside the document bubble — NOT an iOS-only feature; the web had it first and iOS mirrors it. frontend/src/components/chat/DocumentBubble.jsx:56-67 reads attachment.thumbnail_url and page_count, :66-67 gates the preview on `ext === 'pdf' && thumbUrl && !thumbBroken`, :128-136 renders it at h-[150px] with `object-cover object-top` and the same 'show the TOP of page 1, where the title is' rationale that appears verbatim in ios/RxHive/Features/Media/MediaAttachmentViews.swift:882-884. Non-PDF and preview-less PDFs fall through to the icon-row anchor at :96-110, exactly as DocumentAttachmentView.iconRowBubble does.
- Full-screen multi-page PDF reader built on the backend's rasterised pages — the web is the ORIGINAL implementation and PdfReaderView.swift:5-6 says so in its header comment. frontend/src/components/chat/PdfViewer.jsx:214 requests `${base}/page/${n}`, i.e. GET /api/media/{id}/page/{n}; :40-78 PdfPage lazy-loads each page with an IntersectionObserver and an aspect-[1/1.414] placeholder; :150-155 renders the 'Page N of M' header; :201-207 the 'No preview available' state; :127-133 capture-phase Escape; :224 portals to document.body. So: yes, the web absolutely uses the rasterised-page endpoint.
- Consumption of the `page_count` column — grepped the frontend for both `page_count` and `/page/`. DocumentBubble.jsx:57 (`attachment?.page_count ?? message.page_count`), DocumentBubble.jsx:70 (the 'N pages' segment), DocumentBubble.jsx:159 (passed into PdfViewer), PdfViewer.jsx:87/91-97 (clamped to MAX_PAGES = 2000, the same clamp iOS reproduces at PdfReaderView.swift:42), MediaLinksDocsSection.jsx:534 (gallery). It is fully wired.
- A lazy page-count heal the iOS client does NOT have — frontend/src/components/chat/PdfViewer.jsx:109-117 GETs `${base}/meta` when the caller handed it a null page_count, and :97/:193-200 distinguish 'preparing preview…' from 'could not be rendered'. PdfReaderView.swift:44-46 just treats a nil pageCount as zero and shows the unavailable state. This one runs the other way: it is an iOS gap, not a web one.
- PDF thumbnails in the media gallery's Docs tab — frontend/src/components/chat/info/MediaLinksDocsSection.jsx:77-88, with a comment noting thumbnail_url is optimistic for a PDF whose page_count is still null.
- Split open-vs-download affordance on a previewable PDF bubble — DocumentBubble.jsx:115-153: the card body is a role="button" that opens the reader (with Enter/Space keyboard handling at :121-123) and the download arrow is a nested <a> that stopPropagation()s. Structurally identical to DocumentAttachmentView.previewBubble + downloadControl (MediaAttachmentViews.swift:870-904, :1013-1032).
- Full-screen image viewer with pager, thumbnail filmstrip, sender + timestamp header, download and jump-to-message — frontend/src/components/chat/FullscreenImageViewer.jsx:111-218, opened from the bubble at ImageBubble.jsx:138-147. Everything the iOS ImageViewer has except magnification (see the zoom gap).
- Full-screen video viewer — frontend/src/components/chat/FullscreenVideoViewer.jsx exists and is complete (header with filename/sender/timestamp, download, jump-to-message, capture-phase Escape, pause-on-unmount, self-portalled). It is simply not wired to the chat bubble; do not build a new one.
- Pre-send confirmation tray with a caption field and a multi-item filmstrip — frontend/src/components/chat/MessageComposer.jsx:581-706. Caption input at :678-687 with placeholder 'Add a caption...' (iOS uses 'Add a caption…'), horizontally scrolling 60px tiles at :614-670 with per-item remove (:659-667) and per-category previews (image thumb, video first frame, mic glyph, file-type icon), Cancel at :599-606, and — importantly — nothing touches the network until handleConfirmSend (:464), so Cancel is genuinely free. The caption rides on the FIRST item only (:483-486, `i === 0 ? caption : ''`), the same rule MessageComposer.swift:614-616 applies with the same reasoning.
- Full-size look at a staged file before upload — frontend/src/components/chat/StagedFilePreview.jsx, reached by tapping a tray tile (MessageComposer.jsx:621, :711-718). Renders images, video (with controls) and audio from the local object URL; documents show icon + name + size, and :18-26 explains that a blob: PDF is blocked by the app's `default-src 'self'` CSP. Arrow-key paging and Escape at :39-47. This is the web's equivalent of the MediaSendSheet preview area — it just lacks the quality control.
- Per-file failure handling and batch upload progress in the send path — MessageComposer.jsx:485-506 keeps only the files that actually failed staged so they can be retried, and :702-706 shows a determinate bar plus 'Sending N files…'. iOS has the per-job UploadJob equivalent in MessageComposer.swift:765-810.
- Byte formatting parity — frontend/src/components/chat/DocumentBubble.jsx:29-34 formatFileSize is the source that MediaFormatting.byteLabel (MediaAttachmentViews.swift:22-29) was hand-copied from specifically so the two clients print the same string. The numbers already agree; only the metadata line's field order differs.
- Per-sender name colours in groups — the iOS `Theme.SenderColor` (Theme.swift:116-158) is an exact port OF the web, not the other way round. `SENDER_COLORS` (frontend/src/components/chat/MessageBubble.jsx:16-19) and `getSenderColor` (MessageBubble.jsx:21-28) are the original, applied at MessageBubble.jsx:253 (avatar) and MessageBubble.jsx:287 (sender name). Nothing to port.
- Sender name shown only on the first bubble of a run, in groups only — MessageBubble.jsx:285-290 (`!isOwn && showSenderName && isGroup`), with the boundary computed in ChatPanel.jsx:872 and the reserved-but-empty avatar gutter for subsequent rows at MessageBubble.jsx:257-259. Same rule as iOS `startsRun`.
- 'Forwarded' label above the content — MessageBubble.jsx:278-282, `↗ Forwarded` in italic 11px at `text-white/60` (own) / `#A3A3A3` (received). Identical role and colour token to the iOS version.
- Reply quote block inside the bubble, with a coloured left rule and click-to-jump — MessageBubble.jsx:293-307: `border-l-2`, white/40 rule on the own bubble and `#10B981` on the received one (the same inversion the iOS `ReplyQuoteView` comment justifies), sender name + 2-line preview, `onClick={() => onReplyClick(replyMsg._id)}`. Per-type preview labels at MessageBubble.jsx:81-90.
- Bubble hugging its content — the wrapper at MessageBubble.jsx:261 (`max-w-[80%] sm:max-w-[65%] lg:max-w-[550px]`) is a flex item of the `justify-end`/`justify-start` row at MessageBubble.jsx:241, so it is shrink-to-fit by default and clamped by max-width. Bubbles are already sized by their widest child, not stretched to the column. The iOS `.frame(maxWidth: .infinity)` bug described at MessageBubble.swift:372-379 has no web equivalent — only the footer's PLACEMENT differs, not the sizing model.
- Fixed-width audio and document cards — audio is `w-[260px]` (MessageBubble.jsx:332) against iOS 258pt; document is `w-[280px]` in both the plain-anchor (DocumentBubble.jsx:103) and PDF-preview (DocumentBubble.jsx:125) layouts, against iOS 290pt. Fixed card widths are already the design on both clients.
- Determinate per-upload percentage — MessageComposer.jsx:249-261 wires axios `onUploadProgress` into `setUploadProgress`, rendered as a real percentage bar at MessageComposer.jsx:705-707. This is BETTER than iOS, whose `IndeterminateBar` (MessageComposer.swift:1050-1075) exists only because `APIClient.upload` exposes no progress callback (see the note at MessageComposer.swift:717-721). Do not regress it while adding per-file rows.
- Explicit 'Sending N files…' status text during a batch — MessageComposer.jsx:708-710, `data-testid="attachment-sending-status"`. A batch-level status string does exist; what is missing is per-file identity and the compressing phase.
- Multi-select mode with a per-row checkbox — it is not in MessageBubble.jsx (which is why it looks absent), it wraps the bubble from ChatPanel.jsx:1043-1080: a `role="checkbox"` row, an emerald circle-check, `bg-[#10B981]/10` when selected, and the bubble itself made `inert` so in-bubble affordances (reactions, hover chevron) cannot fire — the exact concern the iOS `isSelecting` flag addresses.
- Reply strip above the composer with a dismiss X — ChatPanel.jsx:1415-1417 renders `<ReplyPreview message={replyTo} onClose={() => setReplyTo(null)} />`; ReplyPreview.jsx:15-21 has the emerald left rule, sender name and truncated snippet. Equivalent to the iOS `ReplyStrip` (MessageComposer.swift:954-1001).
- Admin-only-messages blocked notice replacing the composer — ChatPanel.jsx:1091-1092 computes `composerBlocked`, and ChatPanel.jsx:1420-1423 renders 'Only admins can send messages in this group' in place of `<MessageComposer>`. Same string as the iOS `blockedNotice` (MessageComposer.swift:371-381).
- Pinned and starred glyphs, the '· edited' label, the tap-to-retry control on a failed send, and the tick states — all present in the web footer at MessageBubble.jsx:359-403, plus `StatusIcon` at MessageBubble.jsx:55-67. The web actually has FOUR tick states (sending / sent / delivered / read) against iOS's three, since iOS collapses delivered and read (MessageBubble.swift:401-407).
- Squared tail corner on the sender's side — `rounded-[8px_8px_0px_8px]` for own and `rounded-[8px_8px_8px_0px]` for received, applied on all three bubble variants at MessageBubble.jsx:266-271. Same cue as the iOS `bubbleShape` UnevenRoundedRectangle.
- Jump-highlight flash — MessageBubble.jsx:241-243, `highlighted ? 'bg-[#10B981]/15 rounded-[6px]'` with `transition-colors duration-500`. The iOS `Theme.Color.jumpHighlight` is `primary.opacity(0.15)` (Theme.swift:105) — the same value, ported.
- File-type icon and colour mapping for document cards — `FILE_ICONS` at DocumentBubble.jsx:16-27 is the source the iOS `Theme.FileTypeColor` (Theme.swift:163-191) was ported from, including the `${color}20` chip fill at DocumentBubble.jsx:83.
- Reaction chips grouped by emoji with counts and a 'mine' highlight — `aggregateReactions` at MessageBubble.jsx:70-79 and the badge row at MessageBubble.jsx:407-429, including the `userIds.includes(currentUserId)` check that drives the emerald border.
- Caption on the first item of a multi-file batch only, and the reply id attached to the first item only — MessageComposer.jsx:481-485 (`i === 0 ? replyId : null`, `i === 0 ? caption : ''`). Identical rule to the iOS `consumeReplyID()` / `offset == 0` logic (MessageComposer.swift:102-106, 614-618).
- REFRESH-AND-REPLAY, WITH THE SAME THREE EXCLUDED ENDPOINTS — DONE. frontend/src/api/client.js:76-80 defines CREDENTIAL_401_PATHS = {'/api/auth/login', '/api/auth/refresh', '/api/auth/change-password'}, byte-for-byte the same set as APIClient.nonRefreshablePaths (ios/RxHive/Core/APIClient.swift:383-387). Critically, /api/auth/me is NOT excluded on either client — client.js:75 says so explicitly, and the interceptor at client.js:113-115 skips the refresh only for that exact set. This was the headline iOS fix; it is already done on the web.
- EXCLUSION IS CLASSIFIED ON THE PATHNAME, NOT BY SUBSTRING — DONE, and with the same reasoning as iOS. frontend/src/api/client.js:85-91 (`pathnameOf`) parses the URL and matches `new URL(...).pathname` against the set, with the comment at client.js:83-84 naming the '/api/reports?next=/api/auth/login' case. iOS does the equivalent normalisation in skipsRefresh (APIClient.swift:389-395). Do not 'fix' this.
- REFUSED vs UNDELIVERED REFRESH — DONE, and it is a shared exported helper. frontend/src/api/client.js:97-100 exports `sessionRejected(refreshError)` returning true only for status 401 or 403. Everything else — no response at all, 5xx, 429 — is undelivered. This is the exact three-valued distinction of RefreshOutcome (ios/RxHive/Core/APIClient.swift:477-481); the web collapses .refreshed/.rejected/.unreachable into resolve / sessionRejected===true / sessionRejected===false, which is the same information.
- STORED CREDENTIALS SURVIVE A TRANSIENT FAILURE — DONE, on both the interceptor path and the boot path. frontend/src/api/client.js:134-139: `localStorage.removeItem('user')` and the /login redirect are INSIDE `if (sessionRejected(refreshError))`; a 429 or a 502 returns Promise.reject at client.js:140 with the stored user untouched. frontend/src/contexts/AuthContext.jsx:42-48 does the mirror thing at boot: only 401/403 clears the cache, everything else falls back to `cachedUser()`. This matches APIError.endsSession (ios/RxHive/Core/APIError.swift:71-77) and AuthStore.handleSessionLost's precondition.
- WEBSOCKET 4001 HANDLING — DONE. frontend/src/services/websocket.js:111-131: on `event.code === 4001` it awaits refreshSession() and reconnects (websocket.js:114-115); on failure it signs out ONLY if sessionRejected(err) (websocket.js:123-127), otherwise it falls through to _scheduleReconnect() (websocket.js:128). Same shape as RealtimeClient.socketFailed's .valid/.unreachable/.rejected switch (ios/RxHive/Realtime/RealtimeClient.swift:219-248), including the 'this fires every 15 minutes so it constantly samples network health' reasoning, which is written out at websocket.js:117-122.
- BOOT-TIME SESSION RESTORE WITH AN OFFLINE FALLBACK — DONE (the restore itself; only the retry loop is missing, see gaps). frontend/src/contexts/AuthContext.jsx:29-52 calls /api/auth/me, and on a non-401/403 failure comes up signed-in from the localStorage 'user' mirror (AuthContext.jsx:11-17, :47). That is the same decision RememberedUser drives on iOS (ios/RxHive/Features/Auth/AuthStore.swift:118-125). The 'this is a mirror, not a credential' framing is documented identically at AuthContext.jsx:6-10 and AuthStore.swift:306-318.
- SINGLE-FLIGHT REFRESH WITH A DRAINED WAITER QUEUE — DONE. frontend/src/api/client.js:62-68 (`isRefreshing`, `failedQueue`, `processQueue`) and client.js:116-120: concurrent 401s park on a promise instead of each firing their own refresh, which is what RefreshCoordinator does on iOS (ios/RxHive/Core/APIClient.swift:497-510). The web also gets the subtle part right — processQueue is called before BOTH branches (client.js:131-133) so no waiter is ever left unsettled.
- NO STALE-TEARDOWN RACE — structurally handled, no port needed. iOS needs `sessionGeneration` (ios/RxHive/Features/Auth/AuthStore.swift:36, 254-267) so an async teardown cannot delete the cookies of a session that has since replaced it. The web's teardown is `window.location.href = '/login'` (frontend/src/api/client.js:137, frontend/src/services/websocket.js:125) — a full document navigation that destroys every in-flight closure — so the race cannot occur. Do not add a generation counter.
- SOCKET LIFETIME IS THE SESSION'S, NOT A ROUTE'S — DONE. frontend/src/components/shared/RealtimeSession.jsx:30-51, mounted in frontend/src/App.jsx:166 outside <Routes>, keyed on user?.id. This is the web equivalent of AuthStore owning `let realtime = RealtimeClient()` and calling connect()/disconnect() from enterSignedIn/signOut (ios/RxHive/Features/Auth/AuthStore.swift:27, 195, 218).
- APP-LEVEL HEARTBEAT (not a protocol ping) — DONE. frontend/src/services/websocket.js:666-677 sends `{type:'ping'}` every 30s with a 10s pong watchdog. Same requirement iOS documents at ios/RxHive/Realtime/RealtimeClient.swift:291-304: the server's expiry and liveness checks hang off receiving an application ping frame, so a protocol-level ping would not do. Both sit inside the backend's 65s HEARTBEAT_TIMEOUT.
- CHAT MESSAGES ARE NEVER QUEUED FOR REPLAY — DONE, and the web reasoning is actually more explicit than iOS's. frontend/src/services/websocket.js:622-648: sendMessage() returns false rather than queueing, because the sender falls back to an HTTP POST and a replayed frame would double-send. Callers gate on isOpen() (websocket.js:618-620), which reads the live socket rather than the React store copy.
- 429 IS TREATED AS RETRYABLE, NOT AS EXPIRY — DONE. Covered by sessionRejected (frontend/src/api/client.js:97-100) returning false for 429, and separately surfaced to users at frontend/src/utils/helpers.js:32 and frontend/src/pages/Login.jsx:34-36. Matches APIError.rateLimited being isRetryable on iOS (ios/RxHive/Core/APIError.swift:63-64).
- THE /login 401 IS NOT REPORTED AS AN EXPIRY — DONE. frontend/src/pages/Login.jsx:37-39 maps a 401 from login to 'Invalid email or password', and /api/auth/login is in CREDENTIAL_401_PATHS so no refresh is attempted. That is the purpose of APIError.credentials(detail:) on iOS (ios/RxHive/Core/APIError.swift:15, 36-37). The only difference is cosmetic — the web hardcodes the copy where iOS echoes the server's `detail` — and on web no gated 403 can reach login (backend/app/api/auth.py:75-87 gates only client=='mobile').
### Raised but thrown out on verification

These looked like gaps and are not:

- **Document metadata line orders and separates its three facts differently from iOS** — Web already builds this metadata line in four places; the gap is cosmetic (order/separator/case), not a missing capability. Search terms: formatFileSize, fileSize, file_size, byteLabel, formatBytes, humanFileSize, prettyBytes, filesize, pages, pageCount, page_count, numPages, documentSubtitle, subtitle, metaLine, metadataLine, docMeta, fileMeta, toUpperCase(), extension, ext, literal U+2022 bullet
- **Image caption filter is weaker than iOS — storage paths and filenames can leak as visible captions** — Searched /Users/carinrowena/Documents/HIVE EXPORT/Hive Export/rxhive/frontend/src exhaustively. Search terms used (grep -rn over .js/.jsx/.ts/.tsx, case-insensitive where noted): caption, mediaCaption, getCaption, captionFor, displayCaption, isMediaPath, isStoragePath, stripPath, sanitizeCaption, /uploads, /api/uploads, "startsWith('/", 'startsWith("/', filename, media_url, mediaUrl, normalizeMess
- **No self-correcting session revalidation after an offline boot, and no re-check on returning to the tab** — SEARCH TERMS (case-insensitive, whole of frontend/src + frontend/public/sw.js): checkAuth, revalidat, re-validat, reValidat, refreshSession, restoreSession, verifySession, sessionCheck, auth/me, authMe, getMe, fetchMe, currentUser(, visibilitychange, navigator.onLine, 'online', 'offline', 'focus', window.onfocus, document.hasFocus, addEventListener, pageshow, pagehide, freeze, resume, wake, foregr
- **iOS explicitly clears the session cookies after a proven failure** — Searched frontend/src with: cookie, document.cookie, cookieStore/CookieStore, clearSession, clearCookie, clearAuth, clearToken, purge, destroySession, expireCookie, max-age, expires=, Clear-Site-Data/clearSiteData, auth/logout, logout, signOut, hardLogout, forceLogout, forceSignOut, signOutEverywhere, revoke, invalidate, wipe, reset*Session, sessionLost, session_lost, access denied, /login, localS
---

## 2. Verified gaps

33 items. Each gives the iOS behaviour, the code to read on both sides, and an honest portability call.

## A. Voice notes and audio

### 1. Press-and-hold to record (hold-to-talk)

**Needs adaptation** · effort: medium

**What iOS does.** The mic button records on the PRESS STATE, not on tap. `MessageComposer.sendOrMicButton` uses `.onLongPressGesture(minimumDuration:...)`-style press tracking with `micHeld`, calling `beginRecording()` when the finger goes down and `endRecording()` when it lifts (MessageComposer.swift:475-524). While held, the composer row is replaced by `VoiceRecorderBar` in `.holding(dragX:dragY:)` mode: a pulsing red `mic.fill`, a live monospaced elapsed timer, and the caption "slide to cancel ‹" (VoiceRecorderBar.swift:69-105). Releasing without travel sends immediately; there is no second confirmation tap. The mic button also scales to 1.25x while held (MessageComposer.swift:330).

**Why it matters.** Hold-to-talk is the whole interaction model the iOS voice-note flow is built around — lock, slide-to-cancel and release-to-send are all children of it. Without it the web has a three-click flow (click mic, click finish, click send) for what iOS does in one continuous gesture.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `micHeld`, `beginRecording()`, `endRecording()`, `recorderMode`, `sendOrMicButton`
- ios/RxHive/Features/Chat/VoiceRecorderBar.swift — `Mode.holding(dragX:dragY:)`, `holdingStrip(dragX:)`

**What the web does today.** The mic is a plain click toggle. `frontend/src/components/chat/MessageComposer.jsx:870` — `onClick={hasText ? handleSend : (canRecord ? handleMicClick : undefined)}`. `handleMicClick` (MessageComposer.jsx:383-387) just calls `recorder.start()` and returns; recording then runs until the user clicks a separate Finish (Check) button in `AudioRecorderBar.jsx:102-111`. There is no pointer-down/pointer-up handling anywhere in the composer — I grepped the whole of frontend/src for `onPointerDown|onPointerUp|onPointerMove|onTouchStart|onTouchMove|onTouchEnd|onMouseDown|longPress|press.?and.?hold|holdTo|useLongPress` and the only hits are MessageBubble.jsx's long-press-to-open-context-menu (MessageBubble.jsx:125-186, 246-249). Nothing in the recorder path.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`, `frontend/src/components/chat/AudioRecorderBar.jsx`

**Porting notes.** Pointer Events give a browser everything it needs (pointerdown/pointermove/pointerup with setPointerCapture), so this is genuinely portable to touch. The adaptation is that a mouse-hold is a poor primary interaction on desktop: the web will need hold-to-talk on coarse pointers and keep the existing click-to-start toggle on fine pointers, rather than replacing one with the other. The `UIImpactFeedbackGenerator` haptics in `beginRecording()`/`lockRecording()` (MessageComposer.swift:438, 496) are not portable — the Vibration API is unavailable in iOS Safari.

**Corrections from verification.** The finding is accurate on substance; two refinements. (1) It says "there is no pointer-down/pointer-up handling anywhere in the composer" — true for the composer, but the codebase does have one pointerdown listener elsewhere: frontend/src/components/calls/CallAudioSink.jsx:93 uses a document-level `pointerdown` purely to unlock autoplay (see also services/livekitClient.js:286). Unrelated to recording, but the blanket "nothing anywhere" phrasing is slightly off. (2) The web flow is richer than "click Finish" — AudioRecorderBar has three stages (recording / paused / preview) with Discard, Pause-and-review, Finish, Resume and an explicit Send, i.e. a two-step commit (Finish then Send). That makes the UX gap LARGER than stated, not smaller: iOS release-to-send is one gesture, web is click-mic -> click-Check -> click-Send. Portability: I would not call this "direct". The gesture is entirely doable in a browser (pointerdown/pointerup/pointermove + setPointerCapture, touch-action:none, -webkit-touch-callout:none), but three things need real adaptation vs SwiftUI: (a) the FIRST hold triggers the getUserMedia permission prompt, which steals the pointer and breaks release-to-send — needs a first-run path that falls back to tap-toggle or pre-warms permission; (b) MediaRecorder start-up latency means a sub-~300ms hold captures a zero-byte blob (useAudioRecorder.js:139-144 already has the empty-blob guard, so it would silently no-op) — needs a minimum-duration threshold plus a "hold to record" hint; (c) mobile Safari fires selection/callout on long press, and the composer's existing scroll suppression (pages/Chat.jsx:59 preventScroll) has to coexist with slide-to-cancel tracking. Implementable, but not a mechanical port.

### 2. Swipe up to lock into hands-free recording

**Needs adaptation** · effort: medium

**What iOS does.** While the finger is down, dragging up past `VoiceRecorderBar.lockThreshold = 55` points locks the recording so it continues without the finger (MessageComposer.swift:418-420, `lockRecording()` at :431-439). A lock affordance — an open padlock that switches to `lock.fill` at 75% of the threshold, with a chevron that fades out once armed — floats above the mic button and rides upward with the drag (`VoiceRecorderBar.lockAffordance(dragY:)`, VoiceRecorderBar.swift:111-133; overlaid at MessageComposer.swift:281-282). Once locked the bar switches to `.locked`: full-width live meter plus trash / pause / send (VoiceRecorderBar.swift:137-178). The lock check runs BEFORE the cancel check so a diagonal drag locks rather than reading as a half-hearted cancel (MessageComposer.swift:415-418).

**Why it matters.** Only meaningful once hold-to-talk lands. It is the escape hatch that makes hold-to-talk tolerable for anything longer than a sentence, so shipping the hold gesture without lock would be a regression against today's click-to-start behaviour.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `micGesture`, `lockRecording()`, `isLocked`, `slideUp`
- ios/RxHive/Features/Chat/VoiceRecorderBar.swift — `lockThreshold`, `lockAffordance(dragY:)`, `lockedBar`

**What the web does today.** No such surface exists. Grepped frontend/src for `swipe|hands.?free|lockRecord|isLocked|lockThreshold|cancelThreshold` — zero hits outside unrelated CSS class strings. The web recorder is hands-free by definition (it starts on a click and keeps going), so there is nothing to lock; but that also means there is no in-between state and no affordance. `AudioRecorderBar.jsx:25-36` accepts only `stage` (`recording`/`paused`/`preview`) — there is no `holding` or `locked` stage in its vocabulary.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`, `frontend/src/components/chat/AudioRecorderBar.jsx`

**Porting notes.** The gesture itself is plain pointermove arithmetic and fully portable. It is only worth building on touch, and only alongside the hold gesture — on desktop the existing click-start IS the locked state, so the affordance should not render for fine pointers.

**Corrections from verification.** Nothing material — the finding is accurate. Two refinements: (1) the claimed "zero hits outside unrelated CSS class strings" is right, but the specific near-hits are the lucide `Lock` encryption icon in the calls/chat surfaces and the "VIEWPORT LOCK" comment at index.css:117, not CSS class strings generally. (2) The three-stage limit is asserted even more explicitly than the finding cites: AudioRecorderBar.jsx:10-14 states the stages in prose, and useAudioRecorder.js:7 states the full machine as 'idle' -> 'recording' <-> 'paused' -> 'preview', which is stronger evidence than the prop destructure at :25-36.

### 3. Slide left to cancel

**Needs adaptation** · effort: small

**What iOS does.** Dragging left past `VoiceRecorderBar.cancelThreshold = 90` points arms cancel; lifting the finger then discards the recording instead of sending it (`micGesture` sets `cancelArmed` at MessageComposer.swift:413; `endRecording()` branches on it at :513-516). The feedback is progressive rather than binary: the whole holding strip fades to 35% opacity as travel approaches the threshold, and the "slide to cancel" label slides left with the thumb at half rate (`travel`/`fade`/`.offset(x: -travel * 0.5)`, VoiceRecorderBar.swift:72-73, 98).

**Why it matters.** Same dependency as lock: without slide-to-cancel, a hold-to-talk release always sends, which makes the gesture feel dangerous. The trash button covers the locked/paused case adequately, so this is only needed if hold-to-talk ships.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `cancelArmed`, `slideOffset`, `micGesture`, `endRecording()`
- ios/RxHive/Features/Chat/VoiceRecorderBar.swift — `cancelThreshold`, `holdingStrip(dragX:)`

**What the web does today.** Cancel exists but only as a discrete button, never as a gesture: the red `Trash2` button at `frontend/src/components/chat/AudioRecorderBar.jsx:46-56`, wired to `recorder.cancel()` via `onCancel` at `MessageComposer.jsx:762`. There is no drag state at all in the recorder bar and no "slide to cancel" string anywhere in frontend/src.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`, `frontend/src/components/chat/AudioRecorderBar.jsx`

**Porting notes.** Portable as pointermove arithmetic, touch-only for the same reason as the lock gesture.

**Corrections from verification.** The finding is accurate as written. One addition it understates: web has no hold-to-record at all (mic is a tap toggle at MessageComposer.jsx:870), so this is not just a missing drag handler on an existing hold gesture — the whole press-and-hold interaction model the gesture lives inside is absent. That also affects portability: iOS's version is a modifier on hold-to-record, which cannot be dropped in as-is.

### 4. Sent-bubble waveform is decorative flat bars, not the clip's real amplitude

**Direct port** · effort: medium

**What iOS does.** `AudioAttachmentView` decodes the actual audio and draws its real envelope in the bubble. `AudioAttachmentPlayback.loadWaveform(path:)` (MediaAttachmentViews.swift:715-736) pulls the bytes (reusing the same `NSCache` the player fills, so a played note costs no extra network), writes them to a scratch file, and hands them to `WaveformExtractor.extract(from:key:)` (Waveform.swift:130-139). That runs an `AVAssetReader` over 16-bit mono PCM in one streaming pass, taking a peak per bucket for 64 buckets, then normalises to the loudest bar so a quietly-recorded note is not a flat line (Waveform.swift:141-204). Results are cached in an `NSCache` keyed by media path (Waveform.swift:120-124), so scrolling back is free. The header comment is explicit that a fake waveform was rejected: "A pattern that does not match what you hear is worse than no pattern: it invites you to scrub to a peak that is not there" (Waveform.swift:112-114).

**Why it matters.** The waveform's only job in a sent bubble is to let you scrub to where something was said. A flat row is scrubbable but gives no target, so the seek control is functionally blind on web and precise on iOS. It is also the most visible cosmetic difference between the two audio bubbles.

**iOS code to read.**

- ios/RxHive/Features/Media/Waveform.swift — `WaveformExtractor.extract(from:key:)`, `decode(url:)`, `cached(for:)`, `sampleCount = 64`
- ios/RxHive/Features/Media/MediaAttachmentViews.swift — `AudioAttachmentPlayback.loadWaveform(path:)`, `ScrubbableWaveform`

**What the web does today.** The web bubble draws a constant-height bar row. `PeaksWaveform` refuses to decode anything that is not a local blob — `frontend/src/components/chat/Waveform.jsx:164`: `if (!src || !src.startsWith('blob:')) { setPeaks(null); return undefined; }`. A sent note's src is `resolveUrl(message.media_url)` (MessageBubble.jsx:340), an http URL, so `peaks` stays null and the draw loop falls back to a literal constant — `Waveform.jsx:250-251`: `const level = peaks && peaks.length ? peaks[Math.floor((i / count) * peaks.length)] ?? 0.35 : 0.35;`. Every bar is therefore the same height. The module docstring states the intent plainly (Waveform.jsx:16-22): remote clips "fall back to a flat bar row. That row is a progress indicator wearing the same clothes, deliberately NOT a fabricated envelope". So the web is honest about it — but the shape is still absent. Note the bars ARE seekable (`onSeek`/`seekTo`, Waveform.jsx:274-295); only the amplitude data is missing. Confirmed the server sends no waveform data either way: grepped backend/app for `waveform|peaks|amplitude`, zero hits.

**Web files to change.** `frontend/src/components/chat/Waveform.jsx`, `frontend/src/components/chat/AudioPlayer.jsx`, `frontend/src/components/chat/MessageBubble.jsx`

**Porting notes.** The browser already does exactly this decode for the local preview — `fetch(src).arrayBuffer()` → `AudioContext.decodeAudioData` → `getChannelData(0)` → peak-per-bucket (Waveform.jsx:172-190). Pointing that same code at a remote URL is a one-line change; the real work is the caching and cost control the iOS side has (an `NSCache`-equivalent keyed by media_url, plus not decoding every clip in a long thread eagerly — decode on first play or on intersection, not on mount). Note the AAC-in-MP4 the app records decodes fine in every browser's decodeAudioData; the `.ogg`/`.weba` fallbacks from `pickAudioFormat` (utils/audioFormat.js:28-35) may not decode in Safari, so the flat-bar fallback has to survive.

**Corrections from verification.** Two small corrections, neither of which rescues the web. (a) The blob: gate is at Waveform.jsx:163, not :164. (b) The finding reads as though the web has no real-envelope extraction at all; in fact the full extraction path exists and works — fetch + decodeAudioData + getChannelData + per-bucket peak, Waveform.jsx:172-188 — it is just fenced off to blob: URLs, so it fires for the pre-send preview (AudioRecorderBar.jsx:79) and staged audio (StagedFilePreview.jsx:114) and never for a bubble. So the missing piece is not the algorithm, it is (i) removing the blob:-only gate, (ii) a peaks cache keyed by media path, and (iii) normalising to the clip's loudest bar — iOS normalises so a quiet note is not flat, whereas the web applies a fixed 1.6x gain, which would render a quietly-recorded note as near-flat even once the gate is opened. Also worth noting the finding undersells how close this is: it is roughly a 20-line change in one file, not a new subsystem.

### 5. Unplayed-avatar vs speed-pill leading control

**Direct port** · effort: small

**What iOS does.** The leading slot of the audio bubble swaps based on whether the note has ever been played. Before first play it shows the SENDER'S AVATAR with a small `mic.fill` badge in the bottom-trailing corner; after playback begins the avatar is replaced by the tappable speed pill (`AudioAttachmentView.leadingControl`, MediaAttachmentViews.swift:548-575, driven by `hasStarted`/`playback.hasPlayed`). The stated reason is at MediaAttachmentViews.swift:458-463: "Offering '2x' on a note nobody has heard yet is a control for a decision the listener has not had the chance to make." `hasPlayed` is a latch set in `start(_:)` (MediaAttachmentViews.swift:771) and deliberately NOT derived from `position > 0`, because reaching the end rewinds to zero and would otherwise flip a fully-listened note back to looking unplayed (MediaAttachmentViews.swift:634-640).

**Why it matters.** Two distinct differences in one control. The avatar-with-mic-badge is how a listener tells at a glance who a note is from and that they have not heard it yet — on web every voice note looks identical and looks equally listened-to. And the always-on speed pill offers a rate choice for audio the user has not heard.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaAttachmentViews.swift — `AudioAttachmentView.leadingControl`, `hasStarted`, `AudioAttachmentPlayback.hasPlayed`, `senderName`/`senderAvatarPath`

**What the web does today.** Web has neither half of the swap. The leading slot is a hardcoded static circle with a generic `Mic` glyph that never changes: `frontend/src/components/chat/MessageBubble.jsx:332-335` — `<div className="w-9 h-9 rounded-full ..."><Mic size={18} .../></div>`. No sender avatar is passed to or rendered by the audio bubble. Separately, the speed pill is always visible, on the TRAILING side, from first paint: `AudioPlayer.jsx:154-169` renders the `{rate}x` button unconditionally. There is no played/unplayed state at all — I grepped frontend/src for `hasPlayed|unplayed|played\b` and the only hits are call-audio `el.play()` promises and the `played` fill colour in Waveform.jsx:223.

**Web files to change.** `frontend/src/components/chat/AudioPlayer.jsx`, `frontend/src/components/chat/MessageBubble.jsx`

**Porting notes.** Pure React state plus the existing avatar component. `hasPlayed` is a boolean latched in AudioPlayer's `onPlay` handler; the sender's avatar_url is already available on the message object in MessageBubble. Nothing platform-specific.

**Corrections from verification.** Two small additions, neither changing the verdict. (1) The claim says no sender avatar is passed to or rendered by the audio bubble — true, but MessageBubble DOES render a row-level sender avatar for group received messages at MessageBubble.jsx:250-258. It is a 7x7 initial-letter circle (message.sender_name?.charAt(0)), not an image, sits outside the bubble, is gated on isGroup && showSenderName, and has zero relationship to audio or playback state. So an identity affordance exists nearby, but not in the audio bubble's leading slot and it never swaps. (2) Port plumbing note: no chat message payload carries a sender avatar URL. `sender_avatar` appears exactly once in the whole tree (components/chat/info/StarredSection.jsx:258, the starred-message API shape); services/websocket.js:181 forwards only sender_name. A faithful port needs sender_avatar plumbed into the message shape or must fall back to initials. That is plumbing, not a platform limit. Everything else in the finding is accurate, including line numbers and the Waveform.jsx:223 false positive.

### 6. Mid-recording preview is unreliable on Safari; iOS guarantees it plays

**Needs adaptation** · effort: large

**What iOS does.** iOS records each record→pause cycle as its own FINALISED `.m4a` segment and stitches them with `AVMutableComposition`, precisely so the paused preview always opens. The header comment states the problem being solved (AudioRecorder.swift:16-26): `AVAudioRecorder.pause()` would keep one file, "but a paused MP4 has no finalised `moov` atom, so `AVAudioPlayer` cannot open it. That kills the whole point of pausing". So `pause()` stops and finalises the current segment (AudioRecorder.swift:127-138), `resume()` opens a new one (:142-148), `previewAsset()` returns a composition spanning all of them for `VoiceNotePreviewPlayer` to play without an export (:213-232), and `finish()` exports once — with a fast path that skips the export entirely for the single-segment case (:156-196).

**Why it matters.** Pausing exists so you can hear yourself back before continuing. On Safari — which is the browser the recording format was chosen for in the first place (utils/audioFormat.js:13-17) — that review step can silently do nothing, giving a dead player and a flat waveform. The user's only recourse is to finish the recording, which is the commitment pausing was meant to let them avoid.

**iOS code to read.**

- ios/RxHive/Features/Chat/AudioRecorder.swift — `segments`, `pause()`, `resume()`, `previewAsset()`, `finish()`, `export(segments:)`
- ios/RxHive/Features/Chat/VoiceRecorderBar.swift — `VoiceNotePreviewPlayer`, `pausedBar`

**What the web does today.** Web keeps ONE MediaRecorder alive across pause/resume and builds the paused preview from the chunks captured so far after a `requestData()` flush (`frontend/src/hooks/useAudioRecorder.js:182-222`), tagging it `partial: true` (:216). Its own docstring acknowledges the failure (useAudioRecorder.js:17-21): "Safari records audio/mp4, whose moov atom is only written on stop, so a partial preview there may refuse to play." The consequence cascades — `PeaksWaveform` also swallows the decode failure and drops to flat bars (`Waveform.jsx:191-195`: "A partial recording ... cannot be decoded. Fall back to flat bars."). The sent file is never affected: a paused send calls `recorder.stop()` first and picks up the completed blob via the effect at MessageComposer.jsx:423-428.

**Web files to change.** `frontend/src/hooks/useAudioRecorder.js`, `frontend/src/components/chat/AudioRecorderBar.jsx`

**Porting notes.** The browser cannot mirror the iOS design cheaply. It CAN do the segmenting half — stop and restart MediaRecorder on each pause, producing N finalised playable blobs — and it can play them back as one by chaining `<audio>` elements or by decoding all N with `decodeAudioData` and concatenating into an `AudioBuffer` for preview. The hard half is producing a SINGLE file on send: there is no browser equivalent of `AVAssetExportSession`, so stitching means decode-all + re-encode, which needs WebCodecs `AudioEncoder` (Chrome/Edge, and Safari 16.4+ only for some codecs) or a WASM encoder. A cheaper adaptation is to keep today's single-recorder approach and simply disable/greay the paused preview when the partial blob fails to decode, so the control is honest instead of dead.

**Corrections from verification.** Two refinements, both of which make the gap WIDER, not narrower, plus one over-generous detail in the finding.

1. The finding (echoing the hook's docstring) frames this as Safari-only. It is not. utils/audioFormat.js:28-35 puts `audio/mp4` FIRST in the candidate list and pickAudioFormat() returns the first supported entry, with a load-bearing comment that this order is deliberate (backend classifies .webm as video; AAC-in-MP4 is the only universally playable output). Current Chrome supports MediaRecorder with audio/mp4, so Chrome also records MP4 and also gets an unfinalised, unplayable partial preview. Only Firefox (no MP4 muxing → falls through to audio/ogg;codecs=opus) reliably gets a playable mid-recording preview. So the "streamable container saves us" assumption in the docstring holds only on the fallback path.

2. The docstring's claim that a failed partial preview "degrades to 'cannot preview yet'" is not implemented. AudioPlayer.jsx has no error/`onerror`/`canplay`/readyState handling at all (only an `ended` listener at :65 and a play() promise catch at :106 that just sets isPlaying=false). There is no "cannot preview" string anywhere in src. So the real degradation is silent: the user taps play on the paused preview, the waveform is flat bars, and nothing happens.

3. Minor: the finding says the sent file is "never affected". True for the audio, but the paused-send path does silently stop the recording (MessageComposer.jsx:430-439) — the user cannot review-then-send without ending the take, which is the same limitation in a different place.

### 7. No minimum-duration guard on a recording

**Needs adaptation** · effort: small

**What iOS does.** `AudioRecorder.minimumDuration = 0.6` seconds (AudioRecorder.swift:47), described as "Below this a press reads as a mis-tap on the mic rather than a message." `finish()` enforces it, deleting the temp files and returning nil (AudioRecorder.swift:168-172), and the composer turns that nil into a coaching toast rather than a silent nothing — "Hold to record, release to send" on the release path (MessageComposer.swift:519) and "That recording was too short to send" from the locked/paused bar (:468).

**Why it matters.** Low severity today because the web needs a deliberate second click to finish, so accidental sub-second notes are rare. It becomes load-bearing the moment hold-to-talk ships, since a mis-tap on the mic would then send a 200ms note. The missing user-facing message for the empty-blob case is a small standalone bug regardless.

**iOS code to read.**

- ios/RxHive/Features/Chat/AudioRecorder.swift — `minimumDuration`, `finish()`
- ios/RxHive/Features/Chat/MessageComposer.swift — `endRecording()`, `finishAndSend()`

**What the web does today.** The only guard is on bytes, not on time: `frontend/src/hooks/useAudioRecorder.js:139-144` — `if (blob.size === 0) { setState('idle'); setElapsed(0); return; }`, commented "Nothing captured — a muted device, or stopped before the first chunk." Anything with a byte in it becomes a sendable preview. Grepped for `minimumDuration|MIN_DURATION|too short` across frontend/src: no hits. And when that byte-guard does trip, the hook returns to idle with no message at all, so the user sees the recorder bar vanish with no explanation.

**Web files to change.** `frontend/src/hooks/useAudioRecorder.js`, `frontend/src/components/chat/MessageComposer.jsx`

**Porting notes.** A comparison against the wall-clock `elapsed` the hook already maintains, plus a toast. Nothing platform-specific.

**Corrections from verification.** Two things the finding gets slightly wrong, neither of which changes the verdict:

1. The web has no press-and-hold recording model at all, so the iOS framing ("a press reads as a mis-tap on the mic rather than a message", the release-path toast "Hold to record, release to send") has no corresponding path on web. `MessageComposer.jsx:869` wires the mic to a plain `onClick={handleMicClick}`, which calls `recorder.start()` and swaps the composer row for `AudioRecorderBar` (a persistent bar with Discard / Pause / Finish / Send). There is no pointerdown/pointerup gesture anywhere in frontend/src (grepped `pointerdown|mousedown|touchstart|long ?press|hold to record` — only hits are `MessageBubble.jsx` long-press context menu and `CallAudioSink.jsx` autoplay-unblock). So the web mis-tap is "click mic, immediately click the red Finish check", not "tap-and-release". A port has to move the guard to the stop/finish path and rewrite the copy; the iOS toast strings are not reusable verbatim.

2. The silent-failure problem is broader than the finding states. Three separate paths in `useAudioRecorder.js` drop the recording with zero user feedback:
   - `:133-137` discard path -> `setState('idle')`, no message (correct — user asked for it)
   - `:139-144` empty-blob path -> `setState('idle')`, no message (the one the finding names)
   - `:204-218` pause path -> `setResult(null)` when `blob.size === 0`, which leaves the bar in `paused` stage rendering an `AudioPlayer` with `src={undefined}` and a live Send button (`AudioRecorderBar.jsx:79-88, 128-140`). A sub-second pause therefore produces an empty player plus an enabled Send, which is worse than the vanishing bar.

The mechanism itself is fully browser-native — the hook already computes exactly the number the guard needs. `elapsedNow()` (`:58-61`) returns wall-clock ms excluding paused time, and `onstop` already does `const seconds = elapsedNow() / 1000` at `:128` before assembling the blob. The guard is a one-line `if (seconds < 0.6)` next to the existing `blob.size === 0` check, and `toast` from `sonner` is already imported in the composer (`MessageComposer.jsx:5`). Rating it needs-adaptation only because the trigger points and the coaching copy have to be redesigned for a click-to-start UI, not because a browser can't do it.

### 8. No handling for the input device disappearing mid-recording

**Needs adaptation** · effort: small

**What iOS does.** `AudioRecorder.observeInterruptions()` (AudioRecorder.swift:348-361) subscribes to `AVAudioSession.interruptionNotification` and PAUSES on `.began`. The reasoning at :341-347: without it "the timer keeps counting against a recorder that has stopped capturing, and the user sends silence", and it pauses rather than cancels because "throwing away a half-finished message without asking is worse than handing it back paused".

**Why it matters.** Lowest-severity item here — it needs a hardware event to trigger — but the failure is silent and the user only discovers it after sending.

**iOS code to read.**

- ios/RxHive/Features/Chat/AudioRecorder.swift — `observeInterruptions()`, `stopObservingInterruptions()`

**What the web does today.** Nothing equivalent. `frontend/src/hooks/useAudioRecorder.js` attaches no listeners to the MediaStream or its tracks — grepped that file for `onended|'ended'|onmute|visibilitychange|onerror`, zero hits. The only track handling is `releaseStream()` calling `t.stop()` on teardown (useAudioRecorder.js:73-76). If the microphone is unplugged or seized by another app mid-recording, the wall-clock tick at :64 keeps counting and the user sends a note that is partly or wholly silence.

**Web files to change.** `frontend/src/hooks/useAudioRecorder.js`

**Porting notes.** A browser has no phone-call interruption concept, so this is not a one-to-one port. The genuine web analogues are `MediaStreamTrack`'s `ended` event (device removed / permission revoked) and its `mute`/`unmute` events (input seized), both widely supported. Pausing on those gets most of the iOS behaviour.

**Corrections from verification.** The finding is essentially correct, with two nuances it understates. (a) It says "the only track handling is releaseStream() calling t.stop()" — there is also useAudioRecorder.js:169, the same t.stop() cleanup on MediaRecorder construction failure, and a degenerate partial guard at :139-144 where a zero-byte blob resets to 'idle' instead of producing a preview (covers only a device that never produced a chunk, and does so silently with no message). (b) The web is not entirely blind: the LiveWaveform AnalyserNode (components/chat/Waveform.jsx:44-134, rendered at AudioRecorderBar.jsx:76) flatlines when the input goes silent, and the code comment at AudioRecorderBar.jsx:72-75 shows this ambiguity was already reasoned about. That is user-visible feedback, not handling — the flatline is indistinguishable from a quiet passage, and no state, timer, or send path reacts to it. The portability rating should be needs-adaptation, not direct.


## B. Media: quality tiers, capture and viewers

### 9. No client-side image re-encode/downscale before upload (Standard tier)

**Needs adaptation** · effort: medium

**What iOS does.** Before any byte leaves the device, MediaTranscoder.image(data:filename:quality:) runs the picked photo through ImageIO — CGImageSourceCreateThumbnailAtIndex with kCGImageSourceThumbnailMaxPixelSize set to MediaQuality.maxImageEdge (1600px Standard / 3024px HD) and kCGImageSourceCreateThumbnailWithTransform:true so EXIF rotation is baked in — then JPEG-encodes at MediaQuality.jpegQuality (0.7 / 0.9). It never upscales, it rewrites the filename to .jpg because the server derives MIME from the extension, and it keeps the ORIGINAL bytes whenever the original is already a JPEG that is smaller than the re-encode. Net effect: a 4.5 MB HEIC iPhone photo goes out at a few hundred KB on Standard.

**Why it matters.** A modern phone photo pasted or dropped into the web app in a hospital browser goes up at full sensor resolution, and one over 16 MB is refused outright rather than fitted — the same photo sent from iOS arrives. Recipients on iOS then pull those full-size originals down over cellular.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaQuality.swift — enum MediaQuality (maxImageEdge, jpegQuality), enum MediaTranscoder.image(data:filename:quality:) -> Output
- ios/RxHive/Features/Chat/MessageComposer.swift:765-810 — enqueueMedia(...) applies the transcode on a background Task before RxHiveAPI.upload

**What the web does today.** The web uploads the raw File object untouched. frontend/src/components/chat/MessageComposer.jsx:249-261 `uploadFile` does `formData.append('file', file)` and POSTs it; :276-282 `sendMediaFile` calls it with `batch[i].file` straight from the staging tray (:339 `file: f`). The only thing standing between a picked photo and the wire is :263-272 `validateSize`, which REJECTS anything over MAX_IMAGE_SIZE (:19, 16 MB) with a toast instead of shrinking it. I grepped the whole of frontend/src for `canvas`, `createImageBitmap`, `toBlob`, `OffscreenCanvas`, `drawImage`, `compress`, `quality`, `resize`, `downscale`, `transcode`, `re-encode`/`reencode` — the only canvas hits are components/chat/Waveform.jsx (audio waveform painting) and the only `quality` hits are LiveKit network-quality indicators in stores/callStore.js and components/calls/ActiveCallView.jsx. Nothing re-encodes an upload.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx (uploadFile / sendMediaFile / handleConfirmSend)`, `a new frontend/src/utils/ module for the encode, so the tray and the send path share one implementation`

**Porting notes.** Fully doable in a browser: createImageBitmap({resizeWidth/resizeHeight}) or a plain <canvas> drawImage + canvas.toBlob('image/jpeg', q). createImageBitmap with imageOrientation:'from-image' handles the EXIF transform the iOS path gets from kCGImageSourceCreateThumbnailWithTransform. Note two real browser caveats that ImageIO does not have: HEIC (what an iPhone hands a browser via the file picker on macOS/iOS Safari) is not decodable by canvas in Chrome/Firefox, and the toBlob output must still be compared against the original size and the smaller one kept, exactly as MediaQuality.swift:126-129 does.

**Corrections from verification.** The finding is accurate in every particular, including all cited line numbers, but it under-counts the blast radius: there is a SECOND raw upload path it does not mention. /Users/carinrowena/Documents/HIVE EXPORT/Hive Export/rxhive/frontend/src/components/chat/ProfileDrawer.jsx:61-75 `handleAvatarUpload` does the same `new FormData(); formData.append('file', file)` POST to /api/upload for the profile avatar (file input at :114, `accept="image/*"`). It is worse than the message path: it has no validateSize call at all, so a 40 MB photo is pushed at the server and only bounced by the backend limit. A fix should route both call sites through one shared transcode helper.

Portability sanity-check: a browser can genuinely do the core of this, so "not-portable" would be wrong, but "direct" overstates it. Directly available: createImageBitmap(file, { resizeWidth/resizeHeight, resizeQuality: 'high', imageOrientation: 'from-image' }) gives the downscale plus EXIF-rotation-baked-in that kCGImageSourceCreateThumbnailWithTransform provides; canvas/OffscreenCanvas + toBlob('image/jpeg', 0.7) gives the JPEG encode at MediaQuality.jpegQuality; the never-upscale rule, the .jpg filename rewrite (via `new File([blob], name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' })`), and the keep-original-if-smaller rule are all trivial JS. The adaptation needed is HEIC: Chrome and Firefox cannot decode image/heic at all, so createImageBitmap rejects and the code must fall back to uploading the original bytes. In practice that fallback rarely fires for the headline case, because iOS Safari and Android Chrome convert HEIC to JPEG when a photo is picked through `<input type="file" accept="image/*">` — the raw-HEIC path is mostly a desktop user dragging in a file copied off a phone. Also worth noting: the app has no 'wasm-unsafe-eval' in its CSP (see PdfViewer.jsx:17), so a wasm HEIC decoder is not an option without a CSP change. Hence needs-adaptation.

### 10. No Standard/HD control and no measured post-transcode size in the pre-send tray

**Needs adaptation** · effort: small

**What iOS does.** MediaSendSheet puts an HD pill in the top bar (qualityButton): tap flips MediaQuality.standard <-> .hd with haptic feedback, press-and-hold (0.4s) opens MediaQualitySheet, a detented sheet explaining 'HD quality is clearer. Standard quality uses less storage space and is faster to send.' with the two labelled rows ('Faster to send, smaller file size' / 'Slower to send, can be 6 times larger'). The choice persists via @AppStorage(MediaQuality.storageKey = "rxhive.mediaQuality"). Directly above the caption field the sheet prints the REAL cost of this send: MediaSendSheet.swift:109-120 re-runs MediaTranscoder.image on a detached task keyed on "index-quality-itemCount" and shows the measured byte count via MediaFormatting.byteLabel, alongside a photo/video glyph, the clip duration and the tier name. Video, whose export is too slow to measure for a label, shows '<size> original' and says so.

**Why it matters.** This is the surface where the size decision is actually made. Without it the web user has no way to trade fidelity for speed and no idea what a send costs before spending it — and the two clients disagree about what 'sending a photo' means.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaSendSheet.swift:167-191 (qualityButton), :268-296 (sendBar size/tier line), :109-120 (.task that measures the real post-transcode size)
- ios/RxHive/Features/Media/MediaQuality.swift:245-327 — struct MediaQualitySheet

**What the web does today.** The web tray has no quality affordance and no size readout at all. frontend/src/components/chat/MessageComposer.jsx:581-706 renders the whole confirmation tray: header + Cancel (:592-606), 60px tiles (:614-670), caption input (:678-687), send button (:688-700), progress bar (:704-706). Size appears only in the tile's `title` tooltip (:619 `title={...formatFileSize(f.size)}`) — invisible to touch and keyboard users — and in the full-size StagedFilePreview header (frontend/src/components/chat/StagedFilePreview.jsx:71-74), and in both places it is the ORIGINAL size because nothing re-encodes. I grepped frontend/src for `HD`, `mediaQuality`, `media.quality`, `standard quality` — zero hits anywhere, including pages/Settings.jsx, which stores rxhive_notif_sound / rxhive_desktop_notif / rxhive_enter_sends / rxhive_font_size (:78-97) and nothing media-related.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx (tray header + the caption/send row)`, `frontend/src/pages/Settings.jsx if the default tier should be settable outside the tray`

**Porting notes.** A toggle plus a Blob.size readout is trivially portable; it just has no meaning until the image re-encode gap above is closed, so it should land as part of that change rather than before it. The long-press-to-explain gesture would become a hover tooltip or an info button; the @AppStorage persistence maps to localStorage, matching how pages/Settings.jsx already persists preferences.

**Corrections from verification.** No correction to the finding itself — it is accurate in every particular I checked (the tray line ranges, the tooltip-only size at MessageComposer.jsx:620, the original-size header at StagedFilePreview.jsx:71-74, the zero grep hits, and the Settings.jsx key list). Two additions worth carrying: (1) the absence is deeper than "no affordance" — there is no re-encode capability in the web app at all (zero canvas-encode calls outside the audio waveform, no processing dependency in package.json), so the HD toggle and the measured-size label must both be built from scratch, not merely surfaced; (2) the backend cannot help as-is — POST /api/upload (backend/app/api/media.py:95) takes no quality parameter, and the only backend `quality` values are server-side thumbnail/PDF JPEG settings (backend/app/services/storage.py:231,278).

Portability: "direct" would overstate it. The load-bearing part is genuinely browser-native — createImageBitmap + OffscreenCanvas.convertToBlob({type, quality}) in a Web Worker yields a real re-encoded blob whose .size is a MEASURED byte count, exactly what MediaTranscoder.image produces for the label, and the keyed detached task maps onto an abortable keyed worker request. Video needs no heroics: iOS already prints "<size> original" because export is too slow to measure, and web should print the identical thing — in-browser video re-encode is additionally blocked here, since components/chat/PdfViewer.jsx:16-17 documents a CSP of script-src 'self' with no 'wasm-unsafe-eval', which rules out ffmpeg.wasm. Adaptations required: @AppStorage -> localStorage (suggest rxhive_media_quality, matching the existing key prefix); the detented MediaQualitySheet -> a popover/dialog; press-and-hold (0.4s) -> long-press PLUS a keyboard-reachable affordance, since a timed hold is not keyboard-operable; and the haptic feedback has no equivalent on iOS Safari (navigator.vibrate is Android-only) and should be dropped rather than shimmed. Worth fixing the tooltip-only size regardless — it is an accessibility gap for touch and keyboard users independent of the HD feature.

### 11. No video re-encode before upload

**Needs adaptation** · effort: large

**What iOS does.** MediaTranscoder.video(data:filename:quality:) writes the picked clip to a temp file, builds an AVURLAsset, checks AVAssetExportSession.exportPresets(compatibleWith:) contains the tier's preset (AVAssetExportPresetMediumQuality for Standard, AVAssetExportPresetHighestQuality for HD — chosen over a fixed 1920x1080 preset precisely so 4K is not silently downscaled nor 720p upscaled), exports to MP4 with shouldOptimizeForNetworkUse = true so the moov atom leads and a recipient can start playing before the download finishes, and — critically — falls back to the untouched original whenever the export fails or comes out LARGER than the source. The composer shows 'Compressing…' as the upload-job status while this runs (MessageComposer.swift:776).

**Why it matters.** A web user can push a 200 MB clip into a conversation that every iOS recipient then downloads; the same clip sent from iOS is re-encoded and moov-optimised first.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaQuality.swift:192-236 — MediaTranscoder.video(data:filename:quality:)
- ios/RxHive/Features/Media/MediaQuality.swift:61-66 — MediaQuality.videoPreset

**What the web does today.** Same raw-upload path as images: frontend/src/components/chat/MessageComposer.jsx:249-261 posts the File as-is, and :20 MAX_MEDIA_SIZE simply permits up to 200 MB. The staged tile only renders a `<video preload="metadata">` for the thumbnail (:637). No transcode of any kind exists in frontend/src.

**Web files to change.** `backend/app/api/media.py (if this is solved server-side)`, `frontend/src/components/chat/MessageComposer.jsx (only to surface progress/state)`

**Porting notes.** Honestly not portable in this app. MediaRecorder can only re-encode by playing the clip back in real time, which is unusable for anything but the shortest videos. WebCodecs + a JS muxer is the only real option and it is uneven across browsers, but the blocker here is concrete and documented in the codebase: frontend/src/components/chat/PdfViewer.jsx:13-17 records that the app's CSP is `script-src 'self'` with no `wasm-unsafe-eval`, which rules out ffmpeg.wasm outright. The moov-atom faststart step has no browser equivalent at all. If video size is a problem for web uploads, the answer is a server-side transcode on the /api/upload path, not a client one.

**Corrections from verification.** Two refinements to the finding, neither of which changes the verdict. (1) The gap is slightly wider than stated: web has no Standard/HD quality setting whatsoever, so porting this needs the settings tier added too, not just the encoder. (2) MAX_MEDIA_SIZE at 200MB does not merely "permit" large files — validateSize (MessageComposer.jsx:263-272) hard-rejects anything larger with a toast, where iOS would have compressed it under the ceiling, so the practical failure is a blocked send, not just a slow one.

### 12. Video bubbles and gallery tiles have no generated poster frame

**Needs adaptation** · effort: medium

**What iOS does.** The upload service only thumbnails images and PDFs, so a video arrives with thumbnailURL nil. ImageAttachmentView handles that by falling back to VideoFrameThumbnail (MediaAttachmentViews.swift:272-324), which builds an AVURLAsset with the session cookies attached, runs AVAssetImageGenerator with appliesPreferredTrackTransform = true and maximumSize 720x720, and grabs the frame at 0.5s — deliberately not frame zero, because the first frame of a phone recording is often black or half-exposed — then caches it in ImageCache under a '<path>#frame' key. MediaSendSheet gets the same treatment pre-send via MediaTranscoder.videoPoster(url:), which pulls the frame at 0.15s.

**Why it matters.** In the web gallery every video in a conversation is an identical anonymous grey square — you cannot tell one clip from another without opening each. In the thread, video bubbles frequently show a black rectangle.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaAttachmentViews.swift:222-234 (thumbnail fallback branch), :272-324 (private struct VideoFrameThumbnail)
- ios/RxHive/Features/Media/MediaQuality.swift:170-182 — MediaTranscoder.videoPoster(url:)

**What the web does today.** In the chat bubble the web sets `poster={message.thumbnail_url ? resolveUrl(...) : undefined}` (frontend/src/components/chat/MessageBubble.jsx:319) — and thumbnail_url is always absent for video, because backend/app/api/media.py:145-152 only builds a thumbnail when `file_type == "image"` or the content type is application/pdf. So the bubble falls back to `preload="metadata"` (:317) and shows whatever frame-0 the browser decides to paint, which is exactly the black frame the iOS code works around. In the media gallery it is worse: frontend/src/components/chat/info/MediaLinksDocsSection.jsx:363 deliberately refuses the media_url fallback for video (`item.thumbnail_url || (isVideo ? null : item.media_url)`) with a comment explaining that pointing an <img> at an mp4 rendered a broken tile, so a video tile shows a grey Film glyph (:384-387) and never a picture of the video. The staged pre-send tile is the one place the web does render a frame, via `<video preload="metadata">` (MessageComposer.jsx:637).

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx (video branch, :312-325)`, `frontend/src/components/chat/info/MediaLinksDocsSection.jsx (media tile, :357-398)`, `backend/app/api/media.py:141-156 if solved server-side instead`

**Porting notes.** Straightforwardly portable: an offscreen <video> with preload='metadata', seek to ~0.5s, wait for 'seeked', drawImage onto a canvas, toDataURL/toBlob. The pieces are already in the codebase — MessageComposer.jsx:637 already relies on preload='metadata' rendering a frame, and Waveform.jsx already does canvas + devicePixelRatio work. The one thing to check is that /api/media/{id} is same-origin (it is — the API 307-redirects and cookies flow, per the ImageBubble.jsx:12-15 comment), otherwise the canvas would taint. The alternative, and probably the better one given both clients need it, is to make backend/app/api/media.py extract the poster at upload time so thumbnail_url is populated for video and BOTH clients stop doing this work.

**Corrections from verification.** Minor framing nit only: the finding says the staged tile is "the one place the web does render a frame". Two other sites also mount live <video> elements — StagedFilePreview.jsx:107 (pre-send full-size check) and FullscreenVideoViewer.jsx:106 (gallery playback) — but both are players rather than poster surfaces, so the verdict is unchanged. Everything else in the finding is accurate, including the exact line numbers and the two source comments that explicitly document the missing video poster.

### 13. No duration badge on video thumbnails

**Direct port** · effort: small

**What iOS does.** ImageAttachmentView.videoOverlay (MediaAttachmentViews.swift:240-268) stamps a capsule in the bottom-leading corner of the bubble carrying a video.fill glyph and MediaFormatting.durationLabel(attachment.duration) — the glyph is there specifically so '0:09' is not misread as the sent-time, which sits in the opposite corner. The gallery tile does the same with a play.fill glyph (MediaGalleryView.swift:517-531). MediaFormatting.durationLabel returns nil when the server sent no duration, so nothing prints a confident '0:00' about a file it never opened.

**Why it matters.** Cosmetic in the bubble (native controls cover it), genuinely missing in the gallery grid where there are no controls at all.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaAttachmentViews.swift:240-268 — ImageAttachmentView.videoOverlay
- ios/RxHive/Features/Media/MediaAttachmentViews.swift:50-60 — MediaFormatting.clockLabel / durationLabel
- ios/RxHive/Features/Media/MediaGalleryView.swift:517-531 — gallery tile overlay

**What the web does today.** The chat bubble renders a bare `<video controls>` (frontend/src/components/chat/MessageBubble.jsx:313-321) with no overlay — the length is only visible inside the browser's own transport bar once the element has loaded metadata. The gallery tile shows a Film icon in a black pill at exactly the position iOS puts the duration, with no text: frontend/src/components/chat/info/MediaLinksDocsSection.jsx:391-395. utils/audioFormat.js already has the formatDuration the iOS clockLabel was copied from, so the formatter exists.

**Web files to change.** `frontend/src/components/chat/info/MediaLinksDocsSection.jsx:391-395`, `frontend/src/components/chat/MessageComposer.jsx (to send duration for video)`, `backend/app/api/media.py (if measured server-side)`

**Porting notes.** Portable, but note a real prerequisite before building it: duration is CLIENT-supplied on message create (backend/app/api/messages.py:120-124, `duration: float | None`) and neither client sends it for video — the web only passes it for voice notes (MessageComposer.jsx:405) and iOS passes `duration: nil` on the media path (MessageComposer.swift:800-803). So attachment.duration is null for every video in the system today and the iOS badge itself almost never renders. Whoever fixes this should populate duration_seconds for video (client-side via the same offscreen <video> used for the poster, or server-side at upload) rather than just adding the badge.

**Corrections from verification.** Two corrections, one of which materially shrinks the gap.

1. The gallery half of the claim is wrong at runtime. The server never sends duration in the media-list payload: backend/app/api/media.py:507-537 (GET /api/conversations/{conv_id}/media) builds each item with _id, message_id, media_url, thumbnail_url, filename, file_size, mime_type, page_count, sender_name, created_at — no duration. iOS's MediaItem does decode `duration` (ios/RxHive/Models/ResponseModels.swift:266), so MediaGalleryView.swift:523 `if let duration = …` is always false and the iOS tile renders a bare play.fill in a bottom-leading capsule. The web tile renders a bare Film glyph in a bottom-left black pill at the same position. On the gallery tile the two clients are visually equivalent today; iOS is not showing "0:09" there.

2. Even in the bubble, duration exists only for iOS-sent videos. duration_seconds is only ever written from the client-supplied field on message create (backend/app/services/messaging.py:180) — the server does not probe the file, despite the comment at ios/.../MediaAttachmentViews.swift:409 claiming it does. iOS measures it locally with AVAsset (MessageComposer.swift:586-590 via MediaTranscoder.videoPoster) and passes it through to the send. The web never does: sendMediaFile's duration param (MessageComposer.jsx:276, :294) is passed only by the voice-note path at :405; the photo/video batch path at :481 leaves it null. So a video sent from the web has duration=null forever and would print nothing on either client. Adding the web badge without also measuring duration on the web upload path only fixes half the chats.

3. Partial prior art worth reusing rather than reinventing: StarredSection.jsx:39-43,83 already formats and displays a video's duration (as row text), and utils/audioFormat.js:61 already has the m:ss formatter — that's now the fourth copy of the same function in the codebase.

Portability: direct. An absolutely-positioned span over the poster is trivial CSS (MediaLinksDocsSection.jsx:391 is already that exact construct, just with no text), and where the server value is null the browser can supply it itself — the bubble's `<video preload="metadata">` fires loadedmetadata and exposes HTMLMediaElement.duration, which AudioPlayer.jsx:61 already does for audio (guarding Number.isFinite, since streaming containers report Infinity/NaN — an mp4/mov with a moov atom is fine). The one non-browser caveat is the gallery tile: with no duration in the payload it would need either the backend field added to app/api/media.py or a hidden metadata load per tile, and the latter is not worth it on a 100-item grid.

### 14. Full-screen image viewer has no zoom or pan

**Needs adaptation** · effort: medium

**What iOS does.** ImageViewer (ios/RxHive/Features/Media/ImageViewer.swift) supports pinch-to-zoom via MagnificationGesture clamped to maxScale (:231), double-tap-to-zoom to doubleTapScale (:245-248), pan of a zoomed image, swipe-to-page, and drag-down-to-dismiss — with a single DragGesture that arbitrates once per gesture between those three so they cannot fight (:52-54, :163-199). Paging resets the scale so you never land on a pre-zoomed photo (:146-147).

**Why it matters.** Clinical photos and screenshots of documents are exactly the images someone needs to enlarge. On web the only recourse is Download.

**iOS code to read.**

- ios/RxHive/Features/Media/ImageViewer.swift — struct ImageViewer, private struct ZoomableImagePage (:400+)

**What the web does today.** frontend/src/components/chat/FullscreenImageViewer.jsx:156-165 renders a single `<motion.img className="max-w-[90vw] max-h-[85vh] object-contain">`. The only motion on it is a 0.2s opacity/scale entrance transition. I grepped that file for `zoom`, `scale`, `pinch`, `wheel`, `pan`, `drag`, `rotate` — the only `scale` hits are that entrance animation. Paging (:176-197), the thumbnail strip (:206-218), sender/timestamp header (:126-131), download (:145-147) and jump-to-message (:133-144) are all present; magnification is not.

**Web files to change.** `frontend/src/components/chat/FullscreenImageViewer.jsx`

**Porting notes.** Portable — wheel/ctrl+wheel zoom plus pointer-drag pan, or CSS transform with a pointer-events implementation; framer-motion is already a dependency and the viewer already uses it. The multi-touch pinch arbitration iOS needs is not required on a desktop browser, so this is a simpler component than the SwiftUI one, not a harder one.

**Corrections from verification.** The finding is accurate as written; nothing to correct on the gap itself. Two refinements: (a) it should mention that the app does not disable the mobile browser's native visual-viewport pinch (index.html:5 has no user-scalable=no), so mobile web users have a crude page-level pinch today — worth noting so the gap isn't overstated as "cannot magnify at all on phones"; (b) portability should stay needs-adaptation, not direct. A browser can absolutely do all of this — CSS transform + Pointer Events + `touch-action: none`, with framer-motion already in the dependency list — but there is no 1:1 web equivalent of SwiftUI's MagnificationGesture or of the single-DragGesture arbitration at ImageViewer.swift:52-54/163-199. On the web that becomes: manual two-pointer distance math for touch pinch, `wheel` with `event.ctrlKey` for trackpad pinch (plus Safari's non-standard gesturestart/gesturechange if you want it native), and a hand-written state machine to arbitrate pan-vs-page-vs-dismiss from raw pointermove. `touch-action: none` on the overlay is also required, which means deliberately suppressing the native pinch described in (a) and owning the behaviour fully. That is real work, not a port.

### 15. Video bubbles play inline instead of opening the app's full-screen viewer

**Direct port** · effort: small

**What iOS does.** Tapping a video bubble opens MediaVideoPlayerSheet as a fullScreenCover (MediaAttachmentViews.swift:217-219, :333-387) — an AVPlayerViewController host chosen specifically for the system transport controls, AirPlay route picker and Picture-in-Picture, with the filename in the header and an explicit pause on disappear so a dismissed sheet cannot keep playing audio behind the chat.

**Why it matters.** Small, and partly covered by the browser's native fullscreen button — but a viewer that already exists, and that images and PDFs both reach from the bubble, is unreachable from a video bubble. Native fullscreen gives no filename, no download and no jump-to-message.

**iOS code to read.**

- ios/RxHive/Features/Media/MediaAttachmentViews.swift:201-220 — ImageAttachmentView tap branch
- ios/RxHive/Features/Media/MediaAttachmentViews.swift:333-403 — MediaVideoPlayerSheet, PlayerViewControllerHost

**What the web does today.** The web DOES have the viewer — frontend/src/components/chat/FullscreenVideoViewer.jsx, with filename, sender, timestamp, download, jump-to-message and Escape-to-close — but the chat bubble never opens it. MessageBubble.jsx:313-321 inlines a `<video controls playsInline preload="metadata">` capped at max-h-[320px]. The viewer's only callers are the gallery (components/chat/info/MediaLinksDocsSection.jsx:519-521) and starred messages (components/chat/info/StarredSection.jsx:303-305). Contrast the PDF path, where DocumentBubble.jsx:120 does open PdfViewer from the bubble, and the image path, where ImageBubble.jsx:138-147 does open FullscreenImageViewer.

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx:312-325`

**Porting notes.** Purely wiring: the component is written, self-portals to document.body, and takes exactly the props the bubble already has.

**Corrections from verification.** No factual correction — the finding is accurate down to the line numbers. Two refinements: (1) the video block is lines 313-325 (the `<video>` element itself is 314-321), not 313-321; (2) the framing "iOS-only feature" is slightly off — the *viewer* is not missing on web at all, only the *wiring from the bubble*. The fix is roughly 15 lines of `useState` + `onClick` in MessageBubble.jsx (or a new VideoBubble.jsx mirroring ImageBubble.jsx), not a new component. Portability should be "direct", not "needs-adaptation": nothing in the browser blocks it, and the target component already exists and is already proven in two call sites. The only genuinely non-portable parts are the AVPlayerViewController *specifics* the iOS finding cites as rationale — AirPlay route picker is Safari-only via native `<video controls>`, and `requestPictureInPicture()` is unavailable in Firefox's JS API (Firefox exposes its own PiP toggle instead). Those are chrome details, not the capability; the user-visible behaviour (tap bubble -> fullscreen player with filename/sender, close button, pause on dismiss) is fully reproducible today with the code already in the repo.

### 16. No Camera entry in the attachment menu

**Needs adaptation** · effort: medium

**What iOS does.** The paperclip menu offers three entries: Photo Library (PhotosPicker, up to 10 items, images+videos), Camera (a `UIImagePickerController` full-screen capture that can shoot a still or a clip, recording at the user's Standard/HD tier), and Document (`.fileImporter` with `allowedContentTypes: [.data]`, multi-select). A capture goes through the same confirm sheet as a pick.

**Why it matters.** On a phone browser and on any laptop with a webcam, taking a photo into the chat is a one-tap action on iOS and impossible on the web without leaving the app.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `attachmentMenu` (line 292-318), `showCamera` / `.fullScreenCover` presenting `CameraCapture` (line 183-205), `CameraCapture: UIViewControllerRepresentable` (line 1101-1163)

**What the web does today.** The web menu has three entries too, but they are all file pickers: `attach-image-btn` → `fileInputRef` (`accept="image/*,video/*,.mp4,.mov,.webm,.m4v"`), `attach-media-btn` → `mediaInputRef` (video+audio), `attach-doc-btn` → `docInputRef` (accepts anything) — frontend/src/components/chat/MessageComposer.jsx:802-822 and the three `<input type="file">` at MessageComposer.jsx:838-840. None carries a `capture` attribute; grepping the whole of frontend/src for `capture=`, `getUserMedia` and `Camera` returns only the LiveKit call UI (components/calls/*, stores/callStore.js) and the avatar-upload icons in CreateGroupModal.jsx:255 / ProfileDrawer.jsx:112. There is no still-capture path in the chat composer.

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`

**Porting notes.** Genuinely portable but not a one-liner. On mobile browsers `<input type="file" accept="image/*" capture="environment">` hands off to the OS camera and needs no permission plumbing. On desktop `capture` is ignored, so a real camera surface means `getUserMedia` + a `<video>` preview + `canvas.drawImage` + `canvas.toBlob` (for video, MediaRecorder). Both are browser-native. Note that the web composer already has a full staging tray with previews (MessageComposer.jsx:584-715), so a captured Blob can be dropped straight into `stageFiles()` — the missing piece is only the capture surface itself.

**Corrections from verification.** Two minor inaccuracies in the finding's description of the web side, neither changing the verdict. (1) The menu labels are "Photos & Videos", "Media" and "Document" — the finding's wording implies a "Photo Library" equivalent, which is accurate in function but not in label. (2) The finding quotes the first accept as the literal string "image/*,video/*,.mp4,.mov,.webm,.m4v"; in source it is a template literal built from the VIDEO_ACCEPT constant at MessageComposer.jsx:23. Worth adding: web also has no Standard/HD media-quality tier at all, so the iOS tier behaviour is a second missing piece that a bare `capture` attribute would not satisfy.


## C. Message bubbles and composer

### 17. Footer overlaid on photo/video with a scrim

**Direct port** · effort: small

**What iOS does.** On an image or video message the timestamp, edited/pinned/starred glyphs and the read tick are drawn ON TOP of the media, pinned to its bottom-trailing corner, inside a black 45%-opacity Capsule scrim (7pt horizontal / 3pt vertical inner padding, 6pt inset from the media edge). The media itself is therefore the entire visible bubble — no band of bubble colour is added below it. The scrim exists because a photo can be white exactly where the timestamp lands.

**Why it matters.** Every photo and video in the web thread carries a strip of empty bubble colour under it, which is the single most visible layout difference between the two clients on a media-heavy conversation.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `MessageBubble.FooterPlacement.overlaid`, `footerPlacement` (line 208-214), the `.overlay(alignment: .bottomTrailing)` on `typeBody` (line 247-257), `footer` (line 353-381)

**What the web does today.** The web renders the same metadata in a normal block-level flex row BELOW the media, still inside the coloured bubble: frontend/src/components/chat/MessageBubble.jsx:359 — `<div className={`flex items-center gap-1 mt-1 ${richBubble ? 'px-2 pb-1' : '-mr-5'} justify-end`}>`. For an image/video `richBubble` is true so it gets `px-2 pb-1` and sits on its own line under the picture, adding ~20px of emerald (own) or #1F1F1F (received) below every photo. There is no scrim anywhere on the media — the only `bg-black/40` in the file is the hover chevron (MessageBubble.jsx:115), not the footer. ImageBubble.jsx renders the grid and an optional caption and nothing else (ImageBubble.jsx:129-136); it has no absolutely-positioned overlay.

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx`, `frontend/src/components/chat/ImageBubble.jsx`

**Porting notes.** Pure CSS: `position: relative` on the media container plus an `absolute bottom-1 right-1` pill with `bg-black/45 rounded-full`. No platform capability involved. The one adaptation needed is the caption case — when `videoCaption`/`caption` is present the footer should stay below the caption text rather than overlay the image, which is also what the iOS layout produces since the overlay is attached to `typeBody`'s media stack.

**Corrections from verification.** Two refinements, neither changing the verdict. (1) The web adds bubble colour on all four sides, not just below: the media wrapper at MessageBubble.jsx:266 is `px-1 py-1` with the emerald/#1F1F1F background, giving a ~4px frame around the photo, and the footer row then adds its ~20px band beneath that — so the visual delta from iOS is slightly larger than the finding states. (2) The finding implies the video path lives in a media component; there is no VideoBubble.jsx — video is rendered inline at MessageBubble.jsx:313-325, so a fix must touch that inline branch as well as ImageBubble.jsx.

### 18. Footer composed INSIDE the audio card, on the duration line

**Direct port** · effort: medium

**What iOS does.** For an audio message the bubble's footer is passed down into the audio card as a `trailingMeta: AnyView` and rendered at the trailing end of the card's elapsed-time line — the one row in the card that already had space going spare. The card is a fixed 258pt wide with its own `surface2` fill and border, and the bubble then wraps it with only 4pt of padding, so the bubble hugs the card exactly.

**Why it matters.** Every voice note on the web gets an extra full-width row of bubble colour under a fixed-width player, which is exactly the dead space the iOS build removed. It also means the ticks on a voice note read as belonging to the bubble rather than to the message.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `footerPlacement` returns `.insideCard` for `.audio` when there is a renderable attachment (line 211); `typeBody` passes `trailingMeta: AnyView(footer)` (line 309-318)
- ios/RxHive/Features/Media/MediaAttachmentViews.swift — `AudioAttachmentView.trailingMeta` (line 421-424), the elapsed-time `HStack` that hosts it (line 505-518), `.frame(width: 258)` (line 523)

**What the web does today.** The web audio bubble is `<div data-testid="audio-bubble" className="w-[260px] flex items-center gap-2.5 p-1.5">` at frontend/src/components/chat/MessageBubble.jsx:332 — a fixed-width card containing a mic circle, a filename line and `<AudioPlayer>`. Nothing is threaded into it. The timestamp and ticks are then emitted by the shared footer row at MessageBubble.jsx:359 on a separate line under the card (`richBubble` → `px-2 pb-1 justify-end`). AudioPlayer.jsx takes `src`, `fallbackDuration`, `tone`, `className` only — there is no slot prop of any kind (grepped for `trailingMeta`, `meta`, `footer`, `children`, `slot` across frontend/src/components/chat).

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx`, `frontend/src/components/chat/AudioPlayer.jsx`

**Porting notes.** Just a React node passed as a prop and rendered in the card's own metadata row. The blocker is structural, not technical: the footer JSX at MessageBubble.jsx:359-403 is one shared block for all message types, so it has to be extracted into a `<MessageFooter>` component before it can be handed to two different places.

**Corrections from verification.** Three small inaccuracies in the finding, none of which change the verdict:
1. "grepped for ... `children` ... across frontend/src/components/chat" implies zero hits — `children` does occur in components/chat/menuKit.jsx, ChatSidebar.jsx, info/InfoPanelShell.jsx and info/InfoPanelPrimitives.jsx. None is audio-related, so the conclusion stands, but the codebase does already use slot-style composition elsewhere in chat, which makes the port easier than the finding suggests.
2. The finding says the iOS footer lands on "the one row in the card that already had space going spare". On web there is no spare row: AudioPlayer renders one single flex row (play, waveform, speed toggle, duration) and the duration already sits at its trailing end. A port must either extend that row (play + waveform + speed + duration + time + ticks in 260px is tight) or hang the meta off the trailing end of the filename line at MessageBubble.jsx:336.
3. The web audio "card" has no `surface2` fill or border of its own — it is a bare layout div drawn straight on the bubble's #10B981 / #1F1F1F fill. Padding is also doubled (bubble `p-1` at line 268 plus card `p-1.5`), not iOS's single 4pt hug. So porting the visual as described means adding a card surface that does not exist today, not just moving the footer.

### 19. Footer composed INSIDE the document card, stacked under the download control

**Direct port** · effort: medium

**What iOS does.** For a file message the footer is passed into `DocumentAttachmentView` as `trailingMeta` and rendered in a trailing VStack directly beneath the download arrow, so it consumes the vertical room the two-line filename already claims and costs no extra row. The card width was deliberately raised from 262 to 290pt to absorb the wider metadata column this created; both the PDF-preview layout and the plain icon-row layout use the same `trailingColumn` helper.

**Why it matters.** Same as the audio case: an extra band of bubble colour under a fixed-width card on every file message, and the ticks visually detached from the card they describe.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `footerPlacement` returns `.insideCard` for `.file` (line 211); `DocumentAttachmentView(attachment:trailingMeta: AnyView(footer))` (line 327)
- ios/RxHive/Features/Media/MediaAttachmentViews.swift — `DocumentAttachmentView.trailingMeta` (line 814-818), `cardWidth = 290` / `previewSize` (line 826-827), `trailingColumn(_:)` (line 940-951), `metaRow` (line 906-937), `iconRowBubble` (line 954-995)

**What the web does today.** `DocumentBubble` renders a `w-[280px]` card — either an anchor (`no-underline w-[280px] flex items-center gap-3 p-3`, DocumentBubble.jsx:103) or the PDF-preview `role="button"` variant (`w-[280px] flex flex-col gap-2 p-1.5`, DocumentBubble.jsx:125) — and takes only `{ message, isOwn }` (DocumentBubble.jsx:36). It has no slot for bubble metadata. The timestamp and ticks land on the shared footer row below it (MessageBubble.jsx:359, `richBubble` branch).

**Web files to change.** `frontend/src/components/chat/DocumentBubble.jsx`, `frontend/src/components/chat/MessageBubble.jsx`

**Porting notes.** A `trailingMeta` prop on DocumentBubble rendered next to the `<Download>` control in both layout branches. Depends on the same `<MessageFooter>` extraction as the audio gap. Note the web card is 280px while iOS widened to 290 for exactly this reason — the web card will likely need the same widening once the timestamp moves in, since the subtitle line (`26 pages · PDF · 43.1 MB`, DocumentBubble.jsx:69-73) already uses the full column.

**Corrections from verification.** The finding is accurate on every checkable detail (DocumentBubble.jsx:36 props, :103 anchor classes, :125 PDF-preview classes, MessageBubble.jsx:359 shared footer row). Three refinements: (a) the shared footer row is technically inside the outer bubble wrapper (MessageBubble.jsx:262-272, `p-1` for isFile) with `px-2 pb-1`, so it sits below the 280px card but still within the green/dark bubble — not outside the bubble entirely; (b) the web filename is single-line `truncate` (DocumentBubble.jsx:88), not two-line, so unlike iOS there is no existing vertical slack for a trailing column to consume for free — a web port must either allow two lines or accept the trailing column driving card height; (c) the effective bubble width is already ~288px (280px card + wrapper `p-1` both sides), so the iOS 262->290pt widening has essentially no web analogue to apply.

### 20. Footer sits BESIDE text, not below it

**Direct port** · effort: medium

**What iOS does.** For text (and for audio/file with no attachment) the footer is laid out as a sibling of the content in a bottom-aligned HStack, so a short message renders as `hi  10:24 AM ✓` on one line. The footer is deliberately NOT `.frame(maxWidth: .infinity)` — the comment at MessageBubble.swift:372-379 records that an infinitely-wide footer stretched every bubble to the full column; trailing alignment comes from the enclosing `VStack(alignment: .trailing)` instead.

**Why it matters.** Short messages take roughly twice the vertical space on the web, and a run of one-word replies looks noticeably looser than the same thread on the phone. This is the placement that most changes the density of a normal text conversation.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `bubble` (line 173-177: `HStack(alignment: .bottom) { bubbleContent; if footerPlacement == .beside { footer } }`), `footer` and its width comment (line 353-381)

**What the web does today.** The web always puts the footer on its own block-level row after the `<p>`: frontend/src/components/chat/MessageBubble.jsx:352-359 — the text paragraph, then `<div className="flex items-center gap-1 mt-1 -mr-5 justify-end">`. So a one-word message is two rows tall with the timestamp right-aligned underneath. The `-mr-5` negative margin exists only to claw back the `pr-8` the hover chevron reserved (MessageBubble.jsx:271).

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx`

**Porting notes.** Standard technique: either render the footer as an inline-block float inside the paragraph, or make the bubble a flex row with `align-items: flex-end` and let the paragraph wrap. Slightly more fiddly than the other two because long wrapping text must be allowed to flow under the footer rather than being pushed off it — a `float: right` on the footer inside the `<p>` is the usual answer. The web's `pr-8` chevron reservation interacts with this and will need re-tuning.

**Corrections from verification.** Nothing material is wrong with the finding. Two small refinements: (1) The claim says the footer div is at lines 352-359 — more precisely the `<p>` is 352-355 and the footer div opens at 359. (2) The claim understates the gap slightly: the web is missing not just the `beside` placement but all three of iOS's placements — `overlaid` (photo/video, MessageBubble.swift:248) and `insideCard` (audio/document via `trailingMeta:`, lines 317/327) have no web equivalent either. The web's single `richBubble ? 'px-2 pb-1' : '-mr-5'` ternary at MessageBubble.jsx:359 is its only concession to message type, and both arms still stack below.

Portability rating "direct" holds — a browser does this natively. iOS's `HStack(alignment: .bottom)` maps 1:1 onto `display:flex; align-items:flex-end` on a wrapper around the `<p>` and the footer, with the footer as `flex-shrink-0`. The iOS footer's "no maxWidth: .infinity, trailing alignment comes from the parent" note translates to simply not giving the footer `flex:1` — the existing `justify-end` on the outer row (MessageBubble.jsx:241) already supplies the trailing alignment, same as the enclosing `VStack(alignment: .trailing)` does on iOS. The `max-w-[80%]` at line 261 keeps long text wrapping correctly since flex items shrink. No JS measurement needed. Worth noting the web version would need the `pr-8`/`-mr-5` chevron dance reworked (the footer would move out of the padded box), and that neither platform does the harder WhatsApp-Web trick of tucking the footer into the last wrapped line's trailing whitespace — that one would need an invisible inline-block spacer, but it is out of scope since iOS does not do it either.

### 21. No per-file upload row with its own status and a working cancel; composer is frozen during upload

**Needs adaptation** · effort: medium

**What iOS does.** Each file in flight becomes its own `UploadJob` row above the composer, showing a type glyph, the filename (middle-truncated), a status string, an animated indeterminate bar and an X. The status is two-phase: `"Compressing…"` (video) / `"Preparing…"` (image) while `MediaTranscoder` re-encodes, then flipped to `"Sending…"` before the network call — and the filename is rewritten mid-row when the transcode renames the file (HEIC→JPEG, .mov→.mp4). The X calls `job.task?.cancel()`, which really aborts the Swift Task and removes the row. Crucially the rows sit ABOVE a fully live composer: the user can keep typing and send more messages while uploads run.

**Why it matters.** On a slow connection a large upload wedges the entire composer with no way out except reloading the page, and a multi-file batch gives no indication of which file is stuck.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `UploadJob` struct (line 722-732), `uploads` state + the `ForEach(uploads) { UploadRow… }` block (line 59, 119-126), `enqueue` (line 734-755), `enqueueMedia` with the Compressing→Sending flip (line 765-810), `cancel(job:)` (line 854-857), `UploadRow` view (line 1004-1046), `IndeterminateBar` (line 1050-1075)

**What the web does today.** The web has ONE batch-level indicator, not per-file rows: `const [uploading, setUploading] = useState(false)` and `const [uploadProgress, setUploadProgress] = useState(0)` (frontend/src/components/chat/MessageComposer.jsx:86-87), rendered only inside the staging tray at MessageComposer.jsx:703-712 as a determinate bar plus the literal text `Sending {stagedFiles.length} files…`. `handleConfirmSend` loops the batch serially (MessageComposer.jsx:477-494) and every file writes into the same `setUploadProgress`, so the bar resets to 0 for each file and no row tells you WHICH file is going. There is no cancel: `clearStaged` is `disabled={uploading}` (MessageComposer.jsx:601-604), the per-tile remove X is `disabled={uploading}` (MessageComposer.jsx:664), and grepping frontend/src for `AbortController`, `abort()`, `signal:`, `CancelToken` returns zero hits — `uploadFile` (MessageComposer.jsx:249-261) passes only `onUploadProgress` to axios. The textarea is `disabled={disabled || uploading}` (MessageComposer.jsx:855) and the send button is `disabled={uploading}` (MessageComposer.jsx:871), so the whole composer locks for the duration of the batch. There is no compressing phase because the web does no client-side transcoding at all (no `canvas.toBlob`, no `drawImage`, no quality tier in frontend/src).

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`

**Porting notes.** Cancel is directly portable — axios accepts an `AbortController` `signal`, and aborting mid-POST is standard. Per-file rows are pure React state (an array of jobs instead of one boolean), and moving them out of the tray so the composer stays live is a layout change. The `"Compressing…"` half is the only part that does not port as-is: it only exists because iOS re-encodes before uploading, and the web has no equivalent step. Browsers CAN compress (canvas/`toBlob` for images, WebCodecs for video) but that is a separate feature — if it is not built, the web status should just be `"Sending…"` rather than inventing a phase. Note the web's determinate percentage is genuinely better than iOS's indeterminate bar and should be kept.

**Corrections from verification.** Nothing in the finding is wrong. Two refinements. (a) The batch status string is slightly worse than described: because `stagedFiles` isn't trimmed until after the loop (MessageComposer.jsx:502), it reads "Sending 5 files…" for the entire batch even when 4 are already done. (b) There IS a per-file artifact, just not an upload row — an optimistic message bubble is created per file after its upload completes, with a failed-state retry, so per-file *outcome* feedback partially exists; per-file *in-flight* feedback and cancel do not.

Portability should be needs-adaptation, not direct. Split by sub-feature: the per-file row UI, the two-phase status string, the animated indeterminate bar, concurrent uploads with a live composer (drop the `disabled={uploading}` guards and key state per job instead of one scalar), and real cancel via `AbortController` + axios `signal:` are all straightforwardly portable — axios aborts the underlying XHR and the row can be dropped from the array. The transcoding half is not. Image "Preparing…" is doable with `canvas.toBlob`/`createImageBitmap`, EXCEPT the HEIC→JPEG case: no browser but Safari can decode HEIC, so the exact iOS rename semantics can't be reproduced cross-browser. Video "Compressing…" (.mov→.mp4) needs WebCodecs plus an MP4 muxer, or ffmpeg.wasm — and ffmpeg.wasm is hard-blocked here: PdfViewer.jsx:16-18 documents the app's CSP as `script-src 'self'` with no `wasm-unsafe-eval` (which is why pdf.js was rejected), plus ffmpeg.wasm would need SharedArrayBuffer/COOP-COEP headers. So the transcode phase should either be dropped on web (rows go straight to "Sending…") or moved server-side.

### 22. No fallback bubble when a media message carries no attachment

**Direct port** · effort: small

**What iOS does.** When a message is typed `.audio` or `.file` but `renderableAttachments` is empty, the bubble renders an explicit warning row — a triangle glyph plus "Voice message unavailable" / "File unavailable" in the muted meta colour — rather than an empty card.

**Why it matters.** Half-written rows from the backend render as visually broken empty bubbles or dead links instead of saying what happened.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `typeBody` audio/file `else` branches (line 319-330), `unavailableMedia(_:)` (line 342-349)

**What the web does today.** There is no such branch. For `type === 'image'` with no media, `ImageBubble` returns `null` outright (frontend/src/components/chat/ImageBubble.jsx:122 — `if (items.length === 0) return null;`), leaving a bubble containing only a timestamp. For `type === 'audio'` with no `media_url`, MessageBubble.jsx:340 passes `resolveUrl(undefined)` which returns `''` (ImageBubble/MessageBubble `resolveUrl`, MessageBubble.jsx:11-14) straight into `<AudioPlayer src="">`. For `type === 'file'`, DocumentBubble falls back to the string `'Document'` for the name and an `undefined` href (DocumentBubble.jsx:42, 99).

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx`, `frontend/src/components/chat/ImageBubble.jsx`

**Porting notes.** Plain conditional JSX; no platform dependency.

**Corrections from verification.** The finding is accurate on all three code paths; nothing to correct in substance. Two refinements: (i) the gap also covers `type === 'video'` (MessageBubble.jsx:312-325 pipes `resolveUrl(undefined)` into `<video src="">` with no guard), which the finding omits; (ii) the codebase does have a precedent for this exact UI shape — the deleted-message notice at MessageBubble.jsx:189-198 — and the strings 'Voice message' and 'Document' already exist as TYPE_LABELS in StarredSection.jsx:32-37, so an implementer should reuse those rather than inventing new copy.

### 23. No tighter vertical spacing within a run of messages from one sender

**Direct port** · effort: small

**What iOS does.** The row's top padding is conditional on `startsRun`: `spacing2` (8pt) when a new sender's run begins, `1` point otherwise, with a constant 1pt bottom. So consecutive messages from one person visibly clump.

**Why it matters.** Runs read as a flat undifferentiated stack on the web; the visual grouping that the avatar gutter and sender name imply is not reinforced by spacing.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageBubble.swift — `content`'s `.padding(.top, startsRun ? Theme.Layout.spacing2 : 1).padding(.bottom, 1)` (line 152-154)

**What the web does today.** The outer row uses a flat `mb-1` on every message regardless of grouping: frontend/src/components/chat/MessageBubble.jsx:241. The `showSenderName` prop that carries the run boundary is already computed and passed (ChatPanel.jsx:872, MessageBubble.jsx:1030) and is used for the avatar and the sender name (MessageBubble.jsx:251-259, 285-290) — but never for spacing.

**Web files to change.** `frontend/src/components/chat/MessageBubble.jsx`

**Porting notes.** One conditional class on an element that already receives the boundary flag. Trivial.

**Corrections from verification.** Nothing in the finding is factually wrong. Two additions rather than corrections: (a) the web already has PARTIAL run awareness — continuation rows hide the avatar and the sender name — so the grouping signal is fully wired and only the vertical rhythm is missing; (b) the gap is actually wider than stated for 1:1 chats, because the avatar/name suppression is gated on `isGroup`, so in a DM the web shows zero visual difference between a new run and a continuation, while iOS applies its 8pt-vs-1pt top padding regardless of group. Also worth flagging for whoever implements it: iOS is ~2pt within a run vs ~9pt between runs, and web's flat 4px sits between the two — so within-run spacing must tighten AND between-run spacing must widen; it is not a one-sided change. Portability 'direct' is right: this is one conditional Tailwind class on an element that already receives the boundary prop (e.g. `${showSenderName ? 'mt-2' : 'mt-px'} mb-px` in place of `mb-1`). A pure-CSS `:has()`/adjacent-sibling variant would also work in modern browsers but is unnecessary and unreliable under react-virtuoso windowing, since off-screen siblings are unmounted.

### 24. Composer text is not carried into the attachment caption

**Direct port** · effort: small

**What iOS does.** When a document or voice note is staged, whatever is already typed in the box becomes the caption and the box is cleared — `stage(data:filename:)` reads `trimmedText`, clears `text` and passes it as `caption`. For photos/video the same typed text is seeded into the send sheet (`MediaSendSheet(items:caption: trimmedText, …)`), and the caption is attached to the first item of a batch only.

**Why it matters.** The very common flow of typing a sentence and then attaching a file silently strands the sentence: the user either loses it or sends it as a second message.

**iOS code to read.**

- ios/RxHive/Features/Chat/MessageComposer.swift — `stage(data:filename:)` (line 646-661), the `MediaSendSheet(caption: trimmedText)` call (line 212-220), `send(media:caption:quality:)` first-item rule (line 602-621)

**What the web does today.** The tray has its own separate caption field — `previewCaption` state (frontend/src/components/chat/MessageComposer.jsx:93) bound to the `Add a caption...` input at MessageComposer.jsx:677-685 — and `handleConfirmSend` uses only `previewCaption.trim()` (MessageComposer.jsx:474). `stageFiles` (MessageComposer.jsx:320-348) never reads or clears `text`, so anything already typed stays sitting in the textarea (which is then disabled during upload) and has to be retyped in the tray. The first-item-only rule for the caption and the reply id IS present (MessageComposer.jsx:481-485, `i === 0 ? caption : ''`).

**Web files to change.** `frontend/src/components/chat/MessageComposer.jsx`

**Porting notes.** Pure state plumbing — seed `previewCaption` from `text` and clear `text` inside `stageFiles`.

**Corrections from verification.** One sharpening rather than a correction — the finding understates the gap. For voice notes the web has no caption mechanism whatsoever: MessageComposer.jsx:405 passes a literal '' and there is no voice-note caption field to retype into, so the iOS behaviour is not merely inconvenient there, it is absent. Everything else in the claim checks out verbatim: lines 93, 474, 677-685, 320-348 and 481-485 are all accurate, including the note that the textarea is disabled during upload.


## D. Session, auth and realtime

### 25. Replayed requests are not marked as replays, so a follower of a single-flight refresh can start a second refresh

**Direct port** · effort: small

**What iOS does.** APIClient.performRaw(_:isRetry:) (APIClient.swift:238) takes an explicit isRetry flag and the 401 branch is gated on `!isRetry` (APIClient.swift:257). Every replay is issued as performRaw(request, isRetry: true) (APIClient.swift:263 and :273), so a replay that 401s again falls straight through to the error mapper and can never trigger another refresh. The recursion is provably one level deep.

**Why it matters.** Against a backend that rotates refresh tokens single-use (backend/app/api/auth.py:5-17), a screen that fires N parallel requests and hits a persistent 401 can chain N further refreshes instead of one. The backend's replay-grace window absorbs most of it, but outside that window a reuse is treated as a stolen cookie and burns the whole session family — the exact failure the single-flight exists to prevent.

**iOS code to read.**

- ios/RxHive/Core/APIClient.swift — performRaw(_:isRetry:)

**What the web does today.** frontend/src/api/client.js:122 sets `originalRequest._retry = true` only on the request that WON the single-flight race. Followers take the branch at client.js:116-120, which pushes onto failedQueue and then replays with `client(originalRequest)` — that config object never gets `_retry` set. So a follower whose replay 401s re-enters the interceptor at client.js:115 with `_retry` still falsy, `isRefreshing` already back to false (client.js:142), and starts its own refresh.

**Web files to change.** `frontend/src/api/client.js`

**Porting notes.** One-line equivalent: set the retry marker on the follower's config before replaying, or route replays through a helper that stamps it.

**Corrections from verification.** Two refinements, both checked:

1. Blast radius is smaller than implied. A follower's replay that 401s re-enters at client.js:115 and becomes a WINNER — it takes the :122 path and sets _retry = true on its own merged config. So the recursion bottoms out at two refresh rounds, not unbounded. The real defect is a redundant second /api/auth/refresh round-trip (and, if the backend rotates refresh cookies, a second refresh racing the first — the failure mode that actually bites), not an infinite loop. iOS's "provably one level deep" is still strictly stronger than web's "two levels deep for followers."

2. The finding does not state the propagation mechanism, which is load-bearing for both halves of the claim: _retry survives `client(originalRequest)` only because axios mergeConfig passes unknown keys through defaultToConfig2. That is why the winner is bounded and the follower is not — same mechanism, one just never gets the key set.

### 26. No refresh-generation check: a request already on the wire when someone else refreshed burns a second rotation

**Direct port** · effort: small

**What iOS does.** APIClient keeps `refreshGeneration` (APIClient.swift:66), bumped on every successful refresh (APIClient.swift:319). performRaw reads it before the request leaves (APIClient.swift:241) and, on a 401, compares (APIClient.swift:262-264): if the generation moved, the 401 is known to be a stale-cookie artefact of someone else's refresh, so the request is simply replayed with no refresh at all.

**Why it matters.** Every avoidable rotation is a write to the refresh table and one more chance to trip the single-use reuse detection. Lower severity than the two other refresh items because the outcome is usually just churn, but it is the one deliberate iOS mechanism with no analogue at all in client.js.

**iOS code to read.**

- ios/RxHive/Core/APIClient.swift — refreshGeneration, performRaw(_:isRetry:), performRefresh()

**What the web does today.** frontend/src/api/client.js has no generation counter — grepped for `generation`, `epoch`, `version` in frontend/src/api and frontend/src/contexts: nothing. The single-flight (client.js:62, 115-128) only covers requests that 401 *while* isRefreshing is true. A request dispatched before the refresh and answered after it (client.js:142 has already cleared the flag) 401s, sees isRefreshing === false, and initiates a fresh rotation.

**Web files to change.** `frontend/src/api/client.js`

**Porting notes.** A module-level integer bumped inside the try at client.js:126-127 and captured per-request via the request interceptor is the whole mechanism; axios exposes config objects that can carry it.

**Corrections from verification.** The finding is accurate. Two things it understates: (1) the queued-waiter path at client.js:117-119 replays `client(originalRequest)` without setting `_retry`, so a replayed request that 401s again can itself kick off another refresh — the hole is slightly wider than "requests dispatched before the refresh"; (2) the same gap crosses transports — services/websocket.js:114 calls the shared refreshSession() on WS close 4001 with no shared generation, so a socket-initiated rotation is invisible to in-flight HTTP requests and vice versa.

### 27. The user is hard-redirected to /login with no explanation of why the session ended

**Direct port** · effort: small

**What iOS does.** AuthStore.handleSessionLost(status:detail:) (AuthStore.swift:254-279) sets `signInError = AuthCopy.sessionExpired` ("Your session expired. Please sign in again.", AuthStore.swift:302) before flipping to .signedOut, and routes a 403 with a detail to a dedicated .accessDenied(reason:) phase carrying the server's own sentence. APIError.credentials(detail:) (APIError.swift:15) exists purely so a /login 401 shows the server's wording rather than asserting an expiry.

**Why it matters.** The whole point of the recent session work is that a sign-out now only happens when it is real. When it does happen the user lands on a blank login form with no idea whether they were logged out, timed out, or the app broke — which is precisely the confusion the iOS side wrote copy to avoid.

**iOS code to read.**

- ios/RxHive/Features/Auth/AuthStore.swift — handleSessionLost(status:detail:), AuthCopy
- ios/RxHive/Core/APIError.swift — APIError.credentials(detail:), userMessage

**What the web does today.** Both sign-out paths are bare navigations that carry nothing: frontend/src/api/client.js:135-138 (`localStorage.removeItem('user')` then `window.location.href = '/login'`) and frontend/src/services/websocket.js:124-125 (same, without even the already-on-/login guard client.js has). frontend/src/pages/Login.jsx has no reader for any such signal — grepped for `sessionStorage`, `useLocation`, `location.state`, `searchParams`, `reason=` across frontend/src; Login.jsx imports none of them, and its only error states are set from its own submit handler (Login.jsx:34-43). The string 'Session expired. Please log in again.' exists at frontend/src/utils/helpers.js:20, but that is a toast raised by handleApiError on a 401 that reached a call site — it is destroyed by the full-page navigation on the path that actually signs people out.

**Web files to change.** `frontend/src/api/client.js`, `frontend/src/services/websocket.js`, `frontend/src/pages/Login.jsx`

**Porting notes.** Because the web tears down via a document navigation, the reason has to survive it — sessionStorage or a query param read by Login.jsx — rather than being in-memory state as on iOS.

**Corrections from verification.** The finding is correct, but understated on one point and incomplete on another.

(1) UNDERSTATED: the finding says the 'Session expired. Please log in again.' string at /Users/carinrowena/Documents/HIVE EXPORT/Hive Export/rxhive/frontend/src/utils/helpers.js:20 "is a toast raised by handleApiError on a 401 that reached a call site — it is destroyed by the full-page navigation." In fact `handleApiError` is never called anywhere in frontend/src. Grepping for `handleApiError` and for any import of `utils/helpers` returns exactly two lines: its own definition (helpers.js:3) and one unrelated import (`formatRelativeTime` in components/calls/CallsTab.jsx:4). So the string is dead code that never renders on any path, navigation or not — the web app has no session-expiry copy that can reach a user at all.

(2) PARTIAL ANALOGUE for the 403 half only: App.jsx:87-100 (SuperAdminRoute) renders a real in-app 'Access Denied' card — 'You don't have permission to access the admin panel.' with a sign-out button — instead of bouncing. That is a client-side role check against the cached user object, not a server 403, and it carries hardcoded copy rather than the server's `detail`; the sibling OrgAdminRoute (App.jsx:148-154) does the opposite and silently `<Navigate to=\"/chat\">`s. It does not touch the session-loss path and does not close the claimed gap, but it is the nearest thing on web to iOS's `.accessDenied(reason:)` phase and worth naming so it is not double-counted as a new build.

(3) Minor: Login.jsx:32 binds `const detail = err.response?.data?.detail` and never uses it — the 401 branch hardcodes 'Invalid email or password'. So web also lacks the iOS APIError.credentials(detail:) behaviour of showing the server's own wording on a /login 401.

Nuance worth knowing for the fix, not a correction: there are two structurally different sign-out paths. The two named in the finding are hard `window.location.href` navigations that would wipe any toast. But a third, unnamed path is a soft SPA transition — AuthContext.checkAuth (AuthContext.jsx:42-46) clears the user on a 401/403 from /api/auth/me, after which the route guards render `<Navigate to=\"/login\" replace />`. React state and a mounted Sonner `<Toaster>` (App.jsx:180) survive that one, so a message set there would actually display. It sets no message today.

### 28. WebSocket reconnect backoff has no jitter

**Direct port** · effort: small

**What iOS does.** RealtimeClient.scheduleReconnect() (RealtimeClient.swift:252-265) computes `min(pow(2, min(attempt, 5)), 30)` and adds `Double.random(in: 0...1)`, explicitly so a server restart does not bring every client back in the same instant. The attempt counter is also clamped at 5 before exponentiation.

**Why it matters.** Every browser tab that was connected at the moment the API restarts wakes up on the same schedule and reconnects in lockstep, at 1s, 2s, 4s… That is the thundering-herd case the iOS jitter was added for, and the web is the client with more concurrent sessions per user (multiple tabs).

**iOS code to read.**

- ios/RxHive/Realtime/RealtimeClient.swift — scheduleReconnect()

**What the web does today.** frontend/src/services/websocket.js:690-705: `const delay = immediate ? 100 : Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay)` — deterministic, no random component. `reconnectAttempts` is unbounded (it is only clamped implicitly by maxReconnectDelay = 30000 at websocket.js:34).

**Web files to change.** `frontend/src/services/websocket.js`

**Porting notes.** Same arithmetic; `Math.random()` in place of `Double.random(in:)`.

**Corrections from verification.** The claim is accurate on the jitter gap. One nuance worth downgrading: the "reconnectAttempts is unbounded" point is not a separate defect — because Math.pow(2, largeN) becomes Infinity and Math.min caps it, the web already tops out at the same 30s as iOS. iOS's clamp-at-5 is stylistic. The real, portable gap is only the missing random component. Also note reconnectAttempts does reset to 0 on a successful open (websocket.js:71), so it does not grow across sessions.

### 29. Queued realtime frames are replayed on reconnect instead of being dropped

**Direct port** · effort: small

**What iOS does.** RealtimeClient.send(_:) (RealtimeClient.swift:269-277) refuses to queue anything: if the socket is not .connected the frame is logged and dropped, on the stated reasoning that every frame the app sends is either idempotent-on-reconnect or has a UI-level retry, and a queue would replay stale typing indicators.

**Why it matters.** After a reconnect the peer can be shown a phantom 'typing…' from a keystroke that happened minutes earlier, and read receipts can be emitted for a conversation the user has since left. Bounded rather than serious: the receive side self-clears typing after 4s (websocket.js:241-243) and receipts are idempotent. Listed because it is a deliberate iOS decision that was not carried across, not because it is breaking anything today.

**iOS code to read.**

- ios/RxHive/Realtime/RealtimeClient.swift — send(_:), OutboundFrame

**What the web does today.** frontend/src/services/websocket.js:593-599 pushes any frame onto `this.messageQueue` when the socket is not OPEN, and websocket.js:78-81 drains that queue on the next _onOpen(). The dangerous case is already handled — sendMessage() (websocket.js:634-648) explicitly refuses to queue chat messages because the HTTP fallback owns them — so what actually replays is typing_start/typing_stop (websocket.js:650-656) and read_receipt (websocket.js:658-664).

**Web files to change.** `frontend/src/services/websocket.js`

**Porting notes.** Drop the queue-on-closed behaviour, or filter the queue by frame type at drain time.

**Corrections from verification.** The finding's replay set is incomplete. It names only typing_start/typing_stop and read_receipt, but every call-signalling frame also flows through the queuing send(): call:initiate, call:group_initiate, call:accept, call:join, call:decline, call:cancel, call:end, call:toggle_media, across 8 components plus websocket.js:493. That makes the impact materially worse than "stale typing indicators" — a queued call:initiate rings the callee after reconnect for a call the user already abandoned. Also, the queue is never cleared on disconnect() and has no size bound, so frames accumulate across an entire offline period and all flush at once.

### 30. iOS retries the refresh once when the refresh cookie rotated underneath it

**Needs adaptation** · effort: small

**What iOS does.** performRefresh() (APIClient.swift:302-321) reads the raw rx_refresh cookie value via refreshCookieValue() (APIClient.swift:367-372) before posting, and if the POST comes back 401 it re-reads the jar — if the value has changed, the token it presented was simply the old one, so it posts once more before declaring the session dead.

**Why it matters.** Not a defect to fix. Recording it so nobody tries to port it.

**iOS code to read.**

- ios/RxHive/Core/APIClient.swift — performRefresh(), postRefresh(), refreshCookieValue(), refreshCookieName

**What the web does today.** frontend/src/api/client.js:102-107 (refreshSession) posts and takes the answer at face value; frontend/src/api/client.js:97-100 (sessionRejected) treats any 401/403 as terminal. No cookie inspection anywhere — grepped frontend/src for `document.cookie`, `rx_refresh`, `rx_access`: zero hits.

**Porting notes.** rx_refresh is httpOnly (backend/app/api/auth.py:108-118 sets httponly: True), so JavaScript cannot read its value and therefore cannot detect that the jar moved on. The equivalent protection for browsers already exists server-side: the rotated-token replay grace window described at backend/app/api/auth.py:10-17 lets a client that lost a rotation response replay the old token once.

**Corrections from verification.** Two things to add rather than correct. (a) The finding under-sells the mitigation already present: client.js single-flight (isRefreshing/failedQueue, client.js:62-66,116-121) eliminates the *intra-tab* version of this race, which is the bulk of iOS's exposure; the web's real remaining hole is the cross-tab race, and there is no BroadcastChannel/Web Locks coordination anywhere. (b) The finding does not mention that the mechanism iOS uses is unavailable to a browser: backend/app/api/auth.py:110-118 sets rx_refresh with httponly=True (asserted in backend/tests/test_auth.py:20), so document.cookie can never see it. Any web version must be a different mechanism, not a port.

### 31. iOS skips the boot /me entirely when there is no persisted refresh cookie

**Needs adaptation** · effort: small

**What iOS does.** restoreSession() gates the whole restore on `await api.hasPersistedSession()` (AuthStore.swift:89), which checks the cookie jar for rx_refresh (APIClient.swift:460-464) — so a genuinely signed-out launch goes straight to sign-in with no network round trip and no spurious refresh attempt.

**Why it matters.** Recording it so nobody treats the extra /me + /refresh on an anonymous page load as a bug to fix by reading cookies.

**iOS code to read.**

- ios/RxHive/Core/APIClient.swift — hasPersistedSession(), refreshCookieName
- ios/RxHive/Features/Auth/AuthStore.swift — restoreSession(minimumSplash:)

**What the web does today.** frontend/src/contexts/AuthContext.jsx:32 always calls GET /api/auth/me on mount. For a signed-out visitor that 401s, the interceptor then posts /api/auth/refresh (client.js:126), that 401s too, and sessionRejected fires — the `window.location.pathname !== '/login'` guard at client.js:136 is what stops it becoming a redirect loop. So the behaviour is correct, just two wasted round trips and one wasted rate-limiter token per cold load.

**Porting notes.** Both cookies are httpOnly, so the browser cannot answer 'do I plausibly have a session' without asking the server. The guard at client.js:136 is already the right web-shaped mitigation.

**Corrections from verification.** Two things the finding gets wrong, both in the direction of understating it. (a) The cost is four round trips and a full page reload, not two round trips, for a signed-out visitor at "/" — the client.js:136 pathname guard only holds once the browser is already on /login, so the first cycle at "/" does hard-navigate. It prevents a loop, but only after paying the boot twice. (b) The finding implies the web has no signed-out signal available. It does: the localStorage 'user' key is already maintained on precisely the same lifecycle as the iOS cookie check (set on login and /me success, cleared on logout, on terminal 401/403, on interceptor session-rejection at client.js:135, and on websocket.js:124). It is simply read too late — only in the transport-failure branch at AuthContext.jsx:47, never as a precondition. The port is therefore a smaller change than the finding suggests.

### 32. iOS discriminates the 4001 close REASON string; the web reads only the code

**Needs adaptation** · effort: small

**What iOS does.** The URLSessionWebSocketDelegate didCloseWith handler (RealtimeClient.swift:494-511) stashes the close reason in lastCloseReason, because the server sends 4001 for several distinct situations and only the reason separates them. socketFailed (RealtimeClient.swift:219-248) passes it to onUnauthorized, which AuthStore turns into either the dedicated .accessDenied screen or a plain sign-out (AuthStore.swift:71-73, 254-279).

**Why it matters.** Recording it so nobody adds reason-string parsing to the web socket. The backend emits four 4001 reasons (backend/app/realtime/hub.py:264 'Invalid token', :331 'Token expired', :338 'Account inactive', :347 'Mobile access revoked'), and the web's code-only handling is correct for all of them.

**iOS code to read.**

- ios/RxHive/Realtime/RealtimeClient.swift — urlSession(_:webSocketTask:didCloseWith:reason:), lastCloseReason, socketFailed(_:error:), onUnauthorized
- ios/RxHive/Features/Auth/AuthStore.swift — Phase.accessDenied(reason:)

**What the web does today.** frontend/src/services/websocket.js:107-136 branches on `event.code === 4001` alone and never touches `event.reason` — grepped frontend/src for `event.reason`, `closeCode`: no hits. It refreshes, and only signs out if the refresh is refused (websocket.js:114-127).

**Porting notes.** 'Mobile access revoked' is gated on `client == MOBILE_CLIENT` (backend/app/realtime/hub.py:345-348) and can never reach a web socket — the whole accessDenied phase is a mobile-gate concept with no web meaning. 'Account inactive' can reach the web, but the web's blanket refresh resolves it correctly: /api/auth/refresh re-checks is_active (backend/app/api/auth.py:6), returns 401, sessionRejected fires, user goes to /login. Correct outcome, one extra round trip.

**Corrections from verification.** The finding is literally accurate but materially overstates the gap, because it never checks which reasons a browser can actually receive. Server source: /Users/carinrowena/Documents/HIVE EXPORT/Hive Export/rxhive/backend/app/realtime/hub.py sends 4001 with four distinct reasons — "Invalid token" (line 264), "Token expired" (line 331), "Account inactive" (line 338), "Mobile access revoked" (line 347). The fourth is gated on `if client == MOBILE_CLIENT and (...)` (hub.py:344), so a web socket can never receive it. That is exactly the reason iOS needs its dedicated .accessDenied screen for — the web has no reachable case that maps to it.

Of the three reasons web can receive, the code-only branch already lands on the right terminal outcome: refresh either succeeds (Token expired / Invalid token → reconnect) or is refused with 401/403 and the user is signed out. "Account inactive" is re-checked on refresh (backend/app/api/auth.py:281, `if user is None or not user.is_active`), so it deterministically fails the refresh and produces the plain sign-out — the same outcome iOS reaches on its non-accessDenied branch. The web's extra care about undelivered refreshes (websocket.js:118-127) is a refinement iOS lacks, not a deficiency.

Portability correction: "direct" is wrong as stated. `CloseEvent.reason` is fully readable in every browser (standard, up to 123 UTF-8 bytes), so the mechanism itself ports directly — but the iOS logic cannot be copied 1:1, because the reason string it branches on is structurally unreachable on web. A useful port would have to be re-aimed at "Account inactive" (skip the refresh round-trip and sign out immediately), which is a behavior change rather than a transplant. Hence needs-adaptation, and low value.

### 33. iOS tears the socket down on backgrounding and rebuilds it on foreground

**Needs adaptation** · effort: small

**What iOS does.** applicationDidEnterBackground() (RealtimeClient.swift:311-316) cancels the ping timer and the socket outright, because iOS suspends the process and kills the connection with no close event; applicationWillEnterForeground() (RealtimeClient.swift:318-329) reopens it, guarded against the app-switcher/Control-Center flicker that used to open a duplicate socket on top of a live one.

**Why it matters.** Recording it so nobody adds a visibilitychange teardown to the web socket — it would be a regression, not a port.

**iOS code to read.**

- ios/RxHive/Realtime/RealtimeClient.swift — applicationDidEnterBackground(), applicationWillEnterForeground()
- ios/RxHive/Features/Auth/AuthStore.swift — applicationDidEnterBackground(), applicationWillEnterForeground()

**What the web does today.** frontend/src/services/websocket.js has no visibility handling; the socket's lifetime is the session's, owned by frontend/src/components/shared/RealtimeSession.jsx:36-48. A hidden tab keeps its socket and its 30s heartbeat (websocket.js:666-677) running.

**Porting notes.** Browsers do not suspend a backgrounded tab's socket the way iOS suspends a process; a hidden tab keeps sending frames, and throttled timers are already handled by the server's 65s heartbeat window (backend/app/realtime/hub.py HEARTBEAT_TIMEOUT). Deliberately tearing down on hide would cost the user incoming messages and call rings in exactly the case the web supports and iOS cannot.

**Corrections from verification.** Two details in the finding are slightly off. (a) "websocket.js has no visibility handling" is wrong as stated — it reads document.visibilityState at :189 and :767; what it has no visibility handling for is the socket's lifetime. (b) "no visibility handling" in the web generally is wrong — ChatSidebar.jsx:87-93 has a visibilitychange listener whose comment names precisely the dead-socket-while-hidden case, but it responds with a conversations refetch rather than a socket check, so a foregrounded tab can render a fresh sidebar over a dead socket. The rest of the claim (socket lifetime = session lifetime, owned by RealtimeSession.jsx:36-48; 30s heartbeat at websocket.js:666-677 keeps running while hidden) is accurate.

---

## 3. Reference — iOS files most worth reading

| Area | iOS file | Web counterpart |
|---|---|---|
| Voice recorder state machine | `ios/RxHive/Features/Chat/AudioRecorder.swift` | `frontend/src/hooks/useAudioRecorder.js` |
| Recorder UI, lock, slide-to-cancel | `ios/RxHive/Features/Chat/VoiceRecorderBar.swift` | `frontend/src/components/chat/AudioRecorderBar.jsx` |
| Waveforms (live + extracted) | `ios/RxHive/Features/Media/Waveform.swift` | `frontend/src/components/chat/Waveform.jsx` |
| Audio bubble + speed control | `ios/RxHive/Features/Media/MediaAttachmentViews.swift` | `frontend/src/components/chat/AudioPlayer.jsx` |
| Media quality tiers + transcoding | `ios/RxHive/Features/Media/MediaQuality.swift` | *(none — new)* |
| Pre-send confirm tray | `ios/RxHive/Features/Media/MediaSendSheet.swift` | `frontend/src/components/chat/StagedFilePreview.jsx` |
| Bubble layout + footer placement | `ios/RxHive/Features/Chat/MessageBubble.swift` | `frontend/src/components/chat/MessageBubble.jsx` |
| Composer, attachments, upload rows | `ios/RxHive/Features/Chat/MessageComposer.swift` | `frontend/src/components/chat/MessageComposer.jsx` |
| HTTP client, refresh-and-replay | `ios/RxHive/Core/APIClient.swift` | `frontend/src/api/client.js` |
| Session lifecycle | `ios/RxHive/Features/Auth/AuthStore.swift` | `frontend/src/contexts/AuthContext.jsx` |
| Realtime socket | `ios/RxHive/Realtime/RealtimeClient.swift` | `frontend/src/services/websocket.js` |

---

## 4. Explicitly out of scope

These are iOS-only for good reasons and should **not** be ported.

- **In-app camera capture.** `UIImagePickerController` in
  `ios/RxHive/Features/Chat/MessageComposer.swift` (`CameraCapture`). The product decision is that
  camera capture is a mobile-app feature. A browser `<input capture>` is a pale imitation and would
  create a second, worse capture path. Item 16 covers the *menu entry* only, which is a different
  question — decide that one on its own merits.
- **Haptics.** `UIImpactFeedbackGenerator` on record-start and lock. The Vibration API does not exist
  in iOS Safari and is ignored in most desktop browsers.
- **App-lifecycle socket teardown** (item 33). A browser tab has no `scenePhase`; the nearest
  equivalents are `visibilitychange` and the Page Lifecycle API, and the web's existing reconnect
  already covers the real cases. Read the item before deciding.
- **Offline-launch session restore.** iOS comes up signed-in from a cached identity when the network
  is unreachable at launch. A web page load with no network shows the browser's own error; there is
  no equivalent surface.

---

## 5. Suggested order

Highest user-visible value per unit of effort, based on the effort ratings above.

1. **Bubble footer placement** (items 17–20). Four related changes, one structural refactor —
   extract the shared footer into a `<MessageFooter>` and hand it to the audio and document cards.
   This is the single most visible difference between the two clients.
2. **Upload rows with per-file status and cancel** (item 21). The web composer currently freezes
   during an upload; this is the worst functional gap in the list.
3. **Standard/HD image tier** (items 9, 10). Canvas can do the photo half properly. Ship photos
   first and leave video (item 11) alone until someone has measured whether it is worth it.
4. **Session hardening** (items 25–29). All small, all defensive, none user-visible until the day
   they matter.
5. **Voice-note gestures** (items 1–3). Highest polish, most adaptation work, and only benefits
   touch users. Do these when the rest is done.

---

## 6. How to verify a port is complete

For each item, the acceptance test is behavioural, not visual:

- **Voice gestures:** on a touch device, one continuous gesture must record and send. Releasing
  under the minimum duration must send nothing and must not leave a zero-byte upload.
- **Footer placement:** an audio or document message must not render a row of empty bubble colour
  beneath a fixed-width card. The bubble should hug the card.
- **Quality tiers:** send the same photo at both tiers and compare the bytes the server stores.
  They must differ, and the size shown in the UI before sending must match what actually arrives.
- **Upload rows:** the composer must stay usable during an upload, and cancelling must abort the
  request rather than merely hiding the row.
- **Session items:** a refresh that fails with a network error must leave the user signed in; a
  refresh the server answers 401 must sign them out. Both are testable by stopping the API container
  versus revoking the token in the database.
