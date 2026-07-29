import AVFoundation
import Foundation
import SwiftUI

/// The bar waveform used by voice notes, both while recording and in a sent bubble.
///
/// One view for both jobs so the recording meter and the played-back note look like the
/// same object: the bars you watched while speaking are the bars you scrub afterwards.
struct WaveformView: View {

    /// Amplitudes 0…1, oldest first. Resampled to fit whatever width it gets.
    let samples: [Float]
    /// 0…1. Bars before this are "played"; bars after are pending.
    var progress: Double = 0
    var playedColor: Color = .white
    var pendingColor: Color = .white.opacity(0.4)
    var barWidth: CGFloat = 2.5
    var spacing: CGFloat = 2
    /// Draw the scrub handle. Off for the live recording meter, which has nothing to
    /// scrub to.
    var showsHandle: Bool = false
    var handleColor: Color = .white
    /// Live meters grow from the right as samples arrive; a static waveform fills the
    /// width and stays put.
    var alignsToTrailing: Bool = false
    /// How many bars the full width represents, for a meter whose sample count is a
    /// fixed *time* window rather than a function of the view's width.
    ///
    /// Without this the live meter drew at a fixed 4.5pt pitch, so it covered only
    /// `samples.count × 4.5` points and left the rest of the bar empty — half the
    /// screen, at the 40-sample window it used to have. Deriving the pitch from the
    /// width instead makes a full window span the bar on any device, phone or iPad,
    /// and a partly-filled one grow in from the right at its final pitch rather than
    /// re-flowing every time a sample lands.
    var capacity: Int?

    var body: some View {
        GeometryReader { geo in
            let count = capacity ?? max(1, Int((geo.size.width + spacing) / (barWidth + spacing)))
            let pitch = capacity == nil ? barWidth + spacing : geo.size.width / CGFloat(max(1, count))
            // 0.55 of the pitch, which is the ratio the fixed 2.5pt bar and 2pt gap
            // already had — so a phone-width meter looks exactly as it did, just
            // spanning the whole bar.
            let width = capacity == nil ? barWidth : max(1, pitch * 0.55)
            let gap = capacity == nil ? spacing : pitch - width

            let bars = Self.resample(samples, to: count, padToWidth: !alignsToTrailing)
            let playedCount = Int((Double(bars.count) * progress).rounded())

            HStack(alignment: .center, spacing: gap) {
                ForEach(Array(bars.enumerated()), id: \.offset) { index, value in
                    Capsule()
                        .fill(index < playedCount ? playedColor : pendingColor)
                        .frame(
                            width: width,
                            // A floor of 2pt: a silent stretch must still read as part
                            // of the waveform rather than as a gap in it.
                            height: max(2, CGFloat(value) * geo.size.height)
                        )
                }
            }
            .frame(
                width: geo.size.width,
                height: geo.size.height,
                alignment: alignsToTrailing ? .trailing : .leading
            )
            .overlay(alignment: .leading) {
                if showsHandle, !bars.isEmpty {
                    Circle()
                        .fill(handleColor)
                        .frame(width: 10, height: 10)
                        .offset(x: geo.size.width * CGFloat(min(max(progress, 0), 1)) - 5)
                }
            }
        }
    }

    /// Fit `samples` to `count` bars.
    ///
    /// Averaging buckets rather than picking every nth sample: a voice note is mostly
    /// quiet with peaks, and nth-sampling drops the peaks at random so the same
    /// recording draws a different shape at different widths.
    static func resample(_ samples: [Float], to count: Int, padToWidth: Bool) -> [Float] {
        guard count > 0 else { return [] }
        guard !samples.isEmpty else {
            return padToWidth ? Array(repeating: 0, count: count) : []
        }
        if samples.count <= count {
            // Fewer samples than bars. A live meter shows just what it has (and grows
            // rightwards); a static one pads so the bubble does not resize as it loads.
            return padToWidth
                ? samples + Array(repeating: 0, count: count - samples.count)
                : samples
        }
        let bucket = Double(samples.count) / Double(count)
        return (0..<count).map { index in
            let start = Int(Double(index) * bucket)
            let end = min(samples.count, max(start + 1, Int(Double(index + 1) * bucket)))
            let slice = samples[start..<end]
            return slice.reduce(0, +) / Float(slice.count)
        }
    }
}

/// Reads real amplitudes out of an audio file.
///
/// The server sends no waveform data — there is no column for it and the web client
/// draws a static bar pattern — so the shape has to come from the audio itself. The
/// bubble already downloads the file to play it, so decoding it for amplitudes costs
/// one pass over bytes that are already local.
///
/// Deliberately not a fake waveform derived from the message id. A pattern that does
/// not match what you hear is worse than no pattern: it invites you to scrub to a peak
/// that is not there.
enum WaveformExtractor {

    /// Bars to extract. 64 is enough shape for a 260pt bubble and cheap to hold.
    static let sampleCount = 64

    private static let cache = NSCache<NSString, NSArray>()

    static func cached(for key: String) -> [Float]? {
        (cache.object(forKey: key as NSString) as? [NSNumber])?.map(\.floatValue)
    }

    /// Decode `url` and return `sampleCount` normalised amplitudes.
    ///
    /// Runs off the main actor: a minute of AAC is a few hundred thousand frames, and
    /// doing that on the main thread drops the scroll.
    static func extract(from url: URL, key: String) async -> [Float]? {
        if let hit = cached(for: key) { return hit }
        let samples = await Task.detached(priority: .utility) { () -> [Float]? in
            decode(url: url)
        }.value
        if let samples {
            cache.setObject(samples.map { NSNumber(value: $0) } as NSArray, forKey: key as NSString)
        }
        return samples
    }

    private static func decode(url: URL) -> [Float]? {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else { return nil }
        guard let reader = try? AVAssetReader(asset: asset) else { return nil }

        // 16-bit signed PCM, mono, non-interleaved: the simplest thing to walk, and the
        // decoder will downmix whatever the file actually holds.
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: Int(kAudioFormatLinearPCM),
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsNonInterleaved: false,
                AVNumberOfChannelsKey: 1,
            ]
        )
        guard reader.canAdd(output) else { return nil }
        reader.add(output)
        guard reader.startReading() else { return nil }

        // Peak-per-bucket, accumulated in one streaming pass so a long note never has
        // to be held in memory all at once.
        var peaks: [Float] = []
        var runningPeak: Int16 = 0
        var framesInBucket = 0

        let totalFrames = max(1, Int(asset.duration.seconds * 44_100))
        let framesPerBucket = max(1, totalFrames / sampleCount)

        while reader.status == .reading, let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(
                block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &pointer
            ) == kCMBlockBufferNoErr, let pointer else {
                CMSampleBufferInvalidate(buffer)
                continue
            }
            pointer.withMemoryRebound(to: Int16.self, capacity: length / 2) { frames in
                for index in 0..<(length / 2) {
                    let magnitude = frames[index] == Int16.min ? Int16.max : abs(frames[index])
                    if magnitude > runningPeak { runningPeak = magnitude }
                    framesInBucket += 1
                    if framesInBucket >= framesPerBucket {
                        peaks.append(Float(runningPeak) / Float(Int16.max))
                        runningPeak = 0
                        framesInBucket = 0
                    }
                }
            }
            CMSampleBufferInvalidate(buffer)
        }
        if framesInBucket > 0 { peaks.append(Float(runningPeak) / Float(Int16.max)) }
        guard !peaks.isEmpty else { return nil }

        // Normalise to the loudest bar. Speech recorded at a low input level would
        // otherwise draw as a flat line even though it is perfectly audible.
        let loudest = peaks.max() ?? 1
        let scale = loudest > 0.01 ? 1 / loudest : 1
        return peaks.map { min(1, $0 * scale) }
    }
}

/// Playback speeds a voice note cycles through, in order. Tapping the pill advances to
/// the next and wraps — the reference's 1x → 1.5x → 2x → 1x.
enum PlaybackSpeed: Float, CaseIterable {
    case normal = 1.0
    case fast = 1.5
    case faster = 2.0

    var label: String {
        switch self {
        case .normal: return "1x"
        case .fast: return "1.5x"
        case .faster: return "2x"
        }
    }

    var next: PlaybackSpeed {
        switch self {
        case .normal: return .fast
        case .fast: return .faster
        case .faster: return .normal
        }
    }
}
