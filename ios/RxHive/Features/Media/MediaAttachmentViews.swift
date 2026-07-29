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

    /// Bubble media width. Fixed rather than intrinsic: the thumbnail's aspect ratio
    /// is unknown until it has loaded, and a bubble that resizes underneath the
    /// user's finger as images stream in makes the whole list jump.
    private let width: CGFloat = 240

    @State private var showViewer = false
    @State private var showPlayer = false

    /// Spelled out rather than relying on the synthesised memberwise initialiser,
    /// which private stored properties can quietly demote to `private`.
    init(attachment: Attachment) {
        self.attachment = attachment
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
            ImageViewer(attachment: attachment)
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
                Text(label)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(Theme.Color.text)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
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

    @EnvironmentObject private var toasts: ToastCenter
    @StateObject private var playback = AudioAttachmentPlayback()

    init(attachment: Attachment) {
        self.attachment = attachment
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

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Button {
                Task { @MainActor in
                    if let message = await playback.toggle(path: attachment.mediaURL) {
                        toasts.error(message)
                    }
                }
            } label: {
                ZStack {
                    Circle().fill(Theme.Color.primaryTint)
                    if playback.isLoading {
                        ProgressView().tint(Theme.Color.primary).scaleEffect(0.7)
                    } else {
                        Image(systemName: playback.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Theme.Color.primary)
                    }
                }
                .frame(width: 34, height: 34)
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(playback.isPlaying ? "Pause" : "Play")

            ScrubBar(fraction: fraction, isEnabled: total > 0) { target in
                playback.seek(toFraction: target, total: total)
            }
            .accessibilityLabel("Playback position")
            .accessibilityValue(MediaFormatting.clockLabel(playback.position))

            Text(MediaFormatting.clockLabel(shownTime))
                .font(Theme.Typography.micro)
                .monospacedDigit()
                .foregroundStyle(Theme.Color.textMuted)
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(width: 250)
        .background(
            Capsule().fill(Theme.Color.surface2)
                .overlay(Capsule().stroke(Theme.Color.border2, lineWidth: 1))
        )
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

/// A thin draggable progress bar. Built rather than using `Slider` so the track,
/// knob and hit area come from `Theme` and match the rest of the product.
private struct ScrubBar: View {
    let fraction: Double
    let isEnabled: Bool
    let onSeek: (Double) -> Void

    var body: some View {
        GeometryReader { geo in
            let width: CGFloat = max(1, geo.size.width)
            let progress: CGFloat = CGFloat(min(1, max(0, fraction)))
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.Color.border2).frame(height: 3)
                Capsule().fill(Theme.Color.primary)
                    .frame(width: width * progress, height: 3)
                Circle().fill(Theme.Color.primary)
                    .frame(width: 10, height: 10)
                    .offset(x: min(width - 10, max(0, width * progress - 5)))
            }
            .frame(height: geo.size.height, alignment: .center)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard isEnabled else { return }
                        onSeek(Double(min(1, max(0, value.location.x / width))))
                    }
            )
        }
        // Tall enough to be draggable without swallowing the bubble's own gestures.
        .frame(height: 22)
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
            player.prepareToPlay()
            intrinsicDuration = player.duration.isFinite ? player.duration : 0
            self.player = player
            return start(player)
        } catch {
            return "This audio can't be played on this device."
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

    init(attachment: Attachment) {
        self.attachment = attachment
    }

    private var glyph: (systemImage: String, tint: Color) {
        MediaFormatting.glyph(forFilename: attachment.filename)
    }

    var body: some View {
        Button {
            share()
        } label: {
            HStack(spacing: Theme.Layout.spacing3) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .fill(glyph.tint.opacity(0.12))
                    Image(systemName: glyph.systemImage)
                        .font(.system(size: 18))
                        .foregroundStyle(glyph.tint)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(MediaFormatting.byteLabel(attachment.fileSize))
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
        .accessibilityLabel("\(attachment.filename), \(MediaFormatting.byteLabel(attachment.fileSize)). Share or save")
        .sheet(item: $shareTarget) { target in
            MediaShareSheet(url: target.url)
        }
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
