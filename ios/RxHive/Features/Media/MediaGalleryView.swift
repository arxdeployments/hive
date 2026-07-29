import SwiftUI

/// The "Media, links and docs" sheet.
///
/// Ported from `frontend/src/components/chat/info/MediaLinksDocsSection.jsx`. Three
/// tabs over `GET /api/conversations/{id}/media`, which takes one `type` at a time —
/// so the Media tab pages several types in lockstep and interleaves them by recency,
/// exactly as the web version merges images and videos into one timeline.
///
/// Two differences from the web panel, both deliberate:
///  * Audio is included in Media. The web panel queries only `image` and `video`,
///    which leaves voice notes unreachable from the gallery — they are media, and a
///    tile that plays back is more use than no tile at all.
///  * No multi-select/Forward/Star action bar. Bulk actions belong with the message
///    list's own selection mode (owned elsewhere), and duplicating them here would
///    mean two implementations of Forward.
struct MediaGalleryView: View {

    let conversationID: String
    /// Supplied by the chat screen so a tap can scroll the thread to the message the
    /// item came from. Optional so the sheet also works standalone.
    let onJumpToMessage: ((String) -> Void)?

    /// Explicit, so the private `@State` members cannot demote the synthesised
    /// memberwise initialiser to `private` and make this sheet unpresentable.
    init(conversationID: String, onJumpToMessage: ((String) -> Void)? = nil) {
        self.conversationID = conversationID
        self.onJumpToMessage = onJumpToMessage
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @EnvironmentObject private var toasts: ToastCenter

    @State private var tab: Tab = .media
    @State private var entries: [GalleryEntry] = []
    @State private var isLoading = true
    @State private var isPaging = false
    @State private var loadFailed = false
    /// Highest page fetched, per media type.
    @State private var pages: [String: Int] = [:]
    /// Types with nothing left to fetch (or that errored, so they are not re-hammered).
    @State private var exhausted: Set<String> = []

    @State private var viewerStart: ViewerStart?
    @State private var videoTarget: VideoTarget?
    @State private var pdfTarget: PdfTarget?
    @State private var shareTarget: MediaShareTarget?
    @State private var downloadingID: String?

    private let pageSize = 30
    private let columns = Array(
        repeating: GridItem(.flexible(), spacing: 2), count: 3
    )

    // MARK: Model

    enum Tab: String, CaseIterable, Identifiable {
        case media, links, docs

        var id: String { rawValue }

        var title: String {
            switch self {
            case .media: return "Media"
            case .links: return "Links"
            case .docs: return "Docs"
            }
        }

        /// The `type` values this tab reads. Newest-first merge happens client-side.
        var types: [String] {
            switch self {
            case .media: return ["image", "video", "audio"]
            case .links: return ["link"]
            case .docs: return ["file"]
            }
        }

        var emptyGlyph: String {
            switch self {
            case .media: return "photo.on.rectangle"
            case .links: return "link"
            case .docs: return "doc"
            }
        }

        var emptyTitle: String {
            switch self {
            case .media: return "No media yet"
            case .links: return "No links yet"
            case .docs: return "No documents yet"
            }
        }

        var emptyMessage: String {
            switch self {
            case .media: return "Photos, videos and voice notes shared in this chat will appear here."
            case .links: return "Links shared in messages will be collected here."
            case .docs: return "Files shared in this chat will appear here."
            }
        }
    }

    /// A gallery row, tagged with the type it was fetched as.
    ///
    /// The tag matters because `MediaItem.type` is not dependable across builds, and
    /// the whole layout branches on image / video / audio. The id folds in the url so
    /// several links extracted from one message stay distinct rows.
    private struct GalleryEntry: Identifiable {
        let kind: String
        let item: MediaItem

        var id: String { "\(kind)|\(item.id)|\(item.url ?? "")" }
    }

    /// One month's worth of rows. A named type rather than a tuple because `ForEach`
    /// needs an identity and Swift key paths cannot address tuple elements.
    private struct MonthBucket: Identifiable {
        let id: String
        let entries: [GalleryEntry]
    }

    private struct ViewerStart: Identifiable {
        let id = UUID()
        let index: Int
    }

    private struct VideoTarget: Identifiable {
        let id = UUID()
        let path: String
        let filename: String
    }

    private struct PdfTarget: Identifiable {
        let id = UUID()
        let attachment: Attachment
        let messageID: String?
    }

    // MARK: Body

    var body: some View {
        VStack(spacing: 0) {
            header
            tabBar
            Hairline()
            content
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .task(id: tab) { await load(reset: true) }
        .fullScreenCover(item: $viewerStart) { start in
            ImageViewer(items: imageViewerItems, startAt: start.index)
        }
        .fullScreenCover(item: $videoTarget) { target in
            MediaVideoPlayerSheet(path: target.path, filename: target.filename)
        }
        .fullScreenCover(item: $pdfTarget) { target in
            PdfReaderView(
                attachment: target.attachment,
                // Only offered when there is a thread to go back to, and it dismisses
                // the gallery too — otherwise the user lands on the message with the
                // gallery still stacked over it.
                onJumpToMessage: (target.messageID != nil && onJumpToMessage != nil)
                    ? {
                        if let messageID = target.messageID { onJumpToMessage?(messageID) }
                        dismiss()
                    }
                    : nil
            )
        }
        .sheet(item: $shareTarget) { target in
            MediaShareSheet(url: target.url)
        }
    }

    private var header: some View {
        HStack {
            Text("Media, links & docs")
                .font(Theme.Typography.title)
                .foregroundStyle(Theme.Color.text)
            Spacer()
            Button("Done") { dismiss() }
                .font(Theme.Typography.font(size: 16, weight: .medium))
                .foregroundStyle(Theme.Color.primary)
                .frame(minWidth: Theme.Layout.minTouchTarget, minHeight: Theme.Layout.minTouchTarget)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.top, Theme.Layout.spacing2)
    }

    /// A hand-built segmented control rather than `Picker(.segmented)`, which can only
    /// be themed through global `UISegmentedControl.appearance()` — a process-wide
    /// side effect this app does not take on for one sheet.
    private var tabBar: some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases) { candidate in
                Button {
                    guard tab != candidate else { return }
                    tab = candidate
                } label: {
                    Text(candidate.title)
                        .font(Theme.Typography.pill)
                        .foregroundStyle(tab == candidate ? Theme.Color.primary : Theme.Color.textMuted)
                        .frame(maxWidth: .infinity)
                        .frame(height: 34)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                .fill(tab == candidate ? Theme.Color.primaryTint : Color.clear)
                        )
                }
                .accessibilityAddTraits(tab == candidate ? [.isSelected, .isButton] : .isButton)
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .fill(Theme.Color.surface2)
        )
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .animation(Theme.Motion.ease, value: tab)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            VStack(spacing: Theme.Layout.spacing4) {
                ForEach(0..<6, id: \.self) { _ in
                    SkeletonRow(height: 16, widthFraction: 0.9)
                }
            }
            .padding(Theme.Layout.gutter)
            .frame(maxHeight: .infinity, alignment: .top)
        } else if loadFailed && entries.isEmpty {
            VStack(spacing: Theme.Layout.spacing4) {
                Text("Couldn't load this list.")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
                Button("Try again") { Task { await load(reset: true) } }
                    .font(Theme.Typography.font(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Color.primary)
                    .frame(minHeight: Theme.Layout.minTouchTarget)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entries.isEmpty {
            EmptyStateView(
                systemImage: tab.emptyGlyph,
                title: tab.emptyTitle,
                message: tab.emptyMessage
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Theme.Layout.spacing5) {
                    ForEach(buckets) { bucket in
                        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                            SectionHeader(title: bucket.id)
                                .padding(.horizontal, Theme.Layout.gutter)

                            if tab == .media {
                                LazyVGrid(columns: columns, spacing: 2) {
                                    ForEach(bucket.entries) { entry in
                                        MediaTile(kind: entry.kind, item: entry.item) { activate(entry) }
                                    }
                                }
                                .padding(.horizontal, 2)
                            } else {
                                VStack(spacing: Theme.Layout.spacing1) {
                                    ForEach(bucket.entries) { entry in
                                        row(for: entry)
                                    }
                                }
                                .padding(.horizontal, Theme.Layout.gutter)
                            }
                        }
                    }

                    if hasMore {
                        HStack {
                            Spacer()
                            ProgressView().tint(Theme.Color.textMuted)
                            Spacer()
                        }
                        .padding(.vertical, Theme.Layout.spacing4)
                        // Reaching the spinner is the paging trigger — no "load more"
                        // button, which on a grid of thumbnails is just an extra tap.
                        .onAppear { Task { await load(reset: false) } }
                    }
                }
                .padding(.vertical, Theme.Layout.spacing4)
            }
        }
    }

    // MARK: Rows

    @ViewBuilder
    private func row(for entry: GalleryEntry) -> some View {
        if tab == .links {
            LinkRow(item: entry.item) { activate(entry) }
        } else {
            DocumentRow(
                item: entry.item,
                isDownloading: downloadingID == entry.id,
                onOpen: { activate(entry) },
                onDownload: { download(entry) }
            )
        }
    }

    // MARK: Derived state

    private var hasMore: Bool {
        tab.types.contains { !exhausted.contains($0) }
    }

    /// Month sections, in the order the (already sorted) entries produce them.
    private var buckets: [MonthBucket] {
        var order: [String] = []
        var grouped: [String: [GalleryEntry]] = [:]
        for entry in entries {
            let label = entry.item.createdAt?.formatted(.dateTime.month(.wide).year()) ?? "Earlier"
            if grouped[label] == nil { order.append(label) }
            grouped[label, default: []].append(entry)
        }
        return order.map { MonthBucket(id: $0, entries: grouped[$0] ?? []) }
    }

    /// Only the stills, in display order — the viewer pages through photos, not
    /// through videos and voice notes it cannot render.
    private var imageEntries: [GalleryEntry] {
        entries.filter { $0.kind == "image" }
    }

    private var imageViewerItems: [ImageViewerItem] {
        imageEntries.compactMap { entry in
            guard let path = entry.item.mediaURL else { return nil }
            return ImageViewerItem(
                id: entry.id,
                fullPath: path,
                thumbnailPath: entry.item.thumbnailURL,
                filename: entry.item.filename ?? "image",
                senderName: entry.item.senderName,
                timestamp: entry.item.createdAt
            )
        }
    }

    // MARK: Actions

    private func activate(_ entry: GalleryEntry) {
        switch entry.kind {
        case "image":
            guard let index = imageEntries.firstIndex(where: { $0.id == entry.id }) else { return }
            viewerStart = ViewerStart(index: index)

        case "video":
            guard let path = entry.item.mediaURL else { return }
            videoTarget = VideoTarget(path: path, filename: entry.item.filename ?? "video")

        case "link":
            // Only http(s). These URLs were extracted from message text, so they are
            // user content: opening an arbitrary scheme from it would hand a sender
            // the ability to fire off other apps' deep links.
            guard
                let raw = entry.item.url,
                let url = URL(string: raw),
                let scheme = url.scheme?.lowercased(),
                scheme == "http" || scheme == "https"
            else {
                toasts.error("That link can't be opened.")
                return
            }
            openURL(url)

        default:
            // A rasterisable PDF opens the reader in place. Jumping to the message
            // just to tap the same document again is a worse answer when the row
            // already knows everything the reader needs, and the backend sends
            // mime_type/page_count on gallery rows specifically so this can work.
            // The reader keeps a "go to message" control so that affordance survives.
            if entry.item.isReadablePDF, let attachment = entry.item.asAttachment {
                pdfTarget = PdfTarget(attachment: attachment, messageID: entry.item.messageID)
                return
            }
            // Audio and everything else: go to the message, which is where the audio
            // player and the file bubble already live. Falls back to a download for a
            // standalone presentation with no thread to jump to.
            if let messageID = entry.item.messageID, let onJumpToMessage {
                onJumpToMessage(messageID)
                dismiss()
            } else {
                download(entry)
            }
        }
    }

    private func download(_ entry: GalleryEntry) {
        guard let path = entry.item.mediaURL, downloadingID == nil else { return }
        downloadingID = entry.id
        Task { @MainActor in
            defer { downloadingID = nil }
            do {
                shareTarget = MediaShareTarget(
                    url: try await MediaFormatting.downloadToTemporaryFile(
                        path: path, filename: entry.item.filename ?? "attachment"
                    )
                )
            } catch {
                toasts.failure(error, fallback: "Couldn't download this file")
            }
        }
    }

    // MARK: Loading

    @MainActor
    private func load(reset: Bool) async {
        if reset {
            isLoading = true
            loadFailed = false
            entries = []
            pages = [:]
            exhausted = []
        } else {
            guard hasMore, !isPaging, !isLoading else { return }
            isPaging = true
        }
        defer {
            isLoading = false
            isPaging = false
        }

        let types = tab.types.filter { !exhausted.contains($0) }
        var fetched: [GalleryEntry] = []
        var anyFailed = false

        for type in types {
            let next = (pages[type] ?? 0) + 1
            do {
                let page = try await RxHiveAPI.conversationMedia(
                    conversationID: conversationID, type: type, page: next, limit: pageSize
                )
                pages[type] = next
                let limit = page.limit ?? pageSize
                // Two independent signals, because `total` has been wrong in the past
                // for the link tab (one message can yield several rows).
                if page.data.count < limit || next * limit >= page.total {
                    exhausted.insert(type)
                }
                fetched += page.data.map { GalleryEntry(kind: type, item: $0) }
            } catch {
                anyFailed = true
                // Stop asking for a type that just failed; the others still render.
                exhausted.insert(type)
            }
        }

        if anyFailed && fetched.isEmpty && entries.isEmpty {
            loadFailed = true
            return
        }

        let known = Set(entries.map(\.id))
        entries += fetched.filter { !known.contains($0.id) }
        entries.sort { ($0.item.createdAt ?? .distantPast) > ($1.item.createdAt ?? .distantPast) }
    }
}

// MARK: - Tiles and rows

private struct MediaTile: View {
    /// image | video | audio — the type the row was fetched as.
    let kind: String
    let item: MediaItem
    let onTap: () -> Void

    /// A video without a server thumbnail must NOT fall back to `media_url`: that is
    /// the video itself, and handing it to an image loader downloads the whole clip to
    /// fail at decode. Stills may fall back, since the original is an image.
    private var thumbnailPath: String? {
        if kind == "video" { return item.thumbnailURL }
        return item.thumbnailURL ?? item.mediaURL
    }

    private var label: String {
        let name = item.filename ?? kind
        return "\(kind.capitalized), \(name)"
    }

    var body: some View {
        Button(action: onTap) {
            ZStack {
                Rectangle().fill(Theme.Color.surface)

                if kind == "audio" {
                    VStack(spacing: Theme.Layout.spacing1) {
                        Image(systemName: "waveform")
                            .font(.system(size: 20))
                            .foregroundStyle(Theme.Color.primary)
                        if let duration = MediaFormatting.durationLabel(item.duration) {
                            Text(duration)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
                } else if let thumbnailPath {
                    AuthenticatedImage(path: thumbnailPath) {
                        Rectangle().fill(Theme.Color.surface2)
                    }
                } else {
                    Image(systemName: kind == "video" ? "film" : "photo")
                        .font(.system(size: 18))
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .aspectRatio(1, contentMode: .fill)
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if kind == "video" {
                    HStack(spacing: 3) {
                        Image(systemName: "play.fill").font(.system(size: 8))
                        if let duration = MediaFormatting.durationLabel(item.duration) {
                            Text(duration).font(Theme.Typography.micro)
                        }
                    }
                    .foregroundStyle(Theme.Color.text)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Capsule().fill(Theme.Color.bg.opacity(0.55)))
                    .padding(4)
                }
            }
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(label)
    }
}

private struct LinkRow: View {
    let item: MediaItem
    let onTap: () -> Void

    private var url: URL? { item.url.flatMap(URL.init(string:)) }
    private var host: String { url?.host ?? item.url ?? "Link" }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Layout.spacing3) {
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .fill(Theme.Color.primaryTint)
                    Image(systemName: "link")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Color.primary)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(host)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    Text(item.url ?? "")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .padding(Theme.Layout.spacing3)
            .frame(minHeight: Theme.Layout.minTouchTarget)
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                    .fill(Theme.Color.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                            .stroke(Theme.Color.border, lineWidth: 1)
                    )
            )
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Link to \(host)")
    }
}

private struct DocumentRow: View {
    let item: MediaItem
    let isDownloading: Bool
    let onOpen: () -> Void
    let onDownload: () -> Void

    private var filename: String { item.filename ?? "Document" }

    private var glyph: (systemImage: String, tint: Color) {
        MediaFormatting.glyph(forFilename: filename)
    }

    private var subtitle: String {
        [
            // Page count first for a PDF, so a gallery row carries the same
            // "14 pages • 638 KB • pdf" information the bubble does.
            MediaFormatting.documentSubtitle(
                pageCount: item.pageCount, fileSize: item.fileSize, filename: filename
            ),
            item.senderName ?? "",
            item.createdAt?.conversationListLabel ?? "",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Button(action: onOpen) {
                HStack(spacing: Theme.Layout.spacing3) {
                    ZStack {
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .fill(glyph.tint.opacity(0.12))
                        Image(systemName: glyph.systemImage)
                            .font(.system(size: 15))
                            .foregroundStyle(glyph.tint)
                    }
                    .frame(width: 40, height: 40)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(filename)
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.text)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(subtitle)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .buttonStyle(PressScaleStyle())

            Button(action: onDownload) {
                ZStack {
                    if isDownloading {
                        ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                    } else {
                        Image(systemName: "square.and.arrow.down")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Download \(filename)")
        }
        .padding(.leading, Theme.Layout.spacing3)
        .padding(.trailing, Theme.Layout.spacing1)
        .padding(.vertical, Theme.Layout.spacing2)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                .fill(Theme.Color.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                        .stroke(Theme.Color.border, lineWidth: 1)
                )
        )
    }
}
