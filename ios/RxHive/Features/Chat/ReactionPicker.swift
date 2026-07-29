import SwiftUI

/// The quick-reaction row that floats in above a bubble.
///
/// The six quick emoji are the web picker's `QUICK_REACTIONS`, in order. The web
/// falls back to `emoji-picker-react` behind a "+", which is a 400 KB dependency
/// this app has no equivalent of and does not want one — so "+" expands into a
/// grid of the emoji people actually react with. The API accepts any string up to
/// 32 characters (`Reaction.emoji` is `String(32)`), so nothing here is a
/// server-side restriction; it is purely what we choose to offer.
struct ReactionPicker: View {

    static let quick = ["👍", "❤️", "😂", "😮", "😢", "🙏"]

    /// The extended set. Deliberately short and hand-picked: a full emoji keyboard
    /// inside a bubble overlay is unusable at this size, and a reaction is a
    /// one-tap gesture — if it takes a search field it has stopped being one.
    static let extended = [
        "👍", "👎", "❤️", "🔥", "🎉", "👏", "🙏", "💯",
        "😂", "🤣", "😊", "😍", "🤔", "😮", "😢", "😡",
        "✅", "❌", "⚠️", "👀", "💪", "🙌", "🤝", "🫡",
        "😴", "🤒", "💊", "🩺", "📈", "📉", "⏰", "📌"
    ]

    /// Emoji I have already reacted with — those read as selected so a second tap
    /// obviously removes rather than re-adds.
    var mine: Set<String> = []
    let onPick: (String) -> Void
    let onDismiss: () -> Void

    @State private var showsAll = false

    /// A pill while it is one row; a card once it is a grid — a 999pt radius on a
    /// 330x200 surface renders as an ellipse, not as a rounded panel.
    private var radius: CGFloat {
        showsAll ? Theme.Layout.radiusSheet : Theme.Layout.radiusPill
    }

    var body: some View {
        Group {
            if showsAll { grid } else { row }
        }
        .background(
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(Theme.Color.surface2)
                .overlay(
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .stroke(Theme.Color.border2, lineWidth: 1)
                )
                .shadow(
                    color: Theme.Shadow.card.color,
                    radius: Theme.Shadow.card.radius,
                    y: Theme.Shadow.card.y
                )
        )
        .transition(.scale(scale: 0.85, anchor: .bottom).combined(with: .opacity))
        .animation(Theme.Motion.interactive, value: showsAll)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("React")
    }

    private var row: some View {
        HStack(spacing: 2) {
            ForEach(Self.quick, id: \.self) { emoji in
                emojiButton(emoji, size: 26)
            }
            Button {
                showsAll = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Theme.Color.surface))
            }
            .accessibilityLabel("More reactions")
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
    }

    private var grid: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 2), count: 8), spacing: 2) {
                ForEach(Self.extended, id: \.self) { emoji in
                    emojiButton(emoji, size: 22)
                }
            }
            Button {
                showsAll = false
            } label: {
                Text("Fewer")
                    .font(Theme.Typography.micro)
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(height: 24)
            }
        }
        .padding(Theme.Layout.spacing2)
        .frame(width: 330)
    }

    private func emojiButton(_ emoji: String, size: CGFloat) -> some View {
        Button {
            onPick(emoji)
            onDismiss()
        } label: {
            Text(emoji)
                .font(.system(size: size))
                .frame(width: 38, height: 38)
                .background(
                    Circle().fill(mine.contains(emoji) ? Theme.Color.primaryTint : Color.clear)
                )
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("React with \(emoji)")
    }
}

// MARK: - Who reacted

/// The long-press detail: every reaction on one message, grouped by emoji.
///
/// Tapping my own row removes that reaction, which is the only way to undo a
/// reaction you made from the extended grid without hunting for the same emoji again.
struct ReactionDetailSheet: View {
    let reactions: [Reaction]
    /// Nil while the store hasn't told us who we are; the "you" affordance is then
    /// simply not offered rather than guessed at.
    let currentUserID: String?
    let onRemove: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    private struct EmojiGroup: Identifiable {
        let emoji: String
        let people: [Reaction]
        var id: String { emoji }
    }

    /// Grouped by emoji, in first-reaction order — the same order the chips under
    /// the bubble use, so the sheet matches what was tapped.
    private var groups: [EmojiGroup] {
        var order: [String] = []
        var buckets: [String: [Reaction]] = [:]
        for reaction in reactions {
            if buckets[reaction.emoji] == nil { order.append(reaction.emoji) }
            buckets[reaction.emoji, default: []].append(reaction)
        }
        return order.map { EmojiGroup(emoji: $0, people: buckets[$0] ?? []) }
    }

    var body: some View {
        VStack(spacing: 0) {
            ChatSheetHeader(
                title: "Reactions",
                subtitle: reactions.count == 1 ? "1 reaction" : "\(reactions.count) reactions"
            ) { dismiss() }

            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Layout.spacing4) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                            HStack(spacing: Theme.Layout.spacing2) {
                                Text(group.emoji).font(.system(size: 20))
                                Text("\(group.people.count)")
                                    .font(Theme.Typography.pill)
                                    .foregroundStyle(Theme.Color.textMuted)
                            }

                            VStack(spacing: 0) {
                                ForEach(Array(group.people.enumerated()), id: \.offset) { index, reaction in
                                    if index > 0 { Hairline() }
                                    personRow(reaction, emoji: group.emoji)
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
                .padding(Theme.Layout.gutter)
            }
        }
        .background(Theme.Color.bg)
    }

    private func personRow(_ reaction: Reaction, emoji: String) -> some View {
        let isMine = currentUserID != nil && reaction.userId == currentUserID

        return Button {
            guard isMine else { return }
            onRemove(emoji)
            dismiss()
        } label: {
            HStack(spacing: Theme.Layout.spacing3) {
                Avatar(name: reaction.userName, urlPath: nil, size: Theme.Layout.avatarSmall)
                VStack(alignment: .leading, spacing: 1) {
                    Text(isMine ? "You" : reaction.userName)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.text)
                    if isMine {
                        Text("Tap to remove")
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
                Spacer(minLength: 0)
                if let created = reaction.createdAt {
                    Text(created.bubbleTimeLabel)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .padding(.horizontal, Theme.Layout.spacing3)
            .frame(minHeight: Theme.Layout.minTouchTarget + 8)
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isMine)
    }
}
