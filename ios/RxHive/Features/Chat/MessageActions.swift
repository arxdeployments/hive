import SwiftUI
import UIKit

/// One row of the per-message menu.
///
/// The set and the order are transcribed from
/// `frontend/src/components/chat/MessageContextMenu.jsx`, not invented: that file
/// is the product's definition of what you can do to a message. Two consequences
/// worth stating out loud, because both look like omissions:
///
///  * **There is no Delete.** The feature and its endpoint were removed
///    (`RxHiveAPI` has no `deleteMessage`), so the menu must never offer one.
///  * **Star and Pin carry their current state** rather than being two cases each,
///    because the server endpoints are blind toggles — the label is the only thing
///    that changes, and deriving it from the message keeps the two in step.
enum MessageAction: Identifiable, Hashable {
    case reply
    case react
    case star(isStarred: Bool)
    case pin(isPinned: Bool)
    case forward
    case copy
    case edit
    case info
    case replyPrivately
    case messageUser(name: String)
    case report
    case select

    /// Stable across a state flip, so a menu doesn't re-key itself when you star.
    var id: String {
        switch self {
        case .reply: return "reply"
        case .react: return "react"
        case .star: return "star"
        case .pin: return "pin"
        case .forward: return "forward"
        case .copy: return "copy"
        case .edit: return "edit"
        case .info: return "info"
        case .replyPrivately: return "reply-privately"
        case .messageUser: return "message-user"
        case .report: return "report"
        case .select: return "select"
        }
    }

    var title: String {
        switch self {
        case .reply: return "Reply"
        case .react: return "React"
        case .star(let isStarred): return isStarred ? "Unstar" : "Star"
        case .pin(let isPinned): return isPinned ? "Unpin" : "Pin"
        case .forward: return "Forward"
        case .copy: return "Copy"
        case .edit: return "Edit"
        case .info: return "Message info"
        case .replyPrivately: return "Reply privately"
        case .messageUser(let name): return "Message \(name)"
        case .report: return "Report"
        case .select: return "Select messages"
        }
    }

    var systemImage: String {
        switch self {
        case .reply, .replyPrivately: return "arrowshape.turn.up.left"
        case .react: return "face.smiling"
        case .star(let isStarred): return isStarred ? "star.slash" : "star"
        case .pin(let isPinned): return isPinned ? "pin.slash" : "pin"
        case .forward: return "arrowshape.turn.up.right"
        case .copy: return "doc.on.doc"
        case .edit: return "pencil"
        case .info: return "info.circle"
        case .messageUser: return "bubble.left"
        case .report: return "flag"
        case .select: return "checklist"
        }
    }

    /// Report is the only row the web menu paints in `--rx-danger`.
    var isDestructive: Bool {
        if case .report = self { return true }
        return false
    }
}

/// Builds the ordered, filtered menu for a message. Pure — no store, no network —
/// so the same list can drive a context menu, a swipe action or a test.
enum MessageActions {

    /// Message types the edit endpoint accepts (`MessageContextMenu.jsx:canEdit`).
    private static let editableTypes: Set<MessageType> = [.text, .image, .file]

    static func menuItems(for message: Message, isOwn: Bool, isGroup: Bool) -> [MessageAction] {
        // An optimistic bubble has no server id yet, so every id-keyed action would
        // send a temp id to the API. The web menu shows the rows and then toasts
        // "Message is still sending"; offering nothing is the honest version of the
        // same rule. Copy survives because it never leaves the device.
        if message.isOptimistic {
            return message.type == .text && !message.content.isEmpty ? [.copy] : []
        }

        // Tombstones and system notices are notices, not messages. Select stays so a
        // run of messages containing one can still be swept up and forwarded.
        if message.isDeleted || message.type == .system {
            return [.select]
        }

        var items: [MessageAction] = [
            .reply,
            .react,
            .star(isStarred: message.isStarred),
            .pin(isPinned: message.isPinned),
            .forward
        ]
        if message.type == .text { items.append(.copy) }
        if isOwn, editableTypes.contains(message.type) { items.append(.edit) }
        // `GET .../info` 403s on anything that isn't yours.
        if isOwn { items.append(.info) }

        if isGroup && !isOwn {
            items.append(.replyPrivately)
            items.append(.messageUser(name: message.senderName))
            items.append(.report)
        }

        items.append(.select)
        return items
    }
}

// MARK: - Message info

/// Delivery detail for one of my own messages.
///
/// The web modal renders "Delivered to" and "Read by" as two lists, which on this
/// backend are always the *same people*: receipts are derived from
/// `participant.last_read_at`, so there is no separate delivery signal to report.
/// Two identical lists read as a rendering bug, so this shows Read by / Pending and
/// says why once, quietly, at the bottom.
struct MessageInfoSheet: View {
    let info: MessageInfo

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            ChatSheetHeader(title: "Message info") { dismiss() }

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Layout.spacing5) {
                    sent

                    if !info.readBy.isEmpty {
                        section(
                            title: "Read by",
                            systemImage: "checkmark.circle.fill",
                            tint: Theme.Color.primary,
                            entries: info.readBy,
                            time: { $0.readAt }
                        )
                    }

                    if !info.pending.isEmpty {
                        section(
                            title: "Pending",
                            systemImage: "clock",
                            tint: Theme.Color.warning,
                            entries: info.pending,
                            time: { _ in nil }
                        )
                    }

                    if info.readBy.isEmpty && info.pending.isEmpty {
                        Text("No recipients to report yet.")
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.textMuted)
                    }

                    Text("Delivered and read receipts are the same signal on this server, so a message counts as delivered the moment it's read.")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.textMuted.opacity(0.8))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Theme.Layout.gutter)
            }
        }
        .background(Theme.Color.bg)
    }

    private var sent: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing1) {
            SectionHeader(title: "Sent")
            Text(info.sentAt?.formatted(date: .abbreviated, time: .shortened) ?? "—")
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
        }
    }

    private func section(
        title: String,
        systemImage: String,
        tint: Color,
        entries: [MessageInfo.Entry],
        time: @escaping (MessageInfo.Entry) -> Date?
    ) -> some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            HStack(spacing: Theme.Layout.spacing2) {
                Image(systemName: systemImage)
                    .font(.system(size: 13))
                    .foregroundStyle(tint)
                SectionHeader(title: title)
            }

            VStack(spacing: 0) {
                ForEach(Array(entries.enumerated()), id: \.offset) { index, entry in
                    if index > 0 { Hairline() }
                    HStack {
                        Text(entry.userName)
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.text)
                        Spacer(minLength: Theme.Layout.spacing3)
                        if let stamp = time(entry) {
                            Text(stamp.bubbleTimeLabel)
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
                    .frame(minHeight: Theme.Layout.minTouchTarget)
                    .padding(.horizontal, Theme.Layout.spacing3)
                }
            }
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
}
