import SwiftUI

// MARK: - Shared snippet helpers

/// How a non-text message reads in a list that has no bubble to show it in.
/// Same mapping as `info/StarredSection.jsx`'s TYPE_LABELS.
private func snippetLabel(for message: Message) -> String {
    if message.isDeleted { return "This message was deleted" }
    let text = message.content.trimmed
    if !text.isEmpty { return text }
    let label: String?
    switch message.type {
    case .image: label = "Photo"
    case .video: label = "Video"
    case .audio: label = "Voice message"
    case .file: label = "Document"
    case .text, .system, .unknown: label = nil
    }
    guard let label else { return "Message" }
    if let filename = message.filename, !filename.isEmpty { return "\(label) · \(filename)" }
    return label
}

/// A snippet with every occurrence of `query` picked out in emerald.
///
/// Built as an `AttributedString` rather than by slicing the text into a stack of
/// `Text` views: slicing breaks wrapping, and a search hit is exactly the case
/// where the match tends to sit mid-line in a long paragraph.
private func highlighted(_ text: String, query: String) -> AttributedString {
    var attributed = AttributedString(text)
    attributed.foregroundColor = Theme.Color.textMuted
    attributed.font = Theme.Typography.subheadline

    let needle = query.trimmed
    guard !needle.isEmpty else { return attributed }

    var searchRange = text.startIndex..<text.endIndex
    while let found = text.range(of: needle, options: [.caseInsensitive, .diacriticInsensitive], range: searchRange) {
        if let lower = AttributedString.Index(found.lowerBound, within: attributed),
           let upper = AttributedString.Index(found.upperBound, within: attributed) {
            attributed[lower..<upper].foregroundColor = Theme.Color.primary
            attributed[lower..<upper].font = Theme.Typography.font(size: 15, weight: .semibold)
        }
        guard found.upperBound < text.endIndex else { break }
        searchRange = found.upperBound..<text.endIndex
    }
    return attributed
}

/// One result row: who, when, and what matched.
private struct SearchResultRow: View {
    let title: String
    let timestamp: Date?
    let snippet: AttributedString
    var avatarName: String?
    var avatarPath: String?
    var systemImage: String?

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
            if let avatarName {
                Avatar(name: avatarName, urlPath: avatarPath, size: Theme.Layout.avatarSmall)
            } else if let systemImage {
                ZStack {
                    Circle().fill(Theme.Color.surface2)
                    Image(systemName: systemImage)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.Color.textMuted)
                }
                .frame(width: Theme.Layout.avatarSmall, height: Theme.Layout.avatarSmall)
            }

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Layout.spacing2) {
                    Text(title)
                        .font(Theme.Typography.font(size: 15, weight: .medium))
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let timestamp {
                        Text(timestamp.conversationListLabel)
                            .font(Theme.Typography.micro)
                            .foregroundStyle(Theme.Color.textMuted)
                    }
                }
                Text(snippet)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget, alignment: .top)
        .contentShape(Rectangle())
    }
}

// MARK: - In-conversation search

/// Search inside one conversation, ported from `ConversationSearch.jsx`.
///
/// The web version is a one-line bar above the thread with up/down chevrons that
/// step through hits. On a phone the thread is the whole screen, so the hits become
/// a list you pick from: stepping blind through matches you cannot see is a
/// pointer-and-big-screen interaction.
struct InConversationSearchView: View {

    let conversationID: String
    let onJump: (String) -> Void

    @EnvironmentObject private var chat: ChatStore
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var matches: [InConversationSearch.Match] = []
    @State private var total = 0
    @State private var state: InfoLoadState = .idle
    @State private var failureMessage: String?

    private var trimmedQuery: String { query.trimmed }

    var body: some View {
        VStack(spacing: 0) {
            SearchField(placeholder: "Search messages", text: $query)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing3)

            Hairline()

            content
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .navigationTitle("Search messages")
        .navigationBarTitleDisplayMode(.inline)
        // `.task(id:)` cancels the previous run when the query changes, so the sleep
        // below *is* the debounce — no timer to invalidate, no stale response landing
        // after a newer one.
        .task(id: trimmedQuery) {
            guard trimmedQuery.count >= 1 else {
                matches = []
                total = 0
                state = .idle
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle:
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "Search this chat",
                message: "Find a message by any word in it. Tap a result to jump to it in the conversation."
            )

        case .loading:
            VStack(spacing: Theme.Layout.spacing4) {
                ForEach(0..<5, id: \.self) { _ in
                    SkeletonRow(height: 14, widthFraction: 0.8)
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing4)
            .frame(maxHeight: .infinity, alignment: .top)

        case .failed:
            InfoRetryView(message: failureMessage ?? "Couldn't search this chat.") {
                Task { await search() }
            }
            .frame(maxHeight: .infinity, alignment: .top)

        case .loaded where matches.isEmpty:
            EmptyStateView(
                systemImage: "text.magnifyingglass",
                title: "No messages found",
                message: "Nothing in this chat matches \"\(trimmedQuery)\"."
            )

        case .loaded:
            ScrollView {
                LazyVStack(spacing: 0) {
                    HStack {
                        Text(total == 1 ? "1 match" : "\(total) matches")
                            .font(Theme.Typography.caption)
                            .foregroundStyle(Theme.Color.textMuted)
                        Spacer()
                    }
                    .padding(.horizontal, Theme.Layout.gutter)
                    .padding(.top, Theme.Layout.spacing3)
                    .padding(.bottom, Theme.Layout.spacing1)

                    ForEach(matches) { match in
                        Button {
                            onJump(match.messageID)
                            dismiss()
                        } label: {
                            SearchResultRow(
                                title: conversationTitle,
                                timestamp: match.createdAt,
                                snippet: highlighted(match.contentSnippet, query: trimmedQuery),
                                systemImage: "text.bubble"
                            )
                        }
                        .buttonStyle(PressScaleStyle())
                        InfoRowDivider(inset: Theme.Layout.gutter)
                    }
                }
            }
        }
    }

    /// The search endpoint returns ids, snippets and timestamps but no sender
    /// (`api/messages.py:search_messages`), so rows are titled with the chat itself
    /// rather than inventing an author.
    private var conversationTitle: String {
        guard let conversation = chat.conversation(id: conversationID) else { return "This chat" }
        return chat.title(for: conversation)
    }

    private func search() async {
        state = .loading
        failureMessage = nil
        do {
            let results = try await RxHiveAPI.searchInConversation(
                conversationID: conversationID, query: trimmedQuery
            )
            matches = results.matches
            total = results.total
            state = .loaded
        } catch {
            matches = []
            total = 0
            failureMessage = (error as? APIError)?.userMessage
            state = .failed
        }
    }
}

// MARK: - Global search

/// Search across chats, people and messages, ported from `GlobalSearchResults.jsx`.
///
/// The server caps every bucket at 5 (`search.py:_BUCKET_LIMIT`), so this is a
/// jump-off point rather than a browsable result set — three short sections, no
/// paging, no "show more" that the API cannot honour.
struct GlobalSearchView: View {

    /// Optional router hooks. Nil is a real configuration, not a bug: the thread
    /// screen belongs to another part of the app and is deliberately not referenced
    /// here, so this file stands alone.
    var onOpenConversation: ((String) -> Void)?
    var onOpenMessage: ((String, String) -> Void)?

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results = GlobalSearchModel()
    @State private var state: InfoLoadState = .idle
    @State private var openingContactID: String?

    private var trimmedQuery: String { query.trimmed }

    var body: some View {
        VStack(spacing: 0) {
            SearchField(placeholder: "Search chats, people and messages", text: $query)
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing3)

            Hairline()

            content
        }
        .background(Theme.Color.bg.ignoresSafeArea())
        .navigationTitle("Search")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: trimmedQuery) {
            guard trimmedQuery.count >= 1 else {
                results = GlobalSearchModel()
                state = .idle
                return
            }
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await search()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle:
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "Search RX HIVE",
                message: "Find a chat, someone in your organization, or a message you remember a word from."
            )

        case .loading:
            VStack(spacing: Theme.Layout.spacing4) {
                ForEach(0..<6, id: \.self) { _ in
                    SkeletonRow(height: 14, widthFraction: 0.75)
                }
            }
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing4)
            .frame(maxHeight: .infinity, alignment: .top)

        case .failed:
            InfoRetryView(message: "Couldn't run that search.") {
                Task { await search() }
            }
            .frame(maxHeight: .infinity, alignment: .top)

        case .loaded where results.isEmpty:
            EmptyStateView(
                systemImage: "text.magnifyingglass",
                title: "No results",
                message: "Nothing matches \"\(trimmedQuery)\"."
            )

        case .loaded:
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !results.chats.isEmpty {
                        sectionHeader("Chats")
                        ForEach(results.chats) { row in
                            Button { open(conversationID: row.id) } label: { chatRow(row) }
                                .buttonStyle(PressScaleStyle())
                            InfoRowDivider(inset: Theme.Layout.gutter)
                        }
                    }

                    if !results.contacts.isEmpty {
                        sectionHeader("Contacts")
                        ForEach(results.contacts) { row in
                            Button { Task { await openDirect(with: row) } } label: { contactRow(row) }
                                .buttonStyle(PressScaleStyle())
                                .disabled(openingContactID != nil)
                            InfoRowDivider(inset: Theme.Layout.gutter)
                        }
                    }

                    if !results.messages.isEmpty {
                        sectionHeader("Messages")
                        ForEach(results.messages) { row in
                            Button { open(message: row) } label: {
                                SearchResultRow(
                                    title: "\(row.senderName) · \(row.conversationName)",
                                    timestamp: row.createdAt,
                                    snippet: highlighted(row.snippet, query: trimmedQuery),
                                    systemImage: "text.bubble"
                                )
                            }
                            .buttonStyle(PressScaleStyle())
                            InfoRowDivider(inset: Theme.Layout.gutter)
                        }
                    }
                }
                .padding(.bottom, Theme.Layout.spacing6)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        SectionHeader(title: title)
            .padding(.horizontal, Theme.Layout.gutter)
            .padding(.top, Theme.Layout.spacing4)
            .padding(.bottom, Theme.Layout.spacing2)
    }

    private func chatRow(_ row: GlobalSearchModel.ChatRow) -> some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: row.name, urlPath: row.avatarPath, size: Theme.Layout.avatarSmall)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                Text(row.kindLabel)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.Color.textMuted.opacity(0.7))
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }

    private func contactRow(_ row: GlobalSearchModel.ContactRow) -> some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Avatar(name: row.name, urlPath: row.avatarPath, size: Theme.Layout.avatarSmall)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.text)
                    .lineLimit(1)
                Text(row.subtitle)
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if openingContactID == row.id {
                ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
            } else {
                Image(systemName: "bubble.left")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.Color.primary)
            }
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.vertical, Theme.Layout.spacing3)
        .frame(minHeight: Theme.Layout.minTouchTarget)
        .contentShape(Rectangle())
    }

    // MARK: Navigation

    private func open(conversationID: String) {
        if let onOpenConversation {
            onOpenConversation(conversationID)
        } else {
            // No router: make sure the chat is present and near the top of the list
            // the user is about to land back on. Better than a dead tap.
            Task { await chat.refreshConversation(id: conversationID) }
        }
        dismiss()
    }

    private func open(message row: GlobalSearchModel.MessageRow) {
        guard let conversationID = row.conversationID else { return }
        if let onOpenMessage {
            onOpenMessage(conversationID, row.id)
            dismiss()
        } else {
            open(conversationID: conversationID)
        }
    }

    /// A contact hit is a person, not a conversation, so the direct chat is opened
    /// (or created) before navigating — the same `POST /api/conversations/direct`
    /// the web app's contact rows use.
    private func openDirect(with row: GlobalSearchModel.ContactRow) async {
        openingContactID = row.id
        defer { openingContactID = nil }
        do {
            let direct = try await RxHiveAPI.directConversation(participantID: row.id)
            chat.upsert(direct)
            if let onOpenConversation { onOpenConversation(direct.id) }
            dismiss()
        } catch {
            toasts.failure(error, fallback: "Couldn't open that chat")
        }
    }

    private func search() async {
        state = .loading
        do {
            results = try await GlobalSearchModel.load(query: trimmedQuery)
            state = .loaded
        } catch {
            results = GlobalSearchModel()
            state = .failed
        }
    }
}

/// The three buckets, flattened into what the rows need.
///
/// A view model rather than the raw response so the rows can carry resolved display
/// values — a chat name that falls back for direct conversations, a contact subtitle
/// that prefers department over email — instead of each row view re-deriving them.
private struct GlobalSearchModel {

    struct ChatRow: Identifiable {
        let id: String
        let name: String
        let isGroup: Bool
        let avatarPath: String?

        var kindLabel: String { isGroup ? "Group" : "Direct" }
    }

    struct ContactRow: Identifiable {
        let id: String
        let name: String
        let subtitle: String
        let avatarPath: String?
    }

    struct MessageRow: Identifiable {
        let id: String
        let conversationID: String?
        let conversationName: String
        let senderName: String
        let snippet: String
        let createdAt: Date?
    }

    var chats: [ChatRow] = []
    var contacts: [ContactRow] = []
    var messages: [MessageRow] = []

    var isEmpty: Bool { chats.isEmpty && contacts.isEmpty && messages.isEmpty }

    static func load(query: String) async throws -> GlobalSearchModel {
        GlobalSearchModel(try await RxHiveAPI.globalSearch(query: query))
    }

    private init(_ results: GlobalSearchResults) {
        chats = results.conversations.map {
            ChatRow(
                id: $0.id,
                // Direct chats come back nameless — the router leaves resolving the
                // partner to the client, and the search payload has no participants
                // to resolve it from, so this is the honest placeholder.
                name: $0.name ?? "Conversation",
                isGroup: $0.isGroup,
                avatarPath: $0.avatarURL
            )
        }
        contacts = results.contacts.map {
            ContactRow(
                id: $0.id,
                name: $0.displayName,
                // `department` is `""` rather than null when unset, so emptiness is
                // the test, not nil-ness.
                subtitle: ($0.department?.isEmpty == false ? $0.department : $0.email) ?? "",
                avatarPath: $0.avatarURL
            )
        }
        messages = results.messages.map {
            MessageRow(
                id: $0.messageID,
                conversationID: $0.conversationID,
                conversationName: $0.conversationName ?? "Chat",
                senderName: $0.senderName ?? "Unknown",
                snippet: $0.contentSnippet ?? "",
                createdAt: $0.createdAt
            )
        }
    }

    init() {}
}

// MARK: - Starred and pinned

/// My starred messages in one conversation.
///
/// Starring is private — `MessageStar` is per user — so this list is mine alone,
/// which is why it has no "starred by" column and why un-starring here needs no
/// confirmation.
struct StarredMessagesView: View {

    let conversationID: String
    let onJump: (String) -> Void

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @State private var messages: [Message] = []
    @State private var state: InfoLoadState = .idle

    var body: some View {
        MessageListSection(
            state: state,
            messages: messages,
            emptyTitle: "No starred messages",
            emptyHint: "Star a message from its menu to keep it here for quick access.",
            failureMessage: "Couldn't load starred messages.",
            trailingSystemImage: "star.fill",
            // `starred` (#FBBF24), not `warning` (#F59E0B). The token exists as its own
            // entry precisely because the web app distinguishes them — a star is not a
            // caution — so this is the one place that must not reach for `warning`.
            trailingTint: Theme.Color.starred,
            trailingLabel: "Remove star",
            onRetry: { Task { await load(force: true) } },
            onSelect: { message in
                onJump(message.id)
                dismiss()
            },
            onTrailingAction: { message in Task { await unstar(message) } }
        )
        .navigationTitle("Starred messages")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load(force: Bool = false) async {
        if state == .loaded && !force { return }
        state = .loading
        do {
            messages = try await Self.starred(conversationID: conversationID)
            state = .loaded
        } catch {
            messages = []
            state = .failed
        }
    }

    private func unstar(_ message: Message) async {
        // Optimistic: the row leaves at once and comes back if the toggle fails.
        let previous = messages
        messages.removeAll { $0.id == message.id }
        if await chat.toggleStar(messageID: message.id, in: conversationID) == nil {
            messages = previous
            toasts.error("Could not remove star")
        }
    }

    static func starred(conversationID: String) async throws -> [Message] {
        try await RxHiveAPI.starredMessages(conversationID: conversationID)
    }
}

/// The conversation's pinned messages. Unlike stars, pins are shared: unpinning
/// here unpins for everybody, which the row's icon (a struck-through pin) says.
struct PinnedMessagesView: View {

    let conversationID: String
    let onJump: (String) -> Void

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    @State private var messages: [Message] = []
    @State private var state: InfoLoadState = .idle

    var body: some View {
        MessageListSection(
            state: state,
            messages: messages,
            emptyTitle: "No pinned messages",
            emptyHint: "Pin a message from its menu to keep it at hand for everyone in this chat.",
            failureMessage: "Couldn't load pinned messages.",
            trailingSystemImage: "pin.slash",
            trailingTint: Theme.Color.textMuted,
            trailingLabel: "Unpin for everyone",
            onRetry: { Task { await load(force: true) } },
            onSelect: { message in
                onJump(message.id)
                dismiss()
            },
            onTrailingAction: { message in Task { await unpin(message) } }
        )
        .navigationTitle("Pinned messages")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load(force: Bool = false) async {
        if state == .loaded && !force { return }
        state = .loading
        do {
            messages = try await Self.pinned(conversationID: conversationID)
            state = .loaded
        } catch {
            messages = []
            state = .failed
        }
    }

    private func unpin(_ message: Message) async {
        let previous = messages
        messages.removeAll { $0.id == message.id }
        if await chat.togglePin(messageID: message.id, in: conversationID) == nil {
            messages = previous
            toasts.error("Could not unpin that message")
        }
    }

    static func pinned(conversationID: String) async throws -> [Message] {
        try await RxHiveAPI.pinnedMessages(conversationID: conversationID)
    }
}

/// The list body shared by the starred and pinned screens: same rows, same states,
/// one trailing action that differs only in icon and copy.
private struct MessageListSection: View {
    let state: InfoLoadState
    let messages: [Message]
    let emptyTitle: String
    let emptyHint: String
    let failureMessage: String
    let trailingSystemImage: String
    let trailingTint: Color
    let trailingLabel: String
    let onRetry: () -> Void
    let onSelect: (Message) -> Void
    let onTrailingAction: (Message) -> Void

    var body: some View {
        Group {
            switch state {
            case .idle, .loading:
                VStack(spacing: Theme.Layout.spacing4) {
                    ForEach(0..<5, id: \.self) { _ in
                        SkeletonRow(height: 14, widthFraction: 0.8)
                    }
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.top, Theme.Layout.spacing4)
                .frame(maxHeight: .infinity, alignment: .top)

            case .failed:
                InfoRetryView(message: failureMessage, retry: onRetry)
                    .frame(maxHeight: .infinity, alignment: .top)

            case .loaded where messages.isEmpty:
                EmptyStateView(systemImage: "tray", title: emptyTitle, message: emptyHint)

            case .loaded:
                ScrollView {
                    LazyVStack(spacing: Theme.Layout.spacing2) {
                        ForEach(messages) { message in
                            row(message)
                        }
                    }
                    .padding(.horizontal, Theme.Layout.gutter)
                    .padding(.vertical, Theme.Layout.spacing4)
                }
            }
        }
        .background(Theme.Color.bg.ignoresSafeArea())
    }

    private func row(_ message: Message) -> some View {
        HStack(alignment: .top, spacing: Theme.Layout.spacing3) {
            Avatar(
                name: message.senderName,
                urlPath: message.senderAvatar,
                size: Theme.Layout.avatarSmall
            )

            Button {
                onSelect(message)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Layout.spacing2) {
                        Text(message.senderName)
                            .font(Theme.Typography.font(size: 15, weight: .medium))
                            .foregroundStyle(Theme.Color.text)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if let createdAt = message.createdAt {
                            Text(createdAt.conversationListLabel)
                                .font(Theme.Typography.micro)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
                    Text(snippetLabel(for: message))
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        // Tombstones read as italic muted copy everywhere in the app.
                        .italic(message.isDeleted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())

            Button {
                onTrailingAction(message)
            } label: {
                Image(systemName: trailingSystemImage)
                    .font(.system(size: 15))
                    .foregroundStyle(trailingTint)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(trailingLabel)
        }
        .padding(.leading, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
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
