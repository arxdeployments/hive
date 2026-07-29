import SwiftUI

// MARK: - Avatar

/// The circular avatar used everywhere, with the web app's fallback: the first
/// initial on a 10%-emerald disc with emerald text
/// (`bg-[#10B981]/10 text-[#10B981]`).
///
/// Attachments and avatars are served by the API behind the session cookie, so
/// remote images cannot use plain `AsyncImage` against a bare URL string — they go
/// through `AuthenticatedImage`, which fetches via `APIClient`.
struct Avatar: View {
    let name: String
    let urlPath: String?
    var size: CGFloat = Theme.Layout.avatarMedium
    /// Presence ring/dot. nil hides it entirely (groups, contact pickers).
    var presence: PresenceStatus?

    private var initial: String {
        let trimmed = name.trimmed
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let urlPath, !urlPath.isEmpty {
                    AuthenticatedImage(path: urlPath) { placeholder }
                } else {
                    placeholder
                }
            }
            .frame(width: size, height: size)
            .clipShape(Circle())

            if let presence, presence == .online {
                Circle()
                    .fill(Theme.Color.online)
                    .frame(width: size * 0.28, height: size * 0.28)
                    // A ring in the background colour so the dot reads as separate
                    // from the avatar rather than as part of the image.
                    .overlay(
                        Circle().stroke(Theme.Color.bg, lineWidth: max(1.5, size * 0.05))
                    )
                    .offset(x: 1, y: 1)
            }
        }
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(Theme.Color.primaryTint)
            Text(initial)
                .font(Theme.Typography.font(size: size * 0.38, weight: .medium))
                .foregroundStyle(Theme.Color.primary)
        }
    }
}

/// A stack of avatars, for group rows and call participant lists.
struct AvatarCluster: View {
    let people: [(name: String, urlPath: String?)]
    var size: CGFloat = Theme.Layout.avatarSmall
    var maxShown = 3

    var body: some View {
        HStack(spacing: -size * 0.35) {
            ForEach(Array(people.prefix(maxShown).enumerated()), id: \.offset) { _, person in
                Avatar(name: person.name, urlPath: person.urlPath, size: size)
                    .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
            }
            if people.count > maxShown {
                ZStack {
                    Circle().fill(Theme.Color.surface2)
                    Text("+\(people.count - maxShown)")
                        .font(Theme.Typography.font(size: size * 0.32, weight: .medium))
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .frame(width: size, height: size)
                .overlay(Circle().stroke(Theme.Color.bg, lineWidth: 2))
            }
        }
    }
}

// MARK: - Authenticated remote image

/// Loads an image from the API, which requires the session cookie.
///
/// `AsyncImage` uses its own `URLSession.shared` and would work here only by
/// accident of the shared cookie jar; going through `APIClient` also means a 401
/// triggers the same refresh-and-replay as any other call, so an avatar does not
/// silently 401 while the rest of the screen works.
struct AuthenticatedImage<Placeholder: View>: View {
    let path: String
    @ViewBuilder let placeholder: () -> Placeholder

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                placeholder()
            } else {
                placeholder()
                    .overlay(ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7))
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        if let cached = ImageCache.shared.image(for: path) {
            image = cached
            return
        }
        do {
            let data = try await RxHiveAPI.attachmentData(path: path)
            guard let decoded = UIImage(data: data) else { failed = true; return }
            ImageCache.shared.store(decoded, for: path)
            image = decoded
        } catch {
            failed = true
        }
    }
}

/// A small in-memory image cache.
///
/// `NSCache` rather than a dictionary so it evicts under memory pressure — a chat
/// scrolled through a few hundred photos would otherwise grow without bound and be
/// killed by the watchdog.
final class ImageCache {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() {
        cache.totalCostLimit = 64 * 1024 * 1024
    }

    func image(for key: String) -> UIImage? {
        cache.object(forKey: key as NSString)
    }

    func store(_ image: UIImage, for key: String) {
        // Cost in bytes, so the limit above means something.
        let cost = Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        cache.setObject(image, forKey: key as NSString, cost: cost)
    }
}

// MARK: - Pills, badges, chips

/// The web app's `rounded-full` status pill.
struct Pill: View {
    let text: String
    var color: Color = Theme.Color.primary
    var filled = false

    var body: some View {
        Text(text)
            .font(Theme.Typography.micro)
            .foregroundStyle(filled ? Theme.Color.onPrimary : color)
            .padding(.horizontal, Theme.Layout.spacing2)
            .padding(.vertical, 3)
            .background(
                Capsule()
                    .fill(filled ? color : color.opacity(0.10))
                    .overlay(
                        Capsule().stroke(filled ? .clear : color.opacity(0.30), lineWidth: 1)
                    )
            )
    }
}

/// Unread count badge.
struct UnreadBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.onPrimary)
                .padding(.horizontal, count > 9 ? 6 : 0)
                .frame(minWidth: 20, minHeight: 20)
                .background(Capsule().fill(Theme.Color.primary))
        }
    }
}

/// A horizontal-strip filter chip: emerald tint, emerald text and a 30%-emerald
/// border when on, `--rx-surface-2` when off.
///
/// Shared rather than per-screen. The Chats and Calls tabs both head their list with
/// one of these strips, and they had each grown a private `FilterChip` with a
/// different treatment — one tinted, one a solid emerald fill — so switching tabs
/// restyled the same control. `Theme.Color.primaryTint` / `primaryTintBorder` are
/// documented as *the* selected-pill tokens, which settles which of the two was right.
///
/// Distinct from `Pill`, which is a label with no selected state and no hit target.
struct FilterChip: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    /// The chip's own height. The touch target is padded out to 44pt around it.
    private let height: CGFloat = 32

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.pill)
                .foregroundStyle(isSelected ? Theme.Color.primary : Theme.Color.textMuted)
                .padding(.horizontal, Theme.Layout.spacing3)
                .frame(height: height)
                .background(
                    Capsule()
                        .fill(isSelected ? Theme.Color.primaryTint : Theme.Color.surface2)
                        .overlay(
                            Capsule().stroke(
                                isSelected ? Theme.Color.primaryTintBorder : Theme.Color.border2,
                                lineWidth: 1
                            )
                        )
                )
                // A 32pt chip is the right size visually; the hit area is padded out
                // to the 44pt minimum instead of inflating the chip itself.
                .padding(.vertical, (Theme.Layout.minTouchTarget - height) / 2)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .animation(Theme.Motion.ease, value: isSelected)
    }
}

// MARK: - Buttons

/// The primary emerald action button.
struct PrimaryButton: View {
    let title: String
    var systemImage: String?
    var isLoading = false
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Layout.spacing2) {
                if isLoading {
                    ProgressView().tint(Theme.Color.onPrimary).scaleEffect(0.8)
                } else if let systemImage {
                    Image(systemName: systemImage)
                }
                Text(title).font(Theme.Typography.font(size: 16, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .frame(height: Theme.Layout.controlHeight)
            .foregroundStyle(Theme.Color.onPrimary)
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                    .fill(isEnabled && !isLoading ? Theme.Color.primary : Theme.Color.primary.opacity(0.5))
            )
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled || isLoading)
    }
}

/// Secondary / cancel button on `--rx-surface-2`.
struct SecondaryButton: View {
    let title: String
    var systemImage: String?
    var tint: Color = Theme.Color.text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Layout.spacing2) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title).font(Theme.Typography.font(size: 16, weight: .medium))
            }
            .frame(maxWidth: .infinity)
            .frame(height: Theme.Layout.controlHeight)
            .foregroundStyle(tint)
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
    }
}

// MARK: - Containers

/// A card on `--rx-surface` with the standard hairline.
struct SurfaceCard<Content: View>: View {
    var padding: CGFloat = Theme.Layout.spacing4
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
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

/// A grouped-list section header, in the muted uppercase style the admin tables use.
struct SectionHeader: View {
    let title: String

    var body: some View {
        Text(title.uppercased())
            .font(Theme.Typography.micro)
            .tracking(0.6)
            .foregroundStyle(Theme.Color.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Full-screen empty state.
struct EmptyStateView: View {
    let systemImage: String
    let title: String
    var message: String?
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        VStack(spacing: Theme.Layout.spacing4) {
            Image(systemName: systemImage)
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Theme.Color.textMuted.opacity(0.35))

            VStack(spacing: Theme.Layout.spacing2) {
                Text(title)
                    .font(Theme.Typography.headline)
                    .foregroundStyle(Theme.Color.text)
                if let message {
                    Text(message)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let actionTitle, let action {
                Button(action: action) {
                    Text(actionTitle)
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Color.primary)
                        .padding(.horizontal, Theme.Layout.spacing4)
                        .frame(height: 40)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                                .stroke(Theme.Color.primary, lineWidth: 1)
                        )
                }
                .buttonStyle(PressScaleStyle())
            }
        }
        .padding(Theme.Layout.spacing6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Skeleton row, matching the admin tables' `animate-pulse` placeholders.
struct SkeletonRow: View {
    var height: CGFloat = 14
    var widthFraction: CGFloat = 0.6

    @State private var pulse = false

    var body: some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: 4)
                .fill(Theme.Color.surface2)
                .frame(width: geo.size.width * widthFraction, height: height)
                .opacity(pulse ? 0.45 : 1)
        }
        .frame(height: height)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { pulse = true }
        }
    }
}

/// A search field styled like the admin filters.
struct SearchField: View {
    let placeholder: String
    @Binding var text: String
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(Theme.Color.textMuted)

            TextField(placeholder, text: $text)
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
                .tint(Theme.Color.primary)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($focused)
                .submitLabel(.search)

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .frame(height: 40)
        .background(
            RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                .fill(Theme.Color.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                        .stroke(focused ? Theme.Color.primary : Theme.Color.border2, lineWidth: 1)
                )
        )
        .animation(Theme.Motion.ease, value: focused)
    }
}

/// A divider matching `--rx-border`.
struct Hairline: View {
    var body: some View {
        Rectangle()
            .fill(Theme.Color.border)
            .frame(height: 1)
    }
}
