import SwiftUI
import UIKit

/// The message thread.
///
/// A port of `frontend/src/components/chat/ChatPanel.jsx`. The structural
/// differences from the web panel are all consequences of the platform, and each is
/// noted where it happens:
///
///  * `ScrollViewReader` + `LazyVStack` instead of `react-virtuoso`. SwiftUI has no
///    `followOutput` / `startReached`, so "stick to the bottom" and "page back at
///    the top" are done with an explicit bottom anchor and a top sentinel.
///  * The panel's inline edit bar becomes an alert with a text field: a phone has no
///    room for a second composer above the real one, and the edit endpoint only ever
///    takes new text.
///  * Long-press replaces right-click and the hover chevron (see `MessageBubble`).
struct ChatView: View {

    let conversationID: String

    init(conversationID: String) {
        self.conversationID = conversationID
    }

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var calls: CallStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss

    // Composer / editing
    @State private var replyTo: Message?
    /// The message being edited, plus a separate presentation flag. One optional
    /// driving `isPresented:` would be cleared on dismissal *before* the Save action
    /// gets to read it, which silently threw the edit away.
    @State private var editTarget: Message?
    @State private var showEditAlert = false
    @State private var editText = ""

    // Overlays
    @State private var sheet: ChatSheet?
    @State private var reportTarget: Message?
    @State private var showReportAlert = false
    @State private var showClearConfirm = false
    @State private var showLeaveConfirm = false
    /// Pushed destinations. One binding, so only one push is ever pending — the info
    /// panels, the search/starred/pinned lists and a jumped-to DM are all screens with
    /// their own navigation title, and each expects to be pushed rather than sheeted.
    @State private var route: ChatRoute?

    // Reactions
    @State private var reactionTargetID: String?

    // Scrolling
    @State private var didInitialScroll = false
    @State private var isAtBottom = true
    @State private var isLoadingOlder = false
    @State private var isJumping = false
    /// Messages that landed while the user was reading further up. The
    /// conversation's own `unreadCount` is zeroed the moment this screen opens, so it
    /// cannot answer "how many did I miss while scrolled away".
    @State private var missedWhileAway = 0

    // Jump / highlight
    @State private var highlightedID: String?
    @State private var highlightToken = 0

    // Unread divider
    @State private var unreadAnchorID: String?
    @State private var unreadAnchorCount = 0

    // Selection
    @State private var isSelecting = false
    @State private var selectedIDs: Set<String> = []

    // Pinned banner
    @State private var pinned: [Message] = []
    @State private var pinCursor = 0

    private let bottomAnchor = "chat-bottom-anchor"

    // MARK: - Derived state

    private var conversation: Conversation? { chat.conversation(id: conversationID) }
    private var messages: [Message] { chat.messages[conversationID] ?? [] }
    private var isGroup: Bool { conversation?.type.isGroup ?? false }
    private var title: String { conversation.map { chat.title(for: $0) } ?? "Conversation" }

    private var typingNames: [String] {
        (chat.typingUsers[conversationID] ?? [:]).values.sorted()
    }

    private var canPost: Bool {
        conversation?.canIPost(userID: chat.currentUserID) ?? true
    }

    private var selectedMessages: [Message] {
        messages.filter { selectedIDs.contains($0.id) }
    }

    /// Star is a toggle server-side, so a mixed selection must read as "Star" and
    /// only touch the rows that are not starred yet.
    private var allSelectedStarred: Bool {
        !selectedMessages.isEmpty && selectedMessages.allSatisfy(\.isStarred)
    }

    private var activePin: Message? {
        guard !pinned.isEmpty else { return nil }
        return pinned[min(pinCursor, pinned.count - 1)]
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            header

            if let activePin, !isSelecting {
                pinnedBanner(activePin)
            }

            messageList

            bottomBar
        }
        .background(Theme.Color.bg)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task { await open() }
        .onChange(of: messages.count) { _, _ in newMessagesArrived() }
        .navigationDestination(item: $route) { destination in
            routeContent(destination)
        }
        // One sheet modifier, one router. Two `.sheet` modifiers on the same view
        // race each other — whichever binding flips second is silently ignored.
        .sheet(item: $sheet) { sheetContent($0) }
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Layout.spacing2) {
                if isSelecting {
                    selectionHeader
                } else {
                    identityHeader
                }
            }
            .padding(.horizontal, Theme.Layout.spacing2)
            .frame(height: 56)

            Hairline()
        }
        .background(Theme.Color.sidebar)
        .alert("Clear this chat?", isPresented: $showClearConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Clear", role: .destructive) {
                Task {
                    if await chat.clearHistory(conversationID: conversationID) {
                        pinned = []
                        unreadAnchorID = nil
                        toasts.success("Chat cleared")
                    } else {
                        toasts.error("Couldn't clear this chat")
                    }
                }
            }
        } message: {
            Text("Messages are removed for you only. Everyone else keeps their copy.")
        }
        .alert("Exit \"\(title)\"?", isPresented: $showLeaveConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Exit group", role: .destructive) { Task { await leaveGroup() } }
        } message: {
            Text("You will stop receiving messages from this group. Only group admins can add you back.")
        }
    }

    private var selectionHeader: some View {
        Group {
            Button {
                exitSelection()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Cancel selection")

            Text("\(selectedIDs.count) selected")
                .font(Theme.Typography.headline)
                .foregroundStyle(Theme.Color.text)

            Spacer(minLength: 0)

            Button {
                selectedIDs = []
            } label: {
                Text("Clear")
                    .font(Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(minWidth: Theme.Layout.minTouchTarget, minHeight: Theme.Layout.minTouchTarget)
            }
            .disabled(selectedIDs.isEmpty)
        }
    }

    private var identityHeader: some View {
        Group {
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(Theme.Color.text)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Back to chats")

            Button {
                route = isGroup ? .groupInfo : .contactInfo
            } label: {
                HStack(spacing: Theme.Layout.spacing2) {
                    Avatar(
                        name: title,
                        urlPath: headerAvatarPath,
                        size: 36,
                        presence: headerPresence
                    )

                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: Theme.Layout.spacing1) {
                            Text(title)
                                .font(Theme.Typography.font(size: 16, weight: .medium))
                                .foregroundStyle(Theme.Color.text)
                                .lineLimit(1)
                            if conversation?.crossOrg == true {
                                Pill(text: "Cross-Org")
                            }
                        }
                        subtitleView
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(isGroup ? "Group info" : "Contact info")

            callButton(video: false)
            callButton(video: true)
            overflowMenu
        }
    }

    private var headerAvatarPath: String? {
        guard let conversation else { return nil }
        if conversation.type.isGroup { return conversation.avatarURL }
        return chat.otherParticipant(in: conversation)?.avatarURL
    }

    private var headerPresence: PresenceStatus? {
        guard let conversation, !conversation.type.isGroup,
              let other = chat.otherParticipant(in: conversation) else { return nil }
        return chat.status(of: other.userId, fallback: other.status)
    }

    @ViewBuilder
    private var subtitleView: some View {
        if !typingNames.isEmpty {
            Text(typingSubtitle)
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.primary)
                .lineLimit(1)
        } else if let text = presenceSubtitle {
            Text(text)
                .font(Theme.Typography.micro)
                .foregroundStyle(text == "online" ? Theme.Color.primary : Theme.Color.textMuted)
                .lineLimit(1)
        }
    }

    private var typingSubtitle: String {
        guard isGroup else { return "typing…" }
        switch typingNames.count {
        case 1: return "\(typingNames[0]) is typing…"
        case 2: return "\(typingNames[0]) and \(typingNames[1]) are typing…"
        default: return "\(typingNames.count) people are typing…"
        }
    }

    private var presenceSubtitle: String? {
        guard let conversation else { return nil }
        if conversation.type.isGroup {
            let count = conversation.participants.count
            return count == 1 ? "1 member" : "\(count) members"
        }
        guard let other = chat.otherParticipant(in: conversation) else { return nil }
        if chat.status(of: other.userId, fallback: other.status) == .online { return "online" }
        if let seen = other.lastSeen { return seen.lastSeenLabel }
        return "offline"
    }

    private func callButton(video: Bool) -> some View {
        Button {
            startCall(video: video)
        } label: {
            Image(systemName: video ? "video.fill" : "phone.fill")
                .font(.system(size: 15))
                .foregroundStyle(Theme.Color.text)
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        }
        .accessibilityLabel(video ? "Video call" : "Voice call")
    }

    private var overflowMenu: some View {
        Menu {
            Button { route = .search } label: { Label("Search", systemImage: "magnifyingglass") }
            Button { sheet = .media } label: { Label("Media, links & docs", systemImage: "photo.on.rectangle") }
            Button { route = .starred } label: { Label("Starred", systemImage: "star") }
            Button { route = .pinned } label: { Label("Pinned", systemImage: "pin") }
            Button { enterSelection(seed: nil) } label: { Label("Select messages", systemImage: "checklist") }

            Divider()

            Button {
                Task { await toggleMute() }
            } label: {
                let muted = conversation?.isMuted == true
                Label(muted ? "Unmute" : "Mute", systemImage: muted ? "bell" : "bell.slash")
            }
            Button { Task { await exportTranscript() } } label: {
                Label("Export chat", systemImage: "square.and.arrow.up")
            }
            Button(role: .destructive) { showClearConfirm = true } label: {
                Label("Clear history", systemImage: "trash")
            }

            if isGroup {
                Divider()
                Button { route = .groupInfo } label: { Label("Group info", systemImage: "info.circle") }
                Button(role: .destructive) { requestLeave() } label: {
                    Label("Exit group", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Theme.Color.text)
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        }
        .accessibilityLabel("More options")
    }

    // MARK: - Pinned banner

    private func pinnedBanner(_ pin: Message) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Layout.spacing3) {
                Button {
                    jump(to: pin.id)
                    // WhatsApp cycles through the pins on repeated taps, which is the
                    // only way to reach the second pin without a list.
                    if pinned.count > 1 {
                        pinCursor = (min(pinCursor, pinned.count - 1) + 1) % pinned.count
                    }
                } label: {
                    HStack(spacing: Theme.Layout.spacing2) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.Color.primary)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(pinned.count > 1
                                 ? "Pinned message \(min(pinCursor, pinned.count - 1) + 1) of \(pinned.count)"
                                 : "Pinned message")
                                .font(Theme.Typography.micro)
                                .foregroundStyle(Theme.Color.primary)
                            Text("\(pin.senderName): \(pin.chatPreviewLabel)")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Color.textMuted)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())

                Button {
                    Task { await unpin(pin) }
                } label: {
                    Image(systemName: "pin.slash")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.Color.textMuted)
                        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
                }
                .accessibilityLabel("Unpin this message")
            }
            .padding(.leading, Theme.Layout.gutter)
            .padding(.vertical, Theme.Layout.spacing1)

            Hairline()
        }
        .background(Theme.Color.surface)
    }

    // MARK: - Message list

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    historyTop

                    ForEach(rows) { row in
                        rowView(row)
                    }

                    if !typingNames.isEmpty {
                        TypingIndicatorView(names: typingNames, showsNames: isGroup)
                    }

                    // The scroll target for "newest message". A trailing anchor rather
                    // than the last row's id: the typing indicator and the bottom
                    // padding sit below it, and scrolling to the last row would leave
                    // them cut off.
                    Color.clear
                        // Tall enough that the lazy stack reliably reports it in and
                        // out of view; a 1pt probe is missed on fast flicks.
                        .frame(height: 12)
                        .id(bottomAnchor)
                        .onAppear {
                            isAtBottom = true
                            missedWhileAway = 0
                        }
                        .onDisappear { isAtBottom = false }
                }
                .padding(.bottom, Theme.Layout.spacing3)
            }
            .scrollDismissesKeyboard(.interactively)
            .overlay(alignment: .center) {
                if chat.loadingThreads.contains(conversationID) && messages.isEmpty {
                    ProgressView().tint(Theme.Color.primary)
                } else if messages.isEmpty && !chat.loadingThreads.contains(conversationID) {
                    EmptyStateView(
                        systemImage: "bubble.left.and.bubble.right",
                        title: "No messages yet",
                        message: canPost
                            ? "Say hello — this is the start of the conversation."
                            : "Only admins can post in this group."
                    )
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !isAtBottom && !isSelecting {
                    ScrollToBottomButton(unreadCount: missedWhileAway) {
                        scrollToBottom(proxy, animated: true)
                    }
                    .padding(.trailing, Theme.Layout.spacing2)
                    .padding(.bottom, Theme.Layout.spacing3)
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .overlay(alignment: .top) {
                if isJumping {
                    ProgressView()
                        .tint(Theme.Color.primary)
                        .padding(Theme.Layout.spacing3)
                        .background(Circle().fill(Theme.Color.surface))
                        .padding(.top, Theme.Layout.spacing3)
                }
            }
            .animation(Theme.Motion.ease, value: isAtBottom)
            // The scroll work has to be driven from inside the reader, so the proxy
            // is parked for the handlers that live outside it (jump, new message).
            .onAppear { scrollProxy = proxy }
        }
        .alert("Edit message", isPresented: $showEditAlert) {
            TextField("Message", text: $editText)
            Button("Cancel", role: .cancel) { editTarget = nil }
            Button("Save") { saveEdit() }
        }
        .alert(
            "Report \(reportTarget?.senderName ?? "sender")?",
            isPresented: $showReportAlert
        ) {
            Button("Cancel", role: .cancel) { reportTarget = nil }
            Button("Report", role: .destructive) {
                // No endpoint exists for this — the web menu is also purely local
                // (`MessageContextMenu.jsx:confirmReport`). The confirmation is the
                // whole feature, so it must not claim more than it does.
                let name = reportTarget?.senderName ?? "the sender"
                reportTarget = nil
                toasts.success("Reported to your administrator. \(name) was not notified.")
            }
        } message: {
            Text("This message will be forwarded to your administrator. \(reportTarget?.senderName ?? "The sender") will not be notified.")
        }
    }

    /// The top sentinel: paging back happens when it comes into view.
    ///
    /// Guarded on `didInitialScroll` because a `LazyVStack` builds from the top, so
    /// on mount this appears *before* we have scrolled to the newest message — and an
    /// unguarded sentinel would immediately fetch a page nobody asked for.
    private var historyTop: some View {
        Group {
            if chat.hasMoreHistory[conversationID] == true {
                HStack {
                    Spacer()
                    ProgressView().tint(Theme.Color.textMuted).scaleEffect(0.7)
                    Spacer()
                }
                .frame(height: 36)
                .onAppear {
                    guard didInitialScroll, !isLoadingOlder else { return }
                    Task { await loadOlder() }
                }
            } else {
                Color.clear.frame(height: Theme.Layout.spacing3)
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: ChatRow) -> some View {
        switch row.kind {
        case .date(let date):
            DateSeparatorView(date: date)

        case .unread:
            UnreadDividerView(count: unreadAnchorCount)

        case .message(let message):
            MessageBubble(
                message: message,
                conversationID: conversationID,
                isOwn: message.senderId == chat.currentUserID,
                isGroup: isGroup,
                startsRun: row.startsRun,
                isHighlighted: highlightedID == message.id,
                isSelecting: isSelecting,
                isSelected: selectedIDs.contains(message.id),
                isReacting: reactionTargetID == message.id,
                onAction: { perform($0, on: message) },
                onJump: { jump(to: $0) },
                onToggleReaction: { emoji in
                    Task {
                        await chat.toggleReaction(
                            messageID: message.id, emoji: emoji, in: conversationID
                        )
                    }
                },
                onShowReactions: { sheet = .reactions(message) },
                onDismissReactionPicker: { withAnimation(Theme.Motion.ease) { reactionTargetID = nil } },
                onToggleSelected: { toggleSelected(message.id) }
            )
        }
    }

    /// The list, with date separators and the unread divider woven in.
    private var rows: [ChatRow] {
        var out: [ChatRow] = []
        var previous: Message?

        for message in messages {
            let created = message.createdAt
            if previous == nil || !Self.sameDay(previous?.createdAt, created) {
                out.append(ChatRow(id: "date-\(message.id)", kind: .date(created ?? Date())))
            }
            if unreadAnchorID == message.id {
                out.append(ChatRow(id: "unread-\(message.id)", kind: .unread))
            }

            // A run is the same sender, same day, within five minutes. Anything else
            // starts a new run and gets its avatar and name back.
            let gap = (created ?? Date()).timeIntervalSince(previous?.createdAt ?? .distantPast)
            let startsRun = previous == nil
                || previous?.senderId != message.senderId
                || !Self.sameDay(previous?.createdAt, created)
                || gap > 300

            out.append(ChatRow(id: message.id, kind: .message(message), startsRun: startsRun))
            previous = message
        }
        return out
    }

    private static func sameDay(_ lhs: Date?, _ rhs: Date?) -> Bool {
        guard let lhs, let rhs else { return lhs == nil && rhs == nil }
        return Calendar.current.isDate(lhs, inSameDayAs: rhs)
    }

    // MARK: - Bottom bar

    @ViewBuilder
    private var bottomBar: some View {
        if isSelecting {
            SelectionBar(
                selectedCount: selectedIDs.count,
                allSelectedStarred: allSelectedStarred,
                onForward: {
                    // Ids are captured before leaving selection mode, since the
                    // selection is what defines them.
                    let ids = selectedMessages.map(\.id)
                    exitSelection()
                    sheet = .forward(ids)
                },
                onStar: { Task { await batchStar() } },
                onCancel: exitSelection
            )
        } else if !canPost {
            VStack(spacing: 0) {
                Hairline()
                Text("Only admins can send messages in this group")
                    .font(Theme.Typography.subheadline)
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Layout.spacing4)
            }
            .background(Theme.Color.sidebar)
        } else {
            MessageComposer(
                conversationID: conversationID,
                replyTo: replyTo,
                onSent: {
                    replyTo = nil
                    if let proxy = scrollProxy { scrollToBottom(proxy, animated: true) }
                },
                onCancelReply: { replyTo = nil }
            )
        }
    }

    // MARK: - Sheets

    @ViewBuilder
    private func sheetContent(_ sheet: ChatSheet) -> some View {
        switch sheet {
        case .media:
            MediaGalleryView(conversationID: conversationID, onJumpToMessage: { jump(to: $0) })

        case .forward(let ids):
            ForwardView(messageIDs: ids)

        case .info(let info):
            MessageInfoSheet(info: info)

        case .reactions(let message):
            ReactionDetailSheet(
                reactions: message.reactions,
                currentUserID: chat.currentUserID,
                onRemove: { emoji in
                    Task {
                        await chat.toggleReaction(
                            messageID: message.id, emoji: emoji, in: conversationID
                        )
                    }
                }
            )

        case .share(let url):
            MediaShareSheet(url: url)
        }
    }

    // MARK: - Pushed destinations

    @ViewBuilder
    private func routeContent(_ destination: ChatRoute) -> some View {
        switch destination {
        case .search:
            InConversationSearchView(conversationID: conversationID, onJump: { jump(to: $0) })

        case .starred:
            StarredMessagesView(conversationID: conversationID, onJump: { jump(to: $0) })

        case .pinned:
            PinnedMessagesView(conversationID: conversationID, onJump: { jump(to: $0) })

        case .contactInfo:
            if let conversation {
                ContactInfoView(
                    conversation: conversation,
                    onJumpToMessage: { jump(to: $0) },
                    // Replaces the pushed panel rather than stacking on it: one
                    // `navigationDestination(item:)` can only hold one pending push,
                    // and Back from the new chat should land on this thread anyway.
                    onOpenConversation: { route = .conversation($0) },
                    onStartCall: { startCall(video: $0 == .video) }
                )
            }

        case .groupInfo:
            if let conversation {
                GroupInfoView(
                    conversation: conversation,
                    onJumpToMessage: { jump(to: $0) },
                    onOpenConversation: { route = .conversation($0) },
                    onStartCall: { startCall(video: $0 == .video) }
                )
            }

        case .conversation(let id):
            ChatView(conversationID: id)
        }
    }

    // MARK: - Lifecycle

    private func open() async {
        // Captured before `markRead`, which zeroes it within the same turn.
        let unread = conversation?.unreadCount ?? 0

        await chat.loadMessages(conversationID: conversationID)

        let loaded = messages
        if unread > 0, unread <= loaded.count {
            unreadAnchorCount = unread
            unreadAnchorID = loaded[loaded.count - unread].id
        }

        // One frame for the rows to exist before scrolling to the end of them.
        // `scrollTo` against a LazyVStack that has not laid out yet is a no-op.
        try? await Task.sleep(for: .milliseconds(80))
        if let proxy = scrollProxy { scrollToBottom(proxy, animated: false) }
        didInitialScroll = true

        await chat.markRead(conversationID: conversationID)
        await loadPinned()
    }

    private func newMessagesArrived() {
        guard didInitialScroll else { return }
        if isAtBottom {
            if let proxy = scrollProxy { scrollToBottom(proxy, animated: true) }
            // Still on screen and still at the newest message, so this is read.
            Task { await chat.markRead(conversationID: conversationID) }
        } else if let last = messages.last, last.senderId != chat.currentUserID {
            missedWhileAway += 1
        }
    }

    private func loadOlder() async {
        isLoadingOlder = true
        // The returned id is the message that used to be at the top; pinning it back
        // there is what stops the list jumping a page's worth of height.
        if let anchor = await chat.loadOlderMessages(conversationID: conversationID) {
            try? await Task.sleep(for: .milliseconds(40))
            scrollProxy?.scrollTo(anchor, anchor: .top)
        }
        isLoadingOlder = false
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated {
            withAnimation(Theme.Motion.easeSlow) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }

    // MARK: - Jump to message

    /// Scroll to a message, loading the window around it first if it isn't loaded.
    ///
    /// Reply quotes, pinned messages and search hits all routinely point at history
    /// far outside the loaded window, which is what `GET .../messages?around=` exists
    /// for. `loadWindow` replaces the window rather than stitching, so the scroll has
    /// to wait for the new rows to exist.
    private func jump(to messageID: String) {
        if messages.contains(where: { $0.id == messageID }) {
            flash(messageID)
            return
        }
        Task {
            isJumping = true
            let resolved = await chat.loadWindow(conversationID: conversationID, around: messageID)
            isJumping = false
            guard resolved else {
                toasts.error("That message is no longer available")
                return
            }
            try? await Task.sleep(for: .milliseconds(80))
            flash(messageID)
        }
    }

    private func flash(_ messageID: String) {
        withAnimation(Theme.Motion.easeSlow) {
            scrollProxy?.scrollTo(messageID, anchor: .center)
        }
        highlightToken += 1
        let token = highlightToken
        highlightedID = messageID
        Task {
            try? await Task.sleep(for: .milliseconds(1600))
            // Only clear if no later jump has happened since.
            guard token == highlightToken else { return }
            withAnimation(Theme.Motion.easeSlow) { highlightedID = nil }
        }
    }

    // MARK: - Message actions

    private func perform(_ action: MessageAction, on message: Message) {
        switch action {
        case .reply:
            editTarget = nil
            replyTo = message

        case .react:
            withAnimation(Theme.Motion.interactive) { reactionTargetID = message.id }

        case .star:
            Task {
                if await chat.toggleStar(messageID: message.id, in: conversationID) == nil {
                    toasts.error("Couldn't update star")
                }
            }

        case .pin:
            Task {
                if await chat.togglePin(messageID: message.id, in: conversationID) == nil {
                    // The server's own 400 detail (the 50-pin cap, most often) is not
                    // surfaced by the store's Bool? signature, so this stays generic.
                    toasts.error("Couldn't update pin")
                } else {
                    await loadPinned()
                }
            }

        case .forward:
            sheet = .forward([message.id])

        case .copy:
            UIPasteboard.general.string = message.content
            toasts.success("Message copied")

        case .edit:
            replyTo = nil
            editText = message.content
            editTarget = message
            showEditAlert = true

        case .info:
            Task {
                do {
                    let info = try await RxHiveAPI.messageInfo(messageID: message.id)
                    sheet = .info(info)
                } catch {
                    toasts.failure(error, fallback: "Couldn't load message info")
                }
            }

        case .replyPrivately:
            Task { await openDirect(with: message, quoting: true) }

        case .messageUser:
            Task { await openDirect(with: message, quoting: false) }

        case .report:
            reportTarget = message
            showReportAlert = true

        case .select:
            enterSelection(seed: message)
        }
    }

    private func saveEdit() {
        guard let message = editTarget else { return }
        let trimmed = editText.trimmed
        editTarget = nil
        guard !trimmed.isEmpty, trimmed != message.content else { return }
        Task {
            if !(await chat.edit(messageID: message.id, content: trimmed, in: conversationID)) {
                toasts.error("Couldn't edit that message")
            }
        }
    }

    /// Open (or create) the DM with a message's sender.
    ///
    /// The quote cannot be carried into the composer: `MessageComposer` takes a
    /// `replyTo`, and `reply_to` is only valid *within* one conversation
    /// (`services/messaging.send_message` drops a foreign id), so quoting across
    /// chats is a text quote or nothing. With no draft channel into the composer, the
    /// quote goes to the clipboard and the user pastes it — which is at least honest
    /// about what happened, unlike silently dropping it.
    private func openDirect(with message: Message, quoting: Bool) async {
        guard let senderID = message.senderId, senderID != chat.currentUserID else { return }
        do {
            let direct = try await RxHiveAPI.directConversation(participantID: senderID)
            chat.upsert(direct)
            if quoting {
                let body = message.type == .text ? message.content : message.chatPreviewLabel
                let snippet = body.count > 180 ? String(body.prefix(180)) + "…" : body
                UIPasteboard.general.string = "> \(message.senderName): \(snippet)\n\n"
                toasts.show("Quote copied — paste it into the chat")
            }
            route = .conversation(direct.id)
        } catch {
            toasts.failure(error, fallback: "Couldn't open that chat")
        }
    }

    // MARK: - Selection

    private func enterSelection(seed: Message?) {
        reactionTargetID = nil
        isSelecting = true
        selectedIDs = seed.map { [$0.id] } ?? []
    }

    private func exitSelection() {
        isSelecting = false
        selectedIDs = []
    }

    private func toggleSelected(_ id: String) {
        if selectedIDs.contains(id) { selectedIDs.remove(id) } else { selectedIDs.insert(id) }
    }

    private func batchStar() async {
        // Only the rows whose state actually needs to change: the endpoint is a
        // toggle, so touching an already-starred message would unstar it.
        let wanted = !allSelectedStarred
        let targets = selectedMessages.filter { $0.isStarred != wanted }
        guard !targets.isEmpty else { exitSelection(); return }

        exitSelection()
        var failures = 0
        for message in targets {
            if await chat.toggleStar(messageID: message.id, in: conversationID) == nil { failures += 1 }
        }
        if failures > 0 {
            toasts.error("Couldn't \(wanted ? "star" : "unstar") \(failures) message\(failures == 1 ? "" : "s")")
        } else {
            let noun = targets.count == 1 ? "message" : "messages"
            toasts.success("\(targets.count) \(noun) \(wanted ? "starred" : "unstarred")")
        }
    }

    // MARK: - Conversation actions

    private func startCall(video: Bool) {
        guard let conversation else { return }
        if conversation.type.isGroup {
            calls.startGroupCall(conversationID: conversationID, video: video)
        } else if let other = chat.otherParticipant(in: conversation) {
            calls.startDirectCall(calleeID: other.userId, conversationID: conversationID, video: video)
        }
    }

    private func toggleMute() async {
        guard let muted = await chat.toggleMute(conversationID: conversationID) else {
            toasts.error("Couldn't update notifications")
            return
        }
        toasts.success(muted ? "Notifications muted" : "Notifications unmuted")
    }

    private func requestLeave() {
        // Cross-org membership is administered centrally; the leave endpoint refuses
        // it, so the button should not pretend otherwise.
        if conversation?.crossOrg == true {
            toasts.error("Cross-organization groups are managed by an administrator")
            return
        }
        showLeaveConfirm = true
    }

    private func leaveGroup() async {
        do {
            try await RxHiveAPI.leaveGroup(conversationID: conversationID)
            // Re-read the list rather than calling `deleteConversation`: leaving has
            // already removed my participant row, so the DELETE would 404 and the
            // stale row would survive in the sidebar.
            await chat.loadConversations()
            toasts.success("Left group")
            dismiss()
        } catch {
            toasts.failure(error, fallback: "Couldn't leave this group")
        }
    }

    private func exportTranscript() async {
        do {
            let data = try await RxHiveAPI.exportConversation(id: conversationID)
            // A real extension, and no path separators from a group name.
            let safeTitle = title.replacingOccurrences(of: "/", with: "-").trimmed
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("\(safeTitle.isEmpty ? "chat" : safeTitle) transcript.txt")
            try data.write(to: url, options: .atomic)
            sheet = .share(url)
        } catch {
            toasts.failure(error, fallback: "Couldn't export this chat")
        }
    }

    // MARK: - Pins

    /// Pins are fetched rather than filtered out of the loaded window: a pin can sit
    /// thousands of messages back, and the banner has to show it anyway.
    private func loadPinned() async {
        do {
            let fetched = try await RxHiveAPI.pinnedMessages(conversationID: conversationID)
            // Live state wins for anything loaded — an optimistic pin from the menu
            // shows up before the refetch lands.
            let loadedPins = messages.filter { $0.isPinned && !$0.isDeleted }
            let loadedIDs = Set(messages.map(\.id))
            let merged = loadedPins + fetched.filter { !loadedIDs.contains($0.id) && !$0.isDeleted }
            pinned = merged.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
            pinCursor = 0
        } catch {
            // A failed pin fetch must not blank a banner the loaded window can
            // already justify.
            pinned = messages.filter { $0.isPinned && !$0.isDeleted }
        }
    }

    private func unpin(_ message: Message) async {
        if await chat.togglePin(messageID: message.id, in: conversationID) == nil {
            toasts.error("Couldn't unpin that message")
            return
        }
        toasts.success("Unpinned")
        await loadPinned()
    }

    // MARK: - Plumbing

    /// Parked so handlers outside the `ScrollViewReader` closure can scroll.
    ///
    /// `@State` holding a proxy is unusual, but the alternatives are worse: threading
    /// the proxy through every action closure, or moving all of this logic inside the
    /// reader's builder where it cannot be read.
    @State private var scrollProxy: ScrollViewProxy?
}

// MARK: - Row model

private struct ChatRow: Identifiable {
    enum Kind {
        case date(Date)
        case unread
        case message(Message)
    }

    let id: String
    let kind: Kind
    var startsRun = false
}

// MARK: - Sheet routing

private enum ChatSheet: Identifiable {
    case media
    /// Message ids, not messages: `ForwardView` takes ids because the media gallery's
    /// select mode only ever has ids to hand.
    case forward([String])
    case info(MessageInfo)
    case reactions(Message)
    /// The exported transcript, once its bytes are on disk.
    case share(URL)

    var id: String {
        switch self {
        case .media: return "media"
        case .forward(let ids): return "forward-\(ids.joined(separator: ","))"
        case .info: return "info"
        case .reactions(let message): return "reactions-\(message.id)"
        case .share(let url): return "share-\(url.lastPathComponent)"
        }
    }
}

/// Screens this one pushes. Each of these owns a navigation title and dismisses by
/// popping, so they belong on the stack rather than in a sheet.
private enum ChatRoute: Hashable {
    case search
    case starred
    case pinned
    case contactInfo
    case groupInfo
    case conversation(String)
}
