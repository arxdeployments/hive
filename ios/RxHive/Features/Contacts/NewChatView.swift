import SwiftUI

/// The "New chat" sheet — the port of `NewChatModal.jsx`, plus the group entry
/// point the web app keeps in a separate modal.
///
/// It does not push the thread itself: the caller owns the navigation stack the
/// chat list lives in, so the id of the opened conversation is handed back through
/// `onOpen` and the sheet closes. Presenting a chat *inside* a sheet would give the
/// user a second, disconnected copy of the conversation.
struct NewChatView: View {
    /// The conversation to open once the sheet has dismissed.
    let onOpen: (String) -> Void

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @StateObject private var directory = ContactDirectory()
    @State private var opening: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.Color.bg.ignoresSafeArea()

                VStack(spacing: 0) {
                    SearchField(placeholder: "Search by name or email", text: $directory.query)
                        .padding(.horizontal, Theme.Layout.gutter)
                        .padding(.bottom, Theme.Layout.spacing3)

                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            // Hidden while searching: a "New group" row is not a
                            // search result, and leaving it above the matches makes
                            // the first hit jump down the list.
                            if directory.query.trimmed.isEmpty {
                                newGroupRow
                                Hairline()
                            }
                            contactList
                        }
                        .padding(.bottom, Theme.Layout.spacing8)
                    }
                    .scrollDismissesKeyboard(.immediately)
                }
            }
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                }
            }
            .task { await directory.start() }
        }
    }

    // MARK: Rows

    private var newGroupRow: some View {
        NavigationLink {
            CreateGroupView { conversationID in
                // Same contract as picking a contact: hand the id back and get out
                // of the way so the caller can push the new group's thread.
                dismiss()
                onOpen(conversationID)
            }
        } label: {
            HStack(spacing: Theme.Layout.spacing3) {
                ZStack {
                    Circle().fill(Theme.Color.primaryTint)
                    Image(systemName: "person.3.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(Theme.Color.primary)
                }
                .frame(width: Theme.Layout.avatarMedium, height: Theme.Layout.avatarMedium)

                VStack(alignment: .leading, spacing: 2) {
                    Text("New group")
                        .font(Theme.Typography.font(size: 16, weight: .medium))
                        .foregroundStyle(Theme.Color.text)
                    Text("Pick members, then name it")
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.textMuted)
                }

                Spacer(minLength: Theme.Layout.spacing2)

                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .frame(minHeight: 64)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
    }

    @ViewBuilder
    private var contactList: some View {
        if directory.contacts.isEmpty, directory.isLoading {
            ProgressView()
                .tint(Theme.Color.primary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.Layout.spacing8)
        } else if directory.contacts.isEmpty, let message = directory.errorMessage {
            EmptyStateView(
                systemImage: "wifi.slash",
                title: "Couldn't load contacts",
                message: message,
                actionTitle: "Try again"
            ) {
                Task { await directory.refresh() }
            }
            .frame(minHeight: 240)
        } else if directory.contacts.isEmpty {
            EmptyStateView(
                systemImage: "person.2",
                title: directory.query.trimmed.isEmpty ? "No contacts available" : "No matches",
                message: directory.query.trimmed.isEmpty
                    ? "No one else in your organization has an account yet."
                    : nil
            )
            .frame(minHeight: 240)
        } else {
            ForEach(directory.contacts) { contact in
                ContactRow(
                    contact: contact,
                    status: chat.status(of: contact.id, fallback: contact.status),
                    isSelected: nil,
                    onTap: { Task { await open(contact) } }
                ) {
                    if opening == contact.id {
                        ProgressView()
                            .tint(Theme.Color.textMuted)
                            .scaleEffect(0.8)
                            .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    }
                }
                if contact.id != directory.contacts.last?.id {
                    Hairline()
                        .padding(.leading, Theme.Layout.gutter + Theme.Layout.avatarMedium + Theme.Layout.spacing3)
                }
            }
        }
    }

    // MARK: Actions

    private func open(_ contact: Contact) async {
        guard opening == nil else { return }
        opening = contact.id
        do {
            let conversation = try await RxHiveAPI.directConversation(participantID: contact.id)
            chat.upsert(conversation)
            dismiss()
            onOpen(conversation.id)
        } catch {
            toasts.failure(error, fallback: "Couldn't start that chat")
        }
        opening = nil
    }
}
