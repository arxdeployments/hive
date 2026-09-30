import Combine
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
    /// Conversations whose loaded window is a slice of history that stops short of
    /// the newest message — what a jump to an old message leaves behind.
    @Published private(set) var hasNewerMessages: [String: Bool] = [:]

    /// Conversations whose thread is the newest page, fetched by `loadMessages`, and
    /// kept current by the socket since. Only these may be served from cache.
    ///
    /// "There are messages in the store" is NOT the same thing, and treating it as
    /// if it were is what hid messages. Three writers leave a non-empty thread that
    /// is not the newest page: `insertIncoming` puts a live message into a thread
    /// that was never opened (a one-message "window"), `loadWindow` replaces the
    /// thread with a slice around an old message, and a thread loaded before the
    /// socket dropped misses everything sent while it was down — the socket closes
    /// every time the phone is locked, and the broker does not replay.
    private(set) var loadedWindows: Set<String> = []

    /// Threads on screen, counted because a thread can appear on the navigation
    /// stack more than once. A reconnect re-fetches these straight away; every other
    /// cached thread just stops being trusted until it is next opened.
    private var visibleThreads: [String: Int] = [:]

    /// Whether the socket that keeps cached threads current is up. True until the
    /// store is attached to a socket, so a store with none behaves as connected.
    private var socketUp = true
    /// Bumped every time trust is withdrawn. A fetch that began under an older value
    /// straddled a drop, and its page is not trusted — see `grantTrust`.
    private var trustEpoch = 0
    /// Threads that were current at the moment the socket dropped. Their history can
    /// be kept across the reconnect's re-fetch; see `threadAfterFetch(keepingHistory:)`.
    private var trustLostToGap: Set<String> = []
    /// Bumped by `reset`. A fetch that answers after a sign-out holds the previous
    /// person's messages and must not write them into the next session.
    private var sessionGeneration = 0
    /// The tail of each thread's window-fetch queue; see `inWindowQueue`.
    private var windowQueues: [String: Task<Void, Never>] = [:]
    private var socketStateWatch: AnyCancellable?

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
    private let api: APIClient
    private var eventTask: Task<Void, Never>?
    private var typingTimers: [String: Task<Void, Never>] = [:]
    private var outgoingTypingSentAt: [String: Date] = [:]
    private let log = Logger(subsystem: "ai.rhythmrx.rxhive", category: "chat")

    var currentUserID: String? { auth?.currentUser?.id }

    /// `api` exists for tests; the app passes nothing and uses the shared client.
    init(api: APIClient = .shared) {
        self.api = api
    }

    func attach(auth: AuthStore) {
        self.auth = auth
        // The reciprocal half: a session ending has to be able to clear this store.
        auth.registerSessionStore(chat: self)
        // Synchronous, not `receive(on:)`: RealtimeClient is @MainActor and sets
        // `state` on the main actor, and a hop would leave a turn in which a tap could
        // still be answered from a thread the socket had already stopped updating.
        socketStateWatch = auth.realtime.$state.sink { [weak self] state in
            MainActor.assumeIsolated {
                self?.socketStateChanged(isConnected: state == .connected)
            }
        }
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
        hasNewerMessages = [:]
        loadedWindows = []
        visibleThreads = [:]
        trustLostToGap = []
        windowQueues = [:]
        sessionGeneration &+= 1
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
        hasNewerMessages: [String: Bool] = [:],
        loadedWindows: Set<String> = [],
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
        self.hasNewerMessages = hasNewerMessages
        self.loadedWindows = loadedWindows
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
            let page = try await RxHiveAPI.conversations(limit: 30, search: search, filter: filter, client: api)
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
                cursor: cursor, limit: 30, search: search, filter: filter, client: api
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

    /// Load the newest page of a thread, unless the one already held is current.
    ///
    /// Returns whether the thread now shows its newest messages — true for a trusted
    /// cached window and for a successful fetch, false when the fetch failed or a jump's
    /// slice was left in place. Cache-first, but only for a window this store fetched
    /// itself and the socket has kept current since; see `loadedWindows` for why a
    /// non-empty thread is not proof of that. `force` re-fetches regardless.
    ///
    /// The page is MERGED into what is held rather than replacing it; see
    /// `threadAfterFetch` for what a replace used to delete.
    @discardableResult
    func loadMessages(conversationID: String, force: Bool = false) async -> Bool {
        await loadNewestPage(conversationID, force: force, afterReconnect: false, keepingHistory: false)
    }

    /// `loadMessages`, plus the two things only a reconnect wants: leave a jump's slice
    /// alone, and keep history paged in above a page that joins onto it.
    private func loadNewestPage(
        _ conversationID: String,
        force: Bool,
        afterReconnect: Bool,
        keepingHistory: Bool
    ) async -> Bool {
        await inWindowQueue(conversationID) { [self] in
            // Decided HERE, once any fetch queued ahead of this one has landed: a
            // thread that fetch made current is served, not fetched a second time.
            if !force, loadedWindows.contains(conversationID), messages[conversationID]?.isEmpty == false {
                return true
            }
            // A jump's slice was never current, and the person reading it asked for
            // it. A reconnect leaves it in place; back-to-latest fetches the newest
            // page when they want it.
            if afterReconnect, hasNewerMessages[conversationID] == true { return false }
            return await fetchNewestPage(conversationID, keepingHistory: keepingHistory)
        }
    }

    private func fetchNewestPage(_ conversationID: String, keepingHistory: Bool) async -> Bool {
        let epoch = trustEpoch
        let session = sessionGeneration
        loadingThreads.insert(conversationID)
        defer { if session == sessionGeneration { loadingThreads.remove(conversationID) } }
        do {
            let page = try await RxHiveAPI.messages(conversationID: conversationID, limit: 50, client: api)
            // Signed out while the page was in flight: it belongs to the last person.
            guard session == sessionGeneration else { return false }
            let thread = Self.threadAfterFetch(
                page.messages,
                replacing: messages[conversationID] ?? [],
                unsent: pendingSends.union(failedSends),
                keepingLiveRows: true,
                keepingHistory: keepingHistory
            )
            messages[conversationID] = thread
            // When history paged in above the page was kept, whether there is more
            // before THAT is still the held answer, not the page's.
            if thread.first?.id == page.messages.first?.id {
                hasMoreHistory[conversationID] = page.hasMore
            }
            // The default page is anchored to the newest message, so nothing newer is
            // missing. This is also what ends a jump's slice-of-history state.
            hasNewerMessages[conversationID] = false
            grantTrust(conversationID, fetchedAt: epoch)
            return true
        } catch {
            guard session == sessionGeneration else { return false }
            // A failed re-fetch leaves whatever was held, which may be stale — so it
            // stops being trusted, and `markRead` will not vouch for it.
            loadedWindows.remove(conversationID)
            log.error("Loading messages failed: \(String(describing: error), privacy: .public)")
            return false
        }
    }

    /// Trust a window only if the fetch that produced it began and ended inside one
    /// connected span. A fetch that straddled a drop read a page the socket then
    /// stopped keeping current, and a fetch made while the socket is down is current
    /// only until the next message nobody delivers.
    private func grantTrust(_ conversationID: String, fetchedAt epoch: Int) {
        if epoch == trustEpoch, socketUp {
            loadedWindows.insert(conversationID)
        }
    }

    /// Run window-replacing work for one thread one piece at a time, in the order it
    /// was asked for.
    ///
    /// Open, a reconnect's re-fetch, back-to-latest and a jump all replace the same
    /// window. Unordered, whichever answer landed LAST won: an older newest-page
    /// response could undo the jump the user had just made, and an older failure could
    /// revoke the trust a newer success had granted. Queued, each one applies after the
    /// one before it, so the last one asked for is the one on screen.
    private func inWindowQueue(
        _ conversationID: String,
        _ work: @escaping @MainActor () async -> Bool
    ) async -> Bool {
        let previous = windowQueues[conversationID]
        let task = Task { @MainActor () -> Bool in
            await previous?.value
            return await work()
        }
        windowQueues[conversationID] = Task { @MainActor in _ = await task.value }
        return await task.value
    }

    /// The thread after a fetched page replaces the one held: the page, plus the rows
    /// the page cannot contain yet.
    ///
    /// A plain replace deleted two kinds of row, and neither came back:
    ///
    /// * **A send the server has not answered.** The optimistic bubble exists only
    ///   here, and the server leaves the sender out of its own `new_message`
    ///   broadcast (`services/messaging.py`), so once the bubble is gone the ack finds
    ///   nothing to resolve and the message never appears. Opening a thread and
    ///   sending before its first page lands was enough. A FAILED send goes the same
    ///   way, taking its retry with it. The web fixed this in batch 67
    ///   (`utils/carryOverLocalOnly.js`); this is the same rule.
    /// * **A message that arrived live while the page was in flight.** The page was
    ///   read before it was sent, so it is newer than anything on the page.
    ///
    /// A carried send that DID land is dropped: the page's row for it carries its
    /// `temp_id` as `client_msg_id`, and showing both would invite a resend.
    ///
    /// `keepingLiveRows` is false for a jump's slice of history: rows newer than that
    /// page are not live arrivals but the old newest end of the thread, and stitching
    /// them on would draw one list with an invisible gap in the middle.
    ///
    /// `keepingHistory` is a reconnect re-fetching a thread that was current when the
    /// socket dropped. The page is the newest 50; if the held thread contains the
    /// page's first row, everything above that row is history the reader paged in,
    /// contiguous with the page, and it stays — otherwise every unlock, and every
    /// token refresh, cut the thread back to 50 rows and moved the reader. If the page
    /// does not join the held rows (more than a page arrived while locked), nothing
    /// can be stitched and the page replaces them.
    static func threadAfterFetch(
        _ fetched: [Message],
        replacing held: [Message],
        unsent: Set<String>,
        keepingLiveRows: Bool,
        keepingHistory: Bool = false
    ) -> [Message] {
        let fetchedIDs = Set(fetched.map(\.id))
        let landed = Set(fetched.compactMap(\.clientMsgId))
        let newestFetched = fetched.compactMap(\.createdAt).max()

        var olderRows: [Message] = []
        if keepingHistory, let firstID = fetched.first?.id,
           let joint = held.firstIndex(where: { $0.id == firstID }) {
            olderRows = held[..<joint].filter { !unsent.contains($0.id) && !fetchedIDs.contains($0.id) }
        }
        let liveRows = keepingLiveRows
            ? held.filter { row in
                !unsent.contains(row.id) && !fetchedIDs.contains(row.id)
                    && (newestFetched.map { newest in (row.createdAt ?? .distantPast) > newest } ?? true)
            }
            : []
        let unsentRows = held.filter { unsent.contains($0.id) && !landed.contains($0.id) }
        return olderRows + fetched + liveRows + unsentRows
    }

    /// Page backwards. Returns the id of the message that was at the top, so the
    /// view can keep it pinned and avoid the scroll jumping.
    @discardableResult
    func loadOlderMessages(conversationID: String) async -> String? {
        guard hasMoreHistory[conversationID] == true,
              let oldest = messages[conversationID]?.first else { return nil }
        do {
            let page = try await RxHiveAPI.messages(
                conversationID: conversationID, before: oldest.id, limit: 50, client: api
            )
            // The window was replaced while this page was in flight — a reconnect's
            // re-fetch, back-to-latest, a jump, a sign-out. A page from before the OLD
            // top row spliced onto the new window would draw a thread with a hole in
            // the middle.
            guard messages[conversationID]?.first?.id == oldest.id else { return nil }
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
    /// render a list with an invisible gap in the middle. Queued behind any other
    /// window fetch for the thread, so a newest-page answer that lands late cannot
    /// undo the jump.
    func loadWindow(conversationID: String, around messageID: String) async -> Bool {
        await inWindowQueue(conversationID) { [self] in
            let epoch = trustEpoch
            let session = sessionGeneration
            do {
                let page = try await RxHiveAPI.messages(
                    conversationID: conversationID, around: messageID, limit: 50, client: api
                )
                guard session == sessionGeneration else { return false }
                messages[conversationID] = Self.threadAfterFetch(
                    page.messages,
                    replacing: messages[conversationID] ?? [],
                    unsent: pendingSends.union(failedSends),
                    keepingLiveRows: !page.hasNewer
                )
                hasMoreHistory[conversationID] = page.hasMore
                // A slice that stops short of the newest message is not the thread:
                // the next open must fetch the newest page rather than reuse this, and
                // it must not be marked read (see `markRead`).
                hasNewerMessages[conversationID] = page.hasNewer
                loadedWindows.remove(conversationID)
                if !page.hasNewer { grantTrust(conversationID, fetchedAt: epoch) }
                // anchorID is nil when the server could not resolve the anchor and
                // returned the newest window instead — the caller should not then try
                // to scroll to a message that isn't there.
                return page.anchorID != nil
            } catch {
                return false
            }
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

    /// Tell the server, and so the sender, that this thread has been read.
    ///
    /// Only for a thread that is showing its newest messages. The server stamps
    /// `last_read_at` with the current time whatever anchor it is given
    /// (`services/messaging.py`), so marking a stale thread read — one that missed
    /// messages while the phone was locked, or a jump's slice of history — reported
    /// messages the phone never displayed as Read to the person who sent them.
    ///
    /// `justFetched` is a caller that has just had `loadMessages` return true: the
    /// newest page is on screen whether or not the socket is up to keep it there.
    func markRead(conversationID: String, justFetched: Bool = false) async {
        guard justFetched || loadedWindows.contains(conversationID) else { return }
        // Zero the badge immediately; the server agrees a moment later.
        replaceConversation(id: conversationID) { $0.applying(unreadCount: 0) }
        if auth?.realtime.state == .connected {
            let lastID = messages[conversationID]?.last?.id
            auth?.realtime.send(.readReceipt(conversationID: conversationID, lastReadMessageID: lastID))
        } else {
            try? await RxHiveAPI.markRead(conversationID: conversationID, client: api)
        }
    }

    // MARK: - Threads on screen

    /// `ChatView` reports itself on screen, so a reconnect knows what to re-fetch.
    func threadDidAppear(_ conversationID: String) {
        visibleThreads[conversationID, default: 0] += 1
    }

    /// The other half of `threadDidAppear`.
    func threadDidDisappear(_ conversationID: String) {
        guard let count = visibleThreads[conversationID] else { return }
        visibleThreads[conversationID] = count > 1 ? count - 1 : nil
    }

    /// Whether any copy of the thread is on screen — for work that finishes after the
    /// user may have left it.
    func isThreadOnScreen(_ conversationID: String) -> Bool {
        visibleThreads[conversationID] != nil
    }

    /// The socket's state, from `attach`'s observer (and directly from tests).
    ///
    /// Trust ends the moment the socket leaves `.connected`, not when it comes back.
    /// Between the two — unlock to the `connected` frame, or the round trips of a
    /// token-refresh reconnect — a thread served from cache was missing whatever was
    /// sent in the gap, and opening it marked those messages read.
    func socketStateChanged(isConnected: Bool) {
        socketUp = isConnected
        if !isConnected { untrustAll() }
    }

    private func untrustAll() {
        trustEpoch &+= 1
        trustLostToGap.formUnion(loadedWindows)
        loadedWindows.removeAll()
    }

    /// After any socket gap: nothing cached can be trusted, and what is on screen is
    /// re-fetched now.
    ///
    /// The broker is fire-and-forget (`redis_bus.py`: "clients refetch on
    /// reconnect"), and the socket closes every time the phone is locked, so a
    /// message sent while it was down is simply not delivered. This used to reload
    /// only the conversation list — which then showed the new message as a preview
    /// and an unread badge, while the thread it opened into did not contain it.
    ///
    /// A thread that was current when the socket dropped keeps the history paged in
    /// above the new page, and a jump's slice on screen is left where the reader is.
    func resyncAfterReconnect() async {
        // Also covers a `connected` that arrives without the drop having been seen.
        untrustAll()
        let currentAtDrop = trustLostToGap
        trustLostToGap = []
        for conversationID in visibleThreads.keys.sorted() {
            await loadNewestPage(
                conversationID,
                force: true,
                afterReconnect: true,
                keepingHistory: currentAtDrop.contains(conversationID)
            )
        }
        await loadConversations()
    }

    func deleteConversation(id: String) async -> Bool {
        do {
            try await RxHiveAPI.deleteConversation(id: id)
            conversations.removeAll { $0.id == id }
            forgetThread(id)
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
            let page = try await RxHiveAPI.conversations(limit: 30, client: api)
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
            await resyncAfterReconnect()

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
            forgetThread(id)

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

    /// A thread the user can no longer see at all: its messages and every flag about
    /// its window go together.
    private func forgetThread(_ conversationID: String) {
        messages[conversationID] = nil
        hasMoreHistory[conversationID] = nil
        hasNewerMessages[conversationID] = nil
        loadedWindows.remove(conversationID)
        trustLostToGap.remove(conversationID)
    }

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
