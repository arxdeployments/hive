import AVFoundation
import Foundation
import os
import SwiftUI

/// Records a voice note to AAC-in-MP4 (`.m4a`), with pause, resume and preview.
///
/// The container is not a preference. The backend classifies an upload by its file
/// **extension** (`app/services/storage.py`), and the web client's
/// `utils/audioFormat.js` documents the trap in detail: `.webm` is in the server's
/// VIDEO extension set, so a voice note named `voice.webm` comes back classified as a
/// video and renders in the wrong bubble. `.m4a` is in the audio set, maps to
/// `audio/mp4`, and AAC-in-MP4 plays natively on every client that can receive it —
/// which matters because a note recorded here has to be playable in Safari.
///
/// ## Why segments rather than one file
///
/// `AVAudioRecorder` does have `pause()`/`record()`, which would keep everything in a
/// single file — but a paused MP4 has no finalised `moov` atom, so `AVAudioPlayer`
/// cannot open it. That kills the whole point of pausing: reviewing what you have so
/// far before you send it.
///
/// So each record→pause cycle writes its own finalised segment, and the segments are
/// stitched with `AVMutableComposition`. Preview plays the composition directly (no
/// export). Send exports it once to a single `.m4a`. A recording that was never paused
/// takes a fast path that skips the export entirely and re-encodes nothing.
@MainActor
final class AudioRecorder: ObservableObject {

    enum Phase: Equatable {
        case idle
        case recording
        /// Stopped but not discarded: the preview player and the resume button live here.
        case paused
    }

    @Published private(set) var phase: Phase = .idle
    /// Total captured length across every segment, including the one in progress.
    @Published private(set) var elapsed: TimeInterval = 0
    /// Every microphone sample taken so far, normalised 0…1, oldest first.
    ///
    /// The whole history rather than a window, because the paused state draws the
    /// shape of the *entire* recording, not just its tail.
    @Published private(set) var levels: [Float] = []

    /// Below this a press reads as a mis-tap on the mic rather than a message.
    static let minimumDuration: TimeInterval = 0.6

    /// Bars in the live meter, and therefore the width of its scrolling window: at the
    /// 60ms sample interval, ~4.8 seconds of history.
    ///
    /// Sized to fill the hands-free bar edge to edge. `WaveformView` draws this many
    /// bars across whatever width it is given (see its `capacity`), so the number is a
    /// choice about how much time the meter shows, not about how wide it looks. It was
    /// 40, which at a fixed bar pitch covered only half the screen.
    static let liveWindow = 80
    private static let sampleInterval: Duration = .milliseconds(60)

    var isRecording: Bool { phase == .recording }
    /// Anything other than idle: the composer swaps to the recorder bar on this.
    var isActive: Bool { phase != .idle }

    /// The tail of `levels`, for the live meter.
    var liveLevels: [Float] {
        levels.suffix(Self.liveWindow)
    }

    private var recorder: AVAudioRecorder?
    /// Finalised segments, in order.
    private var segments: [URL] = []
    /// Length of `segments`; the in-progress recorder's time is added on top.
    private var completedDuration: TimeInterval = 0
    private var ticker: Task<Void, Never>?
    private var interruptionObserver: NSObjectProtocol?

    /// What the audio session looked like before we took it over.
    private var previousCategory: AVAudioSession.Category?
    private var previousMode: AVAudioSession.Mode?
    private var previousOptions: AVAudioSession.CategoryOptions = []

    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "audio")

    /// True once the user has said no. The caller uses this to send them to Settings
    /// instead of re-prompting, because iOS only ever asks once.
    var isPermissionDenied: Bool {
        AVAudioApplication.shared.recordPermission == .denied
    }

    // MARK: - Permission

    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    // MARK: - Lifecycle

    /// Begin a new recording, discarding anything held from before.
    @discardableResult
    func start() -> Bool {
        guard phase == .idle else { return phase == .recording }
        discardSegments()
        completedDuration = 0
        elapsed = 0
        levels = []
        guard activateSession() else { return false }
        guard startSegment() else {
            restoreSession()
            return false
        }
        phase = .recording
        startTicking()
        observeInterruptions()
        return true
    }

    /// Stop capturing but keep what we have. Finalises the current segment so the
    /// preview player can open it.
    func pause() {
        guard phase == .recording, let recorder else { return }
        completedDuration += recorder.currentTime
        recorder.stop()
        self.recorder = nil
        ticker?.cancel()
        ticker = nil
        elapsed = completedDuration
        phase = .paused
        // The session stays active: the user is about to either resume or preview,
        // and tearing it down between the two produces an audible click.
    }

    /// Continue into a new segment.
    @discardableResult
    func resume() -> Bool {
        guard phase == .paused else { return false }
        guard activateSession(), startSegment() else { return false }
        phase = .recording
        startTicking()
        return true
    }

    /// Finish and hand back one file. nil when nothing usable was captured — a muted
    /// device, or a press too short to be a message — in which case temporary files
    /// have already been cleaned up.
    ///
    /// Async because stitching segments is an export. The single-segment case, which
    /// is the overwhelming majority, returns without exporting.
    func finish() async -> (url: URL, duration: TimeInterval)? {
        if phase == .recording, let recorder {
            // Read the length BEFORE stopping: `currentTime` reports 0 on a stopped
            // recorder, which silently sent every voice note with duration 0.
            completedDuration += recorder.currentTime
            recorder.stop()
        }
        self.recorder = nil
        let captured = segments
        let duration = completedDuration
        teardown()

        guard duration >= Self.minimumDuration, !captured.isEmpty else {
            captured.forEach { try? FileManager.default.removeItem(at: $0) }
            segments = []
            return nil
        }

        // One segment: nothing to stitch, so hand the file over untouched rather than
        // re-encoding it.
        if captured.count == 1 {
            let url = captured[0]
            segments = []
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size > 0 else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return (url, duration)
        }

        guard let merged = await export(segments: captured) else {
            log.error("Merging \(captured.count) voice-note segments failed")
            captured.forEach { try? FileManager.default.removeItem(at: $0) }
            segments = []
            return nil
        }
        captured.forEach { try? FileManager.default.removeItem(at: $0) }
        segments = []
        return (merged, duration)
    }

    /// Throw everything away and release the microphone.
    func cancel() {
        recorder?.stop()
        recorder = nil
        teardown()
        discardSegments()
        completedDuration = 0
    }

    // MARK: - Preview

    /// An asset spanning every captured segment, for reviewing while paused.
    ///
    /// A composition rather than a merged file: `AVPlayerItem` plays one directly, so
    /// pausing does not have to pay for an export the user may never send.
    func previewAsset() -> AVAsset? {
        guard !segments.isEmpty else { return nil }
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { return nil }

        var cursor = CMTime.zero
        for url in segments {
            let asset = AVURLAsset(url: url)
            // Deprecated sync accessor on purpose: this runs on already-written local
            // files, and the async loader would make `previewAsset()` async for every
            // caller including the ones that just need a duration.
            guard let source = asset.tracks(withMediaType: .audio).first else { continue }
            let range = CMTimeRange(start: .zero, duration: asset.duration)
            try? track.insertTimeRange(range, of: source, at: cursor)
            cursor = CMTimeAdd(cursor, asset.duration)
        }
        return cursor > .zero ? composition : nil
    }

    // MARK: - Internals

    private func startSegment() -> Bool {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(
            "voice-\(UUID().uuidString).m4a"
        )
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            // Mono at 32 kbps: speech at this bitrate is clean, and a 60-second note
            // is ~240 KB against a 200 MB server cap. The web recorder picks the same
            // numbers, so the two clients produce comparable files.
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            guard recorder.record() else {
                log.error("AVAudioRecorder refused to start")
                return false
            }
            self.recorder = recorder
            segments.append(url)
            return true
        } catch {
            log.error("Could not create recorder: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private func activateSession() -> Bool {
        let session = AVAudioSession.sharedInstance()
        if previousCategory == nil {
            previousCategory = session.category
            previousMode = session.mode
            previousOptions = session.categoryOptions
        }
        do {
            // `.playAndRecord` rather than `.record` so the recording can be reviewed
            // without a category switch mid-flow; `.defaultToSpeaker` keeps that
            // playback out of the earpiece.
            try session.setCategory(
                .playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker]
            )
            try session.setActive(true)
            return true
        } catch {
            log.error("Audio session refused record mode: \(error.localizedDescription, privacy: .public)")
            restoreSession()
            return false
        }
    }

    /// Common teardown. Leaves `segments` alone — `finish` consumes them and `cancel`
    /// deletes them.
    private func teardown() {
        ticker?.cancel()
        ticker = nil
        stopObservingInterruptions()
        phase = .idle
        elapsed = 0
        levels = []
        restoreSession()
    }

    private func discardSegments() {
        segments.forEach { try? FileManager.default.removeItem(at: $0) }
        segments = []
    }

    /// Put the audio session back the way we found it.
    ///
    /// Not housekeeping: leaving the session in `.playAndRecord` routes later playback
    /// through the quiet receiver path, so every voice note played *after* a recording
    /// sounds broken until the app is relaunched.
    private func restoreSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setActive(false, options: [.notifyOthersOnDeactivation])
            if let previousCategory {
                try session.setCategory(
                    previousCategory, mode: previousMode ?? .default, options: previousOptions
                )
            }
        } catch {
            log.notice("Could not restore audio session: \(error.localizedDescription, privacy: .public)")
        }
        previousCategory = nil
        previousMode = nil
        previousOptions = []
    }

    private func startTicking() {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.sampleInterval)
                guard let self, self.phase == .recording, let recorder = self.recorder else { return }
                recorder.updateMeters()
                self.elapsed = self.completedDuration + recorder.currentTime
                self.levels.append(Self.normalise(recorder.averagePower(forChannel: 0)))
            }
        }
    }

    /// A phone call (or Siri) takes the microphone away mid-recording. Without this the
    /// timer keeps counting against a recorder that has stopped capturing, and the user
    /// sends silence.
    ///
    /// Pauses rather than cancels: the user still has whatever was captured before the
    /// interruption, and throwing away a half-finished message without asking is worse
    /// than handing it back paused.
    private func observeInterruptions() {
        stopObservingInterruptions()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard
                let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                AVAudioSession.InterruptionType(rawValue: raw) == .began
            else { return }
            Task { @MainActor in self?.pause() }
        }
    }

    private func stopObservingInterruptions() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
    }

    /// Stitch segments into one `.m4a`.
    private func export(segments: [URL]) async -> URL? {
        let composition = AVMutableComposition()
        guard let track = composition.addMutableTrack(
            withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid
        ) else { return nil }

        var cursor = CMTime.zero
        for url in segments {
            let asset = AVURLAsset(url: url)
            guard let source = asset.tracks(withMediaType: .audio).first else { continue }
            do {
                try track.insertTimeRange(
                    CMTimeRange(start: .zero, duration: asset.duration), of: source, at: cursor
                )
                cursor = CMTimeAdd(cursor, asset.duration)
            } catch {
                log.error("Could not append segment: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        guard cursor > .zero else { return nil }

        let output = FileManager.default.temporaryDirectory.appendingPathComponent(
            "voice-\(UUID().uuidString).m4a"
        )
        // AppleM4A is the only preset that produces the AAC-in-MP4 the server's
        // extension map expects; a passthrough export would keep the segment
        // boundaries as separate edits.
        guard let session = AVAssetExportSession(
            asset: composition, presetName: AVAssetExportPresetAppleM4A
        ) else { return nil }
        session.outputURL = output
        session.outputFileType = .m4a

        await withCheckedContinuation { continuation in
            session.exportAsynchronously { continuation.resume() }
        }
        guard session.status == .completed else {
            log.error("Export failed: \(session.error?.localizedDescription ?? "unknown", privacy: .public)")
            try? FileManager.default.removeItem(at: output)
            return nil
        }
        return output
    }

    /// dBFS (-160…0) to 0…1. Floored at -50 dB rather than the full range: real room
    /// noise sits around -40, so a linear map from -160 would render every bar flat.
    private static func normalise(_ decibels: Float) -> Float {
        guard decibels.isFinite else { return 0 }
        let floorDB: Float = -50
        let clamped = max(floorDB, min(0, decibels))
        return (clamped - floorDB) / -floorDB
    }
}
