import AVFoundation
import Foundation
import os
import SwiftUI

/// Records a voice note to AAC-in-MP4 (`.m4a`).
///
/// The container is not a preference. The backend classifies an upload by its file
/// **extension** (`app/services/storage.py`), and the web client's
/// `utils/audioFormat.js` documents the trap in detail: `.webm` is in the server's
/// VIDEO extension set, so a voice note named `voice.webm` comes back classified as a
/// video and renders in the wrong bubble. `.m4a` is in the audio set, maps to
/// `audio/mp4`, and AAC-in-MP4 plays natively on every client that can receive it —
/// which matters because a note recorded here has to be playable in Safari.
///
/// Duration is measured from `AVAudioRecorder.currentTime` and sent with the message,
/// so a bubble can print "0:34" without downloading the file.
@MainActor
final class AudioRecorder: ObservableObject {

    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: TimeInterval = 0
    /// Recent microphone levels, normalised 0…1, oldest first. Drives the waveform.
    @Published private(set) var levels: [Float] = []

    /// Below this a press reads as a mis-tap on the mic rather than a recording, and
    /// the caller is expected to discard it.
    static let minimumDuration: TimeInterval = 0.6

    /// How many bars the waveform keeps. At the 60ms sample interval this is a
    /// ~2.4s window, which is enough movement to read as "live" without the bars
    /// getting too thin to see.
    private static let levelWindow = 40
    private static let sampleInterval: Duration = .milliseconds(60)

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
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

    /// Ask for the microphone, or answer immediately from the standing decision.
    ///
    /// Wrapped in a continuation rather than relying on the async overload so this
    /// compiles the same way regardless of how the SDK surfaces the callback API.
    func requestPermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        default:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    // MARK: - Lifecycle

    /// Begin recording. Returns false if the session or the recorder refused, in
    /// which case nothing has been left running.
    @discardableResult
    func start() -> Bool {
        guard !isRecording else { return true }

        let session = AVAudioSession.sharedInstance()
        previousCategory = session.category
        previousMode = session.mode
        previousOptions = session.categoryOptions
        do {
            // `.playAndRecord` rather than `.record` so the recording can be reviewed
            // and so a call ringtone is not silenced mid-press; `.defaultToSpeaker`
            // keeps playback out of the earpiece afterwards.
            try session.setCategory(
                .playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker]
            )
            try session.setActive(true)
        } catch {
            log.error("Audio session refused record mode: \(error.localizedDescription, privacy: .public)")
            restoreSession()
            return false
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(Int(Date().timeIntervalSince1970)).m4a")
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
                restoreSession()
                return false
            }
            self.recorder = recorder
            self.fileURL = url
        } catch {
            log.error("Could not create recorder: \(error.localizedDescription, privacy: .public)")
            restoreSession()
            return false
        }

        isRecording = true
        elapsed = 0
        levels = []
        startTicking()
        observeInterruptions()
        return true
    }

    /// Finish and hand back the file. nil when nothing usable was captured — a muted
    /// device, or a press too short to be a message — in which case the file has
    /// already been deleted.
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let recorder, let fileURL else {
            finish()
            return nil
        }
        // Read the length BEFORE stopping: `currentTime` reports 0 on a stopped
        // recorder, which silently sent every voice note with duration 0.
        let duration = recorder.currentTime
        recorder.stop()
        finish()
        self.fileURL = nil

        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attributes?[.size] as? NSNumber)?.intValue ?? 0
        guard duration >= Self.minimumDuration, size > 0 else {
            try? FileManager.default.removeItem(at: fileURL)
            return nil
        }
        return (fileURL, duration)
    }

    /// Throw the recording away and release the microphone.
    func cancel() {
        recorder?.stop()
        finish()
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
    }

    // MARK: - Internals

    /// Common teardown for both exit paths. Leaves `fileURL` alone — `stop` needs it
    /// and `cancel` deletes it.
    private func finish() {
        ticker?.cancel()
        ticker = nil
        stopObservingInterruptions()
        recorder = nil
        isRecording = false
        elapsed = 0
        levels = []
        restoreSession()
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
                guard let self, self.isRecording, let recorder = self.recorder else { return }
                recorder.updateMeters()
                self.elapsed = recorder.currentTime
                var next = self.levels
                next.append(Self.normalise(recorder.averagePower(forChannel: 0)))
                if next.count > Self.levelWindow { next.removeFirst(next.count - Self.levelWindow) }
                self.levels = next
            }
        }
    }

    /// A phone call (or Siri) takes the microphone away mid-recording. Without this
    /// the timer keeps counting against a recorder that has stopped capturing, and the
    /// user sends silence.
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
            Task { @MainActor in self?.cancel() }
        }
    }

    private func stopObservingInterruptions() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
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
