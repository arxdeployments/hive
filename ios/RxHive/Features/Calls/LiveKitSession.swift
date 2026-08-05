import AVFoundation
import Foundation
import LiveKit
import os
import SwiftUI
import UIKit

// The media layer for calls.
//
// The backend never touches media: `services/calls.py` mints a scoped room token
// and tracks lifecycle, and the SFU carries the audio/video. So this file is the
// whole of "being in a call" — everything else in the feature is signalling and
// chrome.
//
// Written against **LiveKit Swift SDK 2.x**. The v1 API differs in the names used
// below (`setMicrophoneEnabled` vs `setMicrophone(enabled:)`, `identity: String`
// vs `Participant.Identity`), so a downgrade will not silently misbehave — it
// will fail to compile, which is what you want.

// MARK: - Failure vocabulary

/// Why a join failed.
///
/// Transcribed from `frontend/src/services/livekitClient.js`: the two causes that
/// account for nearly every real report of "calls don't work" are a stopped SFU
/// and a blocked microphone, and telling them apart is the entire point of having
/// a reason code rather than one generic error.
enum CallJoinFailure: String, Sendable {
    case sfuUnreachable
    case sfuRejected
    case sfuError
    case permissionDenied
    case deviceMissing
    case deviceBusy
    case mediaFailed
    case callUnavailable
    case tokenFailed
    /// The server handed us a URL a native client cannot dial. See `resolveSFUURL`.
    case badSFUURL
    case unknown
}

struct CallJoinError: Error {
    let reason: CallJoinFailure
    /// Developer-facing detail; never shown to the user.
    let detail: String
    let underlying: Error?

    init(_ reason: CallJoinFailure, _ detail: String, underlying: Error? = nil) {
        self.reason = reason
        self.detail = detail
        self.underlying = underlying
    }
}

/// What a successful join produced. A camera that failed while the microphone
/// worked is *not* a failed join — the call degrades to audio and says so.
struct CallJoinOutcome {
    let cameraUnavailable: Bool
    let cameraFailure: CallJoinFailure?
}

// MARK: - Value types the UI renders

/// The call the user is currently in.
struct CallSession: Identifiable, Equatable {
    let id: String
    let type: CallType
    let isGroup: Bool
    /// The SFU room name (`call_<uuid>`), as minted by `services/calls.py:room_name_for`.
    let room: String
    /// Everyone the signalling layer told us about. The *authoritative* live roster
    /// is `LiveKitSession.remoteParticipants` — see the note on `syncFromRoom()`.
    var participants: [CallParticipantBrief]
}

/// One remote participant, flattened for rendering.
struct CallParticipantState: Identifiable {
    let id: String
    var displayName: String
    var avatarPath: String?
    var isMuted: Bool
    var isCameraOff: Bool
    var isSpeaking: Bool
    var videoTrack: VideoTrack?
    /// True when the tile is showing a screen share rather than a camera.
    var isScreenShare: Bool
    /// False for someone the socket says is in the call but who has no SFU
    /// presence yet — they get a placeholder tile rather than being invisible.
    var hasMedia: Bool
}

/// Local connection quality, mapped off LiveKit's own enum so the views never
/// import a media type just to colour a dot.
enum CallNetworkQuality {
    case excellent, good, poor, unknown

    /// The wire value for `call:link_state`, so the peer can render the same grade.
    var wireValue: String {
        switch self {
        case .excellent: return "excellent"
        case .good: return "good"
        case .poor: return "poor"
        case .unknown: return "unknown"
        }
    }
}

/// Where the media session is, as the UI needs to describe it.
///
/// Distinct from "is there a call": a call whose room is `.reconnecting` is very much
/// still a call — the SFU is re-establishing the session and audio usually resumes
/// within a second or two. Treating that as a hang-up (which this used to, via
/// `onRoomLost`) is what turned every tunnel, lift and Wi-Fi handover into a dropped
/// call.
enum CallMediaLink {
    case connected
    case reconnecting

    /// The wire value for `call:link_state`. Matches the server's vocabulary in
    /// `services/calls._PEER_STATES` exactly — a value outside it is dropped rather
    /// than relayed, so the two must not drift.
    var wireValue: String {
        switch self {
        case .connected: return "connected"
        case .reconnecting: return "reconnecting"
        }
    }
}

// MARK: - Session

@MainActor
final class LiveKitSession: NSObject, ObservableObject {

    @Published private(set) var remoteParticipants: [CallParticipantState] = []
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var isMicEnabled = false
    @Published private(set) var isCameraEnabled = false
    @Published private(set) var networkQuality: CallNetworkQuality = .unknown
    /// Whether the room is carrying right now. `.reconnecting` is NOT the end of the
    /// call — see `CallMediaLink`.
    @Published private(set) var mediaLink: CallMediaLink = .connected

    /// Called when the room is gone for good — the SFU is unreachable and the
    /// session cannot be re-established. The store treats it as a hang-up.
    ///
    /// Only reached after `LiveKitSession` has stopped trying. Previously it fired on
    /// the first `didDisconnectWithError`, so a two-second dead spot ended the call.
    var onRoomLost: (() -> Void)?
    /// Called whenever room state changed, so the store can re-derive what it
    /// publishes without observing this object directly.
    var onStateChanged: (() -> Void)?
    /// Called when the media link changes state, so the store can tell the peer
    /// (`call:link_state`) that this side is struggling. The SFU tells nobody else.
    var onMediaLinkChanged: ((CallMediaLink) -> Void)?
    /// Called when the local connection grade changes, for the same reason.
    var onQualityChanged: ((CallNetworkQuality) -> Void)?
    /// Asks the store to fetch a fresh token and re-join. Owned by the store because
    /// only it knows the call's type and whether the call is still live at all;
    /// this class only knows that its room has gone.
    var onNeedsRejoin: (() async -> Bool)?

    private(set) var callID: String?
    /// The room identity this device connected with (`{userID}#{deviceID}`).
    private(set) var identity: String?
    private var room: Room?
    private var syncTicker: Task<Void, Never>?
    private var rejoinTask: Task<Void, Never>?
    /// Identifies the attempt `rejoinTask` currently holds. A rejoin task only clears
    /// the handle if it is still the one the handle refers to, so a task finishing late
    /// cannot clear a newer attempt's handle.
    private var rejoinGeneration = 0
    /// Set by a real teardown (`leave(endingCall: true)`) and cleared when a new
    /// rejoin begins. The rejoin loop's stop condition, kept separate from
    /// `callID` because `join`'s own failure paths clear that too. See `leave`.
    ///
    /// `private(set)` rather than `private` so the discriminator can be asserted
    /// directly. The loop that consumes it is driven in a test too, through
    /// `handleRoomGone()` with a zero-delay `rejoinDelays`.
    private(set) var rejoinAbandoned = false
    /// True while `rejoinTask` is inside `onNeedsRejoin`, which reaches back into
    /// `join` → `leave`. Without it, `leave`'s `rejoinTask?.cancel()` would cancel the
    /// very task calling it, and the cancellation would then abort the `room.connect`
    /// that was about to succeed — a re-join that could never work.
    private var isRejoining = false
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "livekit")

    /// Re-join budget, sized to sit inside the server's reconnect grace window
    /// (`services/calls.RECONNECT_GRACE_SECONDS` = 40s) so the call row is still live
    /// when the last attempt runs: 1 + 2 + 4 + 8 + 8 = 23s of waiting, plus the
    /// connect attempts themselves.
    /// `nonisolated` because it is read from `init`'s default argument, which is
    /// evaluated outside the actor. Safe: an immutable array of `Double`.
    nonisolated static let defaultRejoinDelays: [Double] = [1, 2, 4, 8, 8]

    /// The budget this instance actually spends. Injectable for one reason: those
    /// delays add up to 23 seconds of real sleeping, so the loop that consumes them
    /// could not be covered by a test, and its stop condition had already been wrong
    /// once — see `rejoinAbandoned`. A test passes zero delays and drives the same
    /// loop, same attempts, same order. Production never passes anything.
    private let rejoinDelays: [Double]

    init(rejoinDelays: [Double] = LiveKitSession.defaultRejoinDelays) {
        self.rejoinDelays = rejoinDelays
        super.init()
    }

    /// The user half of a room identity. LiveKit gives us `{userID}#{deviceID}`; every
    /// other layer — the socket's participant frames, the avatar lookup, the mute
    /// relay — speaks in bare user ids.
    ///
    /// `nonisolated` because it is pure string work: the `RoomDelegate` callbacks are
    /// nonisolated and would otherwise have to hop to the main actor just to read a
    /// participant's user id.
    nonisolated static func userID(of identity: String?) -> String {
        (identity ?? "").split(separator: "#", maxSplits: 1).first.map(String.init) ?? ""
    }

    // MARK: - URL resolution

    /// Turn `CallToken.url` into something `Room.connect` can dial.
    ///
    /// `POST /api/calls/{id}/token` answers with `settings.livekit_url`, and in the
    /// Caddy deployment that value is the **browser-relative** path `/livekit`:
    /// perfectly good for the web client, which resolves it against
    /// `window.location`, and useless to a native client that has no page origin.
    /// The web app's `_absoluteUrl` does exactly this substitution; this is its
    /// counterpart, resolving against the API origin instead.
    static func resolveSFUURL(_ raw: String?) throws -> String {
        let value = (raw ?? "").trimmed
        guard !value.isEmpty else {
            throw CallJoinError(.badSFUURL, "server returned no LiveKit URL")
        }

        if value.hasPrefix("ws://") || value.hasPrefix("wss://") {
            guard URL(string: value) != nil else {
                throw CallJoinError(.badSFUURL, "unparseable LiveKit URL \(value)")
            }
            return value
        }

        // An https:// SFU URL is a configuration slip that is trivially recoverable:
        // the scheme is the only thing wrong with it.
        if value.hasPrefix("https://") {
            return "wss://" + value.dropFirst("https://".count)
        }
        if value.hasPrefix("http://") {
            return "ws://" + value.dropFirst("http://".count)
        }

        // Path-style (or bare) value: resolve against the API origin, which is
        // where the reverse proxy that owns that path lives.
        let path = value.hasPrefix("/") ? value : "/" + value
        var components = URLComponents(url: AppConfig.webSocketBaseURL, resolvingAgainstBaseURL: false)
        // webSocketBaseURL may itself carry a path prefix; append rather than replace.
        let base = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components?.path = base.isEmpty ? path : "/" + base + path
        guard let url = components?.url else {
            throw CallJoinError(.badSFUURL, "could not resolve \(value) against \(AppConfig.webSocketBaseURL)")
        }
        return url.absoluteString
    }

    // MARK: - Join / leave

    /// Connect to the room and publish local media.
    ///
    /// A voice call must never touch the camera: `wantVideo` is false, so no
    /// capture session is created and iOS never shows a camera prompt.
    func join(
        callID: String,
        token: CallToken,
        wantVideo: Bool,
        speaker: Bool
    ) async throws -> CallJoinOutcome {
        if room != nil, self.callID == callID { return CallJoinOutcome(cameraUnavailable: false, cameraFailure: nil) }
        // `endingCall: false`: this is clearing the way for the join below, not
        // ending anything. When the join IS a rejoin attempt, flagging
        // abandonment here would stop the very loop that called us — which is
        // the bug this whole flag exists to fix, reintroduced one line earlier.
        // A genuinely unrelated previous call is handled by the rejoinTask
        // cancellation above, which runs whenever we are not already rejoining.
        await leave(endingCall: false)

        let url = try Self.resolveSFUURL(token.url)

        // Ask for the microphone before connecting. Doing it after means a blocked
        // mic looks like "the call won't connect", which is the exact confusion the
        // reason codes exist to prevent.
        try await Self.requireMicrophonePermission()

        // State the routing preference before the SDK starts its engine, so the first
        // packet already goes to the right output and the user never hears the call
        // start in the earpiece and jump to the speaker. This only records the
        // preference — the SDK applies it as part of its own session configuration,
        // which is what keeps echo cancellation intact. See `prefersSpeakerOutput`.
        Self.prefersSpeakerOutput(speaker)

        let room = Room(
            delegate: self,
            // Audio capture options are stated explicitly rather than left to the
            // defaults. They happen to match the SDK's defaults today, but echo
            // cancellation is the single setting whose silent regression is most
            // expensive to diagnose — a dependency bump that flipped a default would
            // present as "the call echoes" with nothing in the diff to point at.
            roomOptions: RoomOptions(
                defaultAudioCaptureOptions: AudioCaptureOptions(
                    echoCancellation: true,
                    autoGainControl: true,
                    noiseSuppression: true,
                    highpassFilter: true
                ),
                adaptiveStream: true,
                dynacast: true
            )
        )
        self.room = room
        self.callID = callID
        self.identity = token.identity

        do {
            try await room.connect(url: url, token: token.token)
        } catch {
            // Not the call ending — just this attempt. See leave().
            await leave(endingCall: false)
            throw CallJoinError(Self.connectFailure(error), "could not reach the SFU at \(url)", underlying: error)
        }

        let outcome = try await publishLocalMedia(in: room, wantVideo: wantVideo)
        setMediaLink(.connected)
        startSyncTicker()
        syncFromRoom()
        return outcome
    }

    private func setMediaLink(_ link: CallMediaLink) {
        guard mediaLink != link else { return }
        mediaLink = link
        onMediaLinkChanged?(link)
        onStateChanged?()
    }

    /// Publish mic (mandatory) and camera (best-effort on a video call).
    ///
    /// Failing to open the camera falls back to audio; failing to open the
    /// microphone is fatal, because a call nobody can hear you on is not a call.
    private func publishLocalMedia(in room: Room, wantVideo: Bool) async throws -> CallJoinOutcome {
        do {
            try await room.localParticipant.setMicrophone(enabled: true)
            isMicEnabled = true
        } catch {
            // Not the call ending — just this attempt. See leave().
            await leave(endingCall: false)
            throw CallJoinError(Self.mediaFailure(error), "could not publish the microphone", underlying: error)
        }

        guard wantVideo else {
            return CallJoinOutcome(cameraUnavailable: false, cameraFailure: nil)
        }

        // Permission first, so "you denied the camera" and "there is no camera" are
        // different messages.
        if let denied = await Self.cameraPermissionFailure() {
            log.notice("Camera unavailable (\(denied.rawValue, privacy: .public)); continuing audio-only")
            return CallJoinOutcome(cameraUnavailable: true, cameraFailure: denied)
        }

        do {
            try await room.localParticipant.setCamera(enabled: true)
            isCameraEnabled = true
            return CallJoinOutcome(cameraUnavailable: false, cameraFailure: nil)
        } catch {
            log.notice("Camera publish failed: \(error.localizedDescription, privacy: .public)")
            return CallJoinOutcome(cameraUnavailable: true, cameraFailure: Self.mediaFailure(error))
        }
    }

    /// Tear everything down. Safe to call when there is no room.
    ///
    /// `endingCall: false` is for `join`'s own failure paths, and only those.
    ///
    /// The rejoin loop needs to tell "the user hung up, stop trying" apart from
    /// "this attempt failed, make the next one", and it used `callID == nil` for
    /// that. But `join` tears down on its own failures too, so a failed rejoin
    /// attempt cleared the very flag the loop consults before the next one: the
    /// five-attempt, 23-second budget collapsed to one attempt, and because the
    /// loop returned at that guard it never reached `onRoomLost` either. An SFU
    /// down for two seconds longer than the first retry left the call sitting on
    /// "Reconnecting…" until the user force-quit.
    ///
    /// An explicit flag rather than the id, because the id is also nil for a
    /// join that failed before it got one — a malformed SFU URL throws above the
    /// assignment — and that case must still exhaust the budget and report the
    /// room lost rather than stall in the same silent way.
    func leave(endingCall: Bool = true) async {
        syncTicker?.cancel()
        syncTicker = nil
        if !isRejoining {
            rejoinTask?.cancel()
            rejoinTask = nil
        }
        // `endingCall` governs the rejoin budget and nothing else; the session
        // state below is torn down either way.
        if endingCall { rejoinAbandoned = true }
        let room = self.room
        self.room = nil
        callID = nil
        identity = nil
        remoteParticipants = []
        localVideoTrack = nil
        isMicEnabled = false
        isCameraEnabled = false
        networkQuality = .unknown
        mediaLink = .connected

        if let room {
            // Unpublish explicitly rather than relying on disconnect: leaving the
            // capture session running is what keeps the camera light on after a
            // call, and it is not always torn down with the peer connection.
            try? await room.localParticipant.setCamera(enabled: false)
            try? await room.localParticipant.setMicrophone(enabled: false)
            await room.disconnect()
        }
        // No `setActive(false)` here. The SDK deactivates its own session when the
        // audio engine stops (AudioSessionEngineObserver, with
        // .notifyOthersOnDeactivation), and doing it ourselves could deactivate the
        // session out from under an engine that was still running — the same
        // class of race that cost us echo cancellation while connecting.
        onStateChanged?()
    }

    // MARK: - Controls

    func setMicrophone(enabled: Bool) async {
        guard let room else { return }
        do {
            try await room.localParticipant.setMicrophone(enabled: enabled)
            isMicEnabled = enabled
        } catch {
            log.error("Mic toggle failed: \(error.localizedDescription, privacy: .public)")
        }
        syncFromRoom()
    }

    /// Turn the local camera on or off.
    ///
    /// Audio, the screen share and the room connection are untouched: this mutes or
    /// unmutes exactly one publication. `LocalParticipant.set(source:enabled:)` keeps
    /// the publication alive and calls `mute()`/`unmute()` on it, so nothing is
    /// renegotiated and the far side sees the change as a track mute.
    ///
    /// `position` is passed explicitly because the SDK has a second path: when there is
    /// **no publication to unmute** — a call joined as voice, or a track dropped and
    /// re-published — it builds a new track from
    /// `roomOptions.defaultCameraCaptureOptions`, which means the front camera. Without
    /// this, somebody using the back camera who turned it off and on again would find
    /// the front camera pointed at their face.
    ///
    /// Returns the state actually reached, so the caller does not have to assume the
    /// hardware co-operated.
    @discardableResult
    func setCamera(enabled: Bool, position: AVCaptureDevice.Position? = nil) async -> Bool {
        guard let room else { return enabled }
        do {
            let options = (enabled && position != nil)
                ? CameraCaptureOptions(position: position!)
                : nil
            try await room.localParticipant.setCamera(enabled: enabled, captureOptions: options)
            isCameraEnabled = enabled
            syncFromRoom()
            return enabled
        } catch {
            log.error("Camera toggle failed: \(error.localizedDescription, privacy: .public)")
            // Re-read rather than assume: a failed enable can still have changed the
            // publication, and `syncFromRoom` derives the flag from what is actually
            // published. This is what puts the button back on its own.
            syncFromRoom()
            return isCameraEnabled
        }
    }

    /// Which camera is capturing right now, or `nil` when none is.
    ///
    /// Read from the live capture device rather than tracked in a flag of our own, so it
    /// stays true through a flip that failed and through a device the SDK chose for us.
    var cameraPosition: AVCaptureDevice.Position? {
        guard let track = room?.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return nil }
        return capturer.position
    }

    /// Front/back switch. A no-op when there is no camera published.
    func flipCamera() async {
        guard let track = room?.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
        syncFromRoom()
    }

    /// Speakerphone.
    ///
    /// Goes through the SDK rather than calling `overrideOutputAudioPort` on the
    /// shared session, which is what this did before. An override applied behind the
    /// SDK's back is undone the next time its engine reconfigures the session (a
    /// route change, an interruption, a track being republished mid-call), so the
    /// button appeared to work and then silently stopped — and, worse, the write
    /// raced the SDK's own configuration and could cost the session its
    /// voice-processing unit, and with it echo cancellation. See
    /// `prefersSpeakerOutput`.
    func setSpeaker(on: Bool) {
        Self.prefersSpeakerOutput(on)
    }

    // MARK: - Room state

    /// Rebuild published state from the room.
    ///
    /// **This — not the WebSocket — is the source of truth for who is in a call.**
    ///
    /// The SFU webhook *is* now wired (`main.py` mounts `calls.webhook_router` and
    /// both `infra/livekit*.yaml` declare a `webhook:` block), so
    /// `call:participant_joined` / `call:participant_left` do arrive. They are still
    /// only a supplement, for two reasons that do not go away: they are delivered
    /// server-to-server and can lag or be dropped, and this device may miss any
    /// frame sent while its socket was reconnecting. The room object cannot be
    /// stale in that way — it *is* the media session. So if you ever find yourself
    /// "fixing" the roster by trusting the socket over the room, that is the wrong
    /// direction.
    private func syncFromRoom() {
        guard let room else { return }

        // Connection state drives the media link, and — critically — `.reconnecting`
        // is NOT a lost room.
        //
        // This block used to be `if room.connectionState == .disconnected { onRoomLost() }`
        // and nothing else, with the store treating `onRoomLost` as a hang-up. Because
        // the ticker polls every second, any interruption long enough for the SDK to
        // notice ended the call — a tunnel, a lift, a Wi-Fi/cellular handover, an SFU
        // restart during a deploy. LiveKit recovers most of those on its own within a
        // second or two; all that was missing was the patience to let it.
        switch room.connectionState {
        case .reconnecting:
            setMediaLink(.reconnecting)
            // The roster is untrustworthy mid-reconnect; leave the tiles as they are
            // rather than blanking the call and then repopulating it.
            onStateChanged?()
            return
        case .disconnected:
            log.notice("Room reported disconnected")
            handleRoomGone()
            return
        default:
            setMediaLink(.connected)
        }

        var states: [CallParticipantState] = []
        for participant in room.remoteParticipants.values {
            guard let rawIdentity = participant.identity?.stringValue else { continue }
            // Tiles are keyed by USER id, not by room identity, so this roster and the
            // socket's `call:participant_joined` (which is the only source of avatars)
            // describe the same person. See `LiveKitSession.userID(of:)`.
            let identity = Self.userID(of: rawIdentity)
            guard !identity.isEmpty else { continue }
            let screen = participant.firstScreenShareVideoTrack
            let camera = participant.firstCameraVideoTrack
            // `name` is optional in the LiveKit SDK and is often empty anyway: the
            // token we mint sets only an identity, so fall back to that rather than
            // rendering a blank tile label.
            let publishedName = participant.name ?? ""
            states.append(
                CallParticipantState(
                    id: identity,
                    displayName: publishedName.isEmpty ? identity : publishedName,
                    avatarPath: nil,
                    isMuted: participant.firstAudioPublication?.isMuted ?? true,
                    isCameraOff: camera == nil || (participant.firstCameraPublication?.isMuted ?? true),
                    isSpeaking: participant.isSpeaking,
                    videoTrack: screen ?? camera,
                    isScreenShare: screen != nil,
                    hasMedia: true
                )
            )
        }
        remoteParticipants = states
        localVideoTrack = room.localParticipant.firstCameraVideoTrack
        // Derived from the publications rather than a cached flag: a track the SDK
        // dropped for us (thermal throttling, an interruption) has to move the
        // button, or the UI claims the camera is on while nobody can see anything.
        isCameraEnabled = room.localParticipant.firstCameraPublication.map { !$0.isMuted } ?? false
        isMicEnabled = room.localParticipant.firstAudioPublication.map { !$0.isMuted } ?? false
        onStateChanged?()
    }

    /// A 1-second resync alongside the delegate callbacks.
    ///
    /// Not belt-and-braces for its own sake: `RoomDelegate` in the LiveKit SDK has
    /// default implementations for every method, so a selector that drifts between
    /// SDK versions silently stops being called instead of failing to compile. A
    /// cheap poll over a handful of participants means a renamed callback costs a
    /// second of latency rather than a call with no video in it.
    ///
    /// It is also, for the same reason, what drives `mediaLink`: polling
    /// `room.connectionState` cannot silently stop working the way a renamed delegate
    /// method can, and getting reconnection wrong is the difference between a call
    /// that survives a dead spot and one that dies in it.
    private func startSyncTicker() {
        syncTicker?.cancel()
        syncTicker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                self.syncFromRoom()
            }
        }
    }

    // MARK: - Recovery

    /// The room is gone. Try to get back in before declaring the call over.
    ///
    /// LiveKit's own reconnection covers a brief interruption; this covers the case
    /// where the session is genuinely finished but the CALL is not — an SFU restart, a
    /// signal socket killed by a captive portal, a device waking from sleep. The call
    /// row is still `connected`, the peer is still in the room, and a fresh token gets
    /// us back in. Only when every attempt has failed does the store hear about it.
    ///
    /// Internal rather than private so a test can drive the recovery loop directly.
    /// Production reaches it two ways, both of which need a live room — the sync
    /// ticker seeing `.disconnected` and the room delegate's `didDisconnectWithError`
    /// — which is why this loop went uncovered while its stop condition was wrong.
    func handleRoomGone() {
        guard rejoinTask == nil else { return }  // already trying
        syncTicker?.cancel()
        syncTicker = nil

        // Drop the dead room, keep the call. `leave()` would also clear `callID`,
        // which the store needs to identify what it is re-joining.
        let dead = room
        room = nil
        if let dead { Task { await dead.disconnect() } }

        guard onNeedsRejoin != nil else {
            setMediaLink(.connected)
            onRoomLost?()
            return
        }

        setMediaLink(.reconnecting)
        rejoinGeneration &+= 1
        let generation = rejoinGeneration
        // Captured by value, like `generation`: the loop reads it before `self` has
        // been unwrapped, and it cannot change for the life of an instance anyway.
        let delays = rejoinDelays
        // A fresh budget: only a teardown from outside stops this one.
        rejoinAbandoned = false
        rejoinTask = Task { [weak self] in
            // Cleared on EVERY exit, not just the two that used to do it by hand.
            // Three of the returns below left the handle pointing at a finished
            // task, and `handleRoomGone` opens with `guard rejoinTask == nil`, so
            // once that happened every future room loss was silently ignored and
            // `onRoomLost` never fired again. Not just for the rest of the call:
            // CallStore holds one long-lived LiveKitSession, so the dead handle
            // outlived the call that stranded it and disabled recovery for the
            // process. The reachable path is a hang-up during a rejoin —
            // `leave()` deliberately skips the cancel while `isRejoining`, and
            // clears `callID`, so the next pass returns at the `callID` guard.
            //
            // Generation-guarded: a task that exits after `leave()` has already
            // dropped the handle and a newer attempt has claimed it must not
            // clear the newer attempt's handle out from under it.
            defer {
                if let self, self.rejoinGeneration == generation { self.rejoinTask = nil }
            }
            for (attempt, delay) in delays.enumerated() {
                try? await Task.sleep(for: .seconds(delay))
                // `rejoinAbandoned` means a teardown ran from outside — the user hung
                // up, or the call ended — so there is nothing left to rejoin. This was
                // `callID != nil`, which `join` also clears when an *attempt* fails,
                // so one unreachable SFU ended the whole budget. See `leave`.
                guard let self, !Task.isCancelled, !self.rejoinAbandoned else { return }
                // A `join` from somewhere else got there first.
                if self.room != nil { return }
                self.log.notice("Rejoining the SFU (attempt \(attempt + 1))")
                // The store re-fetches a token and calls `join`; `false` means the call
                // itself is finished, so retrying can only delay the bad news.
                self.isRejoining = true
                let rejoined = await self.onNeedsRejoin?() == true
                self.isRejoining = false
                if rejoined {
                    self.log.notice("Rejoined the SFU")
                    return
                }
                if Task.isCancelled { return }
            }
            guard let self, !Task.isCancelled else { return }
            self.log.error("Gave up rejoining the SFU; ending the call")
            self.setMediaLink(.connected)
            self.onRoomLost?()
        }
    }

    // MARK: - Audio session

    /// Ask for the routing we want. **Never touch `AVAudioSession` directly.**
    ///
    /// This used to call `setCategory(.playAndRecord, mode: .voiceChat)`,
    /// `setActive(true)` and `overrideOutputAudioPort` itself, before connecting —
    /// and that was the cause of severe echo on device.
    ///
    /// The LiveKit SDK **owns the audio session**: `AudioSessionEngineObserver`
    /// applies its own category, mode and options when the audio engine starts, and
    /// deactivates the session when it stops. Configuring the same session by hand
    /// races that. Whichever write lands last wins, so the session could end up in a
    /// category/mode combination where iOS does **not** insert the voice-processing
    /// I/O unit — which is what performs hardware acoustic echo cancellation. With it
    /// absent the far end hears itself back, loudly, and no amount of software
    /// tuning compensates. It also made the outcome nondeterministic: the same build
    /// could sound fine or echo depending on the order the two configurations landed.
    ///
    /// `isSpeakerOutputPreferred` is the SDK's supported hook for exactly this
    /// choice, and it applies through the SDK's own configuration pass, so there is
    /// no race and echo cancellation is never lost. Speaker on for video (the phone
    /// is held away from the face), receiver for voice (held to the ear).
    static func prefersSpeakerOutput(_ speaker: Bool) {
        AudioManager.shared.isSpeakerOutputPreferred = speaker
    }

    // MARK: - Permissions

    private static func requireMicrophonePermission() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return
        case .denied:
            throw CallJoinError(.permissionDenied, "microphone permission denied")
        case .undetermined:
            let granted = await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
            if !granted { throw CallJoinError(.permissionDenied, "microphone permission refused") }
        @unknown default:
            return
        }
    }

    /// nil when the camera is usable.
    private static func cameraPermissionFailure() async -> CallJoinFailure? {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            return nil
        case .denied, .restricted:
            return .permissionDenied
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            return granted ? nil : .permissionDenied
        @unknown default:
            return nil
        }
    }

    // MARK: - Error classification

    /// Classify a connect failure.
    ///
    /// Matched on the error's description rather than on `LiveKitError.type`
    /// deliberately: that enum gains and renames cases between SDK minor versions,
    /// and a `switch` over it turns a routine dependency bump into a build break in
    /// a file nobody was editing. The description is stable enough for a toast, and
    /// the raw error is logged alongside it either way. Anything unplaceable is
    /// reported as an unreachable SFU, because that is what it looks like from the
    /// user's seat and it points at the right thing to check first.
    private static func connectFailure(_ error: Error) -> CallJoinFailure {
        let text = String(describing: error).lowercased()
        if text.contains("unauthorized") || text.contains("permission denied by server")
            || text.contains("invalid token") || text.contains("duplicateidentity") {
            return .sfuRejected
        }
        if text.contains("network") || text.contains("timedout") || text.contains("timed out")
            || text.contains("cancelled") || text.contains("socket") || text.contains("url") {
            return .sfuUnreachable
        }
        return .sfuError
    }

    /// Capture failures map onto the same vocabulary the web client uses for
    /// `getUserMedia` DOMExceptions, so both clients' toasts say the same thing.
    private static func mediaFailure(_ error: Error) -> CallJoinFailure {
        let text = String(describing: error).lowercased()
        if text.contains("not authorized") || text.contains("notauthorized") || text.contains("denied") {
            return .permissionDenied
        }
        if text.contains("in use") || text.contains("inuse") || text.contains("alreadyused")
            || text.contains("busy") {
            return .deviceBusy
        }
        if text.contains("devicenotfound") || text.contains("device not found")
            || text.contains("notconnected") || text.contains("no device") {
            return .deviceMissing
        }
        return .mediaFailed
    }
}

// MARK: - RoomDelegate

// The fast path. `syncFromRoom` recomputes everything from the room rather than
// applying a delta from the callback's arguments — deltas were how the web client
// ended up with participants that had left still on screen.
extension LiveKitSession: RoomDelegate {

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        resync()
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnsubscribeTrack publication: RemoteTrackPublication) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: LocalParticipant, didPublishTrack publication: LocalTrackPublication) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) {
        resync()
    }

    nonisolated func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) {
        resync()
    }

    nonisolated func room(_ room: Room, participant: Participant?, didUpdateConnectionQuality quality: ConnectionQuality) {
        let mapped: CallNetworkQuality
        switch quality {
        case .excellent: mapped = .excellent
        case .good: mapped = .good
        case .poor: mapped = .poor
        default: mapped = .unknown
        }
        let isLocal = participant is LocalParticipant
        Task { @MainActor [weak self] in
            guard let self else { return }
            // Only the local leg drives our own indicator — a remote peer's poor uplink
            // is not something this user can do anything about. But it IS relayed, so
            // the other side can say so on their screen: the SFU reports quality to the
            // affected participant only, which is why a peer with a dying connection
            // used to look perfectly healthy from here.
            if isLocal, self.networkQuality != mapped {
                self.networkQuality = mapped
                self.onQualityChanged?(mapped)
            }
            self.onStateChanged?()
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            guard let self, self.room === room else { return }
            // NOT a hang-up. `handleRoomGone` spends the re-join budget first, and only
            // calls `onRoomLost` once it has run out — see the note there for why the
            // old straight-to-`onRoomLost` behaviour lost calls that were recoverable.
            self.handleRoomGone()
        }
    }

    private nonisolated func resync() {
        Task { @MainActor [weak self] in
            self?.syncFromRoomIfConnected()
        }
    }

    private func syncFromRoomIfConnected() {
        guard room != nil else { return }
        syncFromRoom()
    }
}

// MARK: - Video rendering

/// Bridges LiveKit's `VideoView` into SwiftUI.
///
/// Kept here rather than in `CallViews` so this file stays the only place that
/// knows how a `VideoTrack` becomes pixels — swapping the SFU later touches one
/// file instead of the whole call UI.
struct CallVideoView: UIViewRepresentable {
    let track: VideoTrack?
    /// `.fill` crops to the tile (camera), `.fit` letterboxes (screen share).
    /// Both preserve the source aspect ratio — neither stretches.
    var fitsContent = false

    /// Horizontal mirroring, and **the caller does not decide it**.
    ///
    /// This used to be `mirrored: Bool`, set to `true` for anything local. That is
    /// wrong for half the cameras on the device: a self-view is mirrored because a
    /// front camera shows you your own face and people expect a mirror, but the BACK
    /// camera is pointed at the world, and mirroring the world puts every sign,
    /// badge and screen in the scene back-to-front. `mirrored: tile.isLocal` in the
    /// group grid and `mirrored: true` in the 1:1 self-view both did exactly that.
    ///
    /// A `Bool` at the call site cannot be right, because only the renderer knows
    /// which camera is live *right now* — the answer changes under `flipCamera()`,
    /// and it can change without us asking when the SDK falls back to another
    /// device. So the decision is delegated: `.auto` mirrors iff the frame's
    /// `captureDevice.facingPosition == .front` (`VideoView._shouldMirror`), and the
    /// capture device arrives with every frame from the capturer, so a flip mid-call
    /// is picked up on the next frame with no state of ours to keep in sync.
    ///
    /// For a REMOTE track there is no capture device, so `.auto` is `.off` — remote
    /// video is never mirrored, which is what it must be: it has already been
    /// composed the right way round by whoever sent it.
    ///
    /// This is display only, in either direction. `mirrorMode` ends as
    /// `layer.transform` on the renderer's own layer, while the published frame goes
    /// to `delegate?.capturer(_:didCapture:)` straight off the capture buffer — so
    /// nothing here can mirror what the far side receives.
    var mirror: VideoView.MirrorMode = .auto

    func makeUIView(context: Context) -> VideoView {
        let view = VideoView()
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: VideoView, context: Context) {
        view.layoutMode = fitsContent ? .fit : .fill
        view.mirrorMode = mirror
        if view.track !== track { view.track = track }
    }

    static func dismantleUIView(_ view: VideoView, coordinator: ()) {
        // Detach explicitly: a VideoView that keeps a track reference after the
        // SwiftUI view is gone holds the decoder alive for the rest of the call.
        view.track = nil
    }
}
