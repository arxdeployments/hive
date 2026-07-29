import SwiftUI
import UIKit

// MARK: - Shared info-panel building blocks
//
// The web app has one drawer shell whose left rail swaps the right pane
// (`info/InfoPanelShell.jsx`). A phone has no room for a rail, so the two panels
// become pushed screens and the rail's sections become rows that push further.
// The rows, toggles and states are shared between ContactInfoView and
// GroupInfoView exactly as `info/InfoPanelPrimitives.jsx` shares them on the web —
// one definition, so the two panels cannot drift apart.

/// Where an independently-loaded section (groups in common, permissions, starred)
/// currently is. Four states rather than a `Bool` pair because "loaded but empty"
/// and "failed" need different copy, and conflating them is how a network error
/// ends up reading as "no results".
enum InfoLoadState: Equatable {
    case idle, loading, loaded, failed
}

/// A grouped card on `--rx-surface`, holding rows separated by `InfoRowDivider`.
///
/// Not `SurfaceCard`: that pads its content, which is wrong for full-bleed rows
/// whose tap target has to reach the card's edges.
struct InfoCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(spacing: 0) { content() }
            .background(
                RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                    .fill(Theme.Color.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                            .stroke(Theme.Color.border, lineWidth: 1)
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.radiusCard))
    }
}

/// The between-rows rule. Inset to the leading edge of the row's text so it reads
/// as a list separator rather than as a card split in two.
struct InfoRowDivider: View {
    var inset: CGFloat = 52

    var body: some View {
        Hairline().padding(.leading, inset)
    }
}

/// The visual content of a settings row. Shared by the button, navigation and
/// toggle variants so all three line up to the same grid.
struct InfoRowLabel: View {
    var systemImage: String?
    let title: String
    var subtitle: String?
    var trailingText: String?
    var iconTint: Color = Theme.Color.textMuted
    var titleTint: Color = Theme.Color.text
    var showsChevron = false
    var isBusy = false

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 17))
                    .foregroundStyle(iconTint)
                    .frame(width: 24)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(titleTint)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isBusy {
                ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
            } else if let trailingText {
                Text(trailingText)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted.opacity(0.7))
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }
}

/// A tappable settings row.
struct InfoActionRow: View {
    var systemImage: String?
    let title: String
    var subtitle: String?
    var trailingText: String?
    var isDestructive = false
    var isEnabled = true
    var isBusy = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            InfoRowLabel(
                systemImage: systemImage,
                title: title,
                subtitle: subtitle,
                trailingText: trailingText,
                iconTint: isDestructive ? Theme.Color.danger : Theme.Color.textMuted,
                titleTint: isDestructive ? Theme.Color.danger : Theme.Color.text,
                isBusy: isBusy
            )
        }
        .buttonStyle(PressScaleStyle())
        .disabled(!isEnabled || isBusy)
        .opacity(isEnabled ? 1 : 0.45)
    }
}

/// A settings row that pushes another screen.
struct InfoNavigationRow<Destination: View>: View {
    var systemImage: String?
    let title: String
    var subtitle: String?
    var trailingText: String?
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            InfoRowLabel(
                systemImage: systemImage,
                title: title,
                subtitle: subtitle,
                trailingText: trailingText,
                showsChevron: true
            )
        }
        .buttonStyle(PressScaleStyle())
    }
}

/// A switch row. `onChange` receives the value the user asked for; the caller owns
/// the optimistic update and the roll-back, because only it knows what the server
/// answered.
struct InfoToggleRow: View {
    let title: String
    var subtitle: String?
    let isOn: Bool
    var isEnabled = true
    var isBusy = false
    let onChange: (Bool) -> Void

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(isEnabled ? Theme.Color.text : Theme.Color.textMuted)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if isBusy {
                ProgressView().tint(Theme.Color.primary).scaleEffect(0.7)
            } else {
                Toggle("", isOn: Binding(get: { isOn }, set: { onChange($0) }))
                    .labelsHidden()
                    .tint(Theme.Color.primary)
                    .disabled(!isEnabled)
                    .accessibilityLabel(title)
            }
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
    }
}

/// A read-only identity row (email, department, purpose tag) with an optional
/// copy affordance.
struct InfoDetailRow: View {
    var systemImage: String?
    let label: String
    let value: String?
    var copyable = false

    @EnvironmentObject private var toasts: ToastCenter
    @State private var copied = false

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: 24)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(label.uppercased())
                    .font(Theme.Typography.micro)
                    .tracking(0.6)
                    .foregroundStyle(Theme.Color.textMuted)
                Text(value.flatMap { $0.isEmpty ? nil : $0 } ?? "—")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if copyable, let value, !value.isEmpty {
                Button {
                    UIPasteboard.general.string = value
                    copied = true
                    toasts.success("\(label) copied")
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(copied ? Theme.Color.primary : Theme.Color.textMuted)
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Copy \(label.lowercased())")
            }
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, copyable ? 0 : Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
    }
}

/// The icon-over-label buttons under the hero avatar (Audio / Video / Add / Search).
struct InfoQuickAction: View {
    let systemImage: String
    let title: String
    var isEnabled = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.Layout.spacing1 + 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 18))
                Text(title)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(Theme.Color.text)
            }
            .foregroundStyle(Theme.Color.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 62)
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
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.4)
    }
}

/// A quick-action-shaped `NavigationLink`, so "Search" sits in the same row as the
/// call buttons without one of them being a different control.
struct InfoQuickActionLink<Destination: View>: View {
    let systemImage: String
    let title: String
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        NavigationLink {
            destination()
        } label: {
            VStack(spacing: Theme.Layout.spacing1 + 2) {
                Image(systemName: systemImage)
                    .font(.system(size: 18))
                Text(title)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(Theme.Color.text)
            }
            .foregroundStyle(Theme.Color.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 62)
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
    }
}

/// In-place loading state for a section that is not the whole screen.
struct InfoLoadingRow: View {
    var label: String = "Loading…"

    var body: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            ProgressView().tint(Theme.Color.primary).scaleEffect(0.7)
            Text(label)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Layout.spacing5)
    }
}

/// Section-level failure with a retry. A section that failed must say so and offer
/// the retry itself — the alternative is an empty area the user reads as "nothing
/// here", which is a different and wrong fact.
struct InfoRetryView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: Theme.Layout.spacing3) {
            Text(message)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .multilineTextAlignment(.center)
            Button(action: retry) {
                Text("Try again")
                    .font(Theme.Typography.pill)
                    .foregroundStyle(Theme.Color.primary)
                    .padding(.horizontal, Theme.Layout.spacing4)
                    .frame(height: Theme.Layout.minTouchTarget - 8)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Layout.radiusInput)
                            .stroke(Theme.Color.primaryTintBorder, lineWidth: 1)
                    )
            }
            .buttonStyle(PressScaleStyle())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Layout.spacing5)
    }
}

// MARK: - Encryption notice

/// What protects this chat, ported verbatim in substance from
/// `info/EncryptionSection.jsx`.
///
/// Deliberately NOT a "your messages are end-to-end encrypted" screen: RX HIVE has
/// no E2E encryption, the server can read message content, and the last card says
/// so. Do not soften this into a WhatsApp-style privacy promise — it would be a
/// false security claim, on a product used for clinical coordination.
struct EncryptionNoticeView: View {

    private struct Point: Identifiable {
        let id = UUID()
        let systemImage: String
        let title: String
        let body: String
    }

    private let points: [Point] = [
        Point(
            systemImage: "lock",
            title: "Encrypted in transit",
            body: "Messages, calls and file transfers travel over TLS (HTTPS) and secure WebSockets. Someone sharing your network — office Wi-Fi, a café hotspot, your ISP — cannot read them off the wire."
        ),
        Point(
            systemImage: "checkmark.shield",
            title: "Authorised on every request",
            body: "Your session lives in a cookie this app cannot read out, and every read and write is checked on the server against your membership of the conversation."
        ),
        Point(
            systemImage: "building.2",
            title: "Scoped to your organization",
            body: "Conversations are isolated per organization. People outside it cannot list, open or search this chat, and cross-organization groups only reach the organizations explicitly added to them."
        ),
        Point(
            systemImage: "externaldrive.badge.icloud",
            title: "Stored on RX HIVE servers",
            body: "History is retained on the server so you can search it and pick it up on another device. Clearing a chat hides your copy; everyone else keeps theirs."
        )
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Layout.spacing4) {
                VStack(spacing: Theme.Layout.spacing3) {
                    ZStack {
                        Circle().fill(Theme.Color.primaryTint)
                        Image(systemName: "lock")
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.Color.primary)
                    }
                    .frame(width: 56, height: 56)

                    Text("How this chat is protected")
                        .font(Theme.Typography.headline)
                        .foregroundStyle(Theme.Color.text)
                    Text("RX HIVE secures your conversations in transit and controls who can reach them. Here is exactly what that does and does not cover.")
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, Theme.Layout.spacing2)
                .padding(.bottom, Theme.Layout.spacing2)

                ForEach(points) { point in
                    SurfaceCard {
                        HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
                            Image(systemName: point.systemImage)
                                .font(.system(size: 17))
                                .foregroundStyle(Theme.Color.primary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: Theme.Layout.spacing1) {
                                Text(point.title)
                                    .font(Theme.Typography.font(size: 15, weight: .medium))
                                    .foregroundStyle(Theme.Color.text)
                                Text(point.body)
                                    .font(Theme.Typography.subheadline)
                                    .foregroundStyle(Theme.Color.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }

                // The honest caveat. Keep it visible — it is the point of this screen.
                HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 17))
                        .foregroundStyle(Theme.Color.textMuted)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: Theme.Layout.spacing1) {
                        Text("Not end-to-end encrypted")
                            .font(Theme.Typography.font(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Color.text)
                        Text("Message content is readable on the RX HIVE server, so your organization's administrators can access it where policy, compliance or the law requires. Treat this as a work chat, not a private one — for anything that must stay unreadable to your organization, use a channel designed for it.")
                            .font(Theme.Typography.subheadline)
                            .foregroundStyle(Theme.Color.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Theme.Layout.spacing4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                        .fill(Theme.Color.surface2)
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusCard)
                                .stroke(Theme.Color.border2, lineWidth: 1)
                        )
                )
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing5)
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .navigationTitle("Encryption")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Contact info

/// The 1:1 conversation's info panel, ported from `ContactInfoPanel.jsx`.
///
/// HARD RULE, carried over from the web panel: this screen never renders a phone
/// number. RX HIVE is an org directory keyed on work email, there is no phone
/// field anywhere in the wire contract, and inventing one would be inventing data.
/// "Organization" and "About" are absent for the same reason — nothing this screen
/// can reach carries them for *another* user, so both rows rendered a permanent
/// em dash on the web and were removed.
struct ContactInfoView: View {

    let conversation: Conversation

    /// Optional integration hooks. The thread screen and the router are owned by
    /// other parts of the app; this panel stays compilable on its own by taking
    /// them as closures and degrading to something real when they are absent.
    var onJumpToMessage: ((String) -> Void)?
    var onOpenConversation: ((String) -> Void)?
    var onStartCall: ((CallType) -> Void)?

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    /// Email and department are not on the conversation participant wire shape
    /// (`enrich.serialize_user_brief` omits both), so they come from the org roster.
    @State private var directoryRow: Contact?
    @State private var groups: [Conversation] = []
    @State private var groupsState: InfoLoadState = .idle
    @State private var mutePending = false
    @State private var confirmClear = false
    @State private var confirmDelete = false
    @State private var isWorking = false

    /// The store's copy wins: muting or clearing updates it, and the value handed
    /// to `init` is a snapshot from whenever the row was tapped.
    private var live: Conversation {
        chat.conversation(id: conversation.id) ?? conversation
    }

    private var person: UserBrief? { chat.otherParticipant(in: live) }

    private var displayName: String {
        person?.displayName ?? chat.title(for: live)
    }

    private var presence: PresenceStatus {
        guard let person else { return .offline }
        return chat.status(of: person.userId, fallback: person.status)
    }

    private var presenceLabel: String {
        if presence == .online { return "online" }
        if let lastSeen = person?.lastSeen { return lastSeen.lastSeenLabel }
        return "offline"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Layout.spacing6) {
                hero
                quickActions
                directorySection
                contentSection
                settingsSection
                groupsSection
                protectionSection
                dangerSection
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing5)
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .navigationTitle("Contact info")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: person?.userId) {
            await loadDirectoryRow()
            await loadGroupsInCommon()
        }
        .confirmationDialog(
            "Clear this chat?",
            isPresented: $confirmClear,
            titleVisibility: .visible
        ) {
            Button("Clear chat", role: .destructive) { Task { await clearHistory() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every message will be removed from your copy of this chat. \(displayName) keeps theirs.")
        }
        .confirmationDialog(
            "Delete this chat?",
            isPresented: $confirmDelete,
            titleVisibility: .visible
        ) {
            Button("Delete chat", role: .destructive) { Task { await deleteChat() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The conversation leaves your list. \(displayName) keeps their copy, and a new message from either of you starts it again.")
        }
    }

    // MARK: Hero

    private var hero: some View {
        VStack(spacing: Theme.Layout.spacing3) {
            Avatar(
                name: displayName,
                urlPath: person?.avatarURL,
                size: Theme.Layout.avatarHero,
                presence: presence
            )

            VStack(spacing: Theme.Layout.spacing1) {
                Text(displayName)
                    .font(Theme.Typography.title)
                    .foregroundStyle(Theme.Color.text)
                    .multilineTextAlignment(.center)

                // Email under the name, where WhatsApp puts the phone number.
                Text(directoryRow?.email ?? "Email not available")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
                    .multilineTextAlignment(.center)

                Text(presenceLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(presence == .online ? Theme.Color.primary : Theme.Color.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var quickActions: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            InfoQuickAction(systemImage: "phone", title: "Audio", isEnabled: person != nil) {
                startCall(.voice)
            }
            InfoQuickAction(systemImage: "video", title: "Video", isEnabled: person != nil) {
                startCall(.video)
            }
            InfoQuickActionLink(systemImage: "magnifyingglass", title: "Search") {
                InConversationSearchView(conversationID: live.id, onJump: jump)
            }
        }
    }

    // MARK: Sections

    private var directorySection: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "Directory")
            InfoCard {
                InfoDetailRow(
                    systemImage: "envelope",
                    label: "Email",
                    value: directoryRow?.email,
                    copyable: true
                )
                InfoRowDivider()
                InfoDetailRow(
                    systemImage: "square.grid.2x2",
                    label: "Department",
                    value: directoryRow?.departmentName
                )
            }
        }
    }

    private var contentSection: some View {
        InfoCard {
            InfoNavigationRow(
                systemImage: "photo.on.rectangle",
                title: "Media, links and docs"
            ) {
                MediaGalleryView(conversationID: live.id)
            }
            InfoRowDivider()
            InfoNavigationRow(systemImage: "star", title: "Starred messages") {
                StarredMessagesView(conversationID: live.id, onJump: jump)
            }
            InfoRowDivider()
            InfoNavigationRow(systemImage: "pin", title: "Pinned messages") {
                PinnedMessagesView(conversationID: live.id, onJump: jump)
            }
        }
    }

    private var settingsSection: some View {
        InfoCard {
            InfoToggleRow(
                title: "Mute notifications",
                subtitle: live.isMuted
                    ? "You will not be notified about new messages"
                    : "Notifications are on",
                isOn: live.isMuted,
                isBusy: mutePending
            ) { _ in
                Task { await toggleMute() }
            }
            InfoRowDivider(inset: Theme.Layout.spacing4)
            // Present and inert, exactly as on the web: the product has no
            // disappearing-messages support, and hiding the row makes people hunt
            // for a setting that does not exist.
            InfoRowLabel(
                systemImage: "timer",
                title: "Disappearing messages",
                subtitle: "Not available on RX HIVE yet",
                trailingText: "Off"
            )
        }
    }

    @ViewBuilder
    private var groupsSection: some View {
        VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
            SectionHeader(title: "Groups in common")

            switch groupsState {
            case .idle, .loading:
                InfoCard { InfoLoadingRow(label: "Loading groups…") }

            case .failed:
                InfoCard {
                    InfoRetryView(message: "Couldn't load groups in common.") {
                        Task { await loadGroupsInCommon(force: true) }
                    }
                }

            case .loaded where groups.isEmpty:
                InfoCard {
                    InfoRowLabel(
                        systemImage: "person.2",
                        title: "No groups in common",
                        subtitle: "You and \(displayName) are not in any of the same groups yet."
                    )
                }

            case .loaded:
                InfoCard {
                    ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                        if index > 0 { InfoRowDivider(inset: Theme.Layout.spacing4 + 38 + Theme.Layout.spacing3) }
                        Button {
                            open(conversationID: group.id)
                        } label: {
                            groupRow(group)
                        }
                        .buttonStyle(PressScaleStyle())
                    }
                }
            }
        }
    }

    private func groupRow(_ group: Conversation) -> some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: group.name ?? "Group", urlPath: group.avatarURL, size: 38)

            VStack(alignment: .leading, spacing: 2) {
                Text(group.name ?? "Group")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                Text(memberSummary(of: group))
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if group.crossOrg || group.type == .crossOrg {
                Pill(text: "Cross-Org")
            }

            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Color.textMuted.opacity(0.7))
        }
        .padding(.horizontal, Theme.Layout.spacing4)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }

    private func memberSummary(of group: Conversation) -> String {
        let names = group.participants.prefix(4).map { participant in
            participant.userId == chat.currentUserID ? "You" : participant.displayName
        }
        var summary = names.joined(separator: ", ")
        if group.participants.count > 4 {
            summary += " +\(group.participants.count - 4)"
        }
        return summary
    }

    private var protectionSection: some View {
        InfoCard {
            InfoNavigationRow(
                systemImage: "lock",
                title: "Encryption",
                subtitle: "Encrypted in transit, readable on the server"
            ) {
                EncryptionNoticeView()
            }
        }
    }

    private var dangerSection: some View {
        InfoCard {
            InfoActionRow(
                systemImage: "eraser",
                title: "Clear chat",
                subtitle: "Remove all messages from your copy of this chat",
                isEnabled: !isWorking
            ) {
                confirmClear = true
            }
            InfoRowDivider()
            InfoActionRow(
                systemImage: "trash",
                title: "Delete chat",
                subtitle: "Remove this conversation from your list",
                isDestructive: true,
                isEnabled: !isWorking
            ) {
                confirmDelete = true
            }
        }
    }

    // MARK: Actions

    private func jump(_ messageID: String) {
        onJumpToMessage?(messageID)
        // The panel is pushed from the thread, so popping is what puts the jumped-to
        // message on screen. Harmless when there is no jump handler.
        dismiss()
    }

    private func open(conversationID: String) {
        if let onOpenConversation {
            onOpenConversation(conversationID)
            dismiss()
        } else {
            // No router: the best real outcome is to make sure the chat is in the
            // list and get out of the way, rather than pretending to navigate.
            Task { await chat.refreshConversation(id: conversationID) }
            dismiss()
        }
    }

    private func startCall(_ type: CallType) {
        guard let person else { return }
        if let onStartCall {
            onStartCall(type)
            return
        }
        // No call coordinator was handed in. `call:initiate` is what actually starts
        // the call server-side (`services/calls.py:handle_call_ws_message`) and the
        // resulting `call:ringing_started` is what CallStore renders from, so sending
        // the frame is the real action rather than a stub.
        guard auth.realtime.state == .connected else {
            toasts.error("You're offline — reconnect to place a call.")
            return
        }
        auth.realtime.send(
            .callInitiate(calleeID: person.userId, callType: type.rawValue, conversationID: live.id)
        )
    }

    private func toggleMute() async {
        mutePending = true
        defer { mutePending = false }
        if let muted = await chat.toggleMute(conversationID: live.id) {
            toasts.success(muted ? "Notifications muted" : "Notifications unmuted")
        } else {
            toasts.error("Failed to change mute")
        }
    }

    private func clearHistory() async {
        isWorking = true
        defer { isWorking = false }
        if await chat.clearHistory(conversationID: live.id) {
            toasts.success("Chat cleared")
        } else {
            toasts.error("Failed to clear chat")
        }
    }

    private func deleteChat() async {
        isWorking = true
        defer { isWorking = false }
        if await chat.deleteConversation(id: live.id) {
            toasts.success("Chat deleted")
            dismiss()
        } else {
            toasts.error("Failed to delete chat")
        }
    }

    // MARK: Loading

    private func loadDirectoryRow() async {
        guard let userID = person?.userId else { return }
        // A miss here only blanks two rows, so it fails quietly: the panel's primary
        // job (presence, media, mute, actions) does not depend on the roster.
        guard let rows = try? await RxHiveAPI.contacts() else { return }
        directoryRow = rows.first { $0.id == userID }
    }

    private func loadGroupsInCommon(force: Bool = false) async {
        guard let userID = person?.userId else {
            groupsState = .loaded
            return
        }
        if groupsState == .loaded && !force { return }
        groupsState = .loading
        do {
            groups = try await ContactInfoView.groupsInCommon(userID: userID)
            groupsState = .loaded
        } catch {
            groups = []
            groupsState = .failed
        }
    }

    private static func groupsInCommon(userID: String) async throws -> [Conversation] {
        try await RxHiveAPI.groupsInCommon(userID: userID)
    }
}
