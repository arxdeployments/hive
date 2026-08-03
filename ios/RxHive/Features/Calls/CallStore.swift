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

    @Published private(set) var phase: Phase = .idle
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

    /// Badge for the Calls tab.
    @Published private(set) var missedCallCount = 0
    /// Group calls in progress, keyed by conversation id, so a conversation can
    /// offer "Join call". Populated from `call:group_active`.
    @Published private(set) var activeGroupCalls: [String: CallSignal] = [:]

    let session = LiveKitSession()

    // MARK: Dependencies

    private weak var auth: AuthStore?
    private weak var chat: ChatStore?
    private weak var toasts: ToastCenter?

    private var eventTask: Task<Void, Never>?
    private var timerTask: Task<Void, Never>?
    private var autoResetTask: Task<Void, Never>?

    /// Participants the socket told us about, keyed by user id. A *supplement* to
    /// the room roster, never a replacement — see `recomputeParticipants()`.
    private var signalled: [String: CallParticipantBrief] = [:]
    /// `call:media_toggle` state for participants with no SFU presence yet.
    private var signalledMedia: [String: (muted: Bool?, cameraOff: Bool?)] = [:]
    /// Set while we are the initiator and the server has not yet told us the call id.
    private var awaitingCallID = false
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
    func attach(auth: AuthStore, chat: ChatStore, toasts: ToastCenter) {
        self.auth = auth
        self.chat = chat
        self.toasts = toasts

        session.onStateChanged = { [weak self] in self?.pullSessionState() }
        session.onRoomLost = { [weak self] in self?.handleRoomLost() }

        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let stream = self?.auth?.realtime.subscribe() else { return }
            for await event in stream {
                await self?.handle(event)
            }
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

    func toggleCamera() {
        let enable = !isCameraOn
        isCameraOn = enable
        Task {
            await session.setCamera(enabled: enable)
            if let callID = currentCallID {
                auth?.realtime.send(.callToggleMedia(callID: callID, mediaType: "video", enabled: enable))
            }
        }
    }

    func toggleSpeaker() {
        isSpeakerOn.toggle()
        session.setSpeaker(on: isSpeakerOn)
    }

    func flipCamera() {
        Task { await session.flipCamera() }
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
            // Events that arrived while the socket was down are gone; the badge is
            // the only call state that can be re-read.
            await loadMissedCount()

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

        case .callGroupEnded(let signal):
            if let conversationID = signal.conversationID { activeGroupCalls[conversationID] = nil }
            guard signal.callID == nil || signal.callID == currentCallID, hasLiveCall else { return }
            await teardown(to: .ended)

        case .callDeclined:
            toasts?.show("Call declined")
            await teardown(to: .ended)

        case .callEnded:
            await teardown(to: .ended)

        case .callCancelled:
            // The caller gave up; nothing to say beyond removing the ring.
            await teardown(to: .idle)

        case .callBusy:
            toasts?.show("They're on another call")
            await teardown(to: .ended)

        case .callUnavailable:
            toasts?.show("They're unavailable right now")
            await teardown(to: .ended)

        case .callMissed(let signal):
            // Both sides get this frame. Only the callee's copy carries `caller`,
            // which is how the badge knows whose miss it was.
            if signal.caller != nil { missedCallCount += 1 }
            await teardown(to: .idle)

        case .callFull(let signal):
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

        let wantVideo = isVideoCall
        let token: CallToken
        do {
            token = try await RxHiveAPI.callToken(callID: callID)
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
        phase = .active(callSession)
        isConnecting = false
        startedAt = Date()
        elapsed = 0
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
        isMuted = !session.isMicEnabled
        if isVideoCall { isCameraOn = session.isCameraEnabled }
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
    }

    /// The room went away underneath us.
    private func handleRoomLost() {
        guard hasLiveCall else { return }
        log.notice("Room lost; ending call")
        if let callID = currentCallID {
            auth?.realtime.send(.callEnd(callID: callID))
            reportEnded(callID: callID)
        }
        Task { await teardown(to: .ended) }
    }

    // MARK: - Teardown

    private func teardown(to terminal: Phase) async {
        timerTask?.cancel()
        timerTask = nil
        autoResetTask?.cancel()

        // Detach the callbacks' effect first: leaving the room fires
        // `onRoomLost`/`onStateChanged`, and handling those mid-teardown would
        // recurse straight back into here.
        let wasLive = hasLiveCall
        phase = terminal
        isConnecting = false
        await session.leave()

        signalled = [:]
        signalledMedia = [:]
        participants = []
        localVideoTrack = nil
        networkQuality = .unknown
        startedAt = nil
        awaitingCallID = false
        acceptedLocallyCallID = nil
        activeConversationID = nil

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
