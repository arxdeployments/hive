import SwiftUI

/// One message in the thread.
///
/// A port of `frontend/src/components/chat/MessageBubble.jsx`, with two deliberate
/// translations rather than transcriptions:
///
///  * **The hover chevron is gone.** The web bubble parks a `ChevronDown` in its
///    corner because a mouse needs a target; iOS already has long-press, and
///    `.contextMenu` gives it the platform's own preview-and-menu treatment. The
///    web file even pins the chevron visible under `(pointer: coarse)` for exactly
///    this case — that workaround has no reason to exist here.
///  * **Ticks are near-black, not white.** The web sent bubble is emerald with
///    white text; ours is emerald with `onPrimary` (near-black) text, because at
///    this luminance emerald fails contrast against white. So the tick follows the
///    text: dim `onPrimary` for sent, full-strength for read. The *brightness* step
///    carries the read/unread difference, which is the same trick the web file
///    documents at length — just inverted for our palette.
struct MessageBubble: View {

    let message: Message
    let conversationID: String
    let isOwn: Bool
    let isGroup: Bool
    /// First bubble of a run from this sender: shows the avatar and the name.
    let startsRun: Bool
    /// Flashing after a jump landed on this message.
    let isHighlighted: Bool
    /// Multi-select is active. Suppresses every in-bubble affordance so the row
    /// itself owns the tap — a reaction chip inside a selected bubble must not fire.
    let isSelecting: Bool
    let isSelected: Bool
    /// The reaction picker is open on this bubble.
    let isReacting: Bool

    let onAction: (MessageAction) -> Void
    let onJump: (String) -> Void
    let onToggleReaction: (String) -> Void
    let onShowReactions: () -> Void
    let onDismissReactionPicker: () -> Void
    let onToggleSelected: () -> Void

    @EnvironmentObject private var chat: ChatStore

    // MARK: Derived

    private var isFailed: Bool { chat.failedSends.contains(message.id) }
    private var isPending: Bool { message.isOptimistic && !isFailed }
    private var isRichMedia: Bool {
        switch message.type {
        case .image, .video, .audio, .file: return true
        default: return false
        }
    }

    private var menuItems: [MessageAction] {
        MessageActions.menuItems(for: message, isOwn: isOwn, isGroup: isGroup)
    }

    /// Timestamps, tick marks and the "edited"/"forwarded" labels.
    ///
    /// `bubbleSentTextMuted` is the token for this exact role (the web's
    /// `text-white/60`); it was previously hand-rolled as `bubbleSentText.opacity(0.65)`.
    /// The read/sent tick distinction still reads — read ticks use full-strength
    /// `bubbleSentText`, so the step is 1.0 vs 0.6 rather than 1.0 vs 0.65.
    private var metaColor: Color {
        isOwn ? Theme.Color.bubbleSentTextMuted : Theme.Color.bubbleReceivedTextMuted
    }

    private var textColor: Color {
        isOwn ? Theme.Color.bubbleSentText : Theme.Color.bubbleReceivedText
    }

    private var myReactionEmoji: Set<String> {
        guard let me = chat.currentUserID else { return [] }
        return Set(message.reactions.filter { $0.userId == me }.map(\.emoji))
    }

    // MARK: Body

    var body: some View {
        Group {
            if message.isDeleted {
                notice(text: isOwn ? "You deleted this message" : "This message was deleted", icon: "nosign")
            } else if message.type == .system {
                notice(text: message.content, icon: "info.circle")
            } else {
                content
            }
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        // A tint plus rounding rather than a background swap: the flash has to read
        // on both the emerald own bubble and the dark received one.
        .background(isHighlighted ? Theme.Color.jumpHighlight : Color.clear)
        .background(isSelected ? Theme.Color.primaryTint : Color.clear)
        .animation(Theme.Motion.easeSlow, value: isHighlighted)
        .contentShape(Rectangle())
        .onTapGesture {
            // Tapping the message the picker belongs to closes it. There is no
            // scrim: a scrim above the list would sit on top of the picker itself,
            // since the picker is anchored inside this row rather than to the screen.
            if isReacting {
                onDismissReactionPicker()
            } else if isSelecting {
                // Selection mode makes the whole row one big checkbox.
                onToggleSelected()
            }
        }
    }

    /// Deleted and system rows: centred, muted, italic, no actions but Select.
    private func notice(text: String, icon: String) -> some View {
        HStack(spacing: Theme.Layout.spacing2) {
            if isSelecting { selectionCheckbox }
            Spacer(minLength: 0)
            HStack(spacing: Theme.Layout.spacing1) {
                Image(systemName: icon)
                    .font(.system(size: 10))
                Text(text)
                    .font(Theme.Typography.caption)
                    .italic()
            }
            .foregroundStyle(Theme.Color.textMuted.opacity(0.75))
            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Layout.spacing2)
    }

    private var content: some View {
        HStack(alignment: .bottom, spacing: Theme.Layout.spacing2) {
            if isSelecting { selectionCheckbox }

            if !isOwn && isGroup {
                // The gutter is reserved on every row of a run so the bubbles stay
                // aligned; only the first row of the run fills it.
                if startsRun {
                    Avatar(name: message.senderName, urlPath: message.senderAvatar, size: 28)
                } else {
                    Color.clear.frame(width: 28, height: 1)
                }
            }

            if isOwn { Spacer(minLength: 48) }

            VStack(alignment: isOwn ? .trailing : .leading, spacing: Theme.Layout.spacing1) {
                bubble
                if !message.reactions.isEmpty { reactionChips }
            }

            if !isOwn { Spacer(minLength: 48) }
        }
        // Consecutive messages from one sender sit tighter than the gap between runs.
        .padding(.top, startsRun ? Theme.Layout.spacing2 : 1)
        .padding(.bottom, 1)
    }

    // MARK: Bubble

    private var bubble: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing1) {
            if message.isForwarded {
                HStack(spacing: 3) {
                    Image(systemName: "arrow.turn.up.right").font(.system(size: 9))
                    Text("Forwarded")
                        .font(Theme.Typography.micro)
                        .italic()
                }
                .foregroundStyle(metaColor)
            }

            if !isOwn && isGroup && startsRun {
                Text(message.senderName)
                    .font(Theme.Typography.font(size: 13, weight: .medium))
                    // `Theme.SenderColor` is the design system's own port of the web's
                    // `SENDER_COLORS` — all ten hues, and a hash that reproduces
                    // JavaScript's mixed Double/Int32 arithmetic exactly, so a
                    // colleague who is orange in the browser is orange here too.
                    .foregroundStyle(Theme.SenderColor.color(forUserID: message.senderId))
            }

            if let reply = message.replyToMessage {
                ReplyQuoteView(reply: reply, isOwn: isOwn)
                    .onTapGesture {
                        guard !isSelecting else { return }
                        onJump(reply.id)
                    }
            }

            typeBody

            footer
        }
        .padding(.horizontal, isRichMedia ? Theme.Layout.spacing1 : Theme.Layout.spacing3)
        .padding(.vertical, isRichMedia ? Theme.Layout.spacing1 : Theme.Layout.spacing2)
        .background(isOwn ? Theme.Color.bubbleSent : Theme.Color.bubbleReceived)
        .clipShape(bubbleShape)
        .overlay(
            // The received bubble is only one step lighter than the page, so it
            // needs a hairline to hold its edge; the emerald one does not.
            bubbleShape.stroke(isOwn ? Color.clear : Theme.Color.border, lineWidth: 1)
        )
        // The picker floats above the bubble, anchored to the sender's side so it
        // never covers the message it belongs to.
        .overlay(alignment: isOwn ? .topTrailing : .topLeading) {
            if isReacting {
                ReactionPicker(mine: myReactionEmoji, onPick: onToggleReaction, onDismiss: onDismissReactionPicker)
                    .fixedSize()
                    .offset(y: -46)
                    .zIndex(2)
            }
        }
        // Applied conditionally rather than emitting an empty menu: a
        // `.contextMenu` with no rows still lifts the bubble on long-press and then
        // shows nothing, which reads as a broken gesture.
        .chatContextMenu(enabled: !isSelecting && !menuItems.isEmpty) {
            ForEach(menuItems) { item in
                Button(role: item.isDestructive ? .destructive : nil) {
                    onAction(item)
                } label: {
                    Label(item.title, systemImage: item.systemImage)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(isOwn ? "You" : message.senderName): \(message.chatPreviewLabel)")
    }

    /// The tail corner is squared off on the sender's side, which is what makes a
    /// run of bubbles read as coming from one person without any other cue.
    private var bubbleShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: Theme.Layout.radiusBubble,
            bottomLeadingRadius: isOwn ? Theme.Layout.radiusBubble : 2,
            bottomTrailingRadius: isOwn ? 2 : Theme.Layout.radiusBubble,
            topTrailingRadius: Theme.Layout.radiusBubble,
            style: .continuous
        )
    }

    // MARK: Content by type

    @ViewBuilder
    private var typeBody: some View {
        switch message.type {
        case .image, .video:
            VStack(alignment: .leading, spacing: Theme.Layout.spacing1) {
                ForEach(message.renderableAttachments) { attachment in
                    ImageAttachmentView(attachment: attachment)
                }
                if let caption = message.mediaCaption {
                    Text(caption)
                        .font(Theme.Typography.body)
                        .foregroundStyle(textColor)
                        .padding(.horizontal, Theme.Layout.spacing2)
                }
            }

        case .audio:
            if let attachment = message.renderableAttachments.first {
                AudioAttachmentView(attachment: attachment)
            } else {
                // The message says audio but carries no media — a half-written row.
                // Say so rather than rendering an empty bubble.
                unavailableMedia("Voice message unavailable")
            }

        case .file:
            if let attachment = message.renderableAttachments.first {
                DocumentAttachmentView(attachment: attachment)
            } else {
                unavailableMedia("File unavailable")
            }

        case .text, .system, .unknown:
            Text(message.content)
                .font(Theme.Typography.body)
                .foregroundStyle(textColor)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
        }
    }

    private func unavailableMedia(_ text: String) -> some View {
        HStack(spacing: Theme.Layout.spacing2) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 12))
            Text(text).font(Theme.Typography.caption)
        }
        .foregroundStyle(metaColor)
        .padding(.horizontal, Theme.Layout.spacing2)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: Theme.Layout.spacing1) {
            if message.isPinned {
                Image(systemName: "pin.fill").font(.system(size: 9))
            }
            if message.isStarred {
                Image(systemName: "star.fill").font(.system(size: 9))
            }

            Text(message.createdAt?.bubbleTimeLabel ?? "")
                .font(Theme.Typography.micro)

            if message.isEdited {
                Text("· edited").font(Theme.Typography.micro)
            }

            if isOwn { status }
        }
        .foregroundStyle(metaColor)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.horizontal, isRichMedia ? Theme.Layout.spacing2 : 0)
    }

    @ViewBuilder
    private var status: some View {
        if isFailed {
            Button {
                Task { await chat.retry(tempID: message.id, in: conversationID) }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Theme.Color.bubbleSentText)
                    .frame(width: 16, height: 16)
                    .background(Circle().fill(Theme.Color.danger))
            }
            .disabled(isSelecting)
            .accessibilityLabel("Failed to send. Tap to retry.")
        } else if isPending {
            Image(systemName: "clock")
                .font(.system(size: 9))
                .accessibilityLabel("Sending")
        } else if !message.readBy.isEmpty {
            // Delivered and read are one signal on this server (both derive from
            // `last_read_at`), so there is no third tick state to draw.
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 10))
                .foregroundStyle(Theme.Color.bubbleSentText)
                .accessibilityLabel("Read")
        } else {
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .semibold))
                .accessibilityLabel("Sent")
        }
    }

    // MARK: Reactions

    private var reactionChips: some View {
        // Grouped by emoji in first-reaction order, so a chip does not jump position
        // when someone else joins it.
        let grouped: [(emoji: String, count: Int, mine: Bool)] = {
            var order: [String] = []
            var counts: [String: Int] = [:]
            for reaction in message.reactions {
                if counts[reaction.emoji] == nil { order.append(reaction.emoji) }
                counts[reaction.emoji, default: 0] += 1
            }
            let mine = myReactionEmoji
            return order.map { ($0, counts[$0] ?? 0, mine.contains($0)) }
        }()

        return HStack(spacing: Theme.Layout.spacing1) {
            ForEach(grouped, id: \.emoji) { chip in
                Button {
                    guard !isSelecting else { return }
                    onToggleReaction(chip.emoji)
                } label: {
                    HStack(spacing: 3) {
                        Text(chip.emoji).font(.system(size: 13))
                        Text("\(chip.count)")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(chip.mine ? Theme.Color.text : Theme.Color.textMuted)
                    }
                    .padding(.horizontal, Theme.Layout.spacing2)
                    .padding(.vertical, 3)
                    .background(
                        Capsule()
                            .fill(chip.mine ? Theme.Color.primaryTint : Theme.Color.surface2)
                            .overlay(
                                Capsule().stroke(
                                    chip.mine ? Theme.Color.primaryTintBorder : Theme.Color.border2,
                                    lineWidth: 1
                                )
                            )
                    )
                }
                .buttonStyle(PressScaleStyle())
                // Simultaneous, not `.onLongPressGesture`: a Button already owns the
                // press, and the sequential modifier loses the long press to it.
                .simultaneousGesture(
                    LongPressGesture(minimumDuration: 0.4).onEnded { _ in onShowReactions() }
                )
                .accessibilityLabel("\(chip.emoji) \(chip.count)\(chip.mine ? ", including you" : "")")
            }
        }
        .padding(.horizontal, Theme.Layout.spacing1)
    }

    // MARK: Selection

    private var selectionCheckbox: some View {
        Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .font(.system(size: 20))
            .foregroundStyle(isSelected ? Theme.Color.primary : Theme.Color.border2)
            .frame(width: 24, height: 24)
            .accessibilityHidden(true)
    }
}

// MARK: - Conditional context menu

private extension View {
    @ViewBuilder
    func chatContextMenu<Menu: View>(enabled: Bool, @ViewBuilder menu: () -> Menu) -> some View {
        if enabled {
            contextMenu(menuItems: menu)
        } else {
            self
        }
    }
}

// MARK: - Reply quote

/// The quoted message above a reply: an emerald bar, the sender, one line of preview.
private struct ReplyQuoteView: View {
    let reply: ReplyPreview
    let isOwn: Bool

    var body: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            // The bar is white-ish on the emerald bubble and emerald on the dark one
            // — on its own bubble emerald-on-emerald would be invisible.
            Rectangle()
                .fill(isOwn ? Theme.Color.bubbleSentText.opacity(0.5) : Theme.Color.primary)
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 1) {
                Text(reply.senderName)
                    .font(Theme.Typography.font(size: 12, weight: .semibold))
                    .foregroundStyle(isOwn ? Theme.Color.bubbleSentText.opacity(0.9) : Theme.Color.primary)
                Text(reply.chatPreviewLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(isOwn ? Theme.Color.bubbleSentText.opacity(0.7) : Theme.Color.textMuted)
                    .lineLimit(1)
                    .italic(reply.isDeleted)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, Theme.Layout.spacing1)
        .padding(.trailing, Theme.Layout.spacing2)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(isOwn ? Theme.Color.primaryPressed : Theme.Color.surface2)
        )
        .contentShape(Rectangle())
    }
}

// MARK: - Attachment adaptation

extension Message {

    /// Attachments to render, whichever shape the server used.
    ///
    /// `serialize_message` sends both a real `attachments` array *and* the legacy
    /// flattened `media_url`/`filename`/`file_size` fields, and some responses
    /// populate only the flat ones (the optimistic bubble certainly does). The
    /// attachment views take an `Attachment`, so a flat message is lifted into one
    /// rather than every view learning both shapes.
    var renderableAttachments: [Attachment] {
        if !attachments.isEmpty { return attachments }
        guard let mediaURL, !mediaURL.isEmpty else { return [] }
        return [
            Attachment(
                id: id,
                mediaURL: mediaURL,
                thumbnailURL: thumbnailURL,
                filename: filename ?? defaultFilename,
                mimeType: inferredMimeType,
                fileSize: fileSize ?? 0,
                duration: duration
            )
        ]
    }

    /// A caption under a media bubble, or nil when `content` is just the storage path.
    ///
    /// The send path reuses `content` for the media path on some clients, so a bare
    /// `/api/...` string is a path and not something a human typed.
    var mediaCaption: String? {
        let trimmed = content.trimmed
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("/api/"),
              !trimmed.hasPrefix("/uploads"),
              trimmed != filename
        else { return nil }
        return trimmed
    }

    private var defaultFilename: String {
        switch type {
        case .image: return "image.jpg"
        case .video: return "video.mp4"
        case .audio: return "audio.m4a"
        default: return "file"
        }
    }

    /// The server derives MIME from the file extension and never trusts the client's
    /// header, so the extension is the only reliable signal on the way back too.
    private var inferredMimeType: String {
        let ext = (filename ?? mediaURL ?? "")
            .split(separator: ".").last?
            .lowercased() ?? ""
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "webm": return "video/webm"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "ogg", "opus": return "audio/ogg"
        case "aac": return "audio/aac"
        case "weba": return "audio/webm"
        case "pdf": return "application/pdf"
        case "txt", "md": return "text/plain"
        case "csv": return "text/csv"
        case "zip": return "application/zip"
        case "json": return "application/json"
        default:
            // Fall back on the message type, which is at least the right family.
            switch type {
            case .image: return "image/jpeg"
            case .video: return "video/mp4"
            case .audio: return "audio/mp4"
            default: return "application/octet-stream"
            }
        }
    }
}
