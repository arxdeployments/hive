import SwiftUI

/// Full-screen, scrollable, multi-page PDF reader.
///
/// Pages are **images rendered by the backend** (`GET /api/media/{id}/page/{n}`),
/// not a client-side PDF engine, mirroring `frontend/src/components/chat/PdfViewer.jsx`.
/// The server already rasterises page 1 for the bubble thumbnail, so the renderer is
/// paid for; per-page images add no dependency. It renders in windows of 10 and
/// caches each page back to object storage, so scrolling a long document does not
/// re-render it.
///
/// PDFKit was the obvious alternative and is deliberately not used: it would need
/// the whole file on device first, and these run to 43 MB in real conversations —
/// several seconds and a large download before the first page appears, versus one
/// ~40 KB JPEG here. It would also mean two different renderers producing two
/// different-looking documents across web and iOS.
///
/// **The honest cost, same as the web:** rendered pages carry no text layer, so
/// there is no text selection and no in-document search. The reference design shows
/// a search affordance; it is omitted rather than added-and-broken, because a search
/// button over rasterised images cannot find anything. Share hands over the real
/// file, which does have text.
struct PdfReaderView: View {

    let attachment: Attachment
    /// Optional "jump to the message this came from", supplied by the media gallery
    /// where opening the reader replaces the tile's own tap action. A bubble never
    /// passes it — you are already looking at the message.
    var onJumpToMessage: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var toasts: ToastCenter

    /// Page currently filling most of the screen, for the "n of N" pill.
    @State private var currentPage = 1
    @State private var shareTarget: MediaShareTarget?
    @State private var isPreparingShare = false

    /// Mirrors `storage.PDF_MAX_PAGES`. `page_count` is parser output over untrusted
    /// input, so it is clamped here as well as server-side — the count itself must
    /// never become the attack.
    private static let maxPages = 2000

    private var total: Int {
        min(max(attachment.pageCount ?? 0, 0), Self.maxPages)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if total == 0 {
                unavailable
            } else {
                pages
            }
        }
        .overlay(alignment: .top) { header }
        .overlay(alignment: .topLeading) {
            if total > 0 { pageIndicator }
        }
        .overlay(alignment: .bottomTrailing) { bottomControls }
        .sheet(item: $shareTarget) { target in
            MediaShareSheet(url: target.url)
        }
        .statusBarHidden(false)
    }

    // MARK: - Pages

    private var pages: some View {
        ScrollView {
            LazyVStack(spacing: Theme.Layout.spacing3) {
                // Top inset clears the header, which floats over the content.
                Spacer().frame(height: 84)

                ForEach(1...total, id: \.self) { page in
                    PdfPageView(path: attachment.pdfPagePath(page), pageNumber: page)
                        .onAppear {
                            // Cheaper than an intersection observer and accurate
                            // enough for a page counter: LazyVStack only calls this
                            // as a page actually comes into view.
                            currentPage = page
                        }
                }

                Spacer().frame(height: 96)
            }
            .padding(.horizontal, Theme.Layout.spacing3)
        }
        .scrollIndicators(.hidden)
    }

    // MARK: - Chrome

    private var header: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.filename)
                    .font(Theme.Typography.headline)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(total > 0 ? "Page \(min(currentPage, total)) of \(total)" : "PDF")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if let onJumpToMessage {
                circleButton("arrow.uturn.left", label: "Go to message") {
                    dismiss()
                    onJumpToMessage()
                }
            }

            circleButton("xmark", label: "Close") { dismiss() }
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .background(
            // A gradient rather than a solid bar: the page behind it is white, so an
            // opaque header would cut a hard line across the document.
            LinearGradient(
                colors: [Color.black.opacity(0.92), Color.black.opacity(0)],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    /// The floating "1 of 2" pill from the reference, kept clear of the filename so
    /// a long name cannot push it off screen.
    private var pageIndicator: some View {
        HStack(spacing: 6) {
            Image(systemName: "doc.on.doc")
                .font(.system(size: 11, weight: .semibold))
            Text("\(min(currentPage, total)) of \(total)")
                .font(Theme.Typography.pill)
        }
        .foregroundStyle(Theme.Color.text)
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, 7)
        .background(Capsule().fill(Color.black.opacity(0.55)))
        .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 1))
        .padding(.leading, Theme.Layout.gutter)
        .padding(.top, 78)
        .allowsHitTesting(false)
    }

    private var bottomControls: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            if isPreparingShare {
                ProgressView()
                    .tint(Theme.Color.text)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.black.opacity(0.55)))
            } else {
                circleButton("square.and.arrow.up", label: "Share \(attachment.filename)") {
                    share()
                }
            }
        }
        .padding(.trailing, Theme.Layout.gutter)
        .padding(.bottom, Theme.Layout.spacing6)
    }

    private func circleButton(
        _ systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.Color.text)
                .frame(width: 44, height: 44)
                .background(Circle().fill(Color.black.opacity(0.55)))
                .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 1))
        }
        .accessibilityLabel(label)
    }

    /// Shown when `page_count` is nil or zero — a PDF sent before previews existed,
    /// or one the parser could not read (encrypted, truncated). Sharing still works
    /// because the original file is untouched.
    private var unavailable: some View {
        VStack(spacing: Theme.Layout.spacing4) {
            Image(systemName: "doc.questionmark")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Theme.Color.textMuted)
            Text("No preview available")
                .font(Theme.Typography.headline)
                .foregroundStyle(Theme.Color.text)
            Text("This PDF was sent before previews existed, or it could not be read. Use Share to open it in another app.")
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Theme.Layout.spacing6)
    }

    private func share() {
        guard !isPreparingShare else { return }
        isPreparingShare = true
        Task { @MainActor in
            defer { isPreparingShare = false }
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

/// One rendered page.
///
/// Holds an A4-ish aspect placeholder before the image arrives so the scroll view's
/// content height is stable. Without it every page that loads would resize its row
/// and shove the document under the reader's finger.
private struct PdfPageView: View {
    let path: String
    let pageNumber: Int

    @State private var image: UIImage?
    @State private var failed = false

    /// 1 / 1.414 — ISO 216. Only a placeholder: once loaded, the real aspect wins.
    private let placeholderAspect: CGFloat = 1.0 / 1.414

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else if failed {
                ZStack {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Theme.Color.surface)
                        .overlay(
                            RoundedRectangle(cornerRadius: 4)
                                .stroke(Theme.Color.border2, lineWidth: 1)
                        )
                    Text("Page \(pageNumber) could not be rendered")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .aspectRatio(placeholderAspect, contentMode: .fit)
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.04))
                    ProgressView().tint(Theme.Color.textMuted)
                }
                .aspectRatio(placeholderAspect, contentMode: .fit)
            }
        }
        .frame(maxWidth: .infinity)
        .background(Color.white)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .task(id: path) { await load() }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: path) {
            image = cached
            return
        }
        do {
            // Goes through APIClient: the endpoint is cookie-authenticated and
            // 307-redirects to a presigned storage URL, which URLSession follows.
            let data = try await RxHiveAPI.attachmentData(path: path)
            guard let decoded = UIImage(data: data) else { failed = true; return }
            ImageCache.shared.store(decoded, for: path)
            image = decoded
        } catch {
            failed = true
        }
    }
}
