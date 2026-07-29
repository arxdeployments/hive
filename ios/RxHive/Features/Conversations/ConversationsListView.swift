import SwiftUI

/// The chat list — the port of `ChatSidebar.jsx`'s conversation pane.
///
/// What the sidebar does with a persistent header, a segmented Chats/Calls switch
/// and a kebab menu, this does with a tab bar (see `HomeView`) and a single toolbar
/// button: on a phone the list *is* the screen, so everything that isn't a
/// conversation moves out of it.
struct ConversationsListView: View {
    @EnvironmentObject private var auth: AuthStore
    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter

    @State private var path: [String] = []
    @State private var search = ""
    @State private var filter: ConversationFilter = .all
    @State private var showNewChat = false
    @State private var showGlobalSearch = false
    @State private var pendingDelete: Conversation?
    @State private var isPaging = false
    /// The conversation a sheet picked, pushed once that sheet has actually gone.
    ///
    /// Not pushed from inside the sheet's callback: appending to `path` while a sheet
    /// is mid-dismissal races the dismissal and SwiftUI drops the push often enough
    /// to look like the tap did nothing. Handing the id to `onDismiss` makes the two
    /// transitions sequential. Shared by both sheets — only one is ever up.
    @State private var pendingOpen: String?

    /// One value for "what the list should be showing", so a change to either half
    /// cancels the in-flight debounce and starts a fresh one.
    private var query: String { "\(filter.rawValue)|\(search.trimmed)" }

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                Theme.Color.bg.ignoresSafeArea()

                VStack(spacing: 0) {
                    ConnectionBanner(realtime: auth.realtime)

                    header
                    Hairline()

                    content
                }
            }
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Chats")
                        .font(Theme.Typography.title)
                        .foregroundStyle(Theme.Color.text)
                }
                // The header's own field filters *this list* (the server's
                // `?search=` matches conversation and participant names). Global
                // search is the wider one — it reaches message bodies and people you
                // have never messaged — so it is its own screen, as it is on the web
                // (`GlobalSearchResults.jsx` is not the sidebar's filter).
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showGlobalSearch = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Theme.Color.primary)
                            .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    }
                    .accessibilityLabel("Search everything")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showNewChat = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(Theme.Color.primary)
                            .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                    }
                    .accessibilityLabel("New chat")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .navigationDestination(for: String.self) { conversationID in
                ChatView(conversationID: conversationID)
            }
            .sheet(isPresented: $showNewChat, onDismiss: openPending) {
                // `NewChatView` deliberately does not push the thread itself — it owns
                // no navigation stack, this screen does. It hands back the id of the
                // conversation it opened (existing or freshly created) and dismisses.
                NewChatView { conversationID in
                    pendingOpen = conversationID
                }
            }
            .sheet(isPresented: $showGlobalSearch, onDismiss: openPending) {
                // Sheeted rather than pushed, even though the screen carries its own
                // `.navigationTitle`: it dismisses itself the instant a result is
                // tapped, and a view that pops itself while the same gesture appends to
                // `path` leaves this stack's typed path disagreeing with what is on
                // screen. As a sheet the two transitions are ordered, exactly as for
                // "New chat" above. The wrapper supplies the stack the title needs and
                // a way out when nothing is chosen.
                NavigationStack {
                    GlobalSearchView(
                        onOpenConversation: { pendingOpen = $0 },
                        // The message anchor is dropped: `ChatView` takes only a
                        // conversation id, so the thread opens at the bottom rather
                        // than at the hit. Landing on the right conversation is most
                        // of the value; jumping would need a `ChatView` that accepts
                        // an anchor, which is not its API.
                        onOpenMessage: { conversationID, _ in pendingOpen = conversationID }
                    )
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Cancel") { showGlobalSearch = false }
                                .font(Theme.Typography.subheadline)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
                    .toolbarBackground(Theme.Color.sidebar, for: .navigationBar)
                    .toolbarBackground(.visible, for: .navigationBar)
                }
            }
            .confirmationDialog(
                "Delete chat?",
                isPresented: Binding(
                    get: { pendingDelete != nil },
                    set: { if !$0 { pendingDelete = nil } }
                ),
                presenting: pendingDelete
            ) { conversation in
                Button("Delete for me", role: .destructive) {
                    delete(conversation)
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: { conversation in
                // Say what the endpoint actually does. `DELETE /api/conversations/{id}`
                // removes *my* participant row — everyone else keeps the thread, and
                // a new message can bring it back.
                Text("This hides \(chat.title(for: conversation)) and its history for you only. Other people keep their copy.")
            }
            .task(id: query) {
                // 300ms, same as the web sidebar's `setTimeout(fetchConversations, 300)`
                // — including on first appearance, so a keystroke landing during the
                // initial load doesn't fire two requests. `.task(id:)` cancels the
                // previous debounce for free.
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                await chat.loadConversations(filter: filter.rawValue, search: search.trimmed)
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            SearchField(placeholder: "Search conversations", text: $search)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Layout.spacing2) {
                    ForEach(ConversationFilter.allCases) { option in
                        FilterChip(
                            title: option.label,
                            isSelected: filter == option
                        ) {
                            filter = option
                        }
                    }
                }
                .padding(.horizontal, Theme.Layout.gutter)
            }
            // The scroll view eats the leading gutter so the first chip lines up with
            // the search field while still being able to scroll under it.
            .padding(.horizontal, -Theme.Layout.gutter)
        }
        .padding(.horizontal, Theme.Layout.gutter)
        .padding(.top, Theme.Layout.spacing2)
        .padding(.bottom, Theme.Layout.spacing2)
        .background(Theme.Color.bg)
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if chat.conversations.isEmpty && chat.isLoadingConversations {
            skeleton
        } else if chat.conversations.isEmpty {
            emptyState
        } else {
            list
        }
    }

    private var list: some View {
        List {
            ForEach(chat.conversations) { conversation in
                Button {
                    path.append(conversation.id)
                } label: {
                    ConversationRow(
                        conversation: conversation,
                        showsHairline: conversation.id != chat.conversations.last?.id
                    )
                }
                .buttonStyle(RowPressStyle())
                .listRowInsets(EdgeInsets())
                .listRowBackground(Theme.Color.bg)
                .listRowSeparator(.hidden)
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        Task { await chat.togglePin(conversationID: conversation.id) }
                    } label: {
                        Label(conversation.isPinned ? "Unpin" : "Pin", systemImage: conversation.isPinned ? "pin.slash" : "pin")
                    }
                    .tint(Theme.Color.primary)
                }
                // Full swipe deliberately off: the outermost trailing action would
                // become a one-gesture shortcut, and neither muting nor deleting a
                // thread is something to do by accident while scrolling.
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button {
                        Task { await mute(conversation) }
                    } label: {
                        Label(
                            conversation.isMuted ? "Unmute" : "Mute",
                            systemImage: conversation.isMuted ? "bell" : "bell.slash"
                        )
                    }
                    .tint(Theme.Color.surface2)

                    Button(role: .destructive) {
                        pendingDelete = conversation
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    .tint(Theme.Color.danger)
                }
                .onAppear { pageIfLast(conversation) }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.Color.bg)
        .refreshable {
            await chat.loadConversations(filter: filter.rawValue, search: search.trimmed, reset: true)
        }
    }

    private var skeleton: some View {
        VStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { _ in
                HStack(spacing: Theme.Layout.spacing3) {
                    Circle()
                        .fill(Theme.Color.surface2)
                        .frame(width: Theme.Layout.avatarMedium, height: Theme.Layout.avatarMedium)
                    VStack(alignment: .leading, spacing: Theme.Layout.spacing2) {
                        SkeletonRow(height: 14, widthFraction: 0.45)
                        SkeletonRow(height: 11, widthFraction: 0.7)
                    }
                }
                .padding(.horizontal, Theme.Layout.gutter)
                .padding(.vertical, Theme.Layout.spacing3)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var emptyState: some View {
        if let error = chat.conversationsError {
            EmptyStateView(
                systemImage: "exclamationmark.triangle",
                title: "Couldn't load chats",
                message: error,
                actionTitle: "Try again"
            ) {
                Task { await chat.loadConversations(filter: filter.rawValue, search: search.trimmed) }
            }
        } else if !search.trimmed.isEmpty {
            EmptyStateView(
                systemImage: "magnifyingglass",
                title: "No matches",
                message: "Nothing here matches “\(search.trimmed)”."
            )
        } else if filter != .all {
            EmptyStateView(
                systemImage: filter.emptyGlyph,
                title: filter.emptyTitle,
                message: filter.emptyMessage,
                actionTitle: "Show all chats"
            ) {
                filter = .all
            }
        } else {
            EmptyStateView(
                systemImage: "bubble.left.and.bubble.right",
                title: "No conversations yet",
                message: "Start a chat with someone in your organisation.",
                actionTitle: "New chat"
            ) {
                showNewChat = true
            }
        }
    }

    // MARK: - Actions

    /// Pushes whatever a just-dismissed sheet asked for. Runs from `onDismiss`, so the
    /// sheet is fully gone by the time the navigation stack changes.
    private func openPending() {
        guard let conversationID = pendingOpen else { return }
        pendingOpen = nil
        path.append(conversationID)
    }

    private func pageIfLast(_ conversation: Conversation) {
        guard conversation.id == chat.conversations.last?.id,
              chat.hasMoreConversations,
              !isPaging else { return }
        isPaging = true
        Task {
            await chat.loadMoreConversations(filter: filter.rawValue, search: search.trimmed)
            isPaging = false
        }
    }

    private func mute(_ conversation: Conversation) async {
        guard let isMuted = await chat.toggleMute(conversationID: conversation.id) else {
            toasts.error("Couldn't change notifications")
            return
        }
        toasts.success(isMuted ? "Muted" : "Unmuted")
    }

    private func delete(_ conversation: Conversation) {
        let title = chat.title(for: conversation)
        pendingDelete = nil
        Task {
            if await chat.deleteConversation(id: conversation.id) {
                toasts.success("Deleted \(title)")
            } else {
                toasts.error("Couldn't delete this chat")
            }
        }
    }
}

// MARK: - Filters

/// The four `filter` values `GET /api/conversations` branches on. The web sidebar
/// offers three (All/Unread/Groups); `direct` is already implemented server-side and
/// is the obvious fourth on a phone, where the list is the whole screen.
private enum ConversationFilter: String, CaseIterable, Identifiable {
    case all, unread, groups, direct

    var id: String { rawValue }

    var label: String {
        switch self {
        case .all: return "All"
        case .unread: return "Unread"
        case .groups: return "Groups"
        case .direct: return "Direct"
        }
    }

    var emptyGlyph: String {
        switch self {
        case .unread: return "checkmark.circle"
        case .groups: return "person.3"
        case .direct: return "person"
        case .all: return "bubble.left.and.bubble.right"
        }
    }

    var emptyTitle: String {
        switch self {
        case .unread: return "You're all caught up"
        case .groups: return "No groups"
        case .direct: return "No direct chats"
        case .all: return "No conversations yet"
        }
    }

    var emptyMessage: String {
        switch self {
        case .unread: return "Nothing is waiting for a reply."
        case .groups: return "Groups you're a member of will appear here."
        case .direct: return "One-to-one chats will appear here."
        case .all: return "Start a chat with someone in your organisation."
        }
    }
}

// `FilterChip` is shared — see `DesignSystem/Components.swift`. It lived here as a
// private type until the Calls tab turned out to have its own, differently-styled copy.

// MARK: - Connection banner

/// The port of `OfflineBanner.jsx`, driven by the socket rather than
/// `navigator.onLine` — on a phone "the radio is up" and "we have a live session"
/// are different things, and only the second one means messages will send.
///
/// Takes the client explicitly: `AuthStore` holds `realtime` as a plain `let`, so
/// observing the store does not observe the socket's `state`.
private struct ConnectionBanner: View {
    @ObservedObject var realtime: RealtimeClient

    private var label: String? {
        switch realtime.state {
        case .connected: return nil
        case .connecting: return "Connecting…"
        case .reconnecting: return "Reconnecting…"
        case .idle, .offline: return "Offline"
        }
    }

    private var icon: String {
        // A spinner-ish glyph while there is hope, a hard one when there isn't.
        switch realtime.state {
        case .idle, .offline: return "wifi.slash"
        default: return "arrow.triangle.2.circlepath"
        }
    }

    var body: some View {
        // The strip is wrapped in a container that always exists, because a
        // transition is only animated by an ancestor that survives the change —
        // putting the animation on the strip itself would make it pop in.
        VStack(spacing: 0) {
            if let label {
                HStack(spacing: Theme.Layout.spacing2) {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .semibold))
                    Text(label)
                        .font(Theme.Typography.micro)
                }
                .foregroundStyle(Theme.Color.warning)
                .frame(maxWidth: .infinity)
                .frame(height: 24)
                .background(Theme.Color.warning.opacity(0.15))
                .transition(.move(edge: .top).combined(with: .opacity))
                .accessibilityLabel(label)
            }
        }
        .animation(Theme.Motion.ease, value: label)
    }
}

// MARK: - Row press feedback

/// `hover:bg-[#141414]` from the web row, as a press state. `.buttonStyle(.plain)`
/// would give a row no feedback at all, and the default list highlight is a system
/// grey that does not exist in this palette.
private struct RowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Theme.Color.surface : Theme.Color.bg)
            .animation(Theme.Motion.ease, value: configuration.isPressed)
    }
}
