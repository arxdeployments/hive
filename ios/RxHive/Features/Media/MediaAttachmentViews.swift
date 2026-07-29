import AVFoundation
import AVKit
import Combine
import SwiftUI
import UIKit

// MARK: - Shared media plumbing

/// The formatting and URL work every media surface needs, in one place.
///
/// It lives here rather than in `Theme`/`Components` because it is media-specific
/// and because two files outside this one (`ImageViewer`, `MediaGalleryView`) need
/// the same byte/duration wording — the alternative was two copies that drift.
enum MediaFormatting {

    // MARK: Text

    /// `formatFileSize` from `DocumentBubble.jsx`, to the digit: B / KB / MB with
    /// one decimal place. Not `ByteCountFormatter`, which would say "1.5 MB" as
    /// "1,5 MB" in some locales and "1.6 MB" (decimal MB) in all of them — the two
    /// clients must agree on the number they print for the same file.
    static func byteLabel(_ bytes: Int?) -> String {
        guard let bytes, bytes > 0 else { return "" }
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 {
            return String(format: "%.1f KB", Double(bytes) / 1024)
        }
        return String(format: "%.1f MB", Double(bytes) / (1024 * 1024))
    }

    /// The document bubble's metadata line: "14 pages • 638 KB • pdf".
    ///
    /// Same three facts as the web's `DocumentBubble.jsx` subtitle, in the order the
    /// design reference uses (count, size, format) with a bullet separator. Each part
    /// drops out when unknown, so a docx with no page count reads "42.1 KB • docx"
    /// rather than carrying an empty segment or a stray separator.
    static func documentSubtitle(pageCount: Int?, fileSize: Int?, filename: String) -> String {
        let ext = (filename as NSString).pathExtension.lowercased()
        let pages = (pageCount ?? 0) > 0
            ? "\(pageCount!) page\(pageCount! == 1 ? "" : "s")"
            : nil
        let size = byteLabel(fileSize)
        return [pages, size.isEmpty ? nil : size, ext.isEmpty ? nil : ext]
            .compactMap { $0 }
            .joined(separator: " • ")
    }

    /// `m:ss`. Voice notes and clips are short, so there is no hours case — the same
    /// decision `utils/audioFormat.js:formatDuration` made.
    static func clockLabel(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// nil when the server sent no duration, so a caller can omit the label rather
    /// than print a confident "0:00" about a file it has never opened.
    static func durationLabel(_ seconds: Double?) -> String? {
        guard let seconds, seconds > 0 else { return nil }
        return clockLabel(seconds)
    }

    // MARK: Kind

    static func fileExtension(of filename: String) -> String {
        (filename as NSString).pathExtension.lowercased()
    }

    static func isImage(_ attachment: Attachment) -> Bool {
        if attachment.mimeType.hasPrefix("image/") { return true }
        return ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]
            .contains(fileExtension(of: attachment.filename))
    }

    static func isVideo(_ attachment: Attachment) -> Bool {
        if attachment.mimeType.hasPrefix("video/") { return true }
        return ["mp4", "mov", "webm", "m4v"].contains(fileExtension(of: attachment.filename))
    }

    static func isAudio(_ attachment: Attachment) -> Bool {
        if attachment.mimeType.hasPrefix("audio/") { return true }
        return ["mp3", "m4a", "wav", "ogg", "aac", "opus", "weba"]
            .contains(fileExtension(of: attachment.filename))
    }

    /// Icon + tint for a document, derived from the extension.
    ///
    /// The tint comes from `Theme.FileTypeColor`, which is the design system's own
    /// transcription of the web's `FILE_ICONS` map — Word blue (#3B82F6) and archive
    /// purple (#A855F7) included. Do not re-derive these here: the whole point of the
    /// token is that a `.docx` chip is the same blue in both clients.
    ///
    /// The SF Symbols are chosen here rather than taken from
    /// `Theme.FileTypeColor.symbol`, because that map is coarser (one `doc.text` for
    /// every text-ish type) and a document row is large enough to earn the distinction
    /// between a PDF, a plain-text file and a Word document.
    static func glyph(forFilename filename: String) -> (systemImage: String, tint: Color) {
        let ext = fileExtension(of: filename)
        // `Theme.FileTypeColor` keys off the extension, and treats only xls/xlsx as
        // spreadsheets. A `.csv` is one too, so it is asked about under the extension
        // that carries the right token instead of falling through to the neutral grey.
        let tint = Theme.FileTypeColor.color(forFilename: ext == "csv" ? "sheet.xlsx" : filename)
        switch ext {
        case "pdf": return ("doc.richtext", tint)
        case "xls", "xlsx", "csv": return ("tablecells", tint)
        case "ppt", "pptx": return ("rectangle.on.rectangle", tint)
        case "zip": return ("doc.zipper", tint)
        case "doc", "docx", "rtf": return ("doc.text", tint)
        case "txt", "md", "json": return ("doc.plaintext", tint)
        default: return ("doc", tint)
        }
    }

    // MARK: URLs

    /// Absolute URL for a server-relative media path.
    ///
    /// `URL(string:relativeTo:)` rather than `appendingPathComponent` so a path that
    /// carries a query string (`/api/media/x?variant=thumb`) survives intact instead
    /// of being percent-escaped into a 404.
    static func absoluteURL(forPath path: String) -> URL? {
        if path.hasPrefix("http://") || path.hasPrefix("https://") { return URL(string: path) }
        return URL(string: path, relativeTo: AppConfig.apiBaseURL)?.absoluteURL
    }

    /// An asset AVFoundation can actually load.
    ///
    /// Media is behind the session cookie and AVFoundation does its own networking,
    /// outside `APIClient`, so the cookies have to be handed to it explicitly —
    /// without `AVURLAssetHTTPCookiesKey` every video request comes back 401 and the
    /// player shows an unexplained "cannot play" error.
    static func avAsset(forPath path: String) -> AVURLAsset? {
        guard let url = absoluteURL(forPath: path) else { return nil }
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        return AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: cookies])
    }

    static func player(forPath path: String) -> AVPlayer? {
        guard let asset = avAsset(forPath: path) else { return nil }
        return AVPlayer(playerItem: AVPlayerItem(asset: asset))
    }

    /// Fetch an attachment and drop it in a temp file so it can be handed to the
    /// share sheet. The bytes need the session cookie, so this cannot be a plain
    /// `ShareLink(item: url)` against the remote path — that would share a URL other
    /// apps get a 401 from.
    static func downloadToTemporaryFile(path: String, filename: String) async throws -> URL {
        let data = try await RxHiveAPI.attachmentData(path: path)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("rxhive-share", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(safeFilename(filename))
        try data.write(to: url, options: .atomic)
        return url
    }

    /// Server filenames are user-supplied; a "/" in one would silently write outside
    /// the share directory (or fail), so they are flattened before use as a path.
    static func safeFilename(_ filename: String) -> String {
        let cleaned = filename
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmed
        return cleaned.isEmpty ? "attachment" : cleaned
    }
}

// MARK: - Image / video attachment

/// A photo or video inside a message bubble.
///
/// One view for both because the affordance is the same — a tapped thumbnail — and
/// the only branch is what the tap opens: the pinch-zoom viewer for a still, the
/// player for a clip.
struct ImageAttachmentView: View {
    let attachment: Attachment
    /// Shown in the full-screen viewer's header, as in the reference ("Michele /
    /// 27/07/26, 11:25 AM"). Optional and defaulted so the three-argument call site
    /// keeps compiling and a gallery tile can open the viewer without a sender.
    var senderName: String?
    var timestamp: Date?

    /// Bubble media width. Fixed rather than intrinsic: the thumbnail's aspect ratio
    /// is unknown until it has loaded, and a bubble that resizes underneath the
    /// user's finger as images stream in makes the whole list jump.
    private let width: CGFloat = 240

    @State private var showViewer = false
    @State private var showPlayer = false

    /// Spelled out rather than relying on the synthesised memberwise initialiser,
    /// which private stored properties can quietly demote to `private`.
    init(attachment: Attachment, senderName: String? = nil, timestamp: Date? = nil) {
        self.attachment = attachment
        self.senderName = senderName
        self.timestamp = timestamp
    }

    private var isVideo: Bool { MediaFormatting.isVideo(attachment) }
    private var height: CGFloat { isVideo ? width * 0.62 : width }

    var body: some View {
        Button {
            if isVideo { showPlayer = true } else { showViewer = true }
        } label: {
            ZStack {
                thumbnail
                if isVideo { videoOverlay }
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusBubble - 4, style: .continuous))
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(isVideo ? "Video, \(attachment.filename)" : "Photo, \(attachment.filename)")
        .fullScreenCover(isPresented: $showViewer) {
            ImageViewer(attachment: attachment, senderName: senderName, timestamp: timestamp)
        }
        .fullScreenCover(isPresented: $showPlayer) {
            MediaVideoPlayerSheet(path: attachment.mediaURL, filename: attachment.filename)
        }
    }

    @ViewBuilder
    private var thumbnail: some View {
        if let thumbnailPath = attachment.thumbnailURL, !thumbnailPath.isEmpty {
            AuthenticatedImage(path: thumbnailPath) { placeholder }
        } else if isVideo {
            // The upload service only thumbnails images, so a video usually arrives
            // with no thumbnail at all. Pulling one frame is cheaper than showing a
            // grey rectangle and asking the user to guess what the clip is.
            VideoFrameThumbnail(path: attachment.mediaURL) { placeholder }
        } else {
            AuthenticatedImage(path: attachment.mediaURL) { placeholder }
        }
    }

    private var placeholder: some View {
        Rectangle().fill(Theme.Color.surface2)
    }

    private var videoOverlay: some View {
        ZStack {
            Theme.Color.bg.opacity(0.2)
            Image(systemName: "play.fill")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(Theme.Color.text)
                .frame(width: 48, height: 48)
                .background(Circle().fill(Theme.Color.bg.opacity(0.45)))
        }
        .overlay(alignment: .bottomLeading) {
            if let label = MediaFormatting.durationLabel(attachment.duration) {
                // Glyph + duration, as in the reference. The camera icon is what
                // distinguishes "0:09 of video" from a timestamp at a glance, which
                // matters because the sent-time sits in the opposite corner.
                HStack(spacing: 3) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 9, weight: .semibold))
                    Text(label)
                        .font(Theme.Typography.micro)
                }
                .foregroundStyle(Theme.Color.text)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Capsule().fill(Theme.Color.bg.opacity(0.55)))
                .padding(Theme.Layout.spacing2)
            }
        }
        .allowsHitTesting(false)
    }
}

/// Pulls a single frame out of a remote video for use as a poster image.
private struct VideoFrameThumbnail<Placeholder: View>: View {
    let path: String
    @ViewBuilder let placeholder: () -> Placeholder

    @State private var frame: UIImage?
    @State private var failed = false

    /// Namespaced so a generated frame can never be mistaken for the real image at
    /// this path if the server starts sending thumbnails later.
    private var cacheKey: String { "\(path)#frame" }

    var body: some View {
        Group {
            if let frame {
                Image(uiImage: frame).resizable().scaledToFill()
            } else if failed {
                placeholder().overlay(
                    Image(systemName: "film")
                        .font(.system(size: 22))
                        .foregroundStyle(Theme.Color.textMuted)
                )
            } else {
                placeholder()
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: cacheKey) {
            frame = cached
            return
        }
        guard let asset = MediaFormatting.avAsset(forPath: path) else {
            failed = true
            return
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        // Bounded so a 4K clip does not decode a 4K bitmap for a 240pt bubble.
        generator.maximumSize = CGSize(width: 720, height: 720)
        // Half a second in: frame zero of a phone recording is often a black or
        // half-exposed frame.
        do {
            let (image, _) = try await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600))
            let poster = UIImage(cgImage: image)
            ImageCache.shared.store(poster, for: cacheKey)
            frame = poster
        } catch {
            failed = true
        }
    }
}

// MARK: - Video player

/// Full-screen playback for a video attachment.
///
/// `AVPlayerViewController` rather than SwiftUI's `VideoPlayer` so playback gets the
/// system's own transport controls, AirPlay route picker and Picture in Picture —
/// all of which `VideoPlayer` only partially exposes.
struct MediaVideoPlayerSheet: View {
    let path: String
    let filename: String

    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    init(path: String, filename: String = "") {
        self.path = path
        self.filename = filename
    }

    var body: some View {
        ZStack {
            Theme.Color.bg.ignoresSafeArea()

            if let player {
                PlayerViewControllerHost(player: player)
                    .ignoresSafeArea()
            } else {
                ProgressView().tint(Theme.Color.textMuted)
            }
        }
        .overlay(alignment: .top) {
            HStack(spacing: Theme.Layout.spacing2) {
                if !filename.isEmpty {
                    Text(filename)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.Color.text)
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                        .background(Circle().fill(Theme.Color.bg.opacity(0.45)))
                }
                .accessibilityLabel("Close video")
            }
            .padding(.horizontal, Theme.Layout.spacing3)
        }
        .onAppear {
            player = MediaFormatting.player(forPath: path)
            player?.play()
        }
        .onDisappear {
            // Without this a dismissed sheet keeps playing audio behind the chat.
            player?.pause()
            player = nil
        }
    }
}

private struct PlayerViewControllerHost: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = true
        controller.videoGravity = .resizeAspect
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
    }
}

// MARK: - Audio attachment

/// A voice note or audio file: play/pause, a scrubbable bar, and a length.
///
/// The length comes from `attachment.duration` — the server measures it at upload
/// time precisely so a bubble can say "0:34" without downloading the file. Only when
/// that is missing does this fall back to what the decoder reports.
///
/// Deliberately styled on its own `surface2` capsule rather than inheriting the
/// bubble's colour: the fixed `attachment:`-only signature carries no ownership
/// information, and emerald-on-emerald in a sent bubble would be unreadable.
struct AudioAttachmentView: View {
    let attachment: Attachment
    /// For the unplayed state's avatar. Optional so a gallery row, which has no sender
    /// context, can still render the player.
    var senderName: String?
    var senderAvatarPath: String?

    @EnvironmentObject private var toasts: ToastCenter
    @StateObject private var playback = AudioAttachmentPlayback()

    init(attachment: Attachment, senderName: String? = nil, senderAvatarPath: String? = nil) {
        self.attachment = attachment
        self.senderName = senderName
        self.senderAvatarPath = senderAvatarPath
    }

    private var total: TimeInterval {
        if let duration = attachment.duration, duration > 0 { return duration }
        return playback.intrinsicDuration
    }

    private var fraction: Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, playback.position / total))
    }

    /// Remaining while playing, total while idle — the WhatsApp behaviour the web
    /// player already copies, and it means the row always shows a length.
    private var shownTime: TimeInterval {
        (playback.isPlaying || playback.position > 0) ? max(0, total - playback.position) : total
    }

    /// True once this note has been played at all.
    ///
    /// Drives the leading control, exactly as the reference does: an **unplayed** note
    /// shows the sender's avatar with a mic badge, and the **speed pill** replaces it
    /// only once playback has begun. Offering "2x" on a note nobody has heard yet is
    /// a control for a decision the listener has not had the chance to make.
    private var hasStarted: Bool { playback.hasPlayed }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Theme.Layout.spacing3) {
                leadingControl

                Button {
                    Task { @MainActor in
                        if let message = await playback.toggle(path: attachment.mediaURL) {
                            toasts.error(message)
                        }
                    }
                } label: {
                    Group {
                        if playback.isLoading {
                            ProgressView().tint(Theme.Color.primary).scaleEffect(0.7)
                        } else {
                            Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Theme.Color.primary)
                        }
                    }
                    .frame(width: 30, height: 34)
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(playback.isPlaying ? "Pause" : "Play")

                ScrubbableWaveform(
                    samples: playback.waveform,
                    fraction: fraction,
                    isEnabled: total > 0
                ) { target in
                    playback.seek(toFraction: target, total: total)
                }
                .frame(height: 26)
                .accessibilityLabel("Playback position")
                .accessibilityValue(MediaFormatting.clockLabel(playback.position))
            }

            // Elapsed sits under the waveform rather than beside it, as in the
            // reference — inline it competes with the bubble's own timestamp.
            Text(MediaFormatting.clockLabel(shownTime))
                .font(Theme.Typography.micro)
                .monospacedDigit()
                .foregroundStyle(Theme.Color.textMuted)
                .padding(.leading, 74)
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(width: 258)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Theme.Color.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: 20, style: .continuous)
                        .stroke(Theme.Color.border2, lineWidth: 1)
                )
        )
        // Decoded once per note and cached, so scrolling back to it is free.
        .task { await playback.loadWaveform(path: attachment.mediaURL) }
        .onDisappear { playback.stop() }
        // Only one voice note is audible at a time. Subscribed from the view so the
        // teardown is SwiftUI's problem rather than a token this object has to
        // unregister from a deinit that cannot touch main-actor state.
        .onReceive(NotificationCenter.default.publisher(for: .rxAudioAttachmentStarted)) { note in
            guard (note.object as? UUID) != playback.token else { return }
            playback.pause()
        }
    }
}

private extension AudioAttachmentView {

    /// Avatar-with-mic before first play, speed pill after — see `hasStarted`.
    @ViewBuilder
    var leadingControl: some View {
        if hasStarted {
            Button {
                playback.cycleSpeed()
            } label: {
                Text(playback.speed.label)
                    .font(Theme.Typography.pill)
                    .monospacedDigit()
                    .foregroundStyle(Theme.Color.text)
                    .frame(width: 40, height: 26)
                    .background(Capsule().fill(Theme.Color.border2))
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel("Playback speed \(playback.speed.label). Tap to change")
        } else {
            ZStack(alignment: .bottomTrailing) {
                Avatar(name: senderName ?? "?", urlPath: senderAvatarPath, size: 38)
                Image(systemName: "mic.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Color.primary)
                    .padding(2)
                    .background(Circle().fill(Theme.Color.surface2))
            }
            .frame(width: 40, height: 38)
            .accessibilityHidden(true)
        }
    }
}

/// The waveform, draggable to seek.
///
/// Replaces the thin progress line: a voice note's bars are the only cue for *where* in
/// a message something was said, which is what makes scrubbing to it possible at all.
private struct ScrubbableWaveform: View {
    let samples: [Float]
    let fraction: Double
    let isEnabled: Bool
    let onSeek: (Double) -> Void

    var body: some View {
        GeometryReader { geo in
            let width = max(CGFloat(1), geo.size.width)
            WaveformView(
                samples: samples,
                progress: fraction,
                playedColor: Theme.Color.primary,
                pendingColor: Theme.Color.textMuted.opacity(0.45),
                showsHandle: true,
                handleColor: Theme.Color.primary
            )
            .frame(height: geo.size.height)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard isEnabled else { return }
                        onSeek(Double(min(1, max(0, value.location.x / width))))
                    }
            )
        }
        .frame(height: 26)
        .opacity(isEnabled ? 1 : 0.5)
    }
}

/// Posted when any audio row starts. Every other row listens and pauses itself, so
/// two voice notes can never talk over each other.
private extension Notification.Name {
    static let rxAudioAttachmentStarted = Notification.Name("RxHiveAudioAttachmentStarted")
}

/// Playback for one audio attachment.
///
/// `AVAudioPlayer` over downloaded bytes rather than a streaming `AVPlayer`: voice
/// notes are tens of kilobytes, the bytes need the session cookie anyway, and a
/// local buffer is what makes scrubbing instant instead of a network seek.
@MainActor
private final class AudioAttachmentPlayback: ObservableObject {

    @Published private(set) var isPlaying = false
    @Published private(set) var isLoading = false
    @Published private(set) var position: TimeInterval = 0
    /// Current playback rate. Persists across pauses, as the reference does — pausing
    /// at 2x and resuming must not silently drop back to 1x.
    @Published private(set) var speed: PlaybackSpeed = .normal
    /// Latches on first play and never clears.
    ///
    /// Not `position > 0`: reaching the end rewinds to 0, so deriving it from position
    /// made a note you had just listened to all the way through flip back to looking
    /// unplayed — avatar returned, speed pill vanished, and the rate you had chosen
    /// disappeared with it.
    @Published private(set) var hasPlayed = false
    /// Real amplitudes, decoded from the file. Empty until `loadWaveform` finishes.
    @Published private(set) var waveform: [Float] = []
    /// What the decoder reports, used only when the server sent no duration.
    @Published private(set) var intrinsicDuration: TimeInterval = 0

    /// Identifies this player in the "someone else started" broadcast. The view owns
    /// the subscription (see `AudioAttachmentView`) rather than this object holding a
    /// NotificationCenter token it would have to unregister from `deinit`.
    let token = UUID()

    private var player: AVAudioPlayer?
    private var ticker: Task<Void, Never>?

    /// Downloaded audio, so replaying a note does not re-fetch it. `NSCache` so it
    /// is evicted under pressure — a chat full of voice notes would otherwise grow
    /// without bound.
    private static let cache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()

    /// Returns a user-facing message when it could not play, nil on success.
    func toggle(path: String) async -> String? {
        if isPlaying {
            pause()
            return nil
        }
        if let player {
            return start(player)
        }

        isLoading = true
        defer { isLoading = false }

        let data: Data
        if let cached = Self.cache.object(forKey: path as NSString) {
            data = cached as Data
        } else {
            do {
                data = try await RxHiveAPI.attachmentData(path: path)
                Self.cache.setObject(data as NSData, forKey: path as NSString, cost: data.count)
            } catch {
                return (error as? APIError)?.userMessage ?? "Couldn't load this audio."
            }
        }

        do {
            let player = try AVAudioPlayer(data: data)
            // Must be set before `prepareToPlay`, or `rate` is silently ignored and
            // every speed above 1x plays at normal pitch and normal speed.
            player.enableRate = true
            player.rate = speed.rawValue
            player.prepareToPlay()
            intrinsicDuration = player.duration.isFinite ? player.duration : 0
            self.player = player
            return start(player)
        } catch {
            return "This audio can't be played on this device."
        }
    }

    /// Advance 1x → 1.5x → 2x → 1x, applying it mid-playback.
    func cycleSpeed() {
        speed = speed.next
        player?.rate = speed.rawValue
    }

    /// Real amplitudes for the waveform.
    ///
    /// The server sends none — there is no column for it — so they are decoded from the
    /// audio itself. Reuses the same `Data` cache the player fills, so opening a note
    /// that has already been played costs no network at all; the bytes are written to a
    /// temporary file only because `AVAssetReader` needs a URL.
    func loadWaveform(path: String) async {
        guard waveform.isEmpty else { return }
        if let hit = WaveformExtractor.cached(for: path) {
            waveform = hit
            return
        }
        let data: Data
        if let cached = Self.cache.object(forKey: path as NSString) {
            data = cached as Data
        } else {
            guard let fetched = try? await RxHiveAPI.attachmentData(path: path) else { return }
            Self.cache.setObject(fetched as NSData, forKey: path as NSString, cost: fetched.count)
            data = fetched
        }
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("wave-\(UUID().uuidString).m4a")
        guard (try? data.write(to: scratch)) != nil else { return }
        defer { try? FileManager.default.removeItem(at: scratch) }
        if let samples = await WaveformExtractor.extract(from: scratch, key: path) {
            waveform = samples
        }
    }

    func seek(toFraction fraction: Double, total: TimeInterval) {
        guard total > 0 else { return }
        let target = min(total, max(0, total * fraction))
        position = target
        player?.currentTime = target
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
        position = 0
    }

    private func start(_ player: AVAudioPlayer) -> String? {
        // A voice note has to be audible even if the phone is on silent, which is
        // what `.playback` buys; `.duckOthers` is deliberately not used because a
        // half-heard voice note under music is worse than pausing the music.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            // Non-fatal: playback usually still works on the existing category.
        }
        NotificationCenter.default.post(name: .rxAudioAttachmentStarted, object: token)
        guard player.play() else { return "Couldn't start playback." }
        isPlaying = true
        hasPlayed = true
        startTicking(player)
        return nil
    }

    private func startTicking(_ player: AVAudioPlayer) {
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(80))
                guard let self, let player = self.player else { return }
                self.position = player.currentTime
                if !player.isPlaying {
                    // Finished: rewind so the next tap plays from the top.
                    self.isPlaying = false
                    self.position = 0
                    player.currentTime = 0
                    return
                }
            }
        }
    }
}

// MARK: - Document attachment

/// A file bubble: type glyph, name, size, and a share/save action.
///
/// There is no "open in place" — the bytes are behind the session cookie, so the
/// only honest action is to fetch them and hand them to the share sheet, which is
/// also how a document gets into Files, Mail or another app.
struct DocumentAttachmentView: View {
    let attachment: Attachment

    @EnvironmentObject private var toasts: ToastCenter
    @State private var isFetching = false
    @State private var shareTarget: MediaShareTarget?
    @State private var showReader = false
    /// The page-1 thumbnail 404s for a PDF uploaded before previews existed. Falling
    /// back to the icon row is better than a permanently empty preview plate.
    @State private var previewFailed = false

    init(attachment: Attachment) {
        self.attachment = attachment
    }

    private var glyph: (systemImage: String, tint: Color) {
        MediaFormatting.glyph(forFilename: attachment.filename)
    }

    /// Only PDFs ever get a preview: the backend rasterises page 1 at upload time and
    /// nothing else has a thumbnail. docx/xlsx/zip therefore fall through to the icon
    /// row unchanged, and so do PDFs sent *before* previews existed — their
    /// `page_count` is nil, which is exactly what `hasPDFPreview` tests.
    private var showsPreview: Bool { attachment.hasPDFPreview && !previewFailed }

    private var subtitle: String {
        MediaFormatting.documentSubtitle(
            pageCount: attachment.pageCount,
            fileSize: attachment.fileSize,
            filename: attachment.filename
        )
    }

    var body: some View {
        Group {
            if showsPreview { previewBubble } else { iconRowBubble }
        }
        .sheet(item: $shareTarget) { target in
            MediaShareSheet(url: target.url)
        }
        .fullScreenCover(isPresented: $showReader) {
            PdfReaderView(attachment: attachment)
        }
    }

    // MARK: - PDF with a page-1 preview

    /// Tapping the bubble opens the reader; the download arrow is its own control.
    /// Two nested buttons rather than one, because "open" and "save" are different
    /// intents and the reference gives them separate targets.
    private var previewBubble: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            AuthenticatedImage(path: attachment.thumbnailURL ?? "") {
                ZStack {
                    Rectangle().fill(Color.white.opacity(0.06))
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.8)
                }
            }
            // A white plate under the page: a rasterised page is white-on-white at
            // the margins, and without this it bleeds into the bubble.
            .background(Color.white)
            .frame(width: 250, height: 150)
            // `.top` alignment matters — a cropped portrait page must show the TOP of
            // page 1, where the title is, not its middle.
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))

            metaRow
        }
        .padding(5)
        .frame(width: 262)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                .fill(Theme.Color.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .stroke(Theme.Color.border2, lineWidth: 1)
                )
        )
        .contentShape(Rectangle())
        .onTapGesture { showReader = true }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(attachment.filename), \(subtitle). Open")
        .accessibilityAddTraits(.isButton)
    }

    private var metaRow: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            fileChip

            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.filename)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    // Two lines, wrapping — the reference wraps long report names
                    // rather than eliding them, and a filename is the whole point of
                    // the bubble.
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(subtitle)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    // One line, as in the reference. "26 pages • 43.1 MB • pdf" is
                    // about 8pt wider than the column at 13pt, and wrapping a
                    // three-part metadata line onto a second row so the word "pdf"
                    // can sit alone reads as a layout bug — shrink a hair instead.
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            downloadControl
        }
        .padding(.horizontal, 5)
        .padding(.bottom, 3)
    }

    // MARK: - Everything else: the plain icon row

    private var iconRowBubble: some View {
        Button {
            share()
        } label: {
            HStack(spacing: Theme.Layout.spacing3) {
                fileChip

                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isFetching {
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                } else {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .padding(Theme.Layout.spacing3)
            .frame(width: 262)
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                    .fill(Theme.Color.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .stroke(Theme.Color.border2, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("\(attachment.filename), \(subtitle). Share or save")
    }

    // MARK: - Shared pieces

    /// 40x40 rounded chip, filled with the file-type colour at the web's literal
    /// `${color}20` alpha (0x20/255 = 12.5%, not 20%).
    private var fileChip: some View {
        ZStack {
            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                .fill(glyph.tint.opacity(32.0 / 255.0))
            Image(systemName: glyph.systemImage)
                .font(.system(size: 18))
                .foregroundStyle(glyph.tint)
        }
        .frame(width: 40, height: 40)
    }

    private var downloadControl: some View {
        Button {
            share()
        } label: {
            Group {
                if isFetching {
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                } else {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 16))
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            // A 44pt target around a 16pt glyph, and it must not enlarge the row.
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Download \(attachment.filename)")
    }

    private func share() {
        guard !isFetching else { return }
        isFetching = true
        Task { @MainActor in
            defer { isFetching = false }
            do {
                let url = try await MediaFormatting.downloadToTemporaryFile(
                    path: attachment.mediaURL, filename: attachment.filename
                )
                shareTarget = MediaShareTarget(url: url)
            } catch {
                toasts.failure(error, fallback: "Couldn't download \(attachment.filename)")
            }
        }
    }
}

// MARK: - Sharing

/// A downloaded file waiting to be shared. `sheet(item:)` needs `Identifiable`, and
/// `URL` is not.
struct MediaShareTarget: Identifiable {
    let id = UUID()
    let url: URL
}

/// `UIActivityViewController` rather than `ShareLink`, because the file only exists
/// after an async download — `ShareLink` needs its item up front.
struct MediaShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
