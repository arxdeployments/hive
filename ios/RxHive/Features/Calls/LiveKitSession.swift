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
}

// MARK: - Session

@MainActor
final class LiveKitSession: NSObject, ObservableObject {

    @Published private(set) var remoteParticipants: [CallParticipantState] = []
    @Published private(set) var localVideoTrack: VideoTrack?
    @Published private(set) var isMicEnabled = false
    @Published private(set) var isCameraEnabled = false
    @Published private(set) var networkQuality: CallNetworkQuality = .unknown

    /// Called when the room went away without us asking — SFU restart, network
    /// loss, or the server tearing the room down. The store treats it as a hang-up.
    var onRoomLost: (() -> Void)?
    /// Called whenever room state changed, so the store can re-derive what it
    /// publishes without observing this object directly.
    var onStateChanged: (() -> Void)?

    private(set) var callID: String?
    private var room: Room?
    private var syncTicker: Task<Void, Never>?
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "livekit")

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
        await leave()

        let url = try Self.resolveSFUURL(token.url)

        // Ask for the microphone before connecting. Doing it after means a blocked
        // mic looks like "the call won't connect", which is the exact confusion the
        // reason codes exist to prevent.
        try await Self.requireMicrophonePermission()

        // Route audio before the SDK starts its engine, so the first packet already
        // goes to the right output and the user never hears the call start in the
        // earpiece and jump to the speaker.
        Self.configureAudioSession(speaker: speaker)

        let room = Room(
            delegate: self,
            roomOptions: RoomOptions(adaptiveStream: true, dynacast: true)
        )
        self.room = room
        self.callID = callID

        do {
            try await room.connect(url: url, token: token.token)
        } catch {
            await leave()
            throw CallJoinError(Self.connectFailure(error), "could not reach the SFU at \(url)", underlying: error)
        }

        let outcome = try await publishLocalMedia(in: room, wantVideo: wantVideo)
        startSyncTicker()
        syncFromRoom()
        return outcome
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
            await leave()
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
    func leave() async {
        syncTicker?.cancel()
        syncTicker = nil
        let room = self.room
        self.room = nil
        callID = nil
        remoteParticipants = []
        localVideoTrack = nil
        isMicEnabled = false
        isCameraEnabled = false
        networkQuality = .unknown

        if let room {
            // Unpublish explicitly rather than relying on disconnect: leaving the
            // capture session running is what keeps the camera light on after a
            // call, and it is not always torn down with the peer connection.
            try? await room.localParticipant.setCamera(enabled: false)
            try? await room.localParticipant.setMicrophone(enabled: false)
            await room.disconnect()
        }
        Self.deactivateAudioSession()
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

    func setCamera(enabled: Bool) async {
        guard let room else { return }
        do {
            try await room.localParticipant.setCamera(enabled: enabled)
            isCameraEnabled = enabled
        } catch {
            log.error("Camera toggle failed: \(error.localizedDescription, privacy: .public)")
        }
        syncFromRoom()
    }

    /// Front/back switch. A no-op when there is no camera published.
    func flipCamera() async {
        guard let track = room?.localParticipant.firstCameraVideoTrack as? LocalVideoTrack,
              let capturer = track.capturer as? CameraCapturer else { return }
        _ = try? await capturer.switchCameraPosition()
        syncFromRoom()
    }

    /// Speakerphone. `overrideOutputAudioPort` is the only reliable way to move a
    /// live `.playAndRecord` session between the earpiece and the loudspeaker;
    /// changing the category mid-call drops audio for a moment.
    func setSpeaker(on: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.overrideOutputAudioPort(on ? .speaker : .none)
        } catch {
            log.notice("Speaker override failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Room state

    /// Rebuild published state from the room.
    ///
    /// **This — not the WebSocket — is the source of truth for who is in a call.**
    /// `POST /api/livekit/webhook` is declared in `api/calls.py` but never mounted
    /// in `main.py`, and no webhook is configured on the SFU, so the
    /// `call:participant_joined` / `call:participant_left` frames that the webhook
    /// would publish are never delivered. Those frames *do* still arrive for
    /// explicit `call:join` / `call:leave` signalling, which is why `CallStore`
    /// keeps them as a supplement — but if you ever find yourself "fixing" the
    /// roster by trusting the socket over the room, that is the wrong direction.
    private func syncFromRoom() {
        guard let room else { return }

        if room.connectionState == .disconnected {
            log.notice("Room reported disconnected")
            onRoomLost?()
            return
        }

        var states: [CallParticipantState] = []
        for participant in room.remoteParticipants.values {
            guard let identity = participant.identity?.stringValue else { continue }
            let screen = participant.firstScreenShareVideoTrack
            let camera = participant.firstCameraVideoTrack
            states.append(
                CallParticipantState(
                    id: identity,
                    displayName: participant.name.isEmpty ? identity : participant.name,
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

    // MARK: - Audio session

    /// `.playAndRecord` + `.voiceChat` is the combination that gives a call echo
    /// cancellation and the hardware AGC. `.allowBluetooth` (not
    /// `.allowBluetoothA2DP`) is what routes to a headset's *microphone* as well as
    /// its speaker.
    static func configureAudioSession(speaker: Bool) {
        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.allowBluetooth]
        if speaker { options.insert(.defaultToSpeaker) }
        do {
            try session.setCategory(.playAndRecord, mode: .voiceChat, options: options)
            try session.setActive(true, options: [])
            try session.overrideOutputAudioPort(speaker ? .speaker : .none)
        } catch {
            Logger(subsystem: "ai.rhythmrx.rxhive", category: "livekit")
                .error("Audio session setup failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Hand the session back so other audio (a voice note, the system) resumes.
    static func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
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
            // Only the local leg is actionable — a remote peer's poor uplink is not
            // something this user can do anything about.
            if isLocal { self.networkQuality = mapped }
            self.onStateChanged?()
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        Task { @MainActor [weak self] in
            guard let self, self.room === room else { return }
            self.onRoomLost?()
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
    var fitsContent = false
    var mirrored = false

    func makeUIView(context: Context) -> VideoView {
        let view = VideoView()
        view.backgroundColor = .black
        return view
    }

    func updateUIView(_ view: VideoView, context: Context) {
        view.layoutMode = fitsContent ? .fit : .fill
        view.mirrorMode = mirrored ? .mirror : .off
        if view.track !== track { view.track = track }
    }

    static func dismantleUIView(_ view: VideoView, coordinator: ()) {
        // Detach explicitly: a VideoView that keeps a track reference after the
        // SwiftUI view is gone holds the decoder alive for the rest of the call.
        view.track = nil
    }
}
