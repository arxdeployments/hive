import SwiftUI

/// One conversation in the chat list — the port of `ConversationItem.jsx`.
///
/// Reads the store directly rather than taking a dozen parameters. The web version
/// deliberately subscribes to a narrow slice per row (one person typing used to
/// re-render the whole sidebar); that optimisation has no analogue here, because the
/// `List` lives inside a view that already observes `ChatStore` and SwiftUI rebuilds
/// its rows regardless. Passing the same values down as props would cost the same
/// and read worse.
struct ConversationRow: View {
    let conversation: Conversation
    /// The last row draws no separator, as a plain `List` wouldn't.
    var showsHairline = true

    @EnvironmentObject private var chat: ChatStore

    // MARK: Derived

    private var isGroup: Bool { conversation.type.isGroup }
    private var isUnread: Bool { conversation.unreadCount > 0 }
    private var other: UserBrief? { chat.otherParticipant(in: conversation) }

    private var avatarPath: String? {
        isGroup ? conversation.avatarURL : other?.avatarURL
    }

    /// Presence belongs to a person, so groups get no dot. Live presence wins over
    /// whatever the REST payload said, which is stale the moment someone connects.
    private var presence: PresenceStatus? {
        guard !isGroup, let other else { return nil }
        return chat.status(of: other.userId, fallback: other.status)
    }

    private var timestamp: Date? {
        conversation.lastMessage?.createdAt ?? conversation.lastMessageAt ?? conversation.createdAt
    }

    /// Names of everyone typing here, sorted so the string doesn't reshuffle between
    /// renders when two people type at once.
    private var typingNames: [String] {
        (chat.typingUsers[conversation.id] ?? [:]).values.sorted()
    }

    private var typingLabel: String? {
        guard !typingNames.isEmpty else { return nil }
        // In a group, *who* is typing is the useful half; the web app only ever says
        // "typing" because the sidebar row is 200px wide.
        guard isGroup else { return "typing…" }
        if typingNames.count == 1 { return "\(typingNames[0]) is typing…" }
        return "Several people are typing…"
    }

    // MARK: Preview

    /// The last-message line. Mirrors `ConversationItem.jsx`: system messages stand
    /// alone, my own messages get "You:", group messages get the sender's name.
    /// Non-text messages get a glyph and a noun — their `content` is a caption or a
    /// filename, and for a photo it is usually empty, which would render a blank row.
    private var previewText: String {
        guard let last = conversation.lastMessage else { return "No messages yet" }

        let body: String
        switch last.type {
        case .image:
            body = "📷 Photo"
        case .video:
            body = "🎥 Video"
        case .audio:
            body = "🎤 Voice message"
        case .file:
            let name = last.content.trimmed
            body = name.isEmpty ? "📄 Document" : "📄 \(name)"
        case .text, .unknown:
            let text = last.content.trimmed
            // The server blanks tombstoned content, so an empty text message is a
            // deletion, not an empty send — the composer refuses those.
            body = text.isEmpty ? "This message was deleted" : text
        case .system:
            return last.content
        }

        if let me = chat.currentUserID, last.senderId == me { return "You: \(body)" }
        if isGroup { return "\(last.senderName): \(body)" }
        return body
    }

    // MARK: Body

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(
                name: chat.title(for: conversation),
                urlPath: avatarPath,
                size: Theme.Layout.avatarMedium,
                presence: presence
            )

            VStack(alignment: .leading, spacing: 3) {
                titleLine
                previewLine
            }
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget + Theme.Layout.spacing4)
        .overlay(alignment: .bottomLeading) {
            if showsHairline {
                // Inset past the avatar, iOS-list style, so the separator reads as
                // grouping the text rather than cutting the row in half.
                Hairline()
                    .padding(.leading, Theme.Layout.gutter + Theme.Layout.avatarMedium + Theme.Layout.spacing3)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private var titleLine: some View {
        HStack(spacing: Theme.Layout.spacing1) {
            Text(chat.title(for: conversation))
                .font(Theme.Typography.font(size: 16, weight: isUnread ? .semibold : .medium))
                .foregroundStyle(Theme.Color.text)
                .lineLimit(1)

            // Cross-org threads are marked in the web row too — knowing a message is
            // leaving your organisation matters before you send it, not after.
            if conversation.crossOrg {
                Image(systemName: "globe")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.Color.primary)
            }

            Spacer(minLength: Theme.Layout.spacing2)

            if conversation.isMuted {
                Image(systemName: "bell.slash.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            if conversation.isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            if let timestamp {
                Text(timestamp.conversationListLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
        }
    }

    private var previewLine: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            if let typingLabel {
                Text(typingLabel)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.primary)
                    .lineLimit(1)
            } else {
                Text(previewText)
                    .font(Theme.Typography.subheadline)
                    // Unread previews are brighter, which is what makes the list
                    // scannable without reading the badges.
                    .foregroundStyle(isUnread ? Theme.Color.text : Theme.Color.textMuted)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            UnreadBadge(count: conversation.unreadCount)
        }
    }

    private var accessibilityText: String {
        var parts = [chat.title(for: conversation)]
        parts.append(typingLabel ?? previewText)
        if isUnread { parts.append("\(conversation.unreadCount) unread") }
        if conversation.isMuted { parts.append("Muted") }
        if conversation.isPinned { parts.append("Pinned") }
        if let timestamp { parts.append(timestamp.conversationListLabel) }
        return parts.joined(separator: ", ")
    }
}
