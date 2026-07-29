import AVFoundation
import LiveKit
import SwiftUI
import UIKit

// MARK: - Error copy

/// User-facing text per join failure.
///
/// Transcribed from `frontend/src/utils/callErrors.js`, with the browser wording
/// replaced by the iOS equivalent (Settings, not "browser settings"). Every message
/// names the thing to check: "Could not connect the call" was one string for both a
/// stopped SFU and a blocked microphone, and the user could not tell which they
/// were looking at.
extension CallJoinFailure {

    var userMessage: String {
        switch self {
        case .sfuUnreachable:
            return "Call server unreachable. Check your connection and try again."
        case .sfuRejected:
            return "The call server rejected this call. Try again, or contact your admin."
        case .sfuError:
            return "Call server error — the call could not be established."
        case .permissionDenied:
            return "Microphone blocked. Allow microphone access in Settings, then call again."
        case .deviceMissing:
            return "No microphone found."
        case .deviceBusy:
            return "Your microphone is in use by another app. Close it and try again."
        case .mediaFailed:
            return "Could not start your microphone."
        case .callUnavailable:
            return "That call is no longer active."
        case .tokenFailed:
            return "Could not authorise the call. Check your connection and try again."
        case .badSFUURL:
            return "Calling isn't configured on this server. Contact your admin."
        case .unknown:
            return "Could not connect the call."
        }
    }

    /// The camera failed but the microphone did not — the call is live, just
    /// audio-only, and saying so beats a black tile the user reads as a bug.
    var cameraFallbackMessage: String {
        switch self {
        case .permissionDenied:
            return "Camera blocked — continuing with audio only."
        case .deviceBusy:
            return "Camera in use by another app — continuing with audio only."
        case .deviceMissing:
            return "No camera available — continuing with audio only."
        default:
            return "Camera unavailable — continuing with audio only."
        }
    }
}

// MARK: - Ringing

/// In-app call tones and ring haptics.
///
/// **On CallKit:** an incoming call reaches this app over its own WebSocket, which
/// only exists while the app is running, so the phone can only ring in the
/// foreground (or briefly in the background before iOS suspends the process).
/// CallKit is deliberately *not* wired up here: `CXProvider.reportNewIncomingCall`
/// is only legitimate from a PushKit VoIP push, and registering the UI without one
/// produces a call screen that appears at the wrong times and, from iOS 13, an app
/// that Apple terminates for reporting calls outside a VoIP push. Background
/// ringing needs backend work this product has not done: an APNs VoIP certificate,
/// a `device_tokens` table, and `services/calls.py:initiate_direct_call` sending a
/// VoIP push alongside `publish_to_users`. The current server has only Web
/// Push/VAPID, which cannot carry an APNs token — see the note in the port spec.
///
/// Tones are synthesised rather than bundled, matching the web client's
/// `callSounds.js` oscillators: the same three-note ring on both clients, and no
/// audio asset to license or ship.
@MainActor
final class CallSounds {

    static let shared = CallSounds()

    private var player: AVAudioPlayer?
    private var hapticTask: Task<Void, Never>?

    private init() {}

    func startRingtone() {
        // Route to the speaker before ringing: a ringtone in the earpiece is
        // inaudible unless the phone is already against an ear.
        LiveKitSession.configureAudioSession(speaker: true)
        play(
            Self.tone(
                segments: [(800, 0.15), (0, 0.05), (600, 0.15), (0, 0.05), (800, 0.15)],
                totalDuration: 2.0
            ),
            looping: true,
            volume: 1.0
        )
        startHaptics()
    }

    func startRingback() {
        LiveKitSession.configureAudioSession(speaker: true)
        play(
            Self.tone(segments: [(440, 0.5), (0, 0.1), (440, 0.5)], totalDuration: 3.0),
            looping: true,
            volume: 0.5
        )
    }

    func playConnected() {
        stopAll()
        play(Self.tone(segments: [(880, 0.15), (1100, 0.2)], totalDuration: 0.4), looping: false, volume: 0.6)
    }

    func playEnded() {
        stopAll()
        play(Self.tone(segments: [(600, 0.15), (400, 0.25)], totalDuration: 0.45), looping: false, volume: 0.6)
    }

    func stopAll() {
        player?.stop()
        player = nil
        hapticTask?.cancel()
        hapticTask = nil
    }

    private func play(_ data: Data, looping: Bool, volume: Float) {
        player?.stop()
        do {
            let player = try AVAudioPlayer(data: data)
            player.numberOfLoops = looping ? -1 : 0
            player.volume = volume
            player.prepareToPlay()
            player.play()
            self.player = player
        } catch {
            // A missing tone is not worth failing a call over; the UI still rings
            // visually and the haptics still fire.
            self.player = nil
        }
    }

    private func startHaptics() {
        hapticTask?.cancel()
        hapticTask = Task { @MainActor in
            let generator = UIImpactFeedbackGenerator(style: .heavy)
            generator.prepare()
            while !Task.isCancelled {
                generator.impactOccurred()
                try? await Task.sleep(for: .milliseconds(220))
                guard !Task.isCancelled else { return }
                generator.impactOccurred()
                try? await Task.sleep(for: .milliseconds(1600))
            }
        }
    }

    // MARK: Tone synthesis

    /// A 16-bit mono WAV of the given segments (frequency 0 = silence), padded with
    /// silence to `totalDuration` so a looping player repeats on the right beat.
    private static func tone(
        segments: [(frequency: Double, duration: Double)],
        totalDuration: Double,
        sampleRate: Double = 22_050,
        amplitude: Double = 0.32
    ) -> Data {
        var samples: [Int16] = []
        samples.reserveCapacity(Int(totalDuration * sampleRate))

        for segment in segments {
            let count = Int(segment.duration * sampleRate)
            guard count > 0 else { continue }
            // 5ms fade at each edge: a raw sine that starts mid-cycle clicks.
            let fade = max(1.0, 0.005 * sampleRate)
            for index in 0..<count {
                guard segment.frequency > 0 else { samples.append(0); continue }
                let t = Double(index) / sampleRate
                let envelope = min(1, min(Double(index), Double(count - index)) / fade)
                let value = sin(2 * .pi * segment.frequency * t) * amplitude * envelope
                samples.append(Int16(max(-1, min(1, value)) * 32_767))
            }
        }
        let padding = Int(totalDuration * sampleRate) - samples.count
        if padding > 0 { samples.append(contentsOf: repeatElement(0, count: padding)) }

        return wav(samples: samples, sampleRate: Int(sampleRate))
    }

    private static func wav(samples: [Int16], sampleRate: Int) -> Data {
        var data = Data()
        func ascii(_ text: String) { data.append(contentsOf: Array(text.utf8)) }
        func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }

        let payloadBytes = UInt32(samples.count * 2)
        ascii("RIFF"); u32(36 + payloadBytes); ascii("WAVE")
        ascii("fmt "); u32(16)
        u16(1)                              // PCM
        u16(1)                              // mono
        u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2))         // byte rate
        u16(2)                              // block align
        u16(16)                             // bits per sample
        ascii("data"); u32(payloadBytes)
        for sample in samples { u16(UInt16(bitPattern: sample)) }
        return data
    }
}

// MARK: - Shared chrome

/// The call screens' background: the web app's `#1a3a2a → #0A0A0A` wash, built
/// from the emerald token rather than a second hard-coded green.
private struct CallBackdrop: View {
    var body: some View {
        LinearGradient(
            colors: [
                // `callBackdrop` is the token for exactly this gradient — the web call
                // screen's #1a3a2a. Emerald-at-22%-over-black is a different colour
                // and drifts the one screen the brand green is most saturated on.
                Theme.Color.callBackdrop,
                Theme.Color.bg,
                Theme.Color.bg
            ],
            startPoint: .top,
            endPoint: .center
        )
        .background(Theme.Color.bg)
        .ignoresSafeArea()
    }
}

/// The 128pt avatar at the top of a ringing or voice call.
private struct CallHeroAvatar: View {
    let name: String
    let avatarPath: String?
    let isGroup: Bool
    var pulsing = false
    var highlighted = false

    @State private var scale: CGFloat = 1

    private let size: CGFloat = 128

    var body: some View {
        ZStack {
            if isGroup, avatarPath == nil {
                Circle()
                    .fill(Theme.Color.primaryTint)
                    .overlay(
                        Image(systemName: "person.2.fill")
                            .font(.system(size: 46, weight: .regular))
                            .foregroundStyle(Theme.Color.primary)
                    )
                    .frame(width: size, height: size)
            } else {
                Avatar(name: name, urlPath: avatarPath, size: size)
            }
        }
        .overlay(
            Circle().stroke(
                highlighted ? Theme.Color.primary : Theme.Color.text.opacity(0.10),
                lineWidth: 3
            )
        )
        .shadow(color: Theme.Color.primary.opacity(0.20), radius: 40)
        .scaleEffect(scale)
        .onAppear {
            guard pulsing else { return }
            withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) {
                scale = 1.05
            }
        }
    }
}

/// The three bouncing dots after "Calling" / "Incoming video call".
private struct RingingDots: View {
    @State private var phase = 0

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Theme.Color.textMuted)
                    .frame(width: 4, height: 4)
                    .opacity(phase == index ? 1 : 0.3)
            }
        }
        .task {
            // A task rather than a repeatForever animation: three discrete steps
            // read as a cycle, where an interpolated opacity reads as a flicker.
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(280))
                withAnimation(Theme.Motion.ease) { phase = (phase + 1) % 3 }
            }
        }
    }
}

/// Connection-quality dot. Only ever reflects the *local* leg — a remote peer's
/// bad uplink is not something this user can act on.
private struct NetworkQualityDot: View {
    let quality: CallNetworkQuality

    private var color: Color {
        switch quality {
        case .excellent: return Theme.Color.primary
        case .good: return Theme.Color.warning
        case .poor: return Theme.Color.danger
        case .unknown: return Theme.Color.textMuted
        }
    }

    private var label: String {
        switch quality {
        case .excellent: return "Excellent connection"
        case .good: return "Good connection"
        case .poor: return "Poor connection"
        case .unknown: return "Connection quality unknown"
        }
    }

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityLabel(label)
    }
}

/// A 64pt round accept / decline / hang-up button.
private struct CallActionButton: View {
    let systemImage: String
    let tint: Color
    let label: String
    let action: () -> Void

    var body: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .frame(width: 64, height: 64)
                    .background(Circle().fill(tint))
                    .shadow(color: tint.opacity(0.35), radius: 14, y: 6)
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(label)

            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textMuted)
        }
    }
}

/// One of the square in-call toggles (mute / camera / speaker).
private struct CallToggleButton: View {
    let systemImage: String
    let label: String
    /// `true` renders the "engaged" look — filled, dark glyph — like the web's
    /// `bg-white` active state.
    let isEngaged: Bool
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Button(action: action) {
                Image(systemName: systemImage)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(isEngaged ? Theme.Color.onPrimary : Theme.Color.text)
                    .frame(width: 56, height: 56)
                    .background(
                        RoundedRectangle(cornerRadius: 18)
                            .fill(isEngaged ? Theme.Color.text : Theme.Color.surface2)
                    )
                    .opacity(isEnabled ? 1 : 0.4)
            }
            .buttonStyle(PressScaleStyle())
            .disabled(!isEnabled)
            .accessibilityLabel(label)

            Text(label)
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textMuted)
        }
        .frame(minWidth: Theme.Layout.minTouchTarget)
    }
}

// MARK: - Incoming

/// Full-screen ring. Never minimisable: an incoming call the user cannot see is a
/// missed call.
struct IncomingCallView: View {
    @EnvironmentObject private var calls: CallStore

    private var typeLabel: String {
        let video = calls.isVideoCall
        if calls.isGroupCall {
            return video ? "Incoming group video call" : "Incoming group voice call"
        }
        return video ? "Incoming video call" : "Incoming voice call"
    }

    var body: some View {
        ZStack {
            CallBackdrop()

            VStack(spacing: 0) {
                Spacer()

                CallHeroAvatar(
                    name: calls.peerName,
                    avatarPath: calls.peerAvatarPath,
                    isGroup: calls.isGroupCall,
                    pulsing: true
                )
                .padding(.bottom, Theme.Layout.spacing6)

                Text(calls.peerName)
                    .font(Theme.Typography.font(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.Layout.spacing6)

                if let caller = calls.callerName {
                    Text("\(caller) is calling")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted.opacity(0.7))
                        .padding(.top, 2)
                }

                HStack(spacing: Theme.Layout.spacing1) {
                    Text(typeLabel)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                    RingingDots()
                }
                .padding(.top, Theme.Layout.spacing2)

                Spacer()

                HStack(spacing: 64) {
                    CallActionButton(
                        systemImage: "phone.down.fill",
                        tint: Theme.Color.danger,
                        label: "Decline"
                    ) { calls.decline() }

                    CallActionButton(
                        systemImage: calls.isVideoCall ? "video.fill" : "phone.fill",
                        tint: Theme.Color.primary,
                        label: "Accept"
                    ) { calls.accept() }
                }
                .padding(.bottom, Theme.Layout.spacing8)
            }
        }
        .onAppear { CallSounds.shared.startRingtone() }
        .onDisappear { CallSounds.shared.stopAll() }
    }
}

// MARK: - Outgoing

/// The ringing-out screen. Minimisable, because the caller may well want to keep
/// reading a thread while the phone rings.
struct OutgoingCallView: View {
    @EnvironmentObject private var calls: CallStore

    var body: some View {
        ZStack {
            CallBackdrop()

            VStack(spacing: 0) {
                HStack {
                    Button {
                        calls.minimise()
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 20, weight: .medium))
                            .foregroundStyle(Theme.Color.textMuted)
                            .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    }
                    .accessibilityLabel("Minimise call")
                    Spacer()
                }
                .padding(.horizontal, Theme.Layout.spacing2)

                Spacer()

                CallHeroAvatar(
                    name: calls.peerName,
                    avatarPath: calls.peerAvatarPath,
                    isGroup: calls.isGroupCall,
                    pulsing: true
                )
                .padding(.bottom, Theme.Layout.spacing6)

                Text(calls.peerName)
                    .font(Theme.Typography.font(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.Layout.spacing6)

                HStack(spacing: Theme.Layout.spacing1) {
                    Text(calls.isVideoCall ? "Video calling" : "Calling")
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                    RingingDots()
                }
                .padding(.top, Theme.Layout.spacing2)

                Spacer()

                CallActionButton(
                    systemImage: "phone.down.fill",
                    tint: Theme.Color.danger,
                    label: "Cancel"
                ) { calls.hangUp() }
                    .padding(.bottom, Theme.Layout.spacing8)
            }
        }
        .onAppear { CallSounds.shared.startRingback() }
        .onDisappear { CallSounds.shared.stopAll() }
    }
}

// MARK: - Active

/// The live call: 1:1 video, group grid, or the voice/connecting/ended avatar view.
struct ActiveCallView: View {
    @EnvironmentObject private var calls: CallStore

    private var isConnected: Bool {
        if case .active = calls.phase { return true }
        return false
    }

    private var isEnded: Bool {
        if case .ended = calls.phase { return true }
        return false
    }

    private var statusText: String {
        if isEnded { return "Call ended" }
        if isConnected { return calls.elapsedLabel }
        return "Connecting"
    }

    var body: some View {
        Group {
            if calls.isVideoCall && isConnected && !calls.isGroupCall {
                directVideo
            } else if calls.isGroupCall && isConnected {
                groupGrid
            } else {
                avatarCall
            }
        }
        .onChange(of: calls.phase) { _, phase in
            switch phase {
            case .active: CallSounds.shared.playConnected()
            case .ended: CallSounds.shared.playEnded()
            default: break
            }
        }
        .onDisappear { CallSounds.shared.stopAll() }
    }

    // MARK: 1:1 video

    /// The other party. A direct call has exactly one remote leg, so "first" is not
    /// a guess here.
    private var remote: CallParticipantState? { calls.participants.first }

    private var directVideo: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let track = remote?.videoTrack, remote?.isCameraOff == false || remote?.isScreenShare == true {
                CallVideoView(track: track, fitsContent: remote?.isScreenShare == true)
                    .ignoresSafeArea()
            } else {
                ZStack {
                    CallBackdrop()
                    CallHeroAvatar(
                        name: remote?.displayName ?? calls.peerName,
                        avatarPath: remote?.avatarPath ?? calls.peerAvatarPath,
                        isGroup: false,
                        highlighted: remote?.isSpeaking == true
                    )
                }
            }

            VStack {
                topBar(title: remote?.displayName ?? calls.peerName)
                Spacer()
                controls
            }

            // Local preview. Top-trailing, below the status bar and clear of the
            // title, which is where a thumb naturally isn't.
            VStack {
                HStack {
                    Spacer()
                    localPreview
                        .padding(.trailing, Theme.Layout.gutter)
                        .padding(.top, 64)
                }
                Spacer()
            }
        }
    }

    private var localPreview: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14).fill(Theme.Color.surface)
            if calls.isCameraOn, let track = calls.localVideoTrack {
                CallVideoView(track: track, mirrored: true)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            } else {
                Image(systemName: "video.slash.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
        .frame(width: 108, height: 148)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Theme.Color.text.opacity(0.2), lineWidth: 2)
        )
        .shadow(color: Theme.Shadow.modal.color, radius: 12, y: 6)
    }

    // MARK: Group

    private var groupGrid: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar(title: calls.peerName, subtitle: "\(calls.participants.count + 1) participants")
                VideoGrid()
                controls
            }
        }
    }

    // MARK: Voice / connecting / ended

    private var avatarCall: some View {
        ZStack {
            CallBackdrop()

            VStack(spacing: 0) {
                HStack {
                    if !isEnded {
                        Button {
                            calls.minimise()
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 20, weight: .medium))
                                .foregroundStyle(Theme.Color.textMuted)
                                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                        }
                        .accessibilityLabel("Minimise call")
                    }
                    Spacer()
                }
                .padding(.horizontal, Theme.Layout.spacing2)

                Spacer()

                CallHeroAvatar(
                    name: calls.peerName,
                    avatarPath: calls.peerAvatarPath,
                    isGroup: calls.isGroupCall,
                    pulsing: !isConnected && !isEnded,
                    highlighted: calls.participants.contains { $0.isSpeaking }
                )
                .padding(.bottom, Theme.Layout.spacing6)

                Text(calls.peerName)
                    .font(Theme.Typography.font(size: 22, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.Layout.spacing6)

                HStack(spacing: Theme.Layout.spacing2) {
                    if isConnected {
                        NetworkQualityDot(quality: calls.networkQuality)
                        Text(statusText)
                            .font(Theme.Typography.subheadline.monospacedDigit())
                            .foregroundStyle(Theme.Color.textMuted)
                    } else {
                        Text(statusText)
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.textMuted)
                        if !isEnded { RingingDots() }
                    }
                }
                .padding(.top, Theme.Layout.spacing2)

                Spacer()

                if !isEnded { controls }

                HStack(spacing: 5) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 9))
                    Text("Encrypted in transit")
                        .font(Theme.Typography.micro)
                }
                .foregroundStyle(Theme.Color.textMuted.opacity(0.35))
                .padding(.bottom, Theme.Layout.spacing5)
            }
        }
    }

    // MARK: Chrome

    private func topBar(title: String, subtitle: String? = nil) -> some View {
        HStack {
            Button {
                calls.minimise()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Theme.Color.text.opacity(0.8))
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Minimise call")

            Spacer()

            VStack(spacing: 2) {
                Text(title)
                    .font(Theme.Typography.font(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                HStack(spacing: 5) {
                    NetworkQualityDot(quality: calls.networkQuality)
                    Text([subtitle, statusText].compactMap { $0 }.joined(separator: " · "))
                        .font(Theme.Typography.micro.monospacedDigit())
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }

            Spacer()

            if calls.isVideoCall && calls.isCameraOn {
                Button {
                    calls.flipCamera()
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath.camera")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Theme.Color.text.opacity(0.8))
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                }
                .accessibilityLabel("Switch camera")
            } else {
                Color.clear.frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
        }
        .padding(.horizontal, Theme.Layout.spacing2)
        .padding(.top, Theme.Layout.spacing2)
        .background(
            LinearGradient(
                colors: [Color.black.opacity(0.55), .clear],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    private var controls: some View {
        VStack(spacing: Theme.Layout.spacing5) {
            HStack(spacing: Theme.Layout.spacing4) {
                CallToggleButton(
                    systemImage: calls.isMuted ? "mic.slash.fill" : "mic.fill",
                    label: calls.isMuted ? "Unmute" : "Mute",
                    isEngaged: calls.isMuted,
                    isEnabled: isConnected
                ) { calls.toggleMute() }

                if calls.isVideoCall {
                    CallToggleButton(
                        systemImage: calls.isCameraOn ? "video.fill" : "video.slash.fill",
                        label: "Camera",
                        isEngaged: !calls.isCameraOn,
                        isEnabled: isConnected
                    ) { calls.toggleCamera() }
                }

                CallToggleButton(
                    systemImage: calls.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.fill",
                    label: "Speaker",
                    isEngaged: calls.isSpeakerOn
                ) { calls.toggleSpeaker() }
            }

            CallActionButton(
                systemImage: "phone.down.fill",
                tint: Theme.Color.danger,
                label: "End"
            ) { calls.hangUp() }
        }
        .padding(.vertical, Theme.Layout.spacing5)
        .frame(maxWidth: .infinity)
        .background(Theme.Color.bg.opacity(0.8))
    }
}

// MARK: - Minimised

/// The minimised call. Rendered (and dragged) by `CallOverlayHost`, which owns its
/// position — this is only the content.
struct MinimisedCallPill: View {
    @EnvironmentObject private var calls: CallStore

    /// Whoever is talking, so a group call does not always minimise to the first
    /// participant who happened to join.
    private var featured: CallParticipantState? {
        calls.participants.first { $0.isSpeaking } ?? calls.participants.first
    }

    private var status: String {
        if case .active = calls.phase { return calls.elapsedLabel }
        if case .outgoing = calls.phase { return "Ringing…" }
        return "Connecting…"
    }

    /// True when the featured participant has a frame worth showing. A video call
    /// still uses the video *layout* when this is false — `CallOverlayHost` sizes the
    /// window from `isVideoCall` alone, and a layout that changed width the instant a
    /// camera came up would jump out from under the user's finger.
    private var hasFrame: Bool {
        guard let featured, featured.videoTrack != nil else { return false }
        return !featured.isCameraOff || featured.isScreenShare
    }

    var body: some View {
        VStack(spacing: 0) {
            Button {
                calls.restore()
            } label: {
                if calls.isVideoCall {
                    ZStack(alignment: .topLeading) {
                        if hasFrame, let featured {
                            CallVideoView(track: featured.videoTrack, fitsContent: featured.isScreenShare)
                        } else {
                            ZStack {
                                Theme.Color.surface
                                Avatar(name: calls.peerName, urlPath: calls.peerAvatarPath, size: 56)
                            }
                        }
                        HStack(spacing: 4) {
                            Circle()
                                .fill(Theme.Color.primary)
                                .frame(width: 6, height: 6)
                            Text(status)
                                .font(Theme.Typography.micro.monospacedDigit())
                                .foregroundStyle(Theme.Color.text)
                        }
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(Color.black.opacity(0.6)))
                        .padding(5)
                    }
                    .frame(width: 132, height: 148)
                } else {
                    HStack(spacing: Theme.Layout.spacing2) {
                        ZStack {
                            Circle().fill(Theme.Color.primaryTint)
                            Image(systemName: "mic.fill")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.Color.primary)
                        }
                        .frame(width: 32, height: 32)

                        VStack(alignment: .leading, spacing: 1) {
                            Text(calls.peerName)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(Theme.Color.text)
                                .lineLimit(1)
                            Text(status)
                                .font(Theme.Typography.micro.monospacedDigit())
                                .foregroundStyle(Theme.Color.primary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, Theme.Layout.spacing2)
                    .padding(.top, Theme.Layout.spacing2)
                    .frame(width: 200, alignment: .leading)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Return to call")

            // Controls are siblings of the restore button, not nested inside it: a
            // button inside a button swallows the inner tap.
            HStack(spacing: Theme.Layout.spacing2) {
                Spacer(minLength: 0)
                Button {
                    calls.toggleMute()
                } label: {
                    Image(systemName: calls.isMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Color.text)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(calls.isMuted ? Theme.Color.danger : Theme.Color.border2))
                }
                .accessibilityLabel(calls.isMuted ? "Unmute microphone" : "Mute microphone")

                Button {
                    calls.hangUp()
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.Color.text)
                        .frame(width: 28, height: 28)
                        .background(Circle().fill(Theme.Color.danger))
                }
                .accessibilityLabel("End call")
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 6)
        }
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Theme.Color.sidebar)
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(Theme.Color.primary.opacity(0.4), lineWidth: 1)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: Theme.Shadow.modal.color, radius: 18, y: 10)
    }
}

// MARK: - Grid

/// The group-call tile grid: 1 = full, 2 = split, 3–4 = 2×2, 5+ = scrollable.
struct VideoGrid: View {
    @EnvironmentObject private var calls: CallStore
    @EnvironmentObject private var auth: AuthStore

    /// Local first, then remotes in the store's (name-sorted) order.
    private var tiles: [Tile] {
        var result: [Tile] = [
            Tile(
                id: auth.currentUser?.id ?? "local",
                name: "You",
                avatarPath: auth.currentUser?.avatarURL,
                track: calls.isCameraOn ? calls.localVideoTrack : nil,
                isMuted: calls.isMuted,
                isCameraOff: !calls.isCameraOn,
                isSpeaking: false,
                isScreenShare: false,
                isLocal: true,
                hasMedia: true
            )
        ]
        result.append(contentsOf: calls.participants.map { participant in
            Tile(
                id: participant.id,
                name: participant.displayName,
                avatarPath: participant.avatarPath,
                track: participant.isCameraOff && !participant.isScreenShare ? nil : participant.videoTrack,
                isMuted: participant.isMuted,
                isCameraOff: participant.isCameraOff,
                isSpeaking: participant.isSpeaking,
                isScreenShare: participant.isScreenShare,
                isLocal: false,
                hasMedia: participant.hasMedia
            )
        })
        return result
    }

    var body: some View {
        GeometryReader { geometry in
            layout(for: tiles, availableHeight: geometry.size.height)
        }
    }

    @ViewBuilder
    private func layout(for tiles: [Tile], availableHeight: CGFloat) -> some View {
        switch tiles.count {
        case 1:
            VideoTile(tile: tiles[0])
                .padding(2)

        case 2:
            // Stacked, not side-by-side: two half-height tiles on a portrait phone
            // are far closer to a 16:9 frame than two half-width ones.
            VStack(spacing: 2) {
                ForEach(tiles) { VideoTile(tile: $0) }
            }
            .padding(2)

        case 3, 4:
            VStack(spacing: 2) {
                ForEach(Array(stride(from: 0, to: tiles.count, by: 2)), id: \.self) { row in
                    HStack(spacing: 2) {
                        ForEach(tiles[row..<min(row + 2, tiles.count)]) { VideoTile(tile: $0) }
                        // Keep a lone tile at half width, so a 3-person call does not
                        // have one tile twice the size of the other two.
                        if row + 2 > tiles.count { Color.clear }
                    }
                }
            }
            .padding(2)

        default:
            ScrollView {
                LazyVGrid(columns: [GridItem(spacing: 2), GridItem(spacing: 2)], spacing: 2) {
                    ForEach(tiles) { tile in
                        VideoTile(tile: tile)
                            .frame(height: max(120, availableHeight / 3))
                    }
                }
                .padding(2)
            }
        }
    }

    struct Tile: Identifiable {
        let id: String
        let name: String
        let avatarPath: String?
        let track: VideoTrack?
        let isMuted: Bool
        let isCameraOff: Bool
        let isSpeaking: Bool
        let isScreenShare: Bool
        let isLocal: Bool
        let hasMedia: Bool
    }
}

private struct VideoTile: View {
    let tile: VideoGrid.Tile

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .fill(Theme.Color.surface)

            if let track = tile.track {
                CallVideoView(track: track, fitsContent: tile.isScreenShare, mirrored: tile.isLocal)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusCard))
            } else {
                VStack(spacing: Theme.Layout.spacing2) {
                    Avatar(name: tile.name, urlPath: tile.avatarPath, size: 64)
                    if !tile.hasMedia {
                        Text("Connecting…")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
            }

            VStack {
                Spacer()
                HStack(spacing: 5) {
                    if tile.isScreenShare {
                        Image(systemName: "rectangle.inset.filled.on.rectangle")
                            .font(.system(size: 10))
                            .foregroundStyle(Theme.Color.primary)
                    }
                    Text(tile.isLocal ? "You" : tile.name)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if tile.isMuted {
                        Image(systemName: "mic.slash.fill")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(Theme.Color.text)
                            .frame(width: 20, height: 20)
                            .background(Circle().fill(Theme.Color.danger))
                    }
                }
                .padding(.horizontal, Theme.Layout.spacing2)
                .padding(.vertical, 6)
                .background(
                    LinearGradient(colors: [.clear, Color.black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                )
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusCard))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .stroke(tile.isSpeaking ? Theme.Color.primary : .clear, lineWidth: 2)
        )
    }
}
