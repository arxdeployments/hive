import AVFoundation
import SwiftUI

/// The composer's voice-note surface, in three states.
///
/// Ported from the reference's flow rather than invented:
///
///  1. **`.holding`** — the finger is still on the mic. A pulsing red mic, the elapsed
///     time, and "slide to cancel ‹". Releasing sends; sliding left cancels; sliding up
///     locks.
///  2. **`.locked`** — hands-free. The live meter fills the bar, with trash / pause /
///     send beneath it.
///  3. **`.paused`** — a preview player over what has been captured, with trash /
///     resume / send. This is why the recorder writes segments: a paused MP4 cannot be
///     opened for playback, so each pause finalises one.
///
/// The gesture state lives in `MessageComposer`, which owns the mic button the gesture
/// starts on. This view is told what mode to be in.
struct VoiceRecorderBar: View {

    enum Mode: Equatable {
        case holding(dragX: CGFloat, dragY: CGFloat)
        case locked
        case paused
    }

    @ObservedObject var recorder: AudioRecorder
    let mode: Mode
    let onCancel: () -> Void
    let onPause: () -> Void
    let onResume: () -> Void
    let onSend: () -> Void

    @StateObject private var preview = VoiceNotePreviewPlayer()
    @State private var pulse = false

    /// Past this much leftward travel the recording is discarded. Matched to the
    /// reference's feel: far enough that a wobble while speaking is safe, close enough
    /// to reach with the thumb still on the mic.
    static let cancelThreshold: CGFloat = 90
    /// Upward travel that locks into hands-free.
    static let lockThreshold: CGFloat = 55

    var body: some View {
        Group {
            switch mode {
            case .holding(let dragX, _):
                holdingStrip(dragX: dragX)
            case .locked:
                lockedBar
            case .paused:
                pausedBar
            }
        }
        .animation(Theme.Motion.ease, value: mode)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { pulse = true }
        }
        .onChange(of: mode) { _, new in
            // Leaving the paused state must stop the preview: resuming a recording while
            // its own playback is still running feeds the speaker into the microphone.
            if new != .paused { preview.stop() }
        }
        .onDisappear { preview.stop() }
    }

    // MARK: - 1. Holding

    private func holdingStrip(dragX: CGFloat) -> some View {
        // Fades toward the cancel threshold, so the gesture tells you how close you are
        // rather than discarding the note as a surprise.
        let travel = min(max(-dragX, 0), Self.cancelThreshold)
        let fade = 1 - (travel / Self.cancelThreshold) * 0.65

        return HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: "mic.fill")
                .font(.system(size: 20))
                .foregroundStyle(Theme.Color.danger)
                .opacity(pulse ? 1 : 0.35)

            Text(MediaFormatting.durationLabel(recorder.elapsed) ?? "0:00")
                .font(Theme.Typography.font(size: 17, weight: .regular))
                .foregroundStyle(Theme.Color.text)
                .monospacedDigit()

            Spacer()

            HStack(spacing: 4) {
                Text("slide to cancel")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            // The label rides with the finger, which is the affordance: the text moves
            // toward the thumb as the thumb moves toward it.
            .offset(x: -travel * 0.5)

            Spacer()
        }
        .opacity(fade)
        .padding(.horizontal, Theme.Layout.spacing4)
        .frame(height: 56)
    }

    /// The lock affordance that floats above the mic button while holding.
    ///
    /// Separate from `holdingStrip` because it is anchored to the button, not to the
    /// bar — the composer overlays it.
    static func lockAffordance(dragY: CGFloat) -> some View {
        let travel = min(max(-dragY, 0), lockThreshold)
        let armed = travel >= lockThreshold * 0.75

        return VStack(spacing: Theme.Layout.spacing2) {
            Image(systemName: armed ? "lock.fill" : "lock.open")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(armed ? Theme.Color.primary : Theme.Color.textMuted)
            Image(systemName: "chevron.up")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.Color.textMuted)
                .opacity(armed ? 0 : 1)
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.top, Theme.Layout.spacing3)
        .padding(.bottom, Theme.Layout.spacing4 + 44)
        .background(
            Capsule().fill(Theme.Color.surface2)
                .overlay(Capsule().stroke(Theme.Color.border2, lineWidth: 1))
        )
        .offset(y: -travel * 0.4)
        .allowsHitTesting(false)
    }

    // MARK: - 2. Locked

    private var lockedBar: some View {
        VStack(spacing: Theme.Layout.spacing4) {
            HStack(spacing: Theme.Layout.spacing3) {
                Text(MediaFormatting.durationLabel(recorder.elapsed) ?? "0:00")
                    .font(Theme.Typography.font(size: 17, weight: .regular))
                    .foregroundStyle(Theme.Color.text)
                    .monospacedDigit()

                // The live meter. Grows in from the right so the newest sound is nearest
                // the mic button, and every bar is a real microphone reading. `capacity`
                // makes the window span the whole bar rather than drawing at a fixed
                // pitch and stopping halfway across.
                WaveformView(
                    samples: recorder.liveLevels,
                    progress: 0,
                    playedColor: Theme.Color.text,
                    pendingColor: Theme.Color.text.opacity(0.75),
                    alignsToTrailing: true,
                    capacity: AudioRecorder.liveWindow
                )
                .frame(maxWidth: .infinity)
                .frame(height: 30)
            }

            HStack {
                controlButton("trash", tint: Theme.Color.text, label: "Delete recording", action: onCancel)
                Spacer()
                Button(action: onPause) {
                    Image(systemName: "pause.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Color.danger)
                        .frame(width: 52, height: 52)
                        .overlay(Circle().stroke(Theme.Color.danger, lineWidth: 2))
                }
                .accessibilityLabel("Pause recording")
                Spacer()
                sendButton
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
    }

    // MARK: - 3. Paused

    private var pausedBar: some View {
        VStack(spacing: Theme.Layout.spacing4) {
            HStack(spacing: Theme.Layout.spacing3) {
                Button {
                    preview.toggle(asset: recorder.previewAsset(), duration: recorder.elapsed)
                } label: {
                    Image(systemName: preview.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Color.text)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel(preview.isPlaying ? "Pause preview" : "Play preview")

                WaveformView(
                    samples: recorder.levels,
                    progress: preview.progress,
                    playedColor: Theme.Color.text,
                    pendingColor: Theme.Color.text.opacity(0.35),
                    showsHandle: true,
                    handleColor: Theme.Color.primary
                )
                .frame(height: 28)

                Text(MediaFormatting.durationLabel(preview.isPlaying ? preview.currentTime : recorder.elapsed) ?? "0:00")
                    .font(Theme.Typography.font(size: 15, weight: .regular))
                    .foregroundStyle(Theme.Color.text)
                    .monospacedDigit()
            }
            .padding(.horizontal, Theme.Layout.spacing3)
            .padding(.vertical, Theme.Layout.spacing2)
            .background(
                Capsule().fill(Theme.Color.surface2)
                    .overlay(Capsule().stroke(Theme.Color.border2, lineWidth: 1))
            )

            HStack {
                controlButton("trash", tint: Theme.Color.text, label: "Delete recording", action: onCancel)
                Spacer()
                Button {
                    preview.stop()
                    onResume()
                } label: {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(Theme.Color.danger)
                        .frame(width: 52, height: 52)
                }
                .accessibilityLabel("Continue recording")
                Spacer()
                sendButton
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
    }

    // MARK: - Shared controls

    private var sendButton: some View {
        Button(action: onSend) {
            Image(systemName: "paperplane.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.Color.onPrimary)
                .frame(width: 52, height: 52)
                .background(Circle().fill(Theme.Color.primary))
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Send voice message")
    }

    private func controlButton(
        _ systemImage: String,
        tint: Color,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 19))
                .foregroundStyle(tint)
                .frame(width: 52, height: 52)
                .contentShape(Rectangle())
        }
        .accessibilityLabel(label)
    }
}

/// Plays back the in-progress recording while it is paused.
///
/// `AVPlayer` over the recorder's `AVMutableComposition`, not `AVAudioPlayer`: the
/// segments are separate files, and a composition is the only thing that presents them
/// as one continuous asset without paying for an export the user may never send.
@MainActor
final class VoiceNotePreviewPlayer: ObservableObject {

    @Published private(set) var isPlaying = false
    @Published private(set) var currentTime: TimeInterval = 0
    @Published private(set) var progress: Double = 0

    private var player: AVPlayer?
    private var ticker: Task<Void, Never>?
    private var total: TimeInterval = 0

    func toggle(asset: AVAsset?, duration: TimeInterval) {
        if isPlaying { pause(); return }
        guard let asset else { return }
        total = max(duration, 0.01)

        if player == nil {
            let item = AVPlayerItem(asset: asset)
            player = AVPlayer(playerItem: item)
        }
        // Restart from the top once it has run to the end, rather than requiring a
        // second tap that appears to do nothing.
        if progress >= 0.999 {
            player?.seek(to: .zero)
            currentTime = 0
            progress = 0
        }
        player?.play()
        isPlaying = true
        startTicking()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        ticker?.cancel()
        ticker = nil
    }

    func stop() {
        pause()
        player = nil
        currentTime = 0
        progress = 0
    }

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                guard let self, let player = self.player else { return }
                let seconds = player.currentTime().seconds
                guard seconds.isFinite else { continue }
                self.currentTime = seconds
                self.progress = min(1, seconds / self.total)
                if self.progress >= 0.999 {
                    self.pause()
                    return
                }
            }
        }
    }
}
