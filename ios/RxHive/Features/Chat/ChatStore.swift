import Foundation
import os
import SwiftUI

/// All conversation and message state, and the messaging half of the realtime feed.
///
/// One store rather than one per screen: a message arriving has to update the
/// conversation list's preview, its unread badge, its sort position, *and* the open
/// thread. Split across stores, those four go out of sync the first time an event
/// arrives while the thread is closed.
///
/// `CallStore` subscribes to the same socket independently — see
/// `RealtimeClient.subscribe()` for why that is a fan-out rather than one stream.
@MainActor
final class ChatStore: ObservableObject {

    // MARK: Published state

    @Published private(set) var conversations: [Conversation] = []
    @Published private(set) var isLoadingConversations = false
    @Published private(set) var conversationsError: String?
    @Published private(set) var hasMoreConversations = false

    /// Messages per conversation id, oldest-first.
    @Published private(set) var messages: [String: [Message]] = [:]
    /// Conversations whose first page is in flight.
    @Published private(set) var loadingThreads: Set<String> = []
    /// Whether older history exists, per conversation.
    @Published private(set) var hasMoreHistory: [String: Bool] = [:]

    /// Who is typing, per conversation: user id -> display name.
    @Published private(set) var typingUsers: [String: [String: String]] = [:]
    /// Live presence overrides, keyed by user id. Applied on top of whatever the
    /// last REST payload said, which goes stale the moment someone connects.
    @Published private(set) var presence: [String: PresenceStatus] = [:]

    /// Optimistic sends still awaiting their `message_ack`, keyed by temp id.
    @Published private(set) var pendingSends: Set<String> = []
    /// Temp ids whose send failed — the bubble shows a retry affordance.
    @Published private(set) var failedSends: Set<String> = []

    // MARK: Dependencies

    private weak var auth: AuthStore?
    private var eventTask: Task<Void, Never>?
    private var typingTimers: [String: Task<Void, Never>] = [:]
    private var outgoingTypingSentAt: [String: Date] = [:]
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "chat")

    var currentUserID: String? { auth?.currentUser?.id }

    func attach(auth: AuthStore) {
        self.auth = auth
        // The reciprocal half: a session ending has to be able to clear this store.
        auth.registerSessionStore(chat: self)
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            // `subscribe()`, not a shared stream: `CallStore` consumes these events
            // too, and a single `AsyncStream` would split them between the two stores
            // rather than delivering every event to both.
            guard let stream = self?.auth?.realtime.subscribe() else { return }
            for await event in stream {
                await self?.handle(event)
            }
        }
    }

    // MARK: - Session teardown

    /// Drop everything belonging to the person who was signed in.
    ///
    /// This store is a `@StateObject` on `RxHiveApp`, so it lives for the whole
    /// process: signing out swaps the root view, it does not rebuild this. Until
    /// this method existed nothing could put the data down — there was no reset
    /// here, and `AuthStore` held no reference to this store to call one with.
    ///
    /// So a sign-out left the previous person's threads and message bodies in
    /// memory and handed them to whoever signed in next on the device. Not merely
    /// retained, either: `ConversationsListView` renders `chat.conversations`
    /// directly and only shows its spinner while that array is EMPTY, so a
    /// carry-over skips the spinner and paints the previous user's conversation
    /// list — names and last-message previews — until the new session's first
    /// fetch returns.
    ///
    /// `RememberedUser.clear()` is called at every one of those boundaries already,
    /// to drop the persisted account record. This is the in-memory half, which was
    /// missing.
    ///
    /// Deliberately leaves `eventTask` and `auth` alone. The realtime subscription
    /// is established once in `attach` at launch and has to survive into the next
    /// session; cancelling it here would leave the second sign-in with no live
    /// events at all.
    func reset() {
        conversations = []
        isLoadingConversations = false
        conversationsError = nil
        hasMoreConversations = false
        messages = [:]
        loadingThreads = []
        hasMoreHistory = [:]
        typingUsers = [:]
        presence = [:]
        pendingSends = []
        failedSends = []

        // Live tasks rather than data: each is a pending "stop typing" for a
        // conversation of the session being ended. Left running they fire against
        // the next one and write into `typingUsers` after this has emptied it.
        for timer in typingTimers.values { timer.cancel() }
        typingTimers = [:]
        outgoingTypingSentAt = [:]
    }

    #if DEBUG
    /// Seed the store directly. Every field above is `private(set)`, and the real
    /// writers need a live socket and API; `reset` is about what is in the store,
    /// not how it got there.
    func applyForTesting(
        conversations: [Conversation] = [],
        messages: [String: [Message]] = [:],
        typingUsers: [String: [String: String]] = [:],
        presence: [String: PresenceStatus] = [:],
        pendingSends: Set<String> = [],
        failedSends: Set<String> = [],
        loadingThreads: Set<String> = [],
        hasMoreHistory: [String: Bool] = [:],
        isLoadingConversations: Bool = false,
        hasMoreConversations: Bool = false,
        conversationsError: String? = nil
    ) {
        self.conversations = conversations
        self.messages = messages
        self.typingUsers = typingUsers
        self.presence = presence
        self.pendingSends = pendingSends
        self.failedSends = failedSends
        self.loadingThreads = loadingThreads
        self.hasMoreHistory = hasMoreHistory
        self.isLoadingConversations = isLoadingConversations
        self.hasMoreConversations = hasMoreConversations
        self.conversationsError = conversationsError
    }
    #endif

    // MARK: - Conversations

    func loadConversations(filter: String = "all", search: String = "", reset: Bool = true) async {
        if reset { isLoadingConversations = true }
        conversationsError = nil
        do {
            let page = try await RxHiveAPI.conversations(limit: 30, search: search, filter: filter)
            conversations = page.data
            hasMoreConversations = page.hasMore
        } catch {
            conversationsError = (error as? APIError)?.userMessage ?? "Couldn't load chats"
        }
        isLoadingConversations = false
    }

    func loadMoreConversations(filter: String = "all", search: String = "") async {
        guard hasMoreConversations, let cursor = conversationCursor else { return }
        do {
            let page = try await RxHiveAPI.conversations(
                cursor: cursor, limit: 30, search: search, filter: filter
            )
            // Merge rather than append: an event may have already inserted one of
            // these at the top while the request was in flight.
            let existing = Set(conversations.map(\.id))
            conversations.append(contentsOf: page.data.filter { !existing.contains($0.id) })
            hasMoreConversations = page.hasMore
        } catch {
            log.notice("Paging conversations failed: \(String(describing: error), privacy: .public)")
        }
    }

    private var conversationCursor: String? {
        guard let last = conversations.last?.lastMessageAt else { return nil }
        return RxDate.format(last)
    }

    func conversation(id: String) -> Conversation? {
        conversations.first { $0.id == id }
    }

    /// The title to show for a conversation. Direct chats have no `name` — the
    /// server leaves it nil and expects the client to use the other participant.
    func title(for conversation: Conversation) -> String {
        if let name = conversation.name, !name.isEmpty { return name }
        return otherParticipant(in: conversation)?.displayName ?? "Conversation"
    }

    func otherParticipant(in conversation: Conversation) -> UserBrief? {
        guard let me = currentUserID else { return conversation.participants.first }
        return conversation.participants.first { $0.userId != me }
    }

    /// Live presence for a user, preferring a realtime update over the REST value.
    func status(of userID: String, fallback: PresenceStatus = .offline) -> PresenceStatus {
        presence[userID] ?? fallback
    }

    // MARK: - Messages

    func loadMessages(conversationID: String, force: Bool = false) async {
        if !force, messages[conversationID]?.isEmpty == false { return }
        loadingThreads.insert(conversationID)
        do {
            let page = try await RxHiveAPI.messages(conversationID: conversationID, limit: 50)
            messages[conversationID] = page.messages
            hasMoreHistory[conversationID] = page.hasMore
        } catch {
            log.error("Loading messages failed: \(String(describing: error), privacy: .public)")
        }
        loadingThreads.remove(conversationID)
    }

    /// Page backwards. Returns the id of the message that was at the top, so the
    /// view can keep it pinned and avoid the scroll jumping.
    @discardableResult
    func loadOlderMessages(conversationID: String) async -> String? {
        guard hasMoreHistory[conversationID] == true,
              let oldest = messages[conversationID]?.first else { return nil }
        do {
            let page = try await RxHiveAPI.messages(
                conversationID: conversationID, before: oldest.id, limit: 50
            )
            let known = Set(messages[conversationID]?.map(\.id) ?? [])
            let fresh = page.messages.filter { !known.contains($0.id) }
            messages[conversationID] = fresh + (messages[conversationID] ?? [])
            hasMoreHistory[conversationID] = page.hasMore
            return oldest.id
        } catch {
            log.notice("Paging history failed: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    /// Load a window centred on a specific message, for jump-to-message.
    ///
    /// Replaces the loaded window rather than merging into it: the target may be
    /// thousands of messages away, and stitching two disjoint ranges together would
    /// render a list with an invisible gap in the middle.
    func loadWindow(conversationID: String, around messageID: String) async -> Bool {
        do {
            let page = try await RxHiveAPI.messages(
                conversationID: conversationID, around: messageID, limit: 50
            )
            messages[conversationID] = page.messages
            hasMoreHistory[conversationID] = page.hasMore
            // anchorID is nil when the server could not resolve the anchor and
            // returned the newest window instead — the caller should not then try
            // to scroll to a message that isn't there.
            return page.anchorID != nil
        } catch {
            return false
        }
    }

    // MARK: - Sending

    /// Send text (or a caption-less attachment reference) with an optimistic bubble.
    ///
    /// The socket is preferred because it echoes `temp_id` back in `message_ack`,
    /// which is what lets the placeholder be replaced by the real message rather
    /// than duplicated alongside it. If the socket is down we fall back to HTTP and
    /// reconcile on the response.
    func send(
        conversationID: String,
        content: String,
        type: String = "text",
        replyTo: String? = nil,
        mediaURL: String? = nil,
        duration: Double? = nil,
        thumbnailURL: String? = nil,
        fileSize: Int? = nil,
        filename: String? = nil
    ) async {
        guard let me = auth?.currentUser else { return }
        let tempID = "temp-\(UUID().uuidString)"

        let placeholder = Message.optimistic(
            id: tempID,
            conversationID: conversationID,
            senderID: me.id,
            senderName: me.name,
            senderAvatar: me.avatarURL,
            content: content,
            type: type,
            replyTo: replyTo,
            mediaURL: mediaURL,
            duration: duration,
            filename: filename,
            fileSize: fileSize
        )
        messages[conversationID, default: []].append(placeholder)
        pendingSends.insert(tempID)
        bumpToTop(conversationID: conversationID, preview: placeholder)

        let socketUp = auth?.realtime.state == .connected
        // Attachments always go over HTTP: the socket's `message` handler accepts
        // only a single `media_url` and no thumbnail/size/filename, so a document
        // sent that way would lose its metadata.
        let hasAttachmentMetadata = thumbnailURL != nil || fileSize != nil || filename != nil

        if socketUp && !hasAttachmentMetadata {
            auth?.realtime.send(
                .message(
                    conversationID: conversationID,
                    content: content,
                    msgType: type,
                    replyTo: replyTo,
                    tempID: tempID,
                    mediaURL: mediaURL
                )
            )
            // The ack (or an `error` frame carrying this temp_id) resolves it.
            return
        }

        do {
            let saved = try await RxHiveAPI.sendMessage(
                conversationID: conversationID,
                content: content, type: type, replyTo: replyTo, tempID: tempID,
                mediaURL: mediaURL, duration: duration,
                thumbnailURL: thumbnailURL, fileSize: fileSize, filename: filename
            )
            replacePlaceholder(tempID: tempID, with: saved, in: conversationID)
        } catch {
            pendingSends.remove(tempID)
            failedSends.insert(tempID)
        }
    }

    /// Retry a failed optimistic send: drop the placeholder and send again.
    func retry(tempID: String, in conversationID: String) async {
        guard let placeholder = messages[conversationID]?.first(where: { $0.id == tempID }) else { return }
        messages[conversationID]?.removeAll { $0.id == tempID }
        failedSends.remove(tempID)
        await send(
            conversationID: conversationID,
            content: placeholder.content,
            type: placeholder.type.rawValue,
            replyTo: placeholder.replyTo,
            mediaURL: placeholder.mediaURL,
            duration: placeholder.duration,
            fileSize: placeholder.fileSize,
            filename: placeholder.filename
        )
    }

    func discardFailed(tempID: String, in conversationID: String) {
        messages[conversationID]?.removeAll { $0.id == tempID }
        failedSends.remove(tempID)
    }

    // MARK: - Message actions

    func toggleReaction(messageID: String, emoji: String, in conversationID: String) async {
        do {
            let reactions = try await RxHiveAPI.react(messageID: messageID, emoji: emoji)
            mutate(messageID: messageID, in: conversationID) { $0.applying(reactions: reactions) }
        } catch {
            log.notice("Reaction failed: \(String(describing: error), privacy: .public)")
        }
    }

    func toggleStar(messageID: String, in conversationID: String) async -> Bool? {
        do {
            let starred = try await RxHiveAPI.toggleStar(messageID: messageID)
            mutate(messageID: messageID, in: conversationID) { $0.applying(isStarred: starred) }
            return starred
        } catch {
            return nil
        }
    }

    func togglePin(messageID: String, in conversationID: String) async -> Bool? {
        do {
            let pinned = try await RxHiveAPI.togglePin(messageID: messageID)
            mutate(messageID: messageID, in: conversationID) { $0.applying(isPinned: pinned) }
            return pinned
        } catch {
            return nil
        }
    }

    func edit(messageID: String, content: String, in conversationID: String) async -> Bool {
        do {
            let updated = try await RxHiveAPI.editMessage(messageID: messageID, content: content)
            mutate(messageID: messageID, in: conversationID) { _ in updated }
            return true
        } catch {
            return false
        }
    }

    // MARK: - Conversation actions

    func togglePin(conversationID: String) async {
        do {
            let state = try await RxHiveAPI.togglePin(conversationID: conversationID)
            applyPin(conversationID: conversationID, isPinned: state.isPinned, pinOrder: state.pinOrder)
        } catch {
            log.notice("Pin failed: \(String(describing: error), privacy: .public)")
        }
    }

    func toggleMute(conversationID: String) async -> Bool? {
        do {
            let state = try await RxHiveAPI.toggleMute(conversationID: conversationID)
            replaceConversation(id: conversationID) { $0.applying(isMuted: state.isMuted) }
            return state.isMuted
        } catch {
            return nil
        }
    }

    func markRead(conversationID: String) async {
        // Zero the badge immediately; the server agrees a moment later.
        replaceConversation(id: conversationID) { $0.applying(unreadCount: 0) }
        if auth?.realtime.state == .connected {
            let lastID = messages[conversationID]?.last?.id
            auth?.realtime.send(.readReceipt(conversationID: conversationID, lastReadMessageID: lastID))
        } else {
            try? await RxHiveAPI.markRead(conversationID: conversationID)
        }
    }

    func deleteConversation(id: String) async -> Bool {
        do {
            try await RxHiveAPI.deleteConversation(id: id)
            conversations.removeAll { $0.id == id }
            messages[id] = nil
            return true
        } catch {
            return false
        }
    }

    /// Insert (or refresh) a conversation the app just learned about.
    func upsert(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.insert(conversation, at: 0)
        }
        sortConversations()
    }

    /// Refetch one conversation's metadata after an event that only told us its id.
    func refreshConversation(id: String) async {
        // There is no GET /api/conversations/{id}; the list is the only read path,
        // so re-fetch the first page and take the row from it.
        do {
            let page = try await RxHiveAPI.conversations(limit: 30)
            if let fresh = page.data.first(where: { $0.id == id }) {
                upsert(fresh)
            }
        } catch {
            log.notice("Refresh conversation failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Typing

    /// Announce that I'm typing, at most once every 3 seconds.
    ///
    /// Throttled because the composer would otherwise emit a frame per keystroke,
    /// and the socket is rate-limited to 120 frames/minute server-side
    /// (`hub.py:RATE_LIMIT_PER_MINUTE`) — fast typing alone would trip it.
    func noteTyping(in conversationID: String) {
        let now = Date()
        if let last = outgoingTypingSentAt[conversationID], now.timeIntervalSince(last) < 3 { return }
        outgoingTypingSentAt[conversationID] = now
        auth?.realtime.send(.typingStart(conversationID: conversationID))
    }

    func stopTyping(in conversationID: String) {
        outgoingTypingSentAt[conversationID] = nil
        auth?.realtime.send(.typingStop(conversationID: conversationID))
    }

    // MARK: - Realtime

    private func handle(_ event: RealtimeEvent) async {
        switch event {
        case .connected:
            // Re-sync after any gap: events that arrived while disconnected are gone.
            await loadConversations()

        case .pong, .unknown:
            break

        case .error(let detail, let tempID):
            if let tempID {
                pendingSends.remove(tempID)
                failedSends.insert(tempID)
            }
            log.notice("Server error frame: \(detail, privacy: .public)")

        case .newMessage(let message):
            insertIncoming(message)

        case let .messageAck(tempID, messageID, createdAt, _):
            guard let tempID else { return }
            pendingSends.remove(tempID)
            resolveAck(tempID: tempID, messageID: messageID, createdAt: createdAt)

        case .messageStatus:
            // Delivery is derived from last_read_at server-side, so there is no
            // per-message state worth storing here.
            break

        case let .messagesRead(conversationID, userID, readAt):
            guard let conversationID, let userID, let readAt else { return }
            applyReadReceipt(conversationID: conversationID, userID: userID, readAt: readAt)

        case let .messageEdited(messageID, conversationID, content, editedAt):
            guard let conversationID else { return }
            mutate(messageID: messageID, in: conversationID) {
                $0.applying(content: content, editedAt: editedAt)
            }

        case let .reactionUpdate(messageID, conversationID, reactions):
            guard let messageID, let conversationID else { return }
            mutate(messageID: messageID, in: conversationID) { $0.applying(reactions: reactions) }

        case let .messagePinUpdate(messageID, conversationID, isPinned):
            guard let messageID, let conversationID else { return }
            mutate(messageID: messageID, in: conversationID) { $0.applying(isPinned: isPinned) }

        case let .typing(conversationID, userID, userName, isTyping):
            applyTyping(conversationID: conversationID, userID: userID, name: userName, isTyping: isTyping)

        case let .presence(userID, status, _):
            presence[userID] = status

        case .conversationCreated(let conversation):
            if let conversation { upsert(conversation) }

        case .conversationUpdated(let id):
            if let id { await refreshConversation(id: id) }

        case let .conversationPinUpdate(id, isPinned, pinOrder):
            guard let id else { return }
            applyPin(conversationID: id, isPinned: isPinned, pinOrder: pinOrder)

        case .permissionsUpdated(let id, _):
            if let id { await refreshConversation(id: id) }

        case .memberAdded(let id, _), .memberRemoved(let id, _),
             .memberLeft(let id, _), .roleChanged(let id, _, _):
            if let id { await refreshConversation(id: id) }

        case .removedFromConversation(let id):
            guard let id else { return }
            conversations.removeAll { $0.id == id }
            messages[id] = nil

        case .profileUpdated:
            // Cheapest correct response: names and avatars live on the conversation
            // payloads, so re-read the list.
            await loadConversations()

        case .crossOrg:
            await loadConversations()

        // Calls are CallStore's business. Enumerated rather than defaulted so a new
        // call event has to be routed deliberately in both stores instead of being
        // silently swallowed here.
        case .callIncoming, .callAccepted, .callDeclined, .callCancelled, .callEnded,
             .callBusy, .callMissed, .callUnavailable, .callFull, .callError,
             .callRingingStarted, .callParticipantJoined, .callParticipantLeft,
             .callMediaToggle, .callPeerState, .callResume, .callGroupStarted,
             .callGroupEnded, .callGroupActive, .callGroupAlreadyActive,
             .callGroupParticipants, .callParticipantsInvited, .callParticipantDeclined:
            break
        }
    }

    // MARK: - State mutation helpers

    private func insertIncoming(_ message: Message) {
        let conversationID = message.conversationId
        var thread = messages[conversationID] ?? []

        // De-dupe. Two paths can deliver the same message: our own HTTP send
        // response and the broadcast, and a reconnect can replay one we have.
        if thread.contains(where: { $0.id == message.id }) {
            if let index = thread.firstIndex(where: { $0.id == message.id }) {
                thread[index] = message
                messages[conversationID] = thread
            }
            return
        }
        thread.append(message)
        // Sort by timestamp: a message sent while we were paging can arrive out of
        // order relative to what is already loaded.
        thread.sort { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        messages[conversationID] = thread

        bumpToTop(conversationID: conversationID, preview: message)

        // Unread only counts if it isn't mine.
        if message.senderId != currentUserID {
            replaceConversation(id: conversationID) { $0.applying(unreadCount: $0.unreadCount + 1) }
        }
        // Any message from someone clears their typing indicator.
        if let sender = message.senderId {
            applyTyping(conversationID: conversationID, userID: sender, name: nil, isTyping: false)
        }
    }

    private func resolveAck(tempID: String, messageID: String, createdAt: Date?) {
        for (conversationID, thread) in messages {
            guard let index = thread.firstIndex(where: { $0.id == tempID }) else { continue }
            // The ack carries only ids and a timestamp, not the message. If the
            // broadcast already delivered the real message, drop the placeholder;
            // otherwise re-key it so a later broadcast de-dupes against it.
            if thread.contains(where: { $0.id == messageID }) {
                messages[conversationID]?.remove(at: index)
            } else {
                messages[conversationID]?[index] = thread[index].applying(
                    id: messageID, createdAt: createdAt ?? thread[index].createdAt
                )
            }
            return
        }
    }

    private func replacePlaceholder(tempID: String, with saved: Message, in conversationID: String) {
        pendingSends.remove(tempID)
        guard var thread = messages[conversationID] else { return }
        if let index = thread.firstIndex(where: { $0.id == tempID }) {
            if thread.contains(where: { $0.id == saved.id }) {
                thread.remove(at: index)
            } else {
                thread[index] = saved
            }
            messages[conversationID] = thread
        }
    }

    private func mutate(messageID: String, in conversationID: String, _ transform: (Message) -> Message) {
        guard let index = messages[conversationID]?.firstIndex(where: { $0.id == messageID }),
              let current = messages[conversationID]?[index] else { return }
        messages[conversationID]?[index] = transform(current)
    }

    private func replaceConversation(id: String, _ transform: (Conversation) -> Conversation) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[index] = transform(conversations[index])
    }

    private func bumpToTop(conversationID: String, preview: Message) {
        replaceConversation(id: conversationID) {
            $0.applying(
                lastMessageAt: preview.createdAt ?? Date(),
                lastMessage: LastMessage(
                    content: preview.content,
                    senderId: preview.senderId,
                    senderName: preview.senderName,
                    createdAt: preview.createdAt ?? Date(),
                    type: preview.type
                )
            )
        }
        sortConversations()
    }

    private func applyPin(conversationID: String, isPinned: Bool, pinOrder: Int?) {
        replaceConversation(id: conversationID) { $0.applying(isPinned: isPinned, pinOrder: pinOrder) }
        sortConversations()
    }

    /// Reproduces the server's ORDER BY: my pin first, then my explicit pin order
    /// with NULLS LAST, then recency (`api/conversations.py`).
    private func sortConversations() {
        conversations.sort { a, b in
            if a.isPinned != b.isPinned { return a.isPinned }
            if a.isPinned && b.isPinned {
                switch (a.pinOrder, b.pinOrder) {
                case let (x?, y?) where x != y: return x < y
                case (nil, _?): return false   // NULLS LAST
                case (_?, nil): return true
                default: break
                }
            }
            return (a.lastMessageAt ?? .distantPast) > (b.lastMessageAt ?? .distantPast)
        }
    }

    private func applyReadReceipt(conversationID: String, userID: String, readAt: Date) {
        guard let thread = messages[conversationID] else { return }
        messages[conversationID] = thread.map { message in
            // Receipts are derived from last_read_at, so everything the reader sent
            // *before* that timestamp is now read.
            guard message.senderId == currentUserID,
                  let created = message.createdAt, created <= readAt,
                  !message.readBy.contains(where: { $0.userId == userID })
            else { return message }
            return message.applying(
                readBy: message.readBy + [ReadReceipt(userId: userID, readAt: readAt)],
                deliveredTo: message.deliveredTo + [DeliveryReceipt(userId: userID, deliveredAt: readAt)]
            )
        }
    }

    private func applyTyping(conversationID: String, userID: String, name: String?, isTyping: Bool) {
        guard userID != currentUserID else { return }
        var bucket = typingUsers[conversationID] ?? [:]
        let key = "\(conversationID)|\(userID)"
        typingTimers[key]?.cancel()

        if isTyping {
            bucket[userID] = name ?? bucket[userID] ?? "Someone"
            typingUsers[conversationID] = bucket
            // Self-expire. A client that goes away mid-compose never sends
            // typing_stop, and the indicator would otherwise stay up forever.
            typingTimers[key] = Task { [weak self] in
                try? await Task.sleep(for: .seconds(6))
                guard let self, !Task.isCancelled else { return }
                self.applyTyping(conversationID: conversationID, userID: userID, name: nil, isTyping: false)
            }
        } else {
            bucket.removeValue(forKey: userID)
            typingUsers[conversationID] = bucket.isEmpty ? nil : bucket
            typingTimers[key] = nil
        }
    }
}
