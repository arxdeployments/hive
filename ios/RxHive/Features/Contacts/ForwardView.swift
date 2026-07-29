import SwiftUI

/// The forward sheet, ported from `ForwardModal.jsx`.
///
/// Takes ids rather than `Message` values because the media / links / docs gallery's
/// Select mode only ever has `message_id` to hand — the same reason the web modal
/// normalises both shapes to a list of ids before rendering anything.
///
/// `POST /api/conversations/messages/forward` forwards **one** message per call, so
/// a multi-select forward is a sequential fan-out, and failures are aggregated: one
/// unforwardable item must not silently drop the rest.
struct ForwardView: View {
    let messageIDs: [String]

    init(messageID: String) {
        self.messageIDs = [messageID]
    }

    init(messageIDs: [String]) {
        self.messageIDs = messageIDs
    }

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @StateObject private var directory = ContactDirectory()
    @State private var selectedConversations: Set<String> = []
    @State private var selectedContacts: Set<String> = []
    @State private var isSending = false

    private var selectionCount: Int { selectedConversations.count + selectedContacts.count }

    /// Conversations are filtered locally — the list is already in `ChatStore` and
    /// re-querying `/api/conversations?search=` would fight the contact search's
    /// debounce for the same keystrokes.
    private var recentChats: [Conversation] {
        let term = directory.query.trimmed.lowercased()
        let matches = chat.conversations.filter { conversation in
            guard !term.isEmpty else { return true }
            if chat.title(for: conversation).lowercased().contains(term) { return true }
            return conversation.participants.contains {
                $0.displayName.lowercased().contains(term)
            }
        }
        // The same cap the web uses: this is a shortcut to recent chats, not a
        // second conversation list.
        return Array(matches.prefix(10))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Color.bg.ignoresSafeArea()

                VStack(spacing: 0) {
                    preview

                    SearchField(placeholder: "Search chats and contacts", text: $directory.query)
                        .padding(.horizontal, Theme.Layout.gutter)
                        .padding(.vertical, Theme.Layout.spacing3)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if !recentChats.isEmpty {
                                sectionHeader("Recent chats")
                                ForEach(recentChats) { conversation in
                                    chatRow(for: conversation)
                                }
                            }

                            sectionHeader("Contacts")
                            contactList
                        }
                        .padding(.bottom, Theme.Layout.spacing4)
                    }
                    .scrollDismissesKeyboard(.immediately)

                    footer
                }
            }
            .navigationTitle("Forward")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .disabled(isSending)
                }
            }
            .task { await directory.start() }
        }
    }

    // MARK: Chrome

    private var preview: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Forwarding")
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textMuted)
            Text(messageIDs.count == 1 ? "1 message" : "\(messageIDs.count) messages")
                .font(Theme.Typography.subheadline)
                .foregroundStyle(Theme.Color.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .background(Theme.Color.sidebar)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private func sectionHeader(_ title: String) -> some View {
        SectionHeader(title: title)
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing3)
            .padding(.bottom, Theme.Layout.spacing2)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Hairline()
            PrimaryButton(
                title: selectionCount > 0 ? "Forward (\(selectionCount))" : "Forward",
                systemImage: "arrowshape.turn.up.right",
                isLoading: isSending,
                isEnabled: selectionCount > 0
            ) {
                Task { await forward() }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing3)
            .padding(.bottom, Theme.Layout.spacing2)
        }
        .background(Theme.Color.sidebar)
    }

    // MARK: Rows

    private func chatRow(for conversation: Conversation) -> some View {
        let title = chat.title(for: conversation)
        let other = chat.otherParticipant(in: conversation)
        let isGroup = conversation.type.isGroup
        let status = other.map { chat.status(of: $0.userId, fallback: $0.status) }

        return ForwardChatRow(
            title: title,
            subtitle: subtitle(isGroup: isGroup, conversation: conversation, other: other, status: status),
            avatarName: title,
            avatarPath: isGroup ? conversation.avatarURL : other?.avatarURL,
            // A group has no single person behind it, so no presence dot.
            status: isGroup ? nil : status,
            isSelected: selectedConversations.contains(conversation.id)
        ) {
            toggle(conversationID: conversation.id)
        }
    }

    private func subtitle(
        isGroup: Bool,
        conversation: Conversation,
        other: UserBrief?,
        status: PresenceStatus?
    ) -> String {
        if isGroup {
            let count = conversation.participants.count
            return count == 1 ? "1 member" : "\(count) members"
        }
        if status == .online { return "Online" }
        if let lastSeen = other?.lastSeen { return lastSeen.lastSeenLabel }
        return "Direct message"
    }

    @ViewBuilder
    private var contactList: some View {
        if directory.contacts.isEmpty, directory.isLoading {
            ProgressView()
                .tint(Theme.Color.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Layout.spacing6)
        } else if directory.contacts.isEmpty, let message = directory.errorMessage {
            Text(message)
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing4)
        } else if directory.contacts.isEmpty {
            Text("No contacts found")
                .font(Theme.Typography.caption)
                .foregroundStyle(Theme.Color.textMuted)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing4)
        } else {
            ForEach(directory.contacts) { contact in
                ContactRow(
                    contact: contact,
                    status: chat.status(of: contact.id, fallback: contact.status),
                    isSelected: selectedContacts.contains(contact.id),
                    onTap: { toggle(contactID: contact.id) }
                )
            }
        }
    }

    // MARK: Selection

    private func toggle(conversationID: String) {
        withAnimation(Theme.Motion.ease) {
            if selectedConversations.contains(conversationID) {
                selectedConversations.remove(conversationID)
            } else {
                selectedConversations.insert(conversationID)
            }
        }
    }

    private func toggle(contactID: String) {
        withAnimation(Theme.Motion.ease) {
            if selectedContacts.contains(contactID) {
                selectedContacts.remove(contactID)
            } else {
                selectedContacts.insert(contactID)
            }
        }
    }

    // MARK: Forwarding

    private func forward() async {
        guard selectionCount > 0, !messageIDs.isEmpty, !isSending else { return }
        isSending = true

        let conversationIDs = Array(selectedConversations)
        let contactIDs = Array(selectedContacts)
        var sent = 0
        var reached: Set<String> = []
        var lastError: Error?

        for messageID in messageIDs {
            do {
                // The response is the ids the server actually wrote to: it silently
                // skips a target you are no longer a member of, so this — not the
                // selection count — is the truthful number to report.
                let forwardedTo = try await RxHiveAPI.forward(
                    messageID: messageID,
                    conversationIDs: conversationIDs,
                    contactIDs: contactIDs
                )
                reached.formUnion(forwardedTo)
                sent += 1
            } catch {
                lastError = error
            }
        }

        isSending = false

        guard sent > 0, !reached.isEmpty else {
            if let lastError {
                toasts.failure(lastError, fallback: "Couldn't forward that")
            } else {
                toasts.error("Couldn't forward to those chats")
            }
            return
        }

        let messageWord = sent == 1 ? "message" : "messages"
        let chatWord = reached.count == 1 ? "chat" : "chats"
        toasts.success("Forwarded \(sent) \(messageWord) to \(reached.count) \(chatWord)")
        if sent < messageIDs.count {
            toasts.error("Some messages couldn't be forwarded")
        }
        // No list refresh here on purpose. `messaging.forward_message` publishes
        // `new_message` only to the *other* participants, so there is nothing to
        // apply locally, and re-fetching would have to guess the filter/search the
        // chat list is currently showing and would silently replace it. The target
        // threads read correctly the moment they are opened, and the list picks the
        // copies up on its next load.
        dismiss()
    }
}

/// A conversation row in the forward picker. Deliberately not `ContactRow`: the
/// target here is a conversation, which may be a group with no single person and no
/// presence at all.
struct ForwardChatRow: View {
    let title: String
    let subtitle: String
    let avatarName: String
    let avatarPath: String?
    /// nil for groups — a group has no presence dot.
    let status: PresenceStatus?
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Layout.spacing3) {
                ContactCheckbox(isOn: isSelected)

                Avatar(
                    name: avatarName,
                    urlPath: avatarPath,
                    size: Theme.Layout.avatarMedium,
                    presence: status
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(Theme.Typography.font(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                        .lineLimit(1)
                }

                Spacer(minLength: Theme.Layout.spacing2)
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing2)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
            .background(isSelected ? Theme.Color.primaryTint : Color.clear)
        }
        .buttonStyle(PressScaleStyle())
    }
}
