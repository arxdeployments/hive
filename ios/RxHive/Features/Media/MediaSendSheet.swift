import AVKit
import SwiftUI
import UIKit

/// One picked or captured item, waiting to be sent.
///
/// Carries the bytes rather than a library reference: the picker has already handed
/// them over, the upload needs them in memory, and holding a `PhotosPickerItem` would
/// mean loading them twice.
struct PendingMedia: Identifiable {
    let id = UUID()
    let data: Data
    let filename: String
    let isVideo: Bool
    /// Poster frame for a video, decoded thumbnail for a photo.
    let preview: UIImage?
    /// Videos only — a temp file, because `AVPlayer` cannot play from `Data`.
    let playbackURL: URL?
    let duration: TimeInterval?

    var sizeLabel: String { MediaFormatting.byteLabel(data.count) }
}

/// The confirm-and-send step for photos and video.
///
/// It exists so the quality choice sits where the decision is actually made. The
/// SD/HD control used to live beside the text field, which meant setting it long
/// before there was anything to apply it to, and leaving it visible in chats where
/// nobody was sending a photo at all. Here it is on screen at the one moment it
/// matters — the media is in front of you, the size is stated, and the next tap sends.
///
/// The reference puts the same control in its picker's toolbar. We cannot: `PhotosPicker`
/// presents the system sheet and exposes no chrome to add a button to. This screen is
/// the equivalent surface, and it also gives the caption somewhere to live that is not
/// the composer the user has just left behind.
struct MediaSendSheet: View {

    @State var items: [PendingMedia]
    /// Pre-filled from the composer, so text typed before picking is not lost.
    @State var caption: String
    let onSend: ([PendingMedia], String, MediaQuality) -> Void
    let onCancel: () -> Void

    @AppStorage(MediaQuality.storageKey) private var quality: MediaQuality = .standard
    @State private var index = 0
    @State private var showQualitySheet = false
    @State private var estimate: String?
    @FocusState private var captionFocused: Bool

    private var current: PendingMedia? {
        items.indices.contains(index) ? items[index] : nil
    }

    /// The key window's safe-area insets, with a sane floor.
    ///
    /// Read once: they do not change for a portrait-locked screen, and reading them per
    /// layout pass would be a UIKit hop on every frame. The floor covers the case where
    /// no window is found yet — better a little extra padding than chrome under the
    /// status bar.
    private static let windowInsets: UIEdgeInsets = {
        let found = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets
        guard let found else { return UIEdgeInsets(top: 48, left: 0, bottom: 24, right: 0) }
        return UIEdgeInsets(
            top: max(found.top, 20), left: found.left,
            bottom: max(found.bottom, 12), right: found.right
        )
    }()

    var body: some View {
        // The insets come from the window, not from SwiftUI.
        //
        // SwiftUI reports none here. `RootView` wraps the whole app in a `ZStack` whose
        // background calls `ignoresSafeArea()`, which expands the stack and zeroes the
        // safe area for everything inside it — including a `fullScreenCover` presented
        // from a descendant. So a plain `VStack` put the close button on top of the
        // clock, and `safeAreaInset` and `GeometryReader.safeAreaInsets` both inherited
        // the same zero and did exactly the same thing. The window's own insets are the
        // one source that hierarchy cannot flatten.
        ZStack {
            Color.black
            if let current { preview(for: current) }

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0)
                VStack(spacing: Theme.Layout.spacing2) {
                    if items.count > 1 { filmstrip }
                    sendBar
                }
            }
            .padding(.top, Self.windowInsets.top)
            .padding(.bottom, Self.windowInsets.bottom)
        }
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
        .sheet(isPresented: $showQualitySheet) {
            MediaQualitySheet(quality: $quality) { showQualitySheet = false }
        }
        // Nothing to confirm once the last item is removed.
        .onChange(of: items.count) { _, count in
            if count == 0 { onCancel() } else if index >= count { index = count - 1 }
        }
        // Re-measured whenever the item or the tier changes, so the number on screen is
        // always the number this send will cost.
        .task(id: "\(index)-\(quality.rawValue)-\(items.count)") {
            estimate = nil
            guard let current, !current.isVideo else { return }
            let data = current.data
            let name = current.filename
            let tier = quality
            let measured = await Task.detached(priority: .userInitiated) {
                MediaTranscoder.image(data: data, filename: name, quality: tier).data.count
            }.value
            guard !Task.isCancelled else { return }
            estimate = MediaFormatting.byteLabel(measured)
        }
    }

    // MARK: Top bar

    private var topBar: some View {
        HStack {
            circleButton("xmark", label: "Cancel", action: onCancel)

            Spacer()

            if items.count > 1 {
                Text("\(index + 1) of \(items.count)")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(.white)
                    .padding(.horizontal, Theme.Layout.spacing3)
                    .padding(.vertical, 5)
                    .background(Capsule().fill(.white.opacity(0.14)))
            }

            Spacer()

            if items.count > 1 {
                circleButton("trash", label: "Remove this item") {
                    items.remove(at: index)
                }
            }
            qualityButton
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing2)
        // A gradient, not a flat fill: the bar now floats over the media, and a hard
        // edge across a photo reads as a crop.
        .background(
            LinearGradient(
                colors: [.black.opacity(0.55), .clear],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .top)
        )
    }

    /// Tap flips the tier, press-and-hold explains it.
    ///
    /// Not a `Button` with a simultaneous long press: that fires both, so holding it
    /// would toggle the setting on the way to opening the sheet that reports the
    /// setting. `onTapGesture` and `onLongPressGesture` on the same view are arbitrated.
    private var qualityButton: some View {
        ZStack {
            Circle()
                .fill(quality == .hd ? Color.white : .white.opacity(0.14))
                .frame(width: 40, height: 40)
            HStack(spacing: 1) {
                Text("HD")
                    .font(Theme.Typography.font(size: 13, weight: .bold))
                if quality == .hd {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .black))
                }
            }
            .foregroundStyle(quality == .hd ? .black : .white)
        }
        .contentShape(Circle())
        .onLongPressGesture(minimumDuration: 0.4) { showQualitySheet = true }
        .onTapGesture {
            quality = quality.next
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        .accessibilityLabel("Media quality: \(quality.title)")
        .accessibilityHint("Double tap to switch, or press and hold to see what each option means")
        .accessibilityAddTraits(.isButton)
    }

    private func circleButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Circle().fill(.white.opacity(0.14)))
        }
        .accessibilityLabel(label)
    }

    // MARK: Preview

    @ViewBuilder
    private func preview(for item: PendingMedia) -> some View {
        if item.isVideo, let url = item.playbackURL {
            // Native controls rather than a poster and a play badge: this is the last
            // chance to check the clip is the right one before it is sent.
            VideoPlayer(player: AVPlayer(url: url))
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: .infinity)
        } else if let image = item.preview {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
        } else {
            // Undecodable, but still sendable — say so rather than showing a void.
            VStack(spacing: Theme.Layout.spacing3) {
                Image(systemName: "photo")
                    .font(.system(size: 40))
                    .foregroundStyle(.white.opacity(0.4))
                Text(item.filename)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    private var filmstrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Layout.spacing2) {
                ForEach(Array(items.enumerated()), id: \.element.id) { offset, item in
                    Group {
                        if let image = item.preview {
                            Image(uiImage: image).resizable().scaledToFill()
                        } else {
                            Rectangle().fill(.white.opacity(0.12))
                        }
                    }
                    .frame(width: 54, height: 54)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .stroke(offset == index ? Theme.Color.primary : .clear, lineWidth: 2)
                    )
                    .overlay(alignment: .bottomTrailing) {
                        if item.isVideo {
                            Image(systemName: "video.fill")
                                .font(.system(size: 8))
                                .foregroundStyle(.white)
                                .padding(3)
                        }
                    }
                    .onTapGesture { index = offset }
                    .accessibilityLabel("Item \(offset + 1)")
                }
            }
            .padding(.horizontal, Theme.Layout.spacing4)
        }
        .frame(height: 66)
    }

    // MARK: Caption and send

    private var sendBar: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            // What this send will actually cost, before it is spent. The tier alone does
            // not tell anyone whether they are about to push 24 MB over cellular.
            //
            // For a photo this is the REAL post-transcode size, measured by running the
            // encode — it is a few tens of milliseconds and the number is the whole
            // point of the choice. A video's encode is a full export, far too slow to
            // run for a label, so its source size is shown and named as the original.
            if let current {
                HStack(spacing: 6) {
                    Image(systemName: current.isVideo ? "video" : "photo")
                        .font(.system(size: 10))
                    if let estimate {
                        Text(estimate)
                    } else {
                        Text("\(current.sizeLabel) original")
                    }
                    if let duration = current.duration, let label = MediaFormatting.durationLabel(duration) {
                        Text("• \(label)")
                    }
                    Text("• \(quality == .hd ? "HD" : "Standard")")
                }
                .font(Theme.Typography.micro)
                .foregroundStyle(.white.opacity(0.55))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Layout.spacing4)
                .animation(nil, value: estimate)
            }

            HStack(spacing: Theme.Layout.spacing2) {
                TextField("Add a caption…", text: $caption, axis: .vertical)
                    .lineLimit(1...4)
                    .font(Theme.Typography.body)
                    .foregroundStyle(.white)
                    .focused($captionFocused)
                    .padding(.horizontal, Theme.Layout.spacing3)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusPill, style: .continuous)
                            .fill(.white.opacity(0.12))
                    )

                Button {
                    onSend(items, caption.trimmed, quality)
                } label: {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Theme.Color.onPrimary)
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(Theme.Color.primary))
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(items.count > 1 ? "Send \(items.count) items" : "Send")
            }
            .padding(.horizontal, Theme.Layout.spacing4)
            .padding(.bottom, Theme.Layout.spacing3)
        }
        .padding(.top, Theme.Layout.spacing2)
        .background(
            LinearGradient(
                colors: [.clear, .black.opacity(0.75)],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        )
    }
}
