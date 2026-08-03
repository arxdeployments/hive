import AVFoundation
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// Standard or HD, for photos and video the user sends.
///
/// A mobile-only concern, and deliberately so: the web client uploads whatever the
/// file input hands it, because a browser on a desk is not paying for the bytes. A
/// phone on a ward's cellular connection is, and an iPhone photo is 3–5 MB before
/// anything is done to it while a 30-second 4K clip is over 100 MB. Sending those
/// untouched is the difference between a message that arrives and one that times out.
///
/// The two tiers are real re-encodes, not a flag on the request. Nothing server-side
/// changes — the same `POST /api/media/upload` receives smaller or larger bytes.
enum MediaQuality: String, CaseIterable, Identifiable {
    case standard
    case hd

    var id: String { rawValue }

    /// The reference's wording, kept verbatim so the sheet reads as the user expects.
    var title: String {
        switch self {
        case .standard: return "Standard quality"
        case .hd: return "HD quality"
        }
    }

    var subtitle: String {
        switch self {
        case .standard: return "Faster to send, smaller file size"
        case .hd: return "Slower to send, can be 6 times larger"
        }
    }

    /// Longest edge, in pixels, a photo is fitted inside. Never upscales: a screenshot
    /// that is already 750px wide stays 750px wide in both tiers.
    ///
    /// 1600 covers a full-screen view on every current iPhone (a 6.9" panel is 1320pt
    /// wide at 3x = 1290px) with room to pinch-zoom. 3024 keeps a 12MP photo's detail
    /// while staying comfortably inside the server's 16 MB image ceiling.
    var maxImageEdge: CGFloat {
        switch self {
        case .standard: return 1600
        case .hd: return 3024
        }
    }

    var jpegQuality: CGFloat {
        switch self {
        case .standard: return 0.7
        case .hd: return 0.9
        }
    }

    /// `HighestQuality` re-encodes at the source's own resolution, which is what "HD"
    /// has to mean for video — a preset with a fixed box (1920x1080) would quietly
    /// *downscale* 4K footage and quietly upscale a 720p clip.
    var videoPreset: String {
        switch self {
        case .standard: return AVAssetExportPresetMediumQuality
        case .hd: return AVAssetExportPresetHighestQuality
        }
    }

    /// For the pill in the composer.
    var badge: String { self == .hd ? "HD" : "SD" }

    var next: MediaQuality { self == .standard ? .hd : .standard }

    static let storageKey = "rxhive.mediaQuality"
}

// MARK: - Transcoding

/// Re-encodes picked or captured media to the chosen tier.
///
/// Every method returns the ORIGINAL bytes when it cannot do better — a transcode that
/// grows the file (common when "HD" meets footage that was already compressed once) or
/// fails outright must not block the send. Silently uploading something larger than
/// what the user picked would be the worst of both outcomes.
enum MediaTranscoder {

    /// Result of a transcode: bytes plus the filename they should now carry, because
    /// the server derives MIME type from the extension and a HEIC re-encoded to JPEG
    /// must not keep its old one.
    struct Output {
        let data: Data
        let filename: String
    }

    // MARK: Images

    /// Downscale and JPEG-encode, via ImageIO rather than `UIImage`.
    ///
    /// `CGImageSourceCreateThumbnailAtIndex` decodes straight to the target size, so a
    /// 12MP HEIC never becomes a 48 MB bitmap in memory first — which on an older
    /// device is the difference between a resize and a jetsam kill. It also applies the
    /// EXIF orientation transform, so a photo taken sideways is not sent sideways.
    static func image(data: Data, filename: String, quality: MediaQuality) -> Output {
        let base = (filename as NSString).deletingPathExtension
        let renamed = "\(base.isEmpty ? "IMG" : base).jpg"

        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return Output(data: data, filename: filename)
        }

        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: quality.maxImageEdge,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return Output(data: data, filename: filename)
        }

        guard let encoded = UIImage(cgImage: cgImage).jpegData(compressionQuality: quality.jpegQuality) else {
            return Output(data: data, filename: filename)
        }

        // A JPEG source at standard quality can already be smaller than anything this
        // produces. Keep whichever is smaller, but only if the original is a format the
        // server accepts — a smaller HEIC is no use to it.
        let originalIsJPEG = ["jpg", "jpeg"].contains(MediaFormatting.fileExtension(of: filename))
        if originalIsJPEG, data.count <= encoded.count {
            return Output(data: data, filename: filename)
        }
        return Output(data: encoded, filename: renamed)
    }

    // MARK: Previews, for the send sheet

    /// A decoded, display-sized copy. Not the bytes that get sent — those stay pristine
    /// until the tier is applied — just something the preview can draw without holding a
    /// full 12MP bitmap per item while the user browses a batch of ten.
    static func thumbnail(data: Data, maxEdge: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxEdge,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }

    /// Park video bytes in a temp file so `AVPlayer` can play them — it has no
    /// `Data` initialiser. Cleaned up by `discardPreviewFile` once the item is sent
    /// or dismissed.
    static func stagePreviewFile(data: Data, filename: String) -> URL? {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rxhive-preview", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let ext = MediaFormatting.fileExtension(of: filename)
        let url = directory.appendingPathComponent("\(UUID().uuidString).\(ext.isEmpty ? "mov" : ext)")
        guard (try? data.write(to: url, options: .atomic)) != nil else { return nil }
        return url
    }

    static func discardPreviewFile(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// First frame and duration, for the filmstrip thumbnail.
    static func videoPoster(url: URL?) async -> (UIImage?, TimeInterval?) {
        guard let url else { return (nil, nil) }
        let asset = AVURLAsset(url: url)
        let duration = try? await asset.load(.duration)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1400, height: 1400)
        // A hair in, not zero: the very first frame of a phone recording is often the
        // sensor still settling, and a black thumbnail looks like a failed load.
        let at = CMTime(seconds: 0.15, preferredTimescale: 600)
        let image = try? await generator.image(at: at).image
        return (image.map(UIImage.init(cgImage:)), duration.map(CMTimeGetSeconds))
    }

    // MARK: Video

    /// Re-encode to MP4 at the chosen tier.
    ///
    /// The bytes arrive as `Data` (both the library picker and the camera hand them over
    /// that way), but `AVAssetExportSession` only reads a URL, so they go to a temp file
    /// first. That is not wasted work: the export writes to disk regardless, and the
    /// upload needs the result in memory anyway.
    static func video(data: Data, filename: String, quality: MediaQuality) async -> Output {
        let unchanged = Output(data: data, filename: filename)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rxhive-transcode", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let sourceExtension = MediaFormatting.fileExtension(of: filename)
        let input = directory.appendingPathComponent("in-\(UUID().uuidString).\(sourceExtension.isEmpty ? "mov" : sourceExtension)")
        let output = directory.appendingPathComponent("out-\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: input)
            try? FileManager.default.removeItem(at: output)
        }

        guard (try? data.write(to: input, options: .atomic)) != nil else { return unchanged }

        let asset = AVURLAsset(url: input)
        let available = AVAssetExportSession.exportPresets(compatibleWith: asset)
        guard available.contains(quality.videoPreset),
              let session = AVAssetExportSession(asset: asset, presetName: quality.videoPreset)
        else { return unchanged }

        session.outputURL = output
        session.outputFileType = .mp4
        // Puts the moov atom first so a recipient's player can start before the whole
        // file has arrived, which is the difference between a clip that plays on tap
        // and one that spins.
        session.shouldOptimizeForNetworkUse = true

        await withCheckedContinuation { continuation in
            session.exportAsynchronously { continuation.resume() }
        }

        guard session.status == .completed,
              let encoded = try? Data(contentsOf: output),
              !encoded.isEmpty
        else { return unchanged }

        // HD on already-compressed footage regularly comes out bigger than the source.
        // Sending the original is both smaller and higher fidelity, so prefer it.
        guard encoded.count < data.count else { return unchanged }

        let base = (filename as NSString).deletingPathExtension
        return Output(data: encoded, filename: "\(base.isEmpty ? "VID" : base).mp4")
    }
}

// MARK: - The sheet

/// Explains the choice, then offers it — the reference's own copy and shape.
///
/// A bare toggle would not do: "HD" alone does not tell anyone that it costs six times
/// the data, and this is a decision people make on a metered connection.
struct MediaQualitySheet: View {
    @Binding var quality: MediaQuality
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Text("Media quality")
                    .font(Theme.Typography.font(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                Spacer()
            }
            .overlay(alignment: .trailing) {
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Color.text)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Theme.Color.surface2))
                }
                .accessibilityLabel("Close")
            }
            .padding(.top, Theme.Layout.spacing4)

            Text("HD quality is clearer. Standard quality uses less storage space and is faster to send.")
                .font(Theme.Typography.body)
                .foregroundStyle(Theme.Color.textMuted)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, Theme.Layout.spacing5)

            VStack(spacing: 0) {
                ForEach(Array(MediaQuality.allCases.enumerated()), id: \.element.id) { index, option in
                    Button {
                        quality = option
                        onDismiss()
                    } label: {
                        HStack(spacing: Theme.Layout.spacing3) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(option.title)
                                    .font(Theme.Typography.font(size: 17, weight: .regular))
                                    .foregroundStyle(Theme.Color.text)
                                Text(option.subtitle)
                                    .font(Theme.Typography.caption)
                                    .foregroundStyle(Theme.Color.textMuted)
                            }
                            Spacer(minLength: Theme.Layout.spacing3)
                            if quality == option {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Theme.Color.primary)
                            }
                        }
                        .padding(.vertical, Theme.Layout.spacing3)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(quality == option ? [.isButton, .isSelected] : .isButton)

                    if index < MediaQuality.allCases.count - 1 {
                        Divider().overlay(Theme.Color.border2)
                    }
                }
            }
            .padding(.horizontal, Theme.Layout.spacing4)
            // `radiusBubble` rather than `radiusInput`: this is a grouped card, and at
            // 6pt the corners read as a mistake next to the sheet's own curve.
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusBubble, style: .continuous)
                    .fill(Theme.Color.surface2)
            )
            .padding(.top, Theme.Layout.spacing4)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .background(Theme.Color.bg)
        .presentationDetents([.height(320)])
        .presentationDragIndicator(.visible)
    }
}
