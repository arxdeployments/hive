import AVFoundation
import Combine
import Foundation
import LiveKit
import os
import SwiftUI

/// The call state machine, and the only thing that talks to `LiveKitSession`.
///
/// Split of responsibility, mirroring the backend's: signalling is a handful of
/// `call:*` frames over the app's own WebSocket, and media is a LiveKit room. This
/// store owns the first and drives the second; the views read published state and
/// call intents.
@MainActor
final class CallStore: ObservableObject {

    /// Where the call is.
    ///
    /// `.outgoing` / `.incoming` carry the `CallSignal` they came from — the caller
    /// brief in it is the only place a name and avatar exist before the SFU roster
    /// does, and re-fetching it would make the ring screen flash a placeholder.
    enum Phase: Equatable {
        case idle
        case outgoing(CallSignal)
        case incoming(CallSignal)
        case active(CallSession)
        /// Terminal, held briefly so "Call ended" can be shown before the UI goes.
        case ended
    }

    // MARK: Published state

    @Published private(set) var phase: Phase = .idle {
        didSet {
            // Remember every call id this store has held. That record is what tells
            // a stale terminal frame apart from the outgoing ring we have no id for
            // yet — see `terminalFrameIsOurs`. Recorded here rather than at each of
            // the eight assignments to `phase` so that none of them can forget to.
            guard let id = currentCallID, !seenCallIDs.contains(id) else { return }
            seenCallIDs.append(id)
            if seenCallIDs.count > Self.seenCallIDLimit { seenCallIDs.removeFirst() }
        }
    }
    /// Answered (or accepted by the other side) and joining the room. A distinct
    /// flag rather than a Phase case because the screen is the active-call screen
    /// with a "Connecting" label — the same view, not another one.
    @Published private(set) var isConnecting = false

    @Published private(set) var isMuted = false
    @Published private(set) var isCameraOn = false
    @Published private(set) var isSpeakerOn = false
    /// Remote participants only. Merged from the room and the socket — see
    /// `recomputeParticipants()`.
    @Published private(set) var participants: [CallParticipantState] = []
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var networkQuality: CallNetworkQuality = .unknown
    /// Seconds since the call connected.
    @Published private(set) var elapsed: TimeInterval = 0
    @Published var isMinimised = false

    /// Our own media link (the LiveKit room).
    @Published private(set) var mediaLink: CallMediaLink = .connected
    /// Our own signalling link (the app's WebSocket). Losing it mid-call is a
    /// "Connecting…", not a hang-up: the server holds the call open for its reconnect
    /// grace window and the SFU usually keeps carrying audio throughout.
    @Published private(set) var signalLink: CallMediaLink = .connected
    /// What each peer told us about ITS OWN link, keyed by user id. The SFU relays
    /// nothing of the sort, so without `call:peer_state` a user whose network was
    /// dying looked perfectly healthy from this side.
    @Published private(set) var peerLinks: [String: CallMediaLink] = [:]
    @Published private(set) var peerQualities: [String: String] = [:]

    /// Anything that means the call is not carrying right now: our media link, our
    /// signalling, or a peer's. All three read as "Connecting…" to the user, and the
    /// duration must never be shown over any of them — a clock ticking over dead
    /// audio is the single most misleading thing a call UI can do.
    var isStalled: Bool {
        guard case .active = phase else { return false }
        return mediaLink == .reconnecting
            || signalLink == .reconnecting
            || peerLinks.values.contains(.reconnecting)
    }

    /// True while any leg of the call is graded poor. Drives the connection toast.
    var isQualityPoor: Bool {
        networkQuality == .poor || peerQualities.values.contains("poor")
    }

    /// Badge for the Calls tab.
    @Published private(set) var missedCallCount = 0
    /// Group calls in progress, keyed by conversation id, so a conversation can
    /// offer "Join call". Populated from `call:group_active`.
    @Published private(set) var activeGroupCalls: [String: CallSignal] = [:]

    /// People invited into the current call who have not answered yet.
    ///
    /// The grid shows them as ringing. Without this an invitee materialised out of
    /// nowhere the moment they answered, and an invite that was never answered left no
    /// trace at all — so "did I actually add them?" had no answer on screen. Retired
    /// per-person as they arrive (`recomputeParticipants`) rather than on a timer,
    /// because "still ringing" is exactly the state worth showing.
    @Published private(set) var pendingInvitees: [CallParticipantBrief] = []

    let session = LiveKitSession()

    // MARK: Dependencies

    private weak var auth: AuthStore?
    private weak var chat: ChatStore?
    private weak var toasts: ToastCenter?

    private var eventTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
    private var autoResetTask: Task<Void, Never>?
    /// Fires if an Accept produces no connection. See `armAcceptTimeout`.
    private var acceptTimeoutTask: Task<Void, Never>?
    /// The camera on/off chain. See `toggleCamera` for why the taps are serialised.
    private var cameraTask: Task<Void, Never>?
    /// The camera the user was last using, so turning the camera back on returns to it
    /// even when the SDK has to build a new track rather than unmute the old one.
    private var lastCameraPosition: AVCaptureDevice.Position?
    private var socketStateObserver: AnyCancellable?
    /// Last time a poor-connection toast was shown, so a flapping grade cannot paper
    /// the screen with the same message during the moment it most needs reading.
    private var lastQualityToastAt: Date?
    /// Whether the "Connection lost" toast is currently owed a "restored".
    private var announcedStall = false

    /// This install's LiveKit device suffix.
    ///
    /// Persisted, not per-launch, so a relaunch mid-call reclaims the SAME identity and
    /// the SFU replaces the abandoned connection instead of leaving a ghost participant
    /// in the room for the rest of the call.
    private static let deviceID: String = {
        let key = "rxhive.deviceID"
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let fresh = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }()

    /// How long an Accept may sit unanswered before the user is told.
    ///
    /// Pressing Answer is the point of no return for a user's patience: if the
    /// `call:accept` frame never reaches the server (the socket closed under it) or the
    /// `call:accepted` reply never comes back, this screen used to sit on "Connecting"
    /// forever with no timeout and no error — indistinguishable from every other way a
    /// call fails. Comfortably longer than a reconnect plus a retry, and well inside the
    /// server's 45s ring window.
    private static let acceptTimeout: Duration = .seconds(20)

    /// Minimum gap between two poor-connection toasts.
    private static let qualityToastCooldown: TimeInterval = 20

    /// Participants the socket told us about, keyed by user id. A *supplement* to
    /// the room roster, never a replacement — see `recomputeParticipants()`.
    private var signalled: [String: CallParticipantBrief] = [:]
    /// `call:media_toggle` state for participants with no SFU presence yet.
    private var signalledMedia: [String: (muted: Bool?, cameraOff: Bool?)] = [:]
    /// Set while we are the initiator and the server has not yet told us the call id.
    private var awaitingCallID = false
    /// Call ids this store has held, oldest first. Not history — its only job is to
    /// recognise a call as one we have already been in, so it is bounded and never
    /// read for anything a user sees.
    private var seenCallIDs: [String] = []
    private static let seenCallIDLimit = 32
    /// The call answered on *this* device. Only that device may join the SFU room,
    /// because every device of one user shares a single LiveKit identity and a second
    /// join evicts the first. Cleared on teardown.
    private var acceptedLocallyCallID: String?
    private var startedAt: Date?

    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "calls")

    // MARK: - Attach

    /// Wire up dependencies and start consuming realtime events.
    ///
    /// `RealtimeClient.subscribe()` hands back a stream of its own, so this store and
    /// `ChatStore` each see *every* event. That matters: they were both iterating one
    /// shared `AsyncStream`, which has a single consumer and therefore split the
    /// elements between them — about half of every `call:*` frame was being delivered
    /// to `ChatStore`, which drops them. Everything below is additionally written to be
    /// idempotent and to re-derive from the room and from REST where it can, so a
    /// missed frame degrades latency rather than correctness.
    /// Drop the session-scoped state at a sign-out.
    ///
    /// Narrower than `ChatStore.reset`, on purpose. The three fields below belong
    /// to the person who was signed in — the badge is fetched per account, and the
    /// other two carry participant names — but `phase`, its media and the LiveKit
    /// session belong to a CALL, which can still be live when a sign-out lands.
    /// Tearing that down from here would strand the SFU connection with its
    /// signalling gone, so a store that is not idle keeps everything and this does
    /// nothing.
    #if DEBUG
    /// Seed the session-scoped fields directly; they are all `private(set)` and
    /// their real writers need a socket and an SFU.
    func applyForTesting(missedCallCount: Int, phase: Phase = .idle) {
        self.missedCallCount = missedCallCount
        self.phase = phase
    }
    #endif

    func resetSessionState() {
        guard case .idle = phase else { return }
        missedCallCount = 0
        activeGroupCalls = [:]
        pendingInvitees = []
    }

    func attach(auth: AuthStore, chat: ChatStore, toasts: ToastCenter) {
        self.auth = auth
        self.chat = chat
        self.toasts = toasts
        auth.registerSessionStore(calls: self)

        session.onStateChanged = { [weak self] in self?.pullSessionState() }
        session.onRoomLost = { [weak self] in self?.handleRoomLost() }

        // Our media link changed. Two consequences: the UI says "Connecting…", and the
        // OTHER side is told — the SFU relays this to nobody, so without the frame a
        // peer whose network was failing looked completely normal from across the call.
        session.onMediaLinkChanged = { [weak self] link in
            guard let self else { return }
            self.mediaLink = link
            self.announceConnectivity()
            if let callID = self.currentCallID {
                self.auth?.realtime.send(
                    .callLinkState(callID: callID, state: link.wireValue, quality: nil)
                )
            }
        }
        session.onQualityChanged = { [weak self] quality in
            guard let self else { return }
            self.networkQuality = quality
            self.announceConnectivity()
            if let callID = self.currentCallID {
                self.auth?.realtime.send(
                    .callLinkState(callID: callID, state: nil, quality: quality.wireValue)
                )
            }
        }
        // The room is gone but the CALL may not be. Fetch a fresh token and re-enter;
        // `false` tells the session to keep retrying (or, once its budget is spent, to
        // report the call lost).
        session.onNeedsRejoin = { [weak self] in
            await self?.rejoinCurrentRoom() ?? false
        }

        // Two things the socket has to tell us, both of which used to be nobody's job:
        //
        //  hasLiveCall  stops RealtimeClient tearing the socket down on backgrounding
        //               mid-call (the `audio` background mode keeps the process alive,
        //               so there is nothing to pre-empt) and tightens its reconnect
        //               backoff to fit the server's grace window.
        //  onReconnected  re-reads call state the socket missed. Every `call:*` frame is
        //               a fire-and-forget publish, so a ring delivered while this device
        //               was reconnecting simply evaporated — that is the single biggest
        //               reason a call "was never received".
        auth.realtime.hasLiveCall = { [weak self] in self?.hasLiveCall ?? false }
        auth.realtime.onReconnected = { [weak self] in
            guard let self else { return }
            self.signalLink = .connected
            self.announceConnectivity()
            Task { await self.reconcileWithServer() }
        }

        // Signalling loss has to reach the UI as "Connecting…" — and nothing more.
        //
        // Every client takes a 4001 close when its 15-minute access cookie lapses, so
        // this fires mid-call as a matter of routine. Tearing anything down here would
        // end every call that outlived the remaining cookie lifetime; the server holds
        // the call open for its grace window precisely so this can be a pause.
        socketStateObserver = auth.realtime.$state
            .receive(on: RunLoop.main)
            .sink { [weak self] state in
                guard let self else { return }
                self.signalLink = (state == .connected) ? .connected : .reconnecting
                self.announceConnectivity()
            }

        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let stream = self?.auth?.realtime.subscribe() else { return }
            for await event in stream {
                await self?.handle(event)
            }
        }
    }

    /// Ask the server what call this client should be in, and adopt the answer.
    ///
    /// Called on every (re)connection and on returning to the foreground. Deliberately
    /// additive: it never ends a call on its own except when the server says there is
    /// none, because the only thing worse than a stale call on screen is a live one
    /// torn down by a stale reconciliation.
    func reconcileWithServer() async {
        let state: ActiveCallState?
        do {
            state = try await RxHiveAPI.activeCall()
        } catch {
            // A failed reconcile costs a stale UI until the next attempt, never a wrong
            // decision — so it is logged and dropped rather than acted on.
            log.notice("activeCall failed: \(String(describing: error), privacy: .public)")
            return
        }
        await loadMissedCount()
        await adopt(state)
    }

    /// Reconcile local phase with the server's view of the live call.
    private func adopt(_ state: ActiveCallState?) async {
        guard let state else {
            // Nothing live server-side. An outgoing ring we have not yet been given an
            // id for is the one case where local state is legitimately ahead of the
            // server, so it is left alone.
            if hasLiveCall, !awaitingCallID {
                log.notice("Server reports no live call; clearing local call state")
                await teardown(to: .idle)
            }
            return
        }

        for (userID, link) in state.peerLinks where userID != auth?.currentUser?.id {
            peerLinks[userID] = (link == "down") ? .reconnecting : .connected
        }

        if state.isRinging, !state.isInitiator {
            // A ring recovered from a window in which we had no socket.
            guard currentCallID != state.callID else { return }
            log.notice("Recovered a ring missed while offline: \(state.callID, privacy: .public)")
            handleIncoming(state.asSignal)
            return
        }

        if state.isRinging, state.isInitiator {
            // Our own outgoing ring, recovered — a relaunch or a dropped socket during
            // the 45 seconds the server keeps ringing. Without this the caller's screen
            // went blank while the callee's phone was still ringing, and the only way
            // out was to wait for the timeout.
            guard currentCallID != state.callID else { return }
            log.notice("Recovered our own outgoing ring: \(state.callID, privacy: .public)")
            let me = auth?.currentUser?.id
            let peer = state.participants.first { $0.id != me }
            // `caller` on the resumed state is the INITIATOR, which on an outgoing call
            // is us — and the ringing screen renders `signal.caller` as the person being
            // called. Left as-is it would show the user their own name and avatar.
            beginOutgoing(signal: state.asSignal.withCaller(peer), video: state.callType == .video)
            if let peer { signalled[peer.id] = peer }
            recomputeParticipants()
            return
        }

        // A group call in progress that we never joined is an invitation, not a ringer:
        // it belongs on the conversation as "Join call", not over the whole screen.
        if state.isConnected, state.isGroup, !state.selfJoined {
            if let conversationID = state.conversationID {
                activeGroupCalls[conversationID] = state.asSignal
            }
            return
        }

        guard state.isConnected, state.selfJoined else { return }

        if currentCallID != state.callID {
            log.notice("Recovered a connected call missed while offline: \(state.callID, privacy: .public)")
            autoResetTask?.cancel()
            signalled = [:]
            signalledMedia = [:]
            participants = []
            for brief in state.participants where brief.id != auth?.currentUser?.id {
                signalled[brief.id] = brief
            }
            activeConversationID = state.conversationID
            resetMediaFlags(video: state.callType == .video)
            acceptedLocallyCallID = state.callID
            phase = .active(
                CallSession(
                    id: state.callID,
                    type: state.callType,
                    isGroup: state.isGroup,
                    room: state.room,
                    participants: Array(signalled.values)
                )
            )
            startedAt = state.answeredAt ?? Date()
            elapsed = Date().timeIntervalSince(startedAt ?? Date())
            startTimer()
            recomputeParticipants()
        }

        if session.callID != state.callID {
            log.notice("Rejoining the room after a signalling reconnect")
            isConnecting = true
            await join(callID: state.callID)
        }
    }

    /// Re-enter the room we were dropped from. Returns whether we are back in.
    private func rejoinCurrentRoom() async -> Bool {
        guard hasLiveCall, let callID = currentCallID else { return false }
        do {
            let token = try await RxHiveAPI.callToken(callID: callID, deviceID: Self.deviceID)
            _ = try await session.join(
                callID: callID,
                token: token,
                wantVideo: isVideoCall && isCameraOn,
                speaker: isSpeakerOn
            )
            pullSessionState()
            return true
        } catch let error as APIError {
            // 404/400: the server says this call is over. Retrying cannot help, and
            // pretending otherwise only delays telling the user.
            switch error {
            case .notFound, .validation:
                log.notice("Rejoin refused — the call is no longer active")
                await teardown(to: .ended)
                return true  // "handled": stop the retry loop rather than exhausting it
            default:
                return false
            }
        } catch {
            log.notice("Rejoin failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    // MARK: - Derived, for the views

    var currentCallID: String? {
        switch phase {
        case .idle, .ended: return nil
        case .outgoing(let signal), .incoming(let signal): return signal.callID
        case .active(let session): return session.id
        }
    }

    var callType: CallType {
        switch phase {
        case .outgoing(let signal), .incoming(let signal): return signal.callType ?? .voice
        case .active(let session): return session.type
        case .idle, .ended: return .voice
        }
    }

    var isVideoCall: Bool { callType == .video }

    var isGroupCall: Bool {
        switch phase {
        case .outgoing(let signal), .incoming(let signal): return signal.isGroup == true
        case .active(let session): return session.isGroup
        case .idle, .ended: return false
        }
    }

    /// A call is in progress — ringing, connecting or connected. Deliberately
    /// false for `.ended`: that phase is a two-second epitaph, and treating it as
    /// live is how a teardown re-enters itself.
    var hasLiveCall: Bool {
        switch phase {
        case .outgoing, .incoming, .active: return true
        case .idle, .ended: return false
        }
    }

    /// Something call-related belongs on screen, including the "Call ended" card.
    var isPresentingCall: Bool {
        if case .idle = phase { return false }
        return true
    }

    /// Who the call is *with*, for the big label.
    var peerName: String {
        if isGroupCall {
            if case .outgoing(let signal) = phase, let name = signal.groupName, !name.isEmpty { return name }
            if case .incoming(let signal) = phase, let name = signal.groupName, !name.isEmpty { return name }
            if let id = conversationID, let conversation = chat?.conversation(id: id) {
                return chat?.title(for: conversation) ?? "Group call"
            }
            return "Group call"
        }
        switch phase {
        case .outgoing(let signal), .incoming(let signal):
            if let caller = signal.caller { return caller.displayName }
        case .active:
            if let first = participants.first { return first.displayName }
        default:
            break
        }
        return participants.first?.displayName ?? "Call"
    }

    /// On a group call the *initiator's* name, shown under the group name.
    var callerName: String? {
        guard isGroupCall else { return nil }
        switch phase {
        case .outgoing(let signal), .incoming(let signal): return signal.caller?.displayName
        default: return nil
        }
    }

    var peerAvatarPath: String? {
        switch phase {
        case .outgoing(let signal), .incoming(let signal):
            if isGroupCall { return chat?.conversation(id: conversationID ?? "")?.avatarURL }
            return signal.caller?.avatarURL
        case .active:
            return participants.first?.avatarPath
        default:
            return nil
        }
    }

    var conversationID: String? {
        switch phase {
        case .outgoing(let signal), .incoming(let signal): return signal.conversationID
        case .active: return activeConversationID
        default: return nil
        }
    }

    private var activeConversationID: String?

    /// mm:ss, as the web client formats it.
    var elapsedLabel: String { Self.durationLabel(elapsed) }

    static func durationLabel(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        return String(format: "%02d:%02d", total / 60, total % 60)
    }

    // MARK: - Starting a call

    /// Ring one person. Called by the chat header and by call-history callback.
    func startDirectCall(calleeID: String, conversationID: String?, video: Bool) {
        guard let auth else { return }
        guard case .idle = phase else {
            toasts?.show("You're already in a call")
            return
        }
        guard auth.realtime.state == .connected else {
            toasts?.error("No connection. Reconnect and try again.")
            return
        }

        let peer = brief(forUserID: calleeID, in: conversationID)
        // The call id arrives with `call:ringing_started`; until then the phase
        // carries a locally-built signal so the ringing screen has a name to show.
        let signal = CallSignal(
            callID: nil,
            callType: video ? .video : .voice,
            caller: peer,
            conversationID: conversationID,
            calleeID: calleeID,
            isGroup: false,
            groupName: nil,
            accepterID: nil,
            duration: nil,
            reason: nil,
            message: nil,
            participants: nil,
            participant: nil,
            participantID: nil
        )
        beginOutgoing(signal: signal, video: video)
        if let peer { signalled[peer.id] = peer }
        recomputeParticipants()

        auth.realtime.send(
            .callInitiate(calleeID: calleeID, callType: video ? "video" : "voice", conversationID: conversationID)
        )
    }

    /// Start (or, if one is already running, join) a group call.
    func startGroupCall(conversationID: String, video: Bool) {
        guard let auth else { return }
        // Already-running group calls are the common case in a busy group: join
        // rather than refusing, which is what the server's
        // `call:group_already_active` reply steers us to anyway.
        if let existing = activeGroupCalls[conversationID], let callID = existing.callID, case .idle = phase {
            joinGroupCall(callID: callID, conversationID: conversationID, video: video)
            return
        }
        guard case .idle = phase else {
            toasts?.show("You're already in a call")
            return
        }
        guard auth.realtime.state == .connected else {
            toasts?.error("No connection. Reconnect and try again.")
            return
        }

        let conversation = chat?.conversation(id: conversationID)
        let signal = CallSignal(
            callID: nil,
            callType: video ? .video : .voice,
            caller: nil,
            conversationID: conversationID,
            calleeID: nil,
            isGroup: true,
            groupName: conversation.flatMap { chat?.title(for: $0) },
            accepterID: nil,
            duration: nil,
            reason: nil,
            message: nil,
            participants: nil,
            participant: nil,
            participantID: nil
        )
        beginOutgoing(signal: signal, video: video)
        auth.realtime.send(.callGroupInitiate(conversationID: conversationID, callType: video ? "video" : "voice"))
    }

    /// Join a group call that is already in progress.
    func joinGroupCall(callID: String, conversationID: String, video: Bool) {
        guard let auth, auth.realtime.state == .connected else {
            toasts?.error("No connection. Reconnect and try again.")
            return
        }
        let conversation = chat?.conversation(id: conversationID)
        let signal = CallSignal(
            callID: callID,
            callType: video ? .video : .voice,
            caller: nil,
            conversationID: conversationID,
            calleeID: nil,
            isGroup: true,
            groupName: conversation.flatMap { chat?.title(for: $0) },
            accepterID: nil,
            duration: nil,
            reason: nil,
            message: nil,
            participants: nil,
            participant: nil,
            participantID: nil
        )
        phase = .incoming(signal)
        isConnecting = true
        resetMediaFlags(video: video)
        activeConversationID = conversationID
        // The server answers `call:group_participants`, which is where the LiveKit
        // join happens — that frame is its confirmation the join was accepted.
        auth.realtime.send(.callJoin(callID: callID))
    }

    /// Pull more people into the group call this device is in.
    ///
    /// `names` is only for the messages: the server answers with a per-invitee outcome
    /// keyed by user id, and "Priya is already on the call" is worth far more to whoever
    /// pressed Add than a bare failure would be.
    func invite(userIDs: [String], names: [String: String] = [:]) async {
        guard let callID = currentCallID else {
            toasts?.error("Could not add anyone — the call id is missing")
            return
        }
        guard isGroupCall else {
            // The server refuses this by design: adding a third party to a 1:1 would
            // silently change what two people agreed to be in.
            toasts?.show("People can only be added to a group call")
            return
        }
        guard !userIDs.isEmpty else { return }
        do {
            let result = try await RxHiveAPI.inviteToCall(callID: callID, userIDs: userIDs)
            // Optimistic placeholders for the ones actually rung. The server also sends
            // `call:participants_invited` to everyone in the call including us, so this
            // only wins the race — `addPendingInvitees` drops the duplicates.
            let rung = result.invited.map {
                CallParticipantBrief(id: $0, displayName: names[$0] ?? "Invited", avatarURL: nil)
            }
            addPendingInvitees(rung)
            if !rung.isEmpty {
                toasts?.show(rung.count == 1 ? "Ringing them now" : "Ringing \(rung.count) people now")
            }
            // Anything that did NOT go through is named. See CallInviteResult.message.
            var refused = false
            for (id, outcome) in result.outcome {
                guard let message = CallInviteResult.message(for: outcome, who: names[id] ?? "That person")
                else { continue }
                refused = true
                toasts?.show(message)
            }
            if rung.isEmpty && !refused { toasts?.show("Nobody was added") }
        } catch {
            log.error("Invite failed: \(String(describing: error), privacy: .public)")
            toasts?.error("Could not add anyone to the call")
        }
    }

    /// Call back from history.
    func callBack(_ entry: CallHistoryEntry) {
        let video = entry.callType == .video
        if entry.isGroup, let conversationID = entry.conversationID {
            startGroupCall(conversationID: conversationID, video: video)
            return
        }
        guard let other = entry.otherParticipant else {
            toasts?.show("No one left to call back")
            return
        }
        startDirectCall(calleeID: other.userId, conversationID: entry.conversationID, video: video)
    }

    private func beginOutgoing(signal: CallSignal, video: Bool) {
        autoResetTask?.cancel()
        phase = .outgoing(signal)
        awaitingCallID = signal.callID == nil
        isConnecting = false
        isMinimised = false
        elapsed = 0
        startedAt = nil
        activeConversationID = signal.conversationID
        signalled = [:]
        signalledMedia = [:]
        participants = []
        resetMediaFlags(video: video)
    }

    /// Speaker defaults on for video and off for voice: a video call is held away
    /// from the face, a voice call against the ear. The web client has no earpiece
    /// to choose between, which is why it simply defaults to on.
    private func resetMediaFlags(video: Bool) {
        isMuted = false
        isCameraOn = video
        isSpeakerOn = video
    }

    // MARK: - Answering / ending

    func accept() {
        guard case .incoming(let signal) = phase, let auth, let callID = signal.callID else { return }
        // A tap that cannot be delivered must say so rather than starting a
        // "Connecting…" that will never finish. `RealtimeClient.send` drops frames when
        // the socket is down; this is the one place where that silence is intolerable,
        // because the user has just committed to the call.
        guard auth.realtime.state == .connected else {
            toasts?.error("No connection — reconnecting. Try answering again in a moment.")
            auth.realtime.connect()
            return
        }
        isConnecting = true
        // This device is the one answering, so this device is the one that may enter
        // the SFU room — see `callAccepted` for why only one device per user can.
        acceptedLocallyCallID = callID
        // Group calls are joined, direct calls accepted. Either way the LiveKit join
        // waits for the server's confirmation (`call:accepted` /
        // `call:group_participants`) — joining the room before the call row moves to
        // `connected` gets the token request rejected with 400.
        if signal.isGroup == true {
            auth.realtime.send(.callJoin(callID: callID))
        } else {
            auth.realtime.send(.callAccept(callID: callID))
        }
        armAcceptTimeout(callID: callID)
    }

    /// Bound how long "Connecting…" may sit there after an Accept. See `acceptTimeout`.
    private func armAcceptTimeout(callID: String) {
        acceptTimeoutTask?.cancel()
        acceptTimeoutTask = Task { [weak self] in
            try? await Task.sleep(for: Self.acceptTimeout)
            guard let self, !Task.isCancelled else { return }
            guard self.currentCallID == callID else { return }
            if case .active = self.phase { return }
            self.log.error("Accept timed out with no connection: \(callID, privacy: .public)")
            self.toasts?.error("Could not connect the call. Check your connection and try again.")
            self.auth?.realtime.send(.callEnd(callID: callID))
            self.reportEnded(callID: callID)
            await self.teardown(to: .ended)
        }
    }

    private func clearAcceptTimeout() {
        acceptTimeoutTask?.cancel()
        acceptTimeoutTask = nil
    }

    /// Turn connectivity state into words, exactly once per transition.
    ///
    /// Edge-triggered and throttled on purpose: LiveKit re-grades the connection every
    /// couple of seconds, so a naive "tell the user whenever it is poor" would paper the
    /// screen with the same toast during precisely the moment they need to read one.
    private func announceConnectivity() {
        guard hasLiveCall else {
            announcedStall = false
            lastQualityToastAt = nil
            return
        }
        if isStalled {
            if !announcedStall {
                announcedStall = true
                toasts?.warning("Connection lost — reconnecting…")
            }
            return
        }
        if announcedStall {
            announcedStall = false
            toasts?.success("Connection restored")
            return
        }
        guard isQualityPoor else { return }
        let now = Date()
        if let last = lastQualityToastAt, now.timeIntervalSince(last) < Self.qualityToastCooldown {
            return
        }
        lastQualityToastAt = now
        toasts?.warning("Poor internet connection")
    }

    func decline() {
        guard case .incoming(let signal) = phase else { return }
        if let callID = signal.callID {
            auth?.realtime.send(.callDecline(callID: callID))
        }
        Task { await teardown(to: .idle) }
    }

    /// The red button. What it means depends on where the call is, exactly as
    /// `services/calls.py` expects: cancel while ringing as the caller, end
    /// otherwise (the server turns an ordinary participant's `call:end` in a group
    /// call into a leave, so there is no separate leave button).
    func hangUp() {
        let callID = currentCallID
        switch phase {
        case .outgoing:
            if let callID { auth?.realtime.send(.callCancel(callID: callID)) }
            Task { await teardown(to: .idle) }

        case .incoming where !isConnecting:
            decline()

        case .incoming, .active:
            if let callID {
                auth?.realtime.send(.callEnd(callID: callID))
                reportEnded(callID: callID)
            }
            Task { await teardown(to: .ended) }

        case .idle, .ended:
            break
        }
    }

    /// Belt and braces on the way out of a call.
    ///
    /// `POST /api/calls/ended` runs the same `call:end` handler as the socket frame,
    /// and is idempotent (the service ignores a call that is no longer ringing or
    /// connected). Sending both means a socket that died between the user tapping
    /// hang-up and the frame going out still cannot leave the call row marked
    /// connected forever.
    private func reportEnded(callID: String) {
        guard let userID = auth?.currentUser?.id else { return }
        Task {
            do {
                try await RxHiveAPI.reportCallEnded(callID: callID, userID: userID)
            } catch {
                log.notice("reportCallEnded failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    // MARK: - Controls

    func toggleMute() {
        let enable = isMuted        // flipping the mute flag = the new mic state
        isMuted = !isMuted          // optimistic; pullSessionState corrects it
        Task {
            await session.setMicrophone(enabled: enable)
            if let callID = currentCallID {
                auth?.realtime.send(.callToggleMedia(callID: callID, mediaType: "audio", enabled: enable))
            }
        }
    }

    /// Camera on/off, without disturbing anything else in the call.
    ///
    /// Three things this has to get right:
    ///
    /// **Immediate feedback.** `isCameraOn` moves first, before any awaiting: reopening a
    /// capture device takes long enough that a button which waits for it reads as broken
    /// and gets tapped again. If the operation fails, `setCamera` re-derives the flag
    /// from what is actually published and `pullSessionState` copies it back, so the
    /// button corrects itself rather than lying.
    ///
    /// **Rapid taps.** The work is chained onto `cameraTask` rather than spawned
    /// independently. The SDK serialises its own publish operations, but not *ours*:
    /// two loose Tasks could finish in either order, and each one sends a
    /// `call:toggle_media` frame, so the far side could be left with the state from the
    /// earlier tap. Chaining makes the last tap the last writer.
    ///
    /// **The camera the user chose.** The position is read before turning the camera off
    /// and handed back when turning it on, for the case where the SDK has to build a
    /// fresh track instead of unmuting one — see `LiveKitSession.setCamera`.
    func toggleCamera() {
        let enable = !isCameraOn
        isCameraOn = enable
        if !enable, let position = session.cameraPosition {
            lastCameraPosition = position
        }
        let position = lastCameraPosition
        let previous = cameraTask
        cameraTask = Task { [weak self] in
            _ = await previous?.result
            guard let self else { return }
            let reached = await self.session.setCamera(enabled: enable, position: position)
            // The state actually REACHED, not the one asked for: telling the peers the
            // camera came on when it did not leaves them waiting for video that will
            // never arrive.
            if let callID = self.currentCallID {
                self.auth?.realtime.send(
                    .callToggleMedia(callID: callID, mediaType: "video", enabled: reached)
                )
            }
        }
    }

    func toggleSpeaker() {
        isSpeakerOn.toggle()
        session.setSpeaker(on: isSpeakerOn)
    }

    func flipCamera() {
        Task { [weak self] in
            guard let self else { return }
            await self.session.flipCamera()
            // Remembered here as well as on the way off, so a flip followed by
            // camera-off / camera-on comes back on the camera the user last chose
            // rather than the platform default.
            if let position = self.session.cameraPosition { self.lastCameraPosition = position }
        }
    }

    func minimise() { isMinimised = true }
    func restore() { isMinimised = false }

    // MARK: - Missed-call badge

    func loadMissedCount() async {
        do {
            missedCallCount = try await RxHiveAPI.missedCallCount()
        } catch {
            log.notice("Missed count failed: \(String(describing: error), privacy: .public)")
        }
    }

    /// Clears the badge. Called when the Calls tab appears.
    func markCallsSeen() async {
        do {
            try await RxHiveAPI.markCallsSeen()
            missedCallCount = 0
        } catch {
            log.notice("markCallsSeen failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Realtime

    private func handle(_ event: RealtimeEvent) async {
        switch event {
        case .connected:
            // Handled by `realtime.onReconnected`, which reconciles the whole call state
            // rather than only the badge. Kept as an explicit no-op so it is clear the
            // case is covered and not simply forgotten.
            break

        case .callResume(let state):
            // The server's own picture of a call we may have missed frames for. Routed
            // through the same `adopt` as the REST reconcile so there is one decision
            // table for "what should be on screen", not two that can disagree.
            await adopt(state)

        case let .callPeerState(callID, userID, state, quality):
            guard callID == nil || callID == currentCallID, let userID else { return }
            if let state {
                peerLinks[userID] = (state == "reconnecting") ? .reconnecting : .connected
            }
            if let quality { peerQualities[userID] = quality }
            announceConnectivity()

        case .callIncoming(let signal):
            handleIncoming(signal)

        case .callRingingStarted(let signal):
            // The initiator learns the call id here, which is what makes cancelling
            // a still-ringing call possible.
            guard case .outgoing(let current) = phase, awaitingCallID, let callID = signal.callID else { return }
            awaitingCallID = false
            phase = .outgoing(current.withCallID(callID))

        case .callAccepted(let signal):
            // Published to *both* sides: the caller learns who answered, the
            // accepter gets confirmation the row moved to connected. Both join here.
            guard hasLiveCall else { return }
            let callID = signal.callID ?? currentCallID
            guard let callID else { return }

            // Answered on one of this user's OTHER devices: stop ringing, do not join.
            //
            // The frame goes to every socket the accepting user holds, and every device
            // of a user shares one LiveKit identity (`mint_token`), so a second device
            // entering the room evicts the first. `hasLiveCall` is true while merely
            // `.incoming`, so this phone used to join a call it had not answered and
            // silently knocked the answering client — reliably the browser, which
            // connects before taking the microphone while this app takes it first — out
            // of the room with no error shown anywhere.
            if let accepterID = signal.accepterID,
               accepterID == auth?.currentUser?.id,
               acceptedLocallyCallID != callID {
                log.notice("Call answered on another device; dismissing the ringer")
                await teardown(to: .idle)
                return
            }
            if let accepterID = signal.accepterID,
               accepterID != auth?.currentUser?.id,
               let brief = brief(forUserID: accepterID, in: conversationID) {
                signalled[accepterID] = brief
            }
            // Already in this room — a duplicate `call:accepted` (both sides get one,
            // the server replays it for a retried Accept, and a reconnect can
            // re-deliver it). Re-joining would tear down working media.
            if session.callID == callID, case .active = phase {
                clearAcceptTimeout()
                return
            }
            isConnecting = true
            await join(callID: callID)

        case .callGroupStarted(let signal):
            // Initiator only. The room already exists — the server created the call
            // row as `connected`.
            guard hasLiveCall, let callID = signal.callID ?? currentCallID else { return }
            isConnecting = true
            await join(callID: callID)

        case .callGroupParticipants(let signal):
            // Addressed to the joiner, and the server's confirmation that the join
            // was accepted. `call:group_started` only reaches the initiator, so a
            // joiner that waited for that stayed silent forever.
            guard hasLiveCall, let callID = signal.callID ?? currentCallID else { return }
            for brief in signal.participants ?? [] { signalled[brief.id] = brief }
            recomputeParticipants()
            isConnecting = true
            await join(callID: callID)

        case .callGroupAlreadyActive(let signal):
            guard let conversationID = signal.conversationID, let callID = signal.callID else { return }
            activeGroupCalls[conversationID] = signal
            // We asked to start a call in a group that already has one. Join it
            // instead of leaving the user staring at a dead ringing screen.
            if case .outgoing(let current) = phase, current.conversationID == conversationID {
                joinGroupCall(callID: callID, conversationID: conversationID, video: current.callType == .video)
            }

        case .callGroupActive(let signal):
            guard let conversationID = signal.conversationID else { return }
            activeGroupCalls[conversationID] = signal

        case .callParticipantsInvited(let signal):
            guard signal.callID == nil || signal.callID == currentCallID, hasLiveCall else { return }
            addPendingInvitees(signal.participants ?? [])

        case .callParticipantDeclined(let signal):
            guard signal.callID == nil || signal.callID == currentCallID, hasLiveCall else { return }
            if let id = signal.participantID ?? signal.participant?.id {
                pendingInvitees.removeAll { $0.id == id }
                // They are not coming, so stop expecting them in the roster either.
                signalled[id] = nil
                recomputeParticipants()
            }
            if let name = signal.participant?.displayName {
                toasts?.show("\(name) declined the call")
            } else {
                toasts?.show("Someone declined the call")
            }

        case .callGroupEnded(let signal):
            if let conversationID = signal.conversationID { activeGroupCalls[conversationID] = nil }
            guard terminalFrameIsOurs(signal) else { return }
            await teardown(to: .ended)

        // Every terminal frame below is correlated to the call we are holding
        // before anything is torn down — `terminalFrameIsOurs` is the whole rule,
        // including why our own not-yet-identified outgoing ring is the one case
        // that cannot match on an id. Each of these frames always carried a
        // CallSignal, so reading it is closing an omission rather than adding a
        // capability.
        //
        // Two distinct failures come from getting this wrong. A frame naming a
        // *different* live call ends the call the user is actually on — a delayed
        // `call:cancelled` for a ring that is already over arriving mid-call was
        // enough, because that branch ignored its signal outright.
        //
        // And a frame arriving while *idle* tore the store down to `.ended` —
        // which is only ever cleared by the auto-reset that teardown schedules
        // *when a call was live*, so it stuck permanently behind a full-screen
        // overlay that hangUp() cannot dismiss (it is a no-op in `.ended`) and
        // the reconnect reconcile does not clear (it only acts `if hasLiveCall`).
        // Only a force-quit recovered it. Two ways in, both ordinary: signed in
        // on web and phone, the backend publishes call:ended to the user's
        // channel so every socket that user holds gets it, including the idle
        // phone; and on one device the peer sends both the socket frame and the
        // REST call, so call:ended arrives twice — the first while `.active` arms
        // the 2s reset, the second lands inside that window and cancels it for
        // good.
        //
        // `resolvedTerminal` in teardown is the backstop for the idle case if a
        // future caller skips this guard; it cannot catch the wrong-call case,
        // and it cannot stop the spurious toast either.
        case .callDeclined(let signal):
            guard terminalFrameIsOurs(signal) else { return }
            toasts?.show("Call declined")
            await teardown(to: .ended)

        case .callEnded(let signal):
            guard terminalFrameIsOurs(signal) else { return }
            await teardown(to: .ended)

        case .callCancelled(let signal):
            // The caller gave up; nothing to say beyond removing the ring.
            guard terminalFrameIsOurs(signal) else { return }
            await teardown(to: .idle)

        case .callBusy(let signal):
            guard terminalFrameIsOurs(signal) else { return }
            toasts?.show("They're on another call")
            await teardown(to: .ended)

        case .callUnavailable(let signal):
            guard terminalFrameIsOurs(signal) else { return }
            toasts?.show("They're unavailable right now")
            await teardown(to: .ended)

        case .callMissed(let signal):
            // Both sides get this frame. Only the callee's copy carries `caller`,
            // which is how the badge knows whose miss it was. The badge counts the
            // miss whether or not this device held the call — an idle second device
            // of the same user must still show it — but only the device that held
            // the call has a ring screen to clear.
            if signal.caller != nil { missedCallCount += 1 }
            guard terminalFrameIsOurs(signal) else { return }
            await teardown(to: .idle)

        case .callFull(let signal):
            // A refusal of *a* join attempt, addressed to the user rather than to
            // the device that attempted it, so a second device — possibly one in
            // another call — sees it too. Only the caller of the join owns it.
            guard terminalFrameIsOurs(signal) else { return }
            toasts?.error(signal.message ?? "That call is full")
            await teardown(to: .idle)

        case .callError(let detail):
            toasts?.error(detail.isEmpty ? "Call failed" : detail)
            await teardown(to: .idle)

        case .callParticipantJoined(let signal):
            guard let brief = signal.participant else { return }
            signalled[brief.id] = brief
            recomputeParticipants()

        case .callParticipantLeft(let signal):
            guard let id = signal.participantID else { return }
            signalled[id] = nil
            signalledMedia[id] = nil
            recomputeParticipants()

        case let .callMediaToggle(callID, userID, mediaType, enabled):
            guard callID == nil || callID == currentCallID, let userID else { return }
            var entry = signalledMedia[userID] ?? (muted: nil, cameraOff: nil)
            if mediaType == "audio" { entry.muted = !enabled } else { entry.cameraOff = !enabled }
            signalledMedia[userID] = entry
            recomputeParticipants()

        default:
            // Everything else is ChatStore's business.
            break
        }
    }

    private func handleIncoming(_ signal: CallSignal) {
        // Idempotent by call id. The server replays `call:incoming` when a socket comes
        // back (`replay_pending_ring`), and the same ring arriving twice must not restart
        // the ringer or clear a call already being answered.
        if let callID = signal.callID, currentCallID == callID, hasLiveCall { return }
        guard case .idle = phase else {
            // Already busy. The server refuses a *direct* call to someone with a
            // live call, so this is either a group ring or a race; declining a
            // direct one keeps the caller from ringing out to a 30-second timeout.
            if signal.isGroup != true, let callID = signal.callID {
                auth?.realtime.send(.callDecline(callID: callID))
            }
            return
        }
        autoResetTask?.cancel()
        phase = .incoming(signal)
        isConnecting = false
        isMinimised = false
        elapsed = 0
        startedAt = nil
        activeConversationID = signal.conversationID
        signalled = [:]
        signalledMedia = [:]
        participants = []
        resetMediaFlags(video: signal.callType == .video)
        if let caller = signal.caller {
            signalled[caller.id] = caller
            recomputeParticipants()
        }
    }

    // MARK: - Joining the room

    private func join(callID: String) async {
        // A second `call:accepted` (both sides get one, and a reconnect can replay
        // it) must not tear down a room we are already in.
        if session.callID == callID, case .active = phase { return }

        // Disarm the accept watchdog HERE, at the start of the join — not after it
        // finishes.
        //
        // It was cleared only once `session.join` had fully returned, which put the
        // token round trip, the microphone permission, `room.connect` and the mic/camera
        // publish all inside its 20-second budget. A join that was merely SLOW — a real
        // network, mDNS resolution, an audio route negotiating on device — therefore
        // tripped a watchdog meant for a join that never started, and the handler sends
        // `call:end` to the peer. The join then carried on in its own task and
        // succeeded, so this device showed "connected" while the other side had already
        // been told the call was over. That is the whole of "the phone connects and the
        // web never does".
        //
        // What the watchdog is actually for is the SIGNALLING gap: Accept was sent and
        // the server never answered. Once `call:accepted` has arrived and we are
        // joining, that gap is closed and the join owns its own failures — `failJoin`
        // already reports each one with a specific reason, and `room.connect` has its
        // own timeout. A second, blinder deadline on top of that can only do harm.
        clearAcceptTimeout()

        let wantVideo = isVideoCall
        let token: CallToken
        do {
            token = try await RxHiveAPI.callToken(callID: callID, deviceID: Self.deviceID)
        } catch let error as APIError {
            // 404/400 both mean "that call is not joinable", which is a different
            // sentence from "we could not authorise the call".
            let reason: CallJoinFailure
            switch error {
            case .notFound, .validation: reason = .callUnavailable
            default: reason = .tokenFailed
            }
            await failJoin(reason, callID: callID, underlying: error)
            return
        } catch {
            await failJoin(.tokenFailed, callID: callID, underlying: error)
            return
        }

        do {
            let outcome = try await session.join(
                callID: callID,
                token: token,
                wantVideo: wantVideo,
                speaker: isSpeakerOn
            )
            if outcome.cameraUnavailable {
                isCameraOn = false
                toasts?.warning((outcome.cameraFailure ?? .mediaFailed).cameraFallbackMessage)
            }
            enterActive(callID: callID, room: token.room)
        } catch let error as CallJoinError {
            log.error("Join failed (\(error.reason.rawValue, privacy: .public)): \(error.detail, privacy: .public)")
            await failJoin(error.reason, callID: callID, underlying: error.underlying)
        } catch {
            await failJoin(.unknown, callID: callID, underlying: error)
        }
    }

    private func failJoin(_ reason: CallJoinFailure, callID: String, underlying: Error?) async {
        toasts?.error(reason.userMessage)
        if let underlying {
            log.error("Join cause: \(String(describing: underlying), privacy: .public)")
        }
        // Tell the other side rather than leaving them listening to silence.
        auth?.realtime.send(.callEnd(callID: callID))
        reportEnded(callID: callID)
        await teardown(to: .ended)
    }

    private func enterActive(callID: String, room: String) {
        // `callType` and `isGroupCall` read the *current* phase, so this must be
        // built before the phase is replaced.
        let callSession = CallSession(
            id: callID,
            type: callType,
            isGroup: isGroupCall,
            room: room,
            participants: Array(signalled.values)
        )
        let wasActive: Bool
        if case .active(let existing) = phase, existing.id == callID { wasActive = true } else { wasActive = false }
        phase = .active(callSession)
        isConnecting = false
        // A re-join keeps the original clock. Restarting it made a call that had just
        // survived a dead spot look as if it had only now begun, which is both wrong and
        // the opposite of reassuring.
        if !wasActive || startedAt == nil {
            startedAt = Date()
            elapsed = 0
        }
        startTimer()
        pullSessionState()
    }

    private func startTimer() {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled, let startedAt = self.startedAt else { return }
                self.elapsed = Date().timeIntervalSince(startedAt)
            }
        }
    }

    // MARK: - Session mirroring

    /// Copy the room's view of the world into published state.
    ///
    /// Media flags are only mirrored while the call is actually connected: there is
    /// no room before that and none during teardown, and mirroring "no microphone
    /// published" into `isMuted` would show a ringing call as muted.
    private func pullSessionState() {
        guard case .active = phase else {
            recomputeParticipants()
            return
        }
        // Mid-reconnect the room's publications are not a truthful account of what the
        // user has chosen: the SDK has torn the session down and not yet rebuilt it, so
        // mirroring it would flip the mute and camera buttons on their own and then flip
        // them back. Hold the last known state until the link is back.
        if session.mediaLink == .connected {
            isMuted = !session.isMicEnabled
            if isVideoCall { isCameraOn = session.isCameraEnabled }
        }
        mediaLink = session.mediaLink
        localVideoTrack = session.localVideoTrack
        networkQuality = session.networkQuality
        recomputeParticipants()
    }

    /// Merge the room roster with what the socket said.
    ///
    /// The room wins on everything it knows, because it is the only source that
    /// actually observes media. The socket contributes two things the room cannot:
    /// avatar paths (LiveKit carries an identity and a name, nothing else), and
    /// people who are in the call row but have not published to the SFU yet — a
    /// group member mid-join, who should be a placeholder tile rather than absent.
    private func recomputeParticipants() {
        let me = auth?.currentUser?.id
        var merged: [CallParticipantState] = []
        var seen = Set<String>()

        for roomState in session.remoteParticipants {
            var state = roomState
            seen.insert(state.id)
            if let brief = signalled[state.id] {
                // LiveKit only carries an identity and a name; the avatar can only
                // come from the socket's brief.
                if state.displayName == state.id { state.displayName = brief.displayName }
                state.avatarPath = brief.avatarURL
            }
            merged.append(state)
        }

        for (id, brief) in signalled where !seen.contains(id) && id != me {
            let media = signalledMedia[id]
            merged.append(
                CallParticipantState(
                    id: id,
                    displayName: brief.displayName,
                    avatarPath: brief.avatarURL,
                    isMuted: media?.muted ?? true,
                    isCameraOff: media?.cameraOff ?? true,
                    isSpeaking: false,
                    videoTrack: nil,
                    isScreenShare: false,
                    hasMedia: false
                )
            )
        }

        // Sorted by name so tiles do not reshuffle every time the roster is rebuilt.
        participants = merged.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }

        // Arriving retires the "ringing" placeholder. Done here rather than in the
        // event handler so it holds for every route a participant can appear by — the
        // socket frame, the room roster, and a resume after a reconnect.
        if !pendingInvitees.isEmpty {
            let present = Set(participants.map(\.id))
            pendingInvitees.removeAll { present.contains($0.id) }
        }
    }

    /// Record people who have just been invited, so the grid can show them ringing.
    ///
    /// Anyone already on the call is dropped: the server reports an invite of somebody
    /// present as `already_invited` and adds nobody, and a phantom "Ringing…" tile for a
    /// participant who is visibly in the call is worse than no tile at all.
    func addPendingInvitees(_ people: [CallParticipantBrief]) {
        guard !people.isEmpty else { return }
        var known = Set(participants.map(\.id))
        known.formUnion(pendingInvitees.map(\.id))
        if let me = auth?.currentUser?.id { known.insert(me) }
        // `known` grows as we go, so a name repeated WITHIN one batch is caught too —
        // filtering against a fixed set let `[dave, dave]` through as two tiles.
        var fresh: [CallParticipantBrief] = []
        for person in people where known.insert(person.id).inserted {
            fresh.append(person)
        }
        guard !fresh.isEmpty else { return }
        pendingInvitees.append(contentsOf: fresh)
    }

    /// The room is gone for good.
    ///
    /// Only reached after `LiveKitSession` has spent its whole re-join budget, so by the
    /// time this runs the SFU really is unreachable. It used to fire on the FIRST
    /// disconnect, which is why a tunnel, a lift, or an SFU restart during a deploy ended
    /// the call outright with no attempt to recover it.
    private func handleRoomLost() {
        guard hasLiveCall else { return }
        log.notice("Room lost after exhausting rejoin attempts; ending call")
        toasts?.error("Call disconnected")
        if let callID = currentCallID {
            auth?.realtime.send(.callEnd(callID: callID))
            reportEnded(callID: callID)
        }
        Task { await teardown(to: .ended) }
    }

    // MARK: - Teardown

    /// Where a teardown should actually leave `phase`.
    ///
    /// `.ended` is a *held* state: the only thing that ever clears it is the
    /// auto-reset task below, and that task is scheduled only when a call was
    /// live. Tearing down to `.ended` with nothing live therefore parked the
    /// store in `.ended` permanently — and CallOverlayHost renders `.ended`
    /// full-screen, so the app sat behind an undismissable "Call ended" card
    /// with no call and no way out but a relaunch.
    ///
    /// A single stray frame was enough: `.callEnded`, `.callDeclined`,
    /// `.callBusy` and `.callUnavailable` all tore down unconditionally, unlike
    /// `.callGroupEnded`, which already guarded on `hasLiveCall`. A late frame
    /// for a call that had just been dismissed, or one re-delivered on socket
    /// resume, arrives while idle by definition.
    ///
    /// Whether a terminal frame is about the call this store is holding.
    ///
    /// Every terminal frame the server sends — `call:ended`, `:declined`,
    /// `:cancelled`, `:busy`, `:unavailable`, `:group_ended` — carries a
    /// `call_id`, so a frame that names another call, or names none at all, must
    /// never tear a call down. Stale ones are ordinary rather than exotic:
    /// `publish_to_users` addresses a *user*, so every socket that user holds
    /// sees a peer's hang-up, including a device that has already moved on to the
    /// next call; and a hang-up arrives twice (socket frame plus REST), so the
    /// second copy lands after the first has been acted on.
    ///
    /// One case has nothing to compare against: our own outgoing ring, in the
    /// window between pressing call and `call:ringing_started` bringing the id
    /// back. That window is not hypothetical — `initiate_direct_call` answers
    /// `call:busy` *instead of* `ringing_started` when the callee is already on a
    /// call, so demanding a match there drops the only frame that will ever come
    /// and leaves the caller ringing at nobody until the 45-second timeout. A
    /// frame naming a call we have already held is stale by definition; anything
    /// else is the ring we are waiting on an id for, since this store holds one
    /// call at a time.
    ///
    /// Static and non-private for the same reason as `resolvedTerminal` below:
    /// testable without a seam into the private socket-event path.
    static func terminalFrameIsOurs(
        frameCallID: String?,
        currentCallID: String?,
        awaitingCallID: Bool,
        hasLiveCall: Bool,
        seenCallIDs: [String]
    ) -> Bool {
        guard hasLiveCall else { return false }
        if let currentCallID { return frameCallID == currentCallID }
        guard awaitingCallID, let frameCallID else { return false }
        return !seenCallIDs.contains(frameCallID)
    }

    private func terminalFrameIsOurs(_ signal: CallSignal) -> Bool {
        Self.terminalFrameIsOurs(
            frameCallID: signal.callID,
            currentCallID: currentCallID,
            awaitingCallID: awaitingCallID,
            hasLiveCall: hasLiveCall,
            seenCallIDs: seenCallIDs
        )
    }

    /// Static and non-private so the invariant can be tested without a seam into
    /// the private socket-event path.
    static func resolvedTerminal(_ terminal: Phase, wasLive: Bool) -> Phase {
        if case .ended = terminal, !wasLive { return .idle }
        return terminal
    }

    private func teardown(to terminal: Phase) async {
        timerTask?.cancel()
        timerTask = nil
        autoResetTask?.cancel()
        clearAcceptTimeout()

        // Detach the callbacks' effect first: leaving the room fires
        // `onRoomLost`/`onStateChanged`, and handling those mid-teardown would
        // recurse straight back into here.
        let wasLive = hasLiveCall
        phase = Self.resolvedTerminal(terminal, wasLive: wasLive)
        isConnecting = false
        await session.leave()

        signalled = [:]
        signalledMedia = [:]
        participants = []
        pendingInvitees = []
        localVideoTrack = nil
        networkQuality = .unknown
        startedAt = nil
        awaitingCallID = false
        acceptedLocallyCallID = nil
        activeConversationID = nil
        mediaLink = .connected
        peerLinks = [:]
        peerQualities = [:]
        announcedStall = false
        lastQualityToastAt = nil

        if case .ended = terminal, wasLive {
            // Hold "Call ended" on screen briefly, as the web client does, then
            // clear. 2 seconds is long enough to read and short enough not to be in
            // the way.
            autoResetTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                if case .ended = self.phase {
                    self.phase = .idle
                    self.isMinimised = false
                    self.elapsed = 0
                }
            }
        } else {
            isMinimised = false
            elapsed = 0
        }
    }

    // MARK: - Helpers

    /// Look up a name and avatar for a user id from conversation state.
    ///
    /// There is no `GET /api/users/{id}`, so the conversation participant lists are
    /// the only directory the app has loaded. Returning nil is fine: the ring screen
    /// falls back to the initial-disc placeholder and LiveKit supplies a name once
    /// the room connects.
    private func brief(forUserID userID: String, in conversationID: String?) -> CallParticipantBrief? {
        guard let chat else { return nil }
        if let conversationID,
           let conversation = chat.conversation(id: conversationID),
           let participant = conversation.participants.first(where: { $0.userId == userID }) {
            return CallParticipantBrief(
                id: participant.userId,
                displayName: participant.displayName,
                avatarURL: participant.avatarURL
            )
        }
        for conversation in chat.conversations {
            if let participant = conversation.participants.first(where: { $0.userId == userID }) {
                return CallParticipantBrief(
                    id: participant.userId,
                    displayName: participant.displayName,
                    avatarURL: participant.avatarURL
                )
            }
        }
        return nil
    }
}

// MARK: - Signal mutation

private extension CallSignal {
    /// Replace the party this call is *with*.
    ///
    /// `active_call_state.caller` is the call's initiator, which on an outgoing call is
    /// the local user — and the ringing screen renders `caller` as the person on the
    /// other end. Resuming an outgoing ring therefore has to swap in the peer, or the
    /// user is shown their own name and avatar as the callee.
    func withCaller(_ brief: CallParticipantBrief?) -> CallSignal {
        CallSignal(
            callID: callID,
            callType: callType,
            caller: brief,
            conversationID: conversationID,
            calleeID: calleeID,
            isGroup: isGroup,
            groupName: groupName,
            accepterID: accepterID,
            duration: duration,
            reason: reason,
            message: message,
            participants: participants,
            participant: participant,
            participantID: participantID
        )
    }

    /// Fill in the call id the server assigned to a call we started.
    func withCallID(_ id: String) -> CallSignal {
        CallSignal(
            callID: id,
            callType: callType,
            caller: caller,
            conversationID: conversationID,
            calleeID: calleeID,
            isGroup: isGroup,
            groupName: groupName,
            accepterID: accepterID,
            duration: duration,
            reason: reason,
            message: message,
            participants: participants,
            participant: participant,
            participantID: participantID
        )
    }
}
