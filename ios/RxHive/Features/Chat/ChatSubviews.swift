import SwiftUI

// The small furniture of the message thread. Each of these is one visual idea that
// ChatView composes; they are here rather than nested in ChatView so the thread's
// own file stays about scrolling, loading and actions.

// MARK: - Date separator

/// The day heading between two runs of messages.
///
/// A pill on `--rx-surface-2` rather than the web's bare centred text: on a phone
/// the separator sits directly over message content while scrolling, and unbacked
/// text at 11pt disappears into whatever passes underneath it.
struct DateSeparatorView: View {
    let date: Date

    var body: some View {
        Text(date.dateSeparatorLabel)
            .font(Theme.Typography.micro)
            .foregroundStyle(Theme.Color.textMuted)
            .padding(.horizontal, Theme.Layout.spacing3)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(Theme.Color.surface2)
                    .overlay(Capsule().stroke(Theme.Color.border, lineWidth: 1))
            )
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Layout.spacing3)
            .accessibilityLabel("Messages from \(date.dateSeparatorLabel)")
    }
}

// MARK: - Unread divider

/// "Unread messages", drawn above the first message you hadn't seen.
///
/// Placed once, from the unread count captured *before* the open marks the
/// conversation read — the count is zeroed within a frame of arriving here, so
/// reading it later always yields "nothing unread".
struct UnreadDividerView: View {
    var count: Int?

    private var label: String {
        guard let count, count > 0 else { return "Unread messages" }
        return count == 1 ? "1 unread message" : "\(count) unread messages"
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Rectangle()
                .fill(Theme.Color.primary.opacity(0.35))
                .frame(height: 1)
            Text(label.uppercased())
                .font(Theme.Typography.micro)
                .tracking(0.6)
                .foregroundStyle(Theme.Color.primary)
                .fixedSize()
            Rectangle()
                .fill(Theme.Color.primary.opacity(0.35))
                .frame(height: 1)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
    }
}

// MARK: - Typing indicator

/// Three pulsing dots, plus who is typing when the thread has more than two people.
struct TypingIndicatorView: View {
    /// Display names, as `ChatStore.typingUsers` holds them.
    let names: [String]
    /// Direct chats need no name — there is only one other person in the room.
    var showsNames = false

    @State private var pulsing = false

    private var caption: String? {
        guard showsNames, !names.isEmpty else { return nil }
        switch names.count {
        case 1: return "\(names[0]) is typing"
        case 2: return "\(names[0]) and \(names[1]) are typing"
        default: return "\(names[0]) and \(names.count - 1) others are typing"
        }
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Theme.Color.primary)
                        .frame(width: 6, height: 6)
                        .opacity(pulsing ? 1 : 0.3)
                        .scaleEffect(pulsing ? 1.15 : 0.85)
                        // One animation per dot, offset by its index. A single
                        // `phase` counter driven by a Task would have to be
                        // cancelled on disappear or it keeps ticking for a row the
                        // list has already recycled.
                        .animation(
                            .easeInOut(duration: 0.55)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.18),
                            value: pulsing
                        )
                }
            }
            .padding(.horizontal, Theme.Layout.spacing3)
            .padding(.vertical, Theme.Layout.spacing2)
            .background(
                Capsule().fill(Theme.Color.surface)
                    .overlay(Capsule().stroke(Theme.Color.border, lineWidth: 1))
            )

            if let caption {
                Text(caption)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing2)
        .onAppear { pulsing = true }
        .accessibilityLabel(caption ?? "Typing")
    }
}

// MARK: - Scroll to bottom

/// The floating "back to the newest message" button.
struct ScrollToBottomButton: View {
    var unreadCount: Int = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Circle()
                    .fill(Theme.Color.surface)
                    .overlay(Circle().stroke(Theme.Color.border2, lineWidth: 1))
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    .overlay(
                        Image(systemName: "chevron.down")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(Theme.Color.text)
                    )
                    .shadow(
                        color: Theme.Shadow.card.color,
                        radius: Theme.Shadow.card.radius,
                        y: Theme.Shadow.card.y
                    )

                if unreadCount > 0 {
                    UnreadBadge(count: unreadCount)
                        .offset(x: 6, y: -6)
                }
            }
            // Room for the badge to overhang without being clipped by the parent.
            .padding(.top, 8)
            .padding(.trailing, 8)
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(unreadCount > 0 ? "\(unreadCount) new messages, scroll to latest" : "Scroll to latest message")
    }
}

// MARK: - Selection bar

/// The bottom bar in multi-select mode.
///
/// Forward and Star only — the bulk Delete the web bar used to carry went with the
/// message-deletion feature, and there is no endpoint left behind it.
struct SelectionBar: View {
    let selectedCount: Int
    /// Drives the Star/Unstar label: the endpoint is a toggle, so a mixed selection
    /// must read as "Star" and only touch the ones that aren't starred yet.
    let allSelectedStarred: Bool
    let onForward: () -> Void
    let onStar: () -> Void
    let onCancel: () -> Void

    private var isEnabled: Bool { selectedCount > 0 }

    var body: some View {
        VStack(spacing: 0) {
            Hairline()
            HStack(spacing: Theme.Layout.spacing2) {
                Button(action: onCancel) {
                    Text("Cancel")
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Color.textMuted)
                        .frame(minWidth: Theme.Layout.minTouchTarget, minHeight: Theme.Layout.minTouchTarget)
                }

                Spacer(minLength: 0)

                Text(selectedCount == 0 ? "Select messages" : "\(selectedCount) selected")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)

                Spacer(minLength: 0)

                barButton(
                    title: allSelectedStarred ? "Unstar" : "Star",
                    systemImage: allSelectedStarred ? "star.slash" : "star",
                    action: onStar
                )
                barButton(title: "Forward", systemImage: "arrowshape.turn.up.right", action: onForward)
            }
            .padding(.horizontal, Theme.Layout.spacing3)
            .background(Theme.Color.sidebar)
        }
    }

    private func barButton(title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Image(systemName: systemImage).font(.system(size: 16))
                Text(title).font(Theme.Typography.micro)
            }
            .foregroundStyle(isEnabled ? Theme.Color.text : Theme.Color.textMuted.opacity(0.4))
            .frame(minWidth: 56, minHeight: Theme.Layout.minTouchTarget)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled)
    }
}

// MARK: - Shared sheet chrome

/// The title row every chat sheet wears: title, optional subtitle, close button.
///
/// Not a `NavigationStack` toolbar — these sheets are presented from a screen whose
/// own navigation bar is hidden, and a nested stack would put a second, empty bar
/// above the content on iPhone.
struct ChatSheetHeader: View {
    let title: String
    var subtitle: String?
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Layout.spacing3) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(Theme.Typography.headline)
                        .foregroundStyle(Theme.Color.text)
                    if let subtitle {
                        Text(subtitle)
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
                Spacer(minLength: 0)
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.Color.textMuted)
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                }
                .accessibilityLabel("Close")
            }
            .padding(.leading, Theme.Layout.gutter)
            .padding(.trailing, Theme.Layout.spacing1)
            .padding(.top, Theme.Layout.spacing3)
            .padding(.bottom, Theme.Layout.spacing2)

            Hairline()
        }
        .background(Theme.Color.sidebar)
    }
}

// MARK: - Message previews

extension Message {

    /// One line describing this message, for pinned banners, forward confirmations
    /// and reply quotes. Media gets a labelled glyph because its `content` is often
    /// the storage path, which is meaningless to a reader.
    var chatPreviewLabel: String {
        if isDeleted { return "This message was deleted" }
        switch type {
        case .image: return "Photo"
        case .video: return "Video"
        case .audio: return "Voice message"
        case .file: return filename ?? "Document"
        case .text, .system, .unknown:
            let trimmed = content.trimmed
            return trimmed.isEmpty ? "Message" : trimmed
        }
    }
}

extension ReplyPreview {

    /// The same idea as `Message.chatPreviewLabel`, for the reduced reply shape.
    var chatPreviewLabel: String {
        if isDeleted { return "This message was deleted" }
        switch type {
        case .image: return "Photo"
        case .video: return "Video"
        case .audio: return "Voice message"
        case .file: return "Document"
        case .text, .system, .unknown:
            let trimmed = content.trimmed
            return trimmed.isEmpty ? "Message" : trimmed
        }
    }
}
