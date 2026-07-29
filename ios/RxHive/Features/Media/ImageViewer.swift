import SwiftUI
import UIKit

/// One page of the full-screen viewer.
///
/// A value type rather than `Attachment` because the viewer is also opened from the
/// media gallery, whose rows are `MediaItem`s — and because the sender/timestamp in
/// the top bar come from the *message*, which neither payload carries.
struct ImageViewerItem: Identifiable, Hashable {
    let id: String
    /// Full-size path, for the zoomed image.
    let fullPath: String
    /// Cheaper path for the filmstrip, when the server made one.
    let thumbnailPath: String?
    let filename: String
    var senderName: String?
    var timestamp: Date?

    init(
        id: String,
        fullPath: String,
        thumbnailPath: String? = nil,
        filename: String = "image",
        senderName: String? = nil,
        timestamp: Date? = nil
    ) {
        self.id = id
        self.fullPath = fullPath
        self.thumbnailPath = thumbnailPath
        self.filename = filename
        self.senderName = senderName
        self.timestamp = timestamp
    }

    init(attachment: Attachment, senderName: String? = nil, timestamp: Date? = nil) {
        self.init(
            id: attachment.id,
            fullPath: attachment.mediaURL,
            thumbnailPath: attachment.thumbnailURL,
            filename: attachment.filename,
            senderName: senderName,
            timestamp: timestamp
        )
    }
}

/// Full-screen photo viewer: pinch and double-tap zoom, swipe to page, drag down to
/// dismiss, share.
///
/// Paging is hand-rolled instead of using a paged `TabView`. A `TabView` claims every
/// horizontal drag that starts inside it, which leaves no way to tell "swipe to the
/// next photo" from "drag down to dismiss" from "pan a zoomed-in photo" — the three
/// gestures a photo viewer has to distinguish. Doing it manually means one
/// `DragGesture` decides, once per gesture, which of the three is happening.
struct ImageViewer: View {

    let items: [ImageViewerItem]

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var toasts: ToastCenter

    @State private var index: Int
    /// Zoom and pan of the *current* page. Owned here, not per page, so the paging
    /// gesture can ask "are we zoomed in?" without reaching into a child.
    @State private var scale: CGFloat = 1
    @State private var committedScale: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var committedPan: CGSize = .zero
    @State private var pageDrag: CGFloat = 0
    @State private var dismissDrag: CGFloat = 0
    @State private var axis: DragAxis?
    @State private var chromeHidden = false
    @State private var shareTarget: MediaShareTarget?
    @State private var isSharing = false

    private enum DragAxis { case horizontal, vertical }

    private let maxScale: CGFloat = 4
    private let doubleTapScale: CGFloat = 2.5
    /// Past this much vertical travel the viewer closes rather than springing back.
    private let dismissThreshold: CGFloat = 140

    init(items: [ImageViewerItem], startAt: Int = 0) {
        self.items = items
        _index = State(initialValue: min(max(0, startAt), max(0, items.count - 1)))
    }

    init(attachment: Attachment, senderName: String? = nil, timestamp: Date? = nil) {
        self.init(
            items: [ImageViewerItem(attachment: attachment, senderName: senderName, timestamp: timestamp)]
        )
    }

    init(attachments: [Attachment], startAt: Int = 0, senderName: String? = nil, timestamp: Date? = nil) {
        self.init(
            items: attachments.map {
                ImageViewerItem(attachment: $0, senderName: senderName, timestamp: timestamp)
            },
            startAt: startAt
        )
    }

    private var current: ImageViewerItem? {
        items.indices.contains(index) ? items[index] : nil
    }

    /// The backdrop thins out as the image is dragged away, so the gesture reads as
    /// "putting it back" rather than as a glitch.
    private var backdropOpacity: Double {
        1 - min(0.55, abs(dismissDrag) / 500)
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Theme.Color.bg.opacity(backdropOpacity).ignoresSafeArea()

                if items.isEmpty {
                    EmptyStateView(
                        systemImage: "photo",
                        title: "Nothing to show",
                        message: "This image is no longer available."
                    )
                } else {
                    pager(width: geo.size.width, height: geo.size.height)
                }
            }
            .contentShape(Rectangle())
        }
        .overlay(alignment: .top) { topBar }
        .overlay(alignment: .bottom) { filmstrip }
        .statusBarHidden(true)
        .sheet(item: $shareTarget) { target in
            MediaShareSheet(url: target.url)
        }
    }

    // MARK: Pager

    private func pager(width: CGFloat, height: CGFloat) -> some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { offset in
                ZoomableImagePage(item: items[offset])
                    .frame(width: width, height: height)
                    // Only the visible page is transformed; the neighbours stay at 1x
                    // so paging away from a zoomed photo lands on an unzoomed one.
                    .scaleEffect(offset == index ? scale : 1)
                    .offset(offset == index ? pan : .zero)
            }
        }
        .frame(width: width * CGFloat(max(1, items.count)), alignment: .leading)
        .offset(x: -CGFloat(index) * width + pageDrag)
        .offset(y: dismissDrag)
        .scaleEffect(1 - min(0.12, abs(dismissDrag) / 1600))
        .gesture(dragGesture(width: width))
        .simultaneousGesture(magnifyGesture)
        .onTapGesture(count: 2) { toggleZoom() }
        .onTapGesture { chromeHidden.toggle() }
        .animation(Theme.Motion.interactive, value: index)
    }

    private func dragGesture(width: CGFloat) -> some Gesture {
        DragGesture()
            .onChanged { value in
                // Zoomed in: the drag pans the photo. Nothing else can be meant.
                if scale > 1.01 {
                    pan = CGSize(
                        width: committedPan.width + value.translation.width,
                        height: committedPan.height + value.translation.height
                    )
                    return
                }
                // Lock the axis on the first meaningful movement and keep it for the
                // rest of the gesture: re-deciding mid-drag makes the image stutter
                // between paging and dismissing.
                if axis == nil {
                    let dx = abs(value.translation.width)
                    let dy = abs(value.translation.height)
                    guard max(dx, dy) > 8 else { return }
                    axis = dx > dy ? .horizontal : .vertical
                }
                switch axis {
                case .horizontal:
                    var proposed = value.translation.width
                    // Rubber-band at the ends so the first and last photo feel like
                    // edges instead of silently swallowing the swipe.
                    if (index == 0 && proposed > 0) || (index == items.count - 1 && proposed < 0) {
                        proposed *= 0.35
                    }
                    pageDrag = proposed
                case .vertical:
                    dismissDrag = value.translation.height
                case .none:
                    break
                }
            }
            .onEnded { value in
                defer { axis = nil }
                if scale > 1.01 {
                    committedPan = pan
                    return
                }
                switch axis {
                case .horizontal:
                    let threshold = width / 4
                    withAnimation(Theme.Motion.interactive) {
                        if value.translation.width < -threshold, index < items.count - 1 {
                            index += 1
                            resetTransform()
                        } else if value.translation.width > threshold, index > 0 {
                            index -= 1
                            resetTransform()
                        }
                        pageDrag = 0
                    }
                case .vertical:
                    if abs(value.translation.height) > dismissThreshold {
                        dismiss()
                    } else {
                        withAnimation(Theme.Motion.interactive) { dismissDrag = 0 }
                    }
                case .none:
                    withAnimation(Theme.Motion.interactive) { pageDrag = 0; dismissDrag = 0 }
                }
            }
    }

    private var magnifyGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(maxScale, max(1, committedScale * value.magnification))
            }
            .onEnded { _ in
                if scale <= 1.01 {
                    withAnimation(Theme.Motion.ease) { resetTransform() }
                } else {
                    committedScale = scale
                    committedPan = pan
                }
            }
    }

    private func toggleZoom() {
        withAnimation(Theme.Motion.ease) {
            if scale > 1.01 {
                resetTransform()
            } else {
                scale = doubleTapScale
                committedScale = doubleTapScale
            }
        }
    }

    private func resetTransform() {
        scale = 1
        committedScale = 1
        pan = .zero
        committedPan = .zero
    }

    // MARK: Chrome

    private var topBar: some View {
        HStack(alignment: .top, spacing: Theme.Layout.spacing2) {
            VStack(alignment: .leading, spacing: 2) {
                if let name = current?.senderName, !name.isEmpty {
                    Text(name)
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Color.text)
                }
                if let date = current?.timestamp {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                } else if items.count > 1 {
                    Text("\(index + 1) of \(items.count)")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button { share() } label: {
                ZStack {
                    if isSharing {
                        ProgressView().tint(Theme.Color.text).scaleEffect(0.7)
                    } else {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 16, weight: .medium))
                    }
                }
                .foregroundStyle(Theme.Color.text)
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                .background(Circle().fill(Theme.Color.bg.opacity(0.4)))
            }
            .accessibilityLabel("Share image")

            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    .background(Circle().fill(Theme.Color.bg.opacity(0.4)))
            }
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.bottom, Theme.Layout.spacing3)
        .background(
            LinearGradient(
                colors: [Theme.Color.bg.opacity(0.65), Color.clear],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
        .opacity(chromeHidden ? 0 : 1)
        .animation(Theme.Motion.ease, value: chromeHidden)
    }

    @ViewBuilder
    private var filmstrip: some View {
        if items.count > 1 {
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    HStack(spacing: Theme.Layout.spacing2) {
                        ForEach(items.indices, id: \.self) { offset in
                            let item = items[offset]
                            Button {
                                withAnimation(Theme.Motion.interactive) {
                                    index = offset
                                    resetTransform()
                                }
                            } label: {
                                AuthenticatedImage(path: item.thumbnailPath ?? item.fullPath) {
                                    Rectangle().fill(Theme.Color.surface2)
                                }
                                .frame(width: 52, height: 52)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusInput))
                                .overlay(
                                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                        .stroke(
                                            offset == index ? Theme.Color.primary : Color.clear,
                                            lineWidth: 2
                                        )
                                )
                                .opacity(offset == index ? 1 : 0.55)
                            }
                            .id(item.id)
                            .accessibilityLabel("Image \(offset + 1)")
                        }
                    }
                    .padding(.horizontal, Theme.Layout.gutter)
                }
                .scrollIndicators(.hidden)
                .frame(height: 68)
                .background(
                    LinearGradient(
                        colors: [Color.clear, Theme.Color.bg.opacity(0.65)],
                        startPoint: .top, endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .bottom)
                )
                .opacity(chromeHidden ? 0 : 1)
                .animation(Theme.Motion.ease, value: chromeHidden)
                .onChange(of: index) { _, new in
                    guard items.indices.contains(new) else { return }
                    withAnimation(Theme.Motion.ease) { proxy.scrollTo(items[new].id, anchor: .center) }
                }
            }
        }
    }

    // MARK: Share

    private func share() {
        guard let item = current, !isSharing else { return }
        isSharing = true
        Task { @MainActor in
            defer { isSharing = false }
            do {
                let url = try await MediaFormatting.downloadToTemporaryFile(
                    path: item.fullPath,
                    filename: item.filename.isEmpty ? "image.jpg" : item.filename
                )
                shareTarget = MediaShareTarget(url: url)
            } catch {
                toasts.failure(error, fallback: "Couldn't download this image")
            }
        }
    }
}

/// One full-size page.
///
/// Loads the bytes itself instead of using `AuthenticatedImage`, for two reasons:
/// that component fills its frame (right for a thumbnail, wrong for a viewer, which
/// must letterbox), and a viewer needs a retry affordance when a large original
/// fails on a bad connection. It shares `ImageCache`, so a thumbnail already on
/// screen is not re-fetched when it happens to be the same path.
private struct ZoomableImagePage: View {
    let item: ImageViewerItem

    @State private var image: UIImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            } else if failed {
                VStack(spacing: Theme.Layout.spacing3) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(Theme.Color.textMuted)
                    Text("Couldn't load this image")
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                    Button("Try again") { attempt += 1 }
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Color.primary)
                }
            } else {
                // Show the thumbnail underneath the spinner when there is one: the
                // full-size original can take seconds, and a blurred preview is a
                // far better wait than a black screen.
                ZStack {
                    if let thumbnailPath = item.thumbnailPath, !thumbnailPath.isEmpty {
                        AuthenticatedImage(path: thumbnailPath) { Color.clear }
                            .blur(radius: 8)
                            .opacity(0.6)
                    }
                    ProgressView().tint(Theme.Color.textMuted)
                }
            }
        }
        .task(id: "\(item.fullPath)#\(attempt)") { await load() }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: item.fullPath) {
            image = cached
            failed = false
            return
        }
        failed = false
        do {
            let data = try await RxHiveAPI.attachmentData(path: item.fullPath)
            guard let decoded = UIImage(data: data) else {
                failed = true
                return
            }
            ImageCache.shared.store(decoded, for: item.fullPath)
            image = decoded
        } catch {
            failed = true
        }
    }
}
