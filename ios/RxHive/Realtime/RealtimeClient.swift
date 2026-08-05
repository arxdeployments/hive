import Foundation
import os
#if canImport(UIKit)
import UIKit
#endif

/// The live connection to `/api/ws`.
///
/// ## Auth
/// The handshake is cookie-authenticated: `core/deps.py:get_current_user_ws`
/// reads `rx_access` from the request cookies and only falls back to a
/// `?token=` query param **outside production**. `URLSessionWebSocketTask` sends
/// cookies from the session's storage automatically, so a socket opened after a
/// successful login is authenticated with no extra work — and there is no
/// supported way to authenticate it otherwise in production.
///
/// ## Heartbeat
/// The server drops any socket that goes 65 seconds without a frame
/// (`hub.py:HEARTBEAT_TIMEOUT`). We ping every 25s: frequent enough to survive
/// one lost ping, cheap enough to ignore. The server answers `pong`.
///
/// ## Token expiry is normal, not exceptional
/// On `ping`, the server compares now against the access token's `exp` and closes
/// with **4001** when it has passed — which happens every 15 minutes by default.
/// So 4001 is the expected steady-state closure, and the correct response is to
/// refresh the cookie and reconnect, not to sign the user out. `AuthStore` owns
/// that distinction; this class reports the close code and lets it decide.
@MainActor
final class RealtimeClient: NSObject, ObservableObject {

    enum State: Equatable {
        case idle
        case connecting
        case connected
        /// Waiting out backoff before the next attempt.
        case reconnecting(attempt: Int)
        /// Given up until something external (foreground, network, sign-in) pokes us.
        case offline
    }

    @Published private(set) var state: State = .idle

    /// Live subscriber continuations, keyed so a finished stream can remove its own.
    ///
    /// **This is a fan-out, not a single stream, and it has to be.** A lone
    /// `AsyncStream` has exactly one consumer: two `for await` loops over the same
    /// stream *split* the elements between them rather than each seeing all of them.
    /// `ChatStore` and `CallStore` both consume this, so a single stream would deliver
    /// roughly half of every `call:*` frame to `ChatStore` (which drops them) and half
    /// of every `new_message` to `CallStore` (likewise) — calls and messages both
    /// intermittently dead, with nothing in the logs to say why. Every subscriber gets
    /// its own continuation and every event is yielded to all of them.
    private var subscribers: [UUID: AsyncStream<RealtimeEvent>.Continuation] = [:]

    /// A stream carrying **every** event, for as long as the returned stream is
    /// iterated. Cancelling the consuming task unregisters it.
    ///
    /// `.bufferingNewest(64)` rather than unbounded: a subscriber that stops draining
    /// must not let the socket's backlog grow without limit, and for realtime chat the
    /// newest frames are the ones worth keeping.
    func subscribe() -> AsyncStream<RealtimeEvent> {
        let id = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(64)) { continuation in
            subscribers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in self?.subscribers[id] = nil }
            }
        }
    }

    private func broadcast(_ event: RealtimeEvent) {
        for continuation in subscribers.values {
            continuation.yield(event)
        }
    }

    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var pingTimer: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var attempt = 0
    private var intentionallyClosed = false

    /// Which socket lifecycle we are on. Bumped by everything that starts or ends
    /// one — `connect()`, `disconnect()`, and the backgrounding teardown.
    ///
    /// Work that suspends captures it and re-checks on the far side, because
    /// `intentionallyClosed` cannot answer the question on its own: `connect()`
    /// clears that flag, so after a sign-out and a sign-in it reads exactly like a
    /// session that was never interrupted. The same counter-not-a-flag reasoning
    /// as `AuthStore.sessionGeneration`, for the same class of bug.
    private var connectionGeneration = 0

    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "ws")

    /// Called when the socket closes because the access token expired (4001).
    /// `.valid` means reconnect now; `.unreachable` means the check itself could not
    /// be delivered, so back off and try again rather than ending the session.
    var onTokenExpired: (() async -> AuthStore.SessionCheck)?
    /// Called when the socket is closed for a reason a refresh cannot fix. Carries
    /// the server's close reason — `hub.py` sends "Mobile access revoked" there, and
    /// that sentence is the difference between the right screen and a wrong one.
    var onUnauthorized: ((String) -> Void)?

    /// Whether a call is live right now. Set by `CallStore`, and consulted for two
    /// decisions this class cannot make on its own:
    ///
    ///  * **Backgrounding.** `applicationDidEnterBackground` tears the socket down
    ///    because iOS suspends the process and the socket dies silently anyway. But
    ///    during a call the process is NOT suspended — the `audio` background mode in
    ///    Info.plist keeps it running — so tearing the socket down there was pure
    ///    self-harm: glancing at another app mid-call dropped signalling, and the
    ///    server (before it learned to grant a grace window) ended the call outright.
    ///  * **Reconnect pacing.** A 30-second backoff ceiling is right for chat and
    ///    far too slow for a call, where every second of it is a second of the
    ///    server's reconnect grace window spent doing nothing.
    var hasLiveCall: () -> Bool = { false }

    /// Called on every successful (re)connection, after the server's `connected`
    /// frame. `CallStore` uses it to re-read call state that may have changed while
    /// the socket was away — the frames sent in that window are gone for good.
    var onReconnected: (() -> Void)?

    /// The most recent close reason, captured by the delegate. `closeCode` alone
    /// cannot distinguish "token expired" from "mobile access revoked": the server
    /// sends 4001 for both and puts the difference in the reason.
    private var lastCloseReason = ""

    private let pingInterval: Duration = .seconds(25)
    /// Server closes with 4001 for both "invalid token" and "token expired", and
    /// with 4001 for "account inactive" too — the reason string distinguishes them.
    private let authCloseCode = 4001

    override init() {
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = RxDate.parse(text) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Bad date \(text)")
                )
            }
            return date
        }
        super.init()

        let config = URLSessionConfiguration.default
        config.httpCookieStorage = .shared
        config.httpShouldSetCookies = true
        config.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    // MARK: - Lifecycle

    func connect() {
        guard state != .connected, state != .connecting else { return }
        connectionGeneration &+= 1
        intentionallyClosed = false
        openSocket()
    }

    func disconnect() {
        connectionGeneration &+= 1
        intentionallyClosed = true
        reconnectTask?.cancel(); reconnectTask = nil
        pingTimer?.cancel(); pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        attempt = 0
        state = .idle
    }

    private func openSocket() {
        state = .connecting
        var request = URLRequest(url: AppConfig.webSocketBaseURL.appendingPathComponent("api/ws"))
        // Not required by the handshake (which is a GET), but harmless and keeps
        // every request this app makes uniform.
        request.setValue(AppConfig.csrfHeader.value, forHTTPHeaderField: AppConfig.csrfHeader.name)

        let socket = session.webSocketTask(with: request)
        task = socket
        socket.resume()
        receiveLoop(on: socket)
        startPinging()
    }

    // MARK: - Receiving

    private func receiveLoop(on socket: URLSessionWebSocketTask) {
        // This `Task` inherits the enclosing @MainActor context, so `isCurrent`,
        // `handle` and `socketFailed` are already main-actor-isolated and are called
        // without `await`. Only `socket.receive()` actually suspends.
        Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    guard let self else { return }
                    // A different socket took over while this loop was suspended.
                    guard self.isCurrent(socket) else { return }
                    switch message {
                    case .string(let text):
                        self.handle(text: text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            self.handle(text: text)
                        }
                    @unknown default:
                        break
                    }
                } catch {
                    guard let self else { return }
                    guard self.isCurrent(socket) else { return }
                    self.socketFailed(socket, error: error)
                    return
                }
            }
        }
    }

    private func isCurrent(_ socket: URLSessionWebSocketTask) -> Bool {
        task === socket
    }

    private func handle(text: String) {
        guard let frame = InboundFrame(text: text) else {
            log.error("Unparseable frame: \(text.prefix(200), privacy: .public)")
            return
        }
        if frame.type == "connected" {
            attempt = 0
            state = .connected
            onReconnected?()
        }
        guard let event = map(frame) else {
            log.notice("Unhandled event type \(frame.type, privacy: .public)")
            return
        }
        broadcast(event)
    }

    private func socketFailed(_ socket: URLSessionWebSocketTask, error: Error) {
        pingTimer?.cancel(); pingTimer = nil
        guard !intentionallyClosed else { return }

        let code = socket.closeCode
        log.notice("Socket closed (code \(code.rawValue), \(error.localizedDescription, privacy: .public))")

        if code.rawValue == authCloseCode {
            // The 15-minute access token lapsed — the common case. Refresh and
            // reconnect immediately rather than backing off, because the user is
            // very likely looking at the screen right now.
            let reason = lastCloseReason
            // Drop the dead socket and stop claiming `.connected` BEFORE awaiting
            // the refresh. This close arrives every ~15 minutes for every
            // connected user, and the refresh behind it is two or three round
            // trips; for that whole window `state` still read `.connected` and
            // `task` still pointed at the closed socket, so `send(_:)`'s guard
            // passed and every frame written in that window went into a dead
            // socket and was dropped with nothing but a log line. Tapping Answer
            // in that window sent an accept the server never received.
            task = nil
            state = .connecting
            // Captured out here, not inside the Task: the body does not begin until
            // a later main-actor turn, so a sign-out and sign-in can both have run
            // before its first line — and the generation read there would already be
            // the new session's.
            let generation = connectionGeneration
            Task { [weak self] in
                guard let self else { return }
                let outcome = await self.onTokenExpired?() ?? .unreachable
                // Nothing cancels this Task, so on the far side of that await it has
                // to prove the connection it was refreshing is still the current one.
                // `intentionallyClosed` could not: a sign-out mid-refresh sets it and
                // the sign-in that follows clears it again, so the stale refresh read
                // "still fine to reconnect" and acted on a session that had already
                // been replaced. All three outcomes did damage — `.valid` opened a
                // second socket over the new session's and orphaned the first in
                // `task`, left to linger server-side until the 65s heartbeat timeout
                // (the same duplicate the foreground guard below exists to prevent);
                // `.unreachable` scheduled a reconnect on top of a live socket; and
                // `.rejected` signed the *new* session out, having asked about the
                // old one.
                //
                // Returning without touching `state` is the point: the newer
                // lifecycle owns it now. `disconnect()` left it at `.idle` and any
                // `connect()` since has set its own.
                guard self.connectionIsCurrent(generation) else { return }
                switch outcome {
                case .valid:
                    self.attempt = 0
                    self.openSocket()

                case .unreachable:
                    // We could not confirm the session, which is not the same as
                    // losing it. Back off and try again: this close arrives every 15
                    // minutes for every connected user, so treating one unanswered
                    // check as a sign-out meant a single dead spot ended the session.
                    // Worse, the old code then parked at `.offline` without ever
                    // scheduling a reconnect, so there was no way back even once the
                    // network returned.
                    self.log.notice("Token refresh undeliverable; backing off instead of signing out")
                    self.scheduleReconnect()

                case .rejected:
                    self.state = .offline
                    self.onUnauthorized?(reason)
                }
            }
            return
        }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        attempt += 1
        state = .reconnecting(attempt: attempt)
        // Exponential with a 30s ceiling, plus jitter so a server restart doesn't
        // bring every client back in the same instant.
        //
        // While a call is live the ceiling drops to two seconds. The server holds a
        // disconnected participant's call open for `RECONNECT_GRACE_SECONDS` (40s);
        // backing off for 30 of those spends most of the window doing nothing, and a
        // single further failure runs past it and loses a call that would have
        // resumed. Chat can afford to wait; a call the user is sitting in cannot.
        let ceiling: Double = hasLiveCall() ? 2 : 30
        let base = min(pow(2.0, Double(min(attempt, 5))), ceiling)
        let delay = base + Double.random(in: 0...1)
        // Generation-checked for the same reason as the refresh above, plus one this
        // path owns: `disconnect()` cancels this Task, but `connect()` does not.
        // Answering a call while the socket is in backoff goes through `connect()`
        // (CallStore does exactly that when Accept is pressed on a down socket), and
        // the sleeping Task then woke up to open a second socket on top of the one
        // that had already come back.
        let generation = connectionGeneration
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled, self.connectionIsCurrent(generation) else { return }
            self.openSocket()
        }
    }

    /// Whether the socket lifecycle a suspended piece of work started in is still
    /// the one running. The generation counterpart of `isCurrent(_ socket:)`: that
    /// one asks whether a receive loop still speaks for the live socket, this one
    /// asks whether a reconnect still speaks for the live session.
    ///
    /// Static and non-private so the rule can be tested without a seam into the
    /// private socket paths, which need a real 4001 close to reach.
    static func connectionIsCurrent(captured: Int, current: Int, intentionallyClosed: Bool) -> Bool {
        captured == current && !intentionallyClosed
    }

    private func connectionIsCurrent(_ captured: Int) -> Bool {
        Self.connectionIsCurrent(
            captured: captured,
            current: connectionGeneration,
            intentionallyClosed: intentionallyClosed
        )
    }

    // MARK: - Sending

    func send(_ frame: OutboundFrame) {
        guard let task, state == .connected else {
            // Dropped rather than queued. Every frame this app sends is either
            // idempotent-on-reconnect (read_receipt, typing) or has a UI-level
            // retry (message). A queue would replay stale typing indicators and
            // resend messages the user may have given up on.
            log.debug("Dropping frame; socket not connected")
            return
        }
        do {
            let data = try encoder.encode(frame)
            guard let text = String(data: data, encoding: .utf8) else { return }
            task.send(.string(text)) { [weak self] error in
                if let error {
                    self?.log.error("Send failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        } catch {
            log.error("Encode failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func startPinging() {
        pingTimer?.cancel()
        pingTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: self?.pingInterval ?? .seconds(25))
                guard let self, !Task.isCancelled else { return }
                // The app-level ping, not the WebSocket protocol ping: the server's
                // heartbeat check and token-expiry check both hang off receiving a
                // `{"type":"ping"}` frame, so a protocol-level ping would keep the
                // socket alive without ever triggering either.
                self.send(.ping)
            }
        }
    }

    // MARK: - Foreground / background

    /// iOS suspends the process in the background, which silently kills the
    /// socket; there is no close event to react to. So the connection is torn down
    /// on the way out and rebuilt on the way in, rather than discovered dead.
    ///
    /// **Except during a call.** The `audio` background mode in Info.plist keeps the
    /// process running for the whole call, so the socket does *not* die and there is
    /// nothing to pre-empt. Cancelling it here was actively harmful: glancing at
    /// another app, taking a photo, or reading a notification mid-call dropped
    /// signalling, which meant the hang-up button could not be delivered, the peer's
    /// state stopped arriving, and the server treated it as the participant leaving.
    /// Keeping it open is what makes "put the phone down for a second" a non-event.
    func applicationDidEnterBackground() {
        if hasLiveCall() {
            log.notice("Backgrounded during a call; keeping the socket open")
            return
        }
        pingTimer?.cancel(); pingTimer = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .idle
        // This ends a socket lifecycle as surely as `disconnect()` does, and it
        // leaves the same two pieces of suspended work behind — a refresh in flight
        // and a sleeping reconnect, neither of which is cancelled here. Both used to
        // wake up in a suspended process and call `openSocket()`, and because that
        // set `state` to `.connecting`, the real foregrounding below then returned
        // early and left the app holding whatever the background had managed to open.
        connectionGeneration &+= 1
    }

    func applicationWillEnterForeground() {
        guard !intentionallyClosed else { return }
        // `scenePhase` reaches `.active` for far more than a real return from the
        // background — the app switcher, Control Center, a notification banner, a
        // permission alert. Without this guard each flicker opened another socket on
        // top of the live one, and the orphan lingered server-side until the 65s
        // heartbeat timeout, each one an extra presence connection and an extra
        // chance to trip the auth paths above.
        guard state != .connected, state != .connecting else { return }
        attempt = 0
        openSocket()
    }

    // MARK: - Frame -> event

    private func map(_ frame: InboundFrame) -> RealtimeEvent? {
        switch frame.type {
        case "connected":
            return .connected(userID: frame.string("user_id") ?? "")
        case "pong":
            return .pong
        case "error":
            return .error(detail: frame.string("detail") ?? "", tempID: frame.string("temp_id"))

        // Messaging
        case "new_message":
            // The message rides under `message` in the published payload.
            guard let message = frame.decode(Message.self, at: "message", using: decoder)
                    ?? frame.decodeSelf(Message.self, using: decoder) else { return nil }
            return .newMessage(message)
        case "message_ack":
            return .messageAck(
                tempID: frame.string("temp_id"),
                messageID: frame.string("message_id") ?? "",
                createdAt: frame.date("created_at"),
                status: frame.string("status") ?? "sent"
            )
        case "message_status":
            return .messageStatus(messageID: frame.string("message_id"), status: frame.string("status"))
        case "messages_read":
            return .messagesRead(
                conversationID: frame.string("conversation_id"),
                userID: frame.string("user_id"),
                readAt: frame.date("read_at")
            )
        case "message_edited":
            guard let messageID = frame.string("message_id") else { return nil }
            return .messageEdited(
                messageID: messageID,
                conversationID: frame.string("conversation_id"),
                content: frame.string("content") ?? "",
                editedAt: frame.date("edited_at")
            )
        case "reaction_update":
            let reactions = frame.decode([Reaction].self, at: "reactions", using: decoder) ?? []
            return .reactionUpdate(
                messageID: frame.string("message_id"),
                conversationID: frame.string("conversation_id"),
                reactions: reactions
            )
        case "message_pin_update":
            return .messagePinUpdate(
                messageID: frame.string("message_id"),
                conversationID: frame.string("conversation_id"),
                isPinned: frame.bool("is_pinned") ?? false
            )
        case "typing":
            guard let conversationID = frame.string("conversation_id"),
                  let userID = frame.string("user_id") else { return nil }
            return .typing(
                conversationID: conversationID,
                userID: userID,
                userName: frame.string("user_name"),
                isTyping: frame.bool("is_typing") ?? false
            )
        case "presence":
            guard let userID = frame.string("user_id") else { return nil }
            let status = PresenceStatus(rawValue: frame.string("status") ?? "") ?? .unknown
            return .presence(userID: userID, status: status, lastSeen: frame.date("last_seen"))

        // Conversations
        case "conversation_created":
            return .conversationCreated(frame.decode(Conversation.self, at: "conversation", using: decoder))
        case "conversation_updated":
            return .conversationUpdated(conversationID: frame.string("conversation_id"))
        case "conversation_pin_update":
            return .conversationPinUpdate(
                conversationID: frame.string("conversation_id"),
                isPinned: frame.bool("is_pinned") ?? false,
                pinOrder: frame.int("pin_order")
            )
        case "permissions_updated":
            return .permissionsUpdated(
                conversationID: frame.string("conversation_id"),
                permissions: frame.decode(GroupPermissions.self, at: "permissions", using: decoder)
            )
        case "member_added":
            return .memberAdded(conversationID: frame.string("conversation_id"), userID: frame.string("user_id"))
        case "member_removed":
            return .memberRemoved(conversationID: frame.string("conversation_id"), userID: frame.string("user_id"))
        case "member_left":
            return .memberLeft(conversationID: frame.string("conversation_id"), userID: frame.string("user_id"))
        case "role_changed":
            return .roleChanged(
                conversationID: frame.string("conversation_id"),
                userID: frame.string("user_id"),
                role: ParticipantRole(rawValue: frame.string("role") ?? "")
            )
        case "removed_from_conversation":
            return .removedFromConversation(conversationID: frame.string("conversation_id"))
        case "profile_updated":
            return .profileUpdated(userID: frame.string("user_id"))
        case "cross_org":
            return .crossOrg

        // Calls
        case "call:incoming":            return .callIncoming(signal(frame))
        case "call:accepted":            return .callAccepted(signal(frame))
        case "call:declined":            return .callDeclined(signal(frame))
        case "call:cancelled":           return .callCancelled(signal(frame))
        case "call:ended", "call:end":   return .callEnded(signal(frame))
        case "call:busy":                return .callBusy(signal(frame))
        case "call:missed":              return .callMissed(signal(frame))
        case "call:unavailable":         return .callUnavailable(signal(frame))
        case "call:full":                return .callFull(signal(frame))
        case "call:error":               return .callError(detail: frame.string("message") ?? "Call failed")
        case "call:ringing_started":     return .callRingingStarted(signal(frame))
        case "call:participant_joined":  return .callParticipantJoined(signal(frame))
        case "call:participant_left":    return .callParticipantLeft(signal(frame))
        case "call:group_started":       return .callGroupStarted(signal(frame))
        case "call:group_ended":         return .callGroupEnded(signal(frame))
        case "call:group_active":        return .callGroupActive(signal(frame))
        case "call:group_already_active": return .callGroupAlreadyActive(signal(frame))
        case "call:group_participants":  return .callGroupParticipants(signal(frame))
        case "call:participants_invited": return .callParticipantsInvited(signal(frame))
        case "call:participant_declined": return .callParticipantDeclined(signal(frame))
        case "call:media_toggle":
            return .callMediaToggle(
                callID: frame.string("call_id"),
                userID: frame.string("user_id"),
                mediaType: frame.string("media_type"),
                enabled: frame.bool("enabled") ?? true
            )
        case "call:peer_state":
            return .callPeerState(
                callID: frame.string("call_id"),
                userID: frame.string("user_id"),
                state: frame.string("state"),
                quality: frame.string("quality")
            )
        case "call:resume":
            return .callResume(frame.decode(ActiveCallState.self, at: "call", using: decoder))

        default:
            return .unknown(type: frame.type)
        }
    }

    private func signal(_ frame: InboundFrame) -> CallSignal {
        frame.decodeSelf(CallSignal.self, using: decoder)
            ?? CallSignal(
                callID: frame.string("call_id"), callType: nil, caller: nil,
                conversationID: frame.string("conversation_id"), calleeID: nil,
                isGroup: nil, groupName: nil, accepterID: nil, duration: nil,
                reason: nil, message: frame.string("message"), participants: nil,
                participant: nil, participantID: nil
            )
    }
}

// MARK: - URLSessionWebSocketDelegate

extension RealtimeClient: URLSessionWebSocketDelegate {
    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        // `state` only becomes `.connected` on the server's `connected` frame — an
        // open TCP/TLS socket is not yet an authenticated session, and treating it
        // as one would let frames be sent into a connection about to be closed 4001.
        Task { @MainActor [weak self] in
            guard let self, self.task === webSocketTask else { return }
            if self.state == .connecting { /* awaiting `connected` */ }
        }
    }

    nonisolated func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        // The receive loop's throw is the single path that handles closure, but the
        // reason string arrives *only* here, and it is the only thing that separates
        // a routine token expiry from a withdrawn mobile grant. Stash it for
        // `socketFailed`, which runs immediately afterwards on the same close.
        let text = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        Logger(subsystem: "ai.rhythmrx.rxhive", category: "ws")
            .notice("didClose \(closeCode.rawValue) \(text, privacy: .public)")
        Task { @MainActor [weak self] in
            guard let self, self.task === webSocketTask else { return }
            self.lastCloseReason = text
        }
    }
}
