import XCTest

@testable import RxHive

/// Whether the thread on screen is the thread on the server.
///
/// `ChatStore.loadMessages` used to return early whenever the store held ANY messages
/// for a conversation — `if !force, messages[id]?.isEmpty == false { return }` — and
/// nothing ever passed `force`. Three things leave a thread non-empty without it being
/// the newest page: a live message landing in a thread that was never opened, a jump
/// to an old message, and a socket gap. The socket closes every time the phone is
/// locked, the broker does not replay, and the reconnect re-read only the conversation
/// list. So a message sent to a locked phone showed up as a preview and an unread
/// badge, and the thread it opened into did not contain it — and opening that thread
/// then told the sender it had been read.
///
/// The page is served over `MockURLProtocol`, and every test drives the store's real
/// methods through it.
@MainActor
final class ThreadFreshnessTests: XCTestCase {

    private let conv = "conv-a"
    private var messagesPath: String { "/api/conversations/\(conv)/messages" }
    private var readPath: String { "/api/conversations/\(conv)/read" }

    /// When the running test began, for the time check in `tearDown`.
    private var startedAt = Date()

    /// Starts the clock for this test.
    override func setUp() {
        super.setUp()
        startedAt = Date()
    }

    /// Fails a test that ran long enough to have been saved by a timeout, then clears
    /// `MockURLProtocol`'s script and request log, which are process-wide.
    override func tearDown() {
        // Several tests here assert that nothing was written, and a response that never
        // arrives satisfies that just as well as one that arrived and was discarded. A
        // lost reply shows up only as time — URLSession's 60 s timeout, and then some —
        // so time is what is checked. Every test here finishes in well under a second.
        XCTAssertLessThan(
            Date().timeIntervalSince(startedAt), 10,
            "a scripted reply went undelivered; any 'nothing was written' assertion above passed on a timeout"
        )
        MockURLProtocol.reset()
        super.tearDown()
    }

    // MARK: Fixtures

    /// A client whose every request is answered by `MockURLProtocol`.
    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return APIClient(session: URLSession(configuration: config))
    }

    /// A store wired to that client, with no socket attached — so it behaves as connected
    /// until a test says otherwise through `socketStateChanged`.
    private func makeStore() -> ChatStore {
        ChatStore(api: makeClient())
    }

    /// A message as the API serializes it. `second` orders them in time.
    private func messageJSON(_ id: String, second: Int, clientMsgId: String? = nil, createdAt: String? = nil) -> String {
        let key = clientMsgId.map { "\"\($0)\"" } ?? "null"
        let stamp = createdAt ?? "2026-09-30T08:00:\(String(format: "%02d", second))Z"
        return """
        {"_id":"\(id)","conversation_id":"\(conv)","sender_id":"u-doc","type":"text",
         "content":"\(id)","reactions":[],"read_by":[],"delivered_to":[],"is_deleted":false,
         "is_forwarded":false,"is_starred":false,"is_pinned":false,"sender_name":"Dr A",
         "attachments":[],"created_at":"\(stamp)",
         "client_msg_id":\(key)}
        """
    }

    /// A `GET .../messages` response wrapping `messages`.
    private func pageJSON(_ messages: [String], hasNewer: Bool = false, anchor: String? = nil) -> String {
        let anchorJSON = anchor.map { "\"\($0)\"" } ?? "null"
        return """
        {"messages":[\(messages.joined(separator: ","))],"has_more":false,
         "has_newer":\(hasNewer),"anchor_id":\(anchorJSON)}
        """
    }

    /// The same message as a Swift value, for the rules that take one.
    private func row(_ id: String, second: Int = 0, clientMsgId: String? = nil, createdAt: String? = nil) throws -> Message {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            return try XCTUnwrap(RxDate.parse(text))
        }
        let json = messageJSON(id, second: second, clientMsgId: clientMsgId, createdAt: createdAt)
        return try decoder.decode(Message.self, from: Data(json.utf8))
    }

    /// Answers the newest page with `newest`, and an `around=` request with `around`.
    private func serve(newest: [String], around: String? = nil, hasNewer: Bool = true) {
        let newestPage = pageJSON(newest)
        let aroundPage = around.map { pageJSON([$0], hasNewer: hasNewer, anchor: "m-old") }
        MockURLProtocol.install { request, _ in
            let query = request.url?.query ?? ""
            if query.contains("around="), let aroundPage { return .json(200, aroundPage) }
            if request.url?.path.hasSuffix("/read") == true { return .json(200, "{}") }
            if request.url?.path == "/api/conversations" {
                return .json(200, #"{"data":[],"has_more":false}"#)
            }
            return .json(200, newestPage)
        }
    }

    /// The thread's message ids, oldest first — what the screen would draw.
    private func ids(_ chat: ChatStore) -> [String] {
        (chat.messages[conv] ?? []).map(\.id)
    }

    private var pageFetches: Int {
        MockURLProtocol.requests.filter { $0.path == messagesPath && !($0.url.query ?? "").contains("around=") }.count
    }

    // MARK: Which threads are trusted

    /// A live message for a thread that was never opened leaves a one-message thread.
    /// That is not a window anybody fetched, and it must not be served as one.
    func testAThreadHoldingOnlyALiveMessageIsFetchedWhenOpened() async throws {
        serve(newest: [messageJSON("m1", second: 1), messageJSON("m2", second: 2), messageJSON("m3", second: 3)])
        let chat = makeStore()
        chat.applyForTesting(messages: [conv: [try row("m3", second: 3)]])

        let current = await chat.loadMessages(conversationID: conv)

        XCTAssertTrue(current)
        XCTAssertEqual(pageFetches, 1, "a one-message thread was served as if it were the thread")
        XCTAssertEqual(ids(chat), ["m1", "m2", "m3"])
    }

    /// The cache still works: a window this store fetched, with the socket keeping it
    /// current, re-opens without a round trip. The fix is not "always fetch".
    func testAWindowTheStoreFetchedIsReusedOnReopen() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()

        await chat.loadMessages(conversationID: conv)
        await chat.loadMessages(conversationID: conv)

        XCTAssertEqual(pageFetches, 1)
    }

    // MARK: Reconnect

    /// The reported bug. The thread is open, the phone is locked, Dr A sends
    /// "hold the 10:00 metoprolol", the phone is unlocked. The reconnect has to bring
    /// the message into the thread on screen, not just into the conversation list.
    func testReconnectRefetchesTheThreadOnScreen() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)
        chat.threadDidAppear(conv)

        serve(newest: [messageJSON("m1", second: 1), messageJSON("m-while-locked", second: 2)])
        await chat.resyncAfterReconnect()

        XCTAssertEqual(ids(chat), ["m1", "m-while-locked"], "the message sent while locked never reached the thread")
    }

    /// A thread that is cached but not on screen is not re-fetched on the spot — only
    /// untrusted, so its next open fetches.
    func testReconnectMakesEveryOtherCachedThreadFetchOnItsNextOpen() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)

        await chat.resyncAfterReconnect()
        XCTAssertEqual(pageFetches, 1, "a thread nobody is looking at was re-fetched on reconnect")

        await chat.loadMessages(conversationID: conv)
        XCTAssertEqual(pageFetches, 2, "a thread cached before the gap was trusted after it")
    }

    /// Appear and disappear balance, and a thread shown twice stays on screen until
    /// both copies have gone.
    func testOnlyThreadsStillOnScreenAreRefetchedOnReconnect() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)

        chat.threadDidAppear(conv)
        chat.threadDidAppear(conv)
        chat.threadDidDisappear(conv)
        await chat.resyncAfterReconnect()
        XCTAssertEqual(pageFetches, 2, "still on screen once, so it should have been re-fetched")

        chat.threadDidDisappear(conv)
        await chat.resyncAfterReconnect()
        XCTAssertEqual(pageFetches, 2, "off screen, so it should only have been untrusted")
    }

    // MARK: Jumps

    /// A jump replaces the thread with a slice around an old message. That slice is
    /// not the thread: the next open must fetch the newest page, and until then the
    /// store has to say that newer messages exist.
    func testAJumpedSliceIsNotReusedAsTheThread() async {
        serve(newest: [messageJSON("m9", second: 9)], around: messageJSON("m-old", second: 1))
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)

        let resolved = await chat.loadWindow(conversationID: conv, around: "m-old")
        XCTAssertTrue(resolved)
        XCTAssertEqual(chat.hasNewerMessages[conv], true)
        XCTAssertEqual(ids(chat), ["m-old"], "the old newest rows were stitched onto the jump's slice")

        await chat.loadMessages(conversationID: conv)
        XCTAssertEqual(pageFetches, 2, "the jump's slice was served as the thread")
        XCTAssertEqual(ids(chat), ["m9"])
        XCTAssertEqual(chat.hasNewerMessages[conv], false)
    }

    /// A slice that happens to reach the newest message is the thread after all.
    func testAJumpThatReachesTheNewestMessageIsTheThread() async {
        serve(newest: [messageJSON("m9", second: 9)], around: messageJSON("m9", second: 9), hasNewer: false)
        let chat = makeStore()

        _ = await chat.loadWindow(conversationID: conv, around: "m9")
        await chat.loadMessages(conversationID: conv)

        XCTAssertEqual(pageFetches, 0)
        XCTAssertEqual(chat.hasNewerMessages[conv], false)
    }

    // MARK: Read receipts

    /// The server stamps last_read_at with the current time whatever it is told, so
    /// marking a thread read that is not showing its newest messages reports messages
    /// the phone never displayed as Read to the person who sent them.
    func testMarkReadIsWithheldUntilTheThreadShowsItsNewestMessages() async throws {
        serve(newest: [messageJSON("m1", second: 1), messageJSON("m2", second: 2)])
        let chat = makeStore()
        chat.applyForTesting(messages: [conv: [try row("m2", second: 2)]])

        await chat.markRead(conversationID: conv)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 0, "a thread nobody fetched was marked read")

        await chat.loadMessages(conversationID: conv)
        await chat.markRead(conversationID: conv)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 1)
    }

    /// A jump's slice of old history is not the thread's newest end, so it is not marked
    /// read either.
    func testMarkReadIsWithheldForAJumpedSlice() async {
        serve(newest: [messageJSON("m9", second: 9)], around: messageJSON("m-old", second: 1))
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)
        _ = await chat.loadWindow(conversationID: conv, around: "m-old")

        await chat.markRead(conversationID: conv)

        XCTAssertEqual(MockURLProtocol.count(path: readPath), 0, "a slice of old history was marked read")
    }

    /// "I just fetched the newest page" stops being true the moment a jump queued behind
    /// that fetch replaces it with a slice (CodeRabbit, review of cd6c290). Back-to-latest
    /// waits before marking read, and the pinned banner stays tappable meanwhile.
    func testJustFetchedDoesNotVouchForASliceThatReplacedThePage() async {
        serve(newest: [messageJSON("m9", second: 9)], around: messageJSON("m-old", second: 1))
        let chat = makeStore()
        let current = await chat.loadMessages(conversationID: conv, force: true)
        _ = await chat.loadWindow(conversationID: conv, around: "m-old")

        await chat.markRead(conversationID: conv, justFetched: current)

        XCTAssertTrue(current)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 0,
                       "the newest page was marked read while a jump's slice was on screen")
    }

    /// A re-fetch that fails leaves whatever was held, which may be stale — it must not
    /// be vouched for either.
    func testAFailedRefetchStopsTheThreadBeingTrusted() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)

        MockURLProtocol.install { _, _ in .failing(URLError(.notConnectedToInternet)) }
        let current = await chat.loadMessages(conversationID: conv, force: true)
        await chat.markRead(conversationID: conv)

        XCTAssertFalse(current)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 0)
    }

    // MARK: What a fetch keeps

    /// The iOS twin of web batch 67: send while the first page is in flight. The
    /// server leaves the sender out of its own broadcast, so if the fetch deletes the
    /// bubble the message never appears, and the ack has nothing to resolve.
    func testASendMadeDuringTheFetchSurvivesIt() throws {
        let held = [try row("m1", second: 1), try row("temp-x", second: 5)]
        let fetched = [try row("m1", second: 1)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m1", "temp-x"], unsent: ["temp-x"],
                                                keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "temp-x"])
    }

    /// A send that landed comes back on the page carrying its temp id; the bubble has
    /// to go, or the message shows twice and invites a resend.
    func testASendThatLandedIsNotShownTwice() throws {
        let held = [try row("m1", second: 1), try row("temp-x", second: 5)]
        let fetched = [try row("m1", second: 1), try row("m2", second: 5, clientMsgId: "temp-x")]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m1", "temp-x"], unsent: ["temp-x"],
                                                keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "m2"])
    }

    /// A message that arrives over the socket while the page is in flight, which the
    /// page was read too early to carry.
    func testAMessageThatArrivedLiveDuringTheFetchSurvivesIt() throws {
        let held = [try row("m1", second: 1), try row("m3-live", second: 3)]
        let fetched = [try row("m1", second: 1), try row("m2", second: 2)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m1"], unsent: [], keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "m2", "m3-live"])
    }

    /// Two messages can share a timestamp. A distinct one at the page's newest instant
    /// is an arrival the page does not carry, and must survive (CodeRabbit, PR #111).
    func testAnArrivalSharingThePagesNewestTimestampSurvives() throws {
        let held = [try row("m2", second: 2), try row("m2-twin", second: 2)]
        let fetched = [try row("m1", second: 1), try row("m2", second: 2)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m2"], unsent: [], keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "m2", "m2-twin"])
    }

    /// Rows older than the page that the page does not include are the old window, not
    /// live arrivals, and the page replaces them.
    func testOldRowsThePageDoesNotIncludeAreReplaced() throws {
        let held = [try row("m-older", second: 0), try row("m1", second: 1)]
        let fetched = [try row("m1", second: 1), try row("m2", second: 2)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m-older", "m1"], unsent: [],
                                                keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "m2"])
    }

    /// For a jump's slice the newer held rows are the old end of the thread; stitching
    /// them on would draw one list with a gap in it. Unsent bubbles still survive.
    func testAJumpedSliceDoesNotStitchTheOldNewestRowsOn() throws {
        let held = [try row("m8", second: 8), try row("m9", second: 9), try row("temp-x", second: 10)]
        let fetched = [try row("m2", second: 2)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m8", "m9", "temp-x"],
                                                unsent: ["temp-x"], keepingLiveRows: false)

        XCTAssertEqual(thread.map(\.id), ["m2", "temp-x"])
    }

    /// The same rules, reached through the store's own fetches rather than called
    /// directly: a send the server has not answered survives opening the thread, and
    /// survives a jump — jumping is something people do while they wait.
    func testTheStoresOwnFetchesKeepASendItHasNotHeardBackAbout() async throws {
        serve(newest: [messageJSON("m1", second: 1)], around: messageJSON("m-old", second: 0))
        let chat = makeStore()
        chat.applyForTesting(
            messages: [conv: [try row("temp-x", second: 5)]],
            pendingSends: ["temp-x"]
        )

        await chat.loadMessages(conversationID: conv)
        XCTAssertEqual(ids(chat), ["m1", "temp-x"], "opening the thread deleted a send in flight")

        _ = await chat.loadWindow(conversationID: conv, around: "m-old")
        XCTAssertEqual(ids(chat), ["m-old", "temp-x"], "jumping deleted a send in flight")
    }

    // MARK: The socket going down

    /// Trust ends when the socket drops, not when it comes back. Between the two — an
    /// unlock and its `connected` frame, or a token-refresh reconnect — a cached thread
    /// is missing whatever was sent, and must neither be served nor marked read.
    func testTrustEndsTheMomentTheSocketDrops() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)

        chat.socketStateChanged(isConnected: false)
        await chat.markRead(conversationID: conv)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 0, "a thread the socket stopped updating was marked read")

        let current = await chat.loadMessages(conversationID: conv)
        XCTAssertEqual(pageFetches, 2, "a thread the socket stopped updating was served from cache")
        XCTAssertTrue(current)
        XCTAssertFalse(chat.loadedWindows.contains(conv), "trusted with nothing to keep it current")

        // What the caller just fetched is on screen, so marking THAT read is honest.
        await chat.markRead(conversationID: conv, justFetched: current)
        XCTAssertEqual(MockURLProtocol.count(path: readPath), 1)
    }

    /// A page fetched before a drop and answered after it describes a thread the socket
    /// then stopped keeping current.
    func testAFetchThatStraddlesADropIsNotTrusted() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.5) }
        let chat = makeStore()

        let load = Task { await chat.loadMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        chat.socketStateChanged(isConnected: false)
        chat.socketStateChanged(isConnected: true)
        _ = await load.value

        XCTAssertEqual(ids(chat), ["m1"], "the page itself is still the best there is")
        XCTAssertFalse(chat.loadedWindows.contains(conv), "a page read before the gap was trusted after it")
    }

    /// The way up as well as the way down: a fetch begun while the socket was down read
    /// its page before the socket subscribed, so it must not earn trust by finishing
    /// after the socket came back (CodeRabbit, review of b789477).
    func testAFetchBegunWhileTheSocketWasDownIsNotTrustedWhenItComesBack() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.5) }
        let chat = makeStore()
        chat.socketStateChanged(isConnected: false)

        let load = Task { await chat.loadMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        chat.socketStateChanged(isConnected: true)
        _ = await load.value

        XCTAssertEqual(ids(chat), ["m1"])
        XCTAssertFalse(chat.loadedWindows.contains(conv), "a page read before the socket subscribed was trusted")
    }

    // MARK: A reconnect keeps the reader's place

    /// Every unlock with a thread open, and every token refresh, reconnects. The
    /// re-fetch used to cut the thread back to the newest 50 rows, taking away the
    /// history the reader had paged back to and moving them.
    func testReconnectKeepsHistoryPagedInAboveTheNewPage() async throws {
        serve(newest: [messageJSON("m3", second: 3), messageJSON("m4", second: 4), messageJSON("m5", second: 5)])
        let chat = makeStore()
        chat.applyForTesting(
            messages: [conv: [try row("m1", second: 1), try row("m2", second: 2),
                              try row("m3", second: 3), try row("m4", second: 4)]],
            hasMoreHistory: [conv: true],
            loadedWindows: [conv]
        )
        chat.threadDidAppear(conv)

        chat.socketStateChanged(isConnected: false)
        chat.socketStateChanged(isConnected: true)
        await chat.resyncAfterReconnect()

        XCTAssertEqual(ids(chat), ["m1", "m2", "m3", "m4", "m5"], "the paged-back history was thrown away")
        XCTAssertEqual(chat.hasMoreHistory[conv], true, "the page's has_more describes the page, not the kept history")
    }

    /// More than a page arrived while locked: the new page does not join the held rows,
    /// nothing can be stitched, and it replaces them.
    func testReconnectReplacesAThreadTheNewPageDoesNotJoin() async throws {
        serve(newest: [messageJSON("m60", second: 50), messageJSON("m61", second: 51)])
        let chat = makeStore()
        chat.applyForTesting(
            messages: [conv: [try row("m1", second: 1), try row("m2", second: 2)]],
            hasMoreHistory: [conv: false],
            loadedWindows: [conv]
        )
        chat.threadDidAppear(conv)

        await chat.resyncAfterReconnect()

        XCTAssertEqual(ids(chat), ["m60", "m61"])
    }

    /// History is only kept for a thread that was current when the socket dropped. One
    /// whose last fetch failed can hold a hole of its own, and stitching onto it would
    /// keep the hole.
    func testAThreadThatWasNotCurrentAtTheDropIsReplacedNotStitched() async throws {
        serve(newest: [messageJSON("m1", second: 1), messageJSON("m2", second: 2)])
        let chat = makeStore()
        chat.applyForTesting(messages: [conv: [try row("m-stale", second: 0), try row("m1", second: 1)]])
        chat.threadDidAppear(conv)

        await chat.resyncAfterReconnect()

        XCTAssertEqual(ids(chat), ["m1", "m2"])
    }

    /// A jump's slice on screen is the reader's chosen place, and was never current: a
    /// reconnect leaves it alone.
    func testReconnectLeavesAJumpedSliceOnScreenAlone() async {
        serve(newest: [messageJSON("m9", second: 9)], around: messageJSON("m-old", second: 1))
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)
        _ = await chat.loadWindow(conversationID: conv, around: "m-old")
        chat.threadDidAppear(conv)

        await chat.resyncAfterReconnect()

        XCTAssertEqual(pageFetches, 1, "the reconnect replaced the slice being read")
        XCTAssertEqual(ids(chat), ["m-old"])
    }

    /// A re-sync stops between threads once it is cancelled — by a newer reconnect, or a
    /// sign-out — rather than fetching every thread that was on screen.
    func testACancelledResyncStopsBetweenThreads() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.4) }
        let chat = makeStore()
        chat.threadDidAppear("conv-a")
        chat.threadDidAppear("conv-b")

        let resync = Task { await chat.resyncAfterReconnect() }
        try await Task.sleep(for: .milliseconds(100))
        resync.cancel()
        await resync.value

        XCTAssertEqual(MockURLProtocol.count(path: "/api/conversations/conv-a/messages"), 1)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/conversations/conv-b/messages"), 0,
                       "a cancelled re-sync went on to fetch the next thread")
        XCTAssertEqual(MockURLProtocol.count(path: "/api/conversations"), 0,
                       "a cancelled re-sync went on to reload the list")
    }

    /// Cancelled during the last thread's fetch, a re-sync does not go on to reload the
    /// conversation list either.
    func testACancelledResyncDoesNotReloadTheList() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.4) }
        let chat = makeStore()
        chat.threadDidAppear(conv)

        let resync = Task { await chat.resyncAfterReconnect() }
        try await Task.sleep(for: .milliseconds(100))
        resync.cancel()
        await resync.value

        XCTAssertEqual(pageFetches, 1)
        XCTAssertEqual(MockURLProtocol.count(path: "/api/conversations"), 0,
                       "a cancelled re-sync went on to reload the list")
    }

    /// A thread left open when the app goes to the background is still on the
    /// navigation stack — `onDisappear` does not fire — but nobody is looking at it.
    /// During a call the socket stays open, so a live arrival there would otherwise be
    /// marked read with the phone in a pocket (CodeRabbit, review of 39368d3).
    func testAThreadIsNotOnScreenWhileTheAppIsNotActive() {
        let chat = makeStore()
        chat.threadDidAppear(conv)
        XCTAssertTrue(chat.isThreadOnScreen(conv))

        chat.scenePhaseChanged(isActive: false)
        XCTAssertFalse(chat.isThreadOnScreen(conv), "a backgrounded thread counts as seen")

        chat.scenePhaseChanged(isActive: true)
        XCTAssertTrue(chat.isThreadOnScreen(conv))
    }

    /// The background still leaves the thread counted for the reconnect, which is
    /// what re-fetches it when the app comes back.
    func testABackgroundedThreadIsStillRefetchedOnReconnect() async {
        serve(newest: [messageJSON("m1", second: 1)])
        let chat = makeStore()
        await chat.loadMessages(conversationID: conv)
        chat.threadDidAppear(conv)
        chat.scenePhaseChanged(isActive: false)

        await chat.resyncAfterReconnect()

        XCTAssertEqual(pageFetches, 2, "going to the background stopped the thread being re-fetched")
    }

    // MARK: Fetches for one thread, in order

    /// A newest-page fetch still in flight when the user jumps must not land on top of
    /// the jump.
    func testAJumpIsNotUndoneByAnEarlierFetchLandingLate() async throws {
        let newest = pageJSON([messageJSON("m9", second: 9)])
        let slice = pageJSON([messageJSON("m-old", second: 1)], hasNewer: true, anchor: "m-old")
        MockURLProtocol.install { request, _ in
            (request.url?.query ?? "").contains("around=") ? .json(200, slice) : .json(200, newest, delay: 0.5)
        }
        let chat = makeStore()

        let open = Task { await chat.loadMessages(conversationID: conv, force: true) }
        try await Task.sleep(for: .milliseconds(100))
        let jump = Task { await chat.loadWindow(conversationID: conv, around: "m-old") }
        _ = await open.value
        let resolved = await jump.value

        XCTAssertTrue(resolved)
        XCTAssertEqual(ids(chat), ["m-old"], "the earlier newest-page answer landed on top of the jump")
        XCTAssertEqual(chat.hasNewerMessages[conv], true)
    }

    /// An older failure answering after a newer success must not revoke the trust the
    /// success granted.
    func testAnOlderFailureCannotRevokeANewerSuccess() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, ordinal in
            ordinal == 1 ? .failing(URLError(.timedOut), delay: 0.5) : .json(200, page)
        }
        let chat = makeStore()

        let first = Task { await chat.loadMessages(conversationID: conv, force: true) }
        try await Task.sleep(for: .milliseconds(100))
        let second = Task { await chat.loadMessages(conversationID: conv, force: true) }
        _ = await first.value
        _ = await second.value

        XCTAssertTrue(chat.loadedWindows.contains(conv), "a stale failure revoked a newer success")
    }

    /// Opening a thread while a fetch for it is already under way waits for that fetch
    /// and uses it, rather than asking again.
    func testOpeningDuringAFetchWaitsForItInsteadOfFetchingAgain() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.4) }
        let chat = makeStore()

        let refetch = Task { await chat.loadMessages(conversationID: conv, force: true) }
        try await Task.sleep(for: .milliseconds(100))
        let current = await chat.loadMessages(conversationID: conv)
        _ = await refetch.value

        XCTAssertTrue(current)
        XCTAssertEqual(pageFetches, 1)
    }

    /// A page of history requested before the window was replaced belongs to the old
    /// window. Spliced onto the new one it would draw a thread with a hole in it.
    func testAHistoryPageForAReplacedWindowIsDropped() async throws {
        let history = pageJSON([messageJSON("m1", second: 1), messageJSON("m2", second: 2)])
        let newest = pageJSON([messageJSON("m60", second: 50), messageJSON("m61", second: 51)])
        MockURLProtocol.install { request, _ in
            (request.url?.query ?? "").contains("before=") ? .json(200, history, delay: 0.5) : .json(200, newest)
        }
        let chat = makeStore()
        chat.applyForTesting(
            messages: [conv: [try row("m50", second: 40), try row("m51", second: 41)]],
            hasMoreHistory: [conv: true],
            loadedWindows: [conv]
        )

        let older = Task { await chat.loadOlderMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        await chat.loadMessages(conversationID: conv, force: true)
        let anchor = await older.value

        XCTAssertNil(anchor)
        XCTAssertEqual(ids(chat), ["m60", "m61"], "a page for the old window was spliced onto the new one")
    }

    /// A page that answers after a sign-out holds the previous person's messages.
    func testAPageThatAnswersAfterSignOutIsNotWritten() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.4) }
        let chat = makeStore()

        let load = Task { await chat.loadMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        chat.reset()
        _ = await load.value

        XCTAssertTrue(chat.messages.isEmpty, "the previous session's messages were written after sign-out")
        XCTAssertTrue(chat.loadedWindows.isEmpty)
        XCTAssertTrue(chat.loadingThreads.isEmpty)
    }

    // MARK: A thread that is gone

    /// Deleting the conversation — or being removed from it — forgets its thread. A page
    /// that was already on its way must not bring the messages back.
    func testANewestPageInFlightWhenTheThreadIsDeletedWritesNothing() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        MockURLProtocol.install { request, _ in
            request.httpMethod == "DELETE" ? .json(200, "{}") : .json(200, page, delay: 0.5)
        }
        let chat = makeStore()

        let load = Task { await chat.loadMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        let deleted = await chat.deleteConversation(id: conv)
        _ = await load.value

        XCTAssertTrue(deleted)
        XCTAssertNil(chat.messages[conv], "a deleted conversation's messages came back")
        XCTAssertFalse(chat.loadedWindows.contains(conv))
    }

    /// The same for a jump: its slice must not bring a deleted conversation back.
    func testAJumpInFlightWhenTheThreadIsDeletedWritesNothing() async throws {
        let slice = pageJSON([messageJSON("m-old", second: 1)], hasNewer: true, anchor: "m-old")
        MockURLProtocol.install { request, _ in
            request.httpMethod == "DELETE" ? .json(200, "{}") : .json(200, slice, delay: 0.5)
        }
        let chat = makeStore()

        let jump = Task { await chat.loadWindow(conversationID: conv, around: "m-old") }
        try await Task.sleep(for: .milliseconds(100))
        _ = await chat.deleteConversation(id: conv)
        let resolved = await jump.value

        XCTAssertFalse(resolved)
        XCTAssertNil(chat.messages[conv], "a deleted conversation's slice came back")
        XCTAssertNil(chat.hasNewerMessages[conv])
    }

    /// Loads still waiting their turn when the thread is forgotten never run at all.
    func testLoadsQueuedBehindADeletionNeverRun() async throws {
        let page = pageJSON([messageJSON("m1", second: 1)])
        let slice = pageJSON([messageJSON("m-old", second: 0)], hasNewer: true, anchor: "m-old")
        MockURLProtocol.install { request, _ in
            if request.httpMethod == "DELETE" { return .json(200, "{}") }
            if (request.url?.query ?? "").contains("around=") { return .json(200, slice) }
            return .json(200, page, delay: 0.5)
        }
        let chat = makeStore()

        let first = Task { await chat.loadMessages(conversationID: conv) }
        try await Task.sleep(for: .milliseconds(100))
        let queuedPage = Task { await chat.loadMessages(conversationID: conv, force: true) }
        let queuedJump = Task { await chat.loadWindow(conversationID: conv, around: "m-old") }
        try await Task.sleep(for: .milliseconds(50))
        _ = await chat.deleteConversation(id: conv)
        _ = await first.value
        _ = await queuedPage.value
        _ = await queuedJump.value

        XCTAssertEqual(pageFetches, 1, "a newest-page load queued before the deletion still ran")
        XCTAssertEqual(MockURLProtocol.requests.filter { ($0.url.query ?? "").contains("around=") }.count, 0,
                       "a jump queued before the deletion still ran")
        XCTAssertNil(chat.messages[conv])
    }

    /// The history rule on its own: kept only when the page joins the held rows.
    func testHistoryIsKeptOnlyWhenThePageJoinsTheHeldRows() throws {
        let held = [try row("m1", second: 1), try row("m2", second: 2), try row("temp-x", second: 9)]
        let joining = [try row("m2", second: 2), try row("m3", second: 3)]
        let apart = [try row("m7", second: 7), try row("m8", second: 8)]
        let atRequest: Set<String> = ["m1", "m2", "temp-x"]

        XCTAssertEqual(
            ChatStore.threadAfterFetch(joining, replacing: held, heldAtRequest: atRequest, unsent: ["temp-x"], keepingLiveRows: true,
                                       keepingHistory: true).map(\.id),
            ["m1", "m2", "m3", "temp-x"]
        )
        XCTAssertEqual(
            ChatStore.threadAfterFetch(apart, replacing: held, heldAtRequest: atRequest, unsent: ["temp-x"], keepingLiveRows: true,
                                       keepingHistory: true).map(\.id),
            ["m7", "m8", "temp-x"]
        )
        XCTAssertEqual(
            ChatStore.threadAfterFetch(joining, replacing: held, heldAtRequest: atRequest, unsent: ["temp-x"], keepingLiveRows: true,
                                       keepingHistory: false).map(\.id),
            ["m2", "m3", "temp-x"]
        )
    }

    /// A system-message batch (group create, add members) stamps one row per member a
    /// microsecond apart, and a `Date` from `RxDate` keeps milliseconds. With more than
    /// a page of them, the rows that fell off the page compared EQUAL to its newest
    /// under batch 72's at-or-after rule and were carried under it, and with history
    /// kept they were drawn twice (review of PR #112). Held when the request went out,
    /// they are the old window.
    func testASystemBatchInOneMillisecondIsNotCarriedUnderThePage() throws {
        let batch = try (0...60).map { i in
            try row("s\(i)", createdAt: String(format: "2026-09-30T08:00:00.412%03dZ", i))
        }
        let page = Array(batch[11...])
        let atRequest = Set(batch.map(\.id))

        let replaced = ChatStore.threadAfterFetch(page, replacing: batch, heldAtRequest: atRequest, unsent: [],
                                                  keepingLiveRows: true)
        XCTAssertEqual(replaced.map(\.id), page.map(\.id))

        let kept = ChatStore.threadAfterFetch(page, replacing: batch, heldAtRequest: atRequest, unsent: [],
                                              keepingLiveRows: true, keepingHistory: true)
        XCTAssertEqual(kept.map(\.id), batch.map(\.id))
    }

    /// The server stamps `created_at` before it commits, so a media send stamped before
    /// the page's newest row can commit after the page was read. Its time says older;
    /// it arrived during the fetch, so it survives it (review of PR #112).
    func testAnArrivalStampedBeforeThePagesNewestRowSurvives() throws {
        let held = [try row("m1", second: 1), try row("m2-late", second: 2), try row("m3", second: 3)]
        let fetched = [try row("m1", second: 1), try row("m3", second: 3)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m1", "m3"], unsent: [],
                                                keepingLiveRows: true)

        XCTAssertEqual(thread.map(\.id), ["m1", "m3", "m2-late"])
    }

    /// A held row is history or a live arrival, never both. `insertIncoming` sorts by
    /// time, so an arrival stamped early can sit above the page's first row, where the
    /// history rule keeps it too, and it was drawn twice (CodeRabbit, review of 89408b2).
    func testAnArrivalAboveThePagesFirstRowIsDrawnOnce() throws {
        let held = [try row("m0-late", second: 0), try row("m1", second: 1), try row("m2", second: 2)]
        let fetched = [try row("m1", second: 1), try row("m3", second: 3)]

        let thread = ChatStore.threadAfterFetch(fetched, replacing: held, heldAtRequest: ["m1", "m2"], unsent: [],
                                                keepingLiveRows: true, keepingHistory: true)

        XCTAssertEqual(thread.map(\.id), ["m0-late", "m1", "m3"])
    }

    /// Through the store: the thread's ids are taken as the request goes out, so a row
    /// the socket delivers while it is in flight is kept whatever its timestamp, and a
    /// row held before it is the old window (review of PR #112).
    func testTheStoreDecidesArrivalsByWhatTheThreadHeldWhenItAsked() async throws {
        let page = pageJSON([messageJSON("m1", second: 1), messageJSON("m3", second: 3)])
        MockURLProtocol.install { _, _ in .json(200, page, delay: 0.5) }
        let chat = makeStore()
        chat.applyForTesting(messages: [conv: [try row("m-old", second: 0)]])

        let load = Task { await chat.loadMessages(conversationID: conv, force: true) }
        try await Task.sleep(for: .milliseconds(100))
        chat.applyForTesting(messages: [conv: [try row("m-old", second: 0), try row("m2-late", second: 2)]])
        _ = await load.value

        XCTAssertEqual(ids(chat), ["m1", "m3", "m2-late"])
    }

    /// The same for a jump that lands on the newest page.
    func testAJumpDecidesArrivalsByWhatTheThreadHeldWhenItAsked() async throws {
        let window = pageJSON([messageJSON("m1", second: 1), messageJSON("m3", second: 3)], hasNewer: false, anchor: "m1")
        MockURLProtocol.install { _, _ in .json(200, window, delay: 0.5) }
        let chat = makeStore()
        chat.applyForTesting(messages: [conv: [try row("m-old", second: 0)]])

        let jump = Task { await chat.loadWindow(conversationID: conv, around: "m1") }
        try await Task.sleep(for: .milliseconds(100))
        chat.applyForTesting(messages: [conv: [try row("m-old", second: 0), try row("m2-late", second: 2)]])
        _ = await jump.value

        XCTAssertEqual(ids(chat), ["m1", "m3", "m2-late"])
    }

    // MARK: Wiring

    /// The rules above only help if the socket and the thread screen reach them.
    /// `handle(_:)` is private and the thread screen has no view harness, so this
    /// reads their source, the way the web suite's wiring guards do.
    func testTheReconnectAndTheThreadScreenReachTheseRules() throws {
        let store = try source("Features/Chat/ChatStore.swift")
        let connected = try XCTUnwrap(store.range(of: "case .connected:"))
        let nextCase = try XCTUnwrap(store.range(of: "case .pong", range: connected.upperBound..<store.endIndex))
        let connectedCase = String(store[connected.upperBound..<nextCase.lowerBound])
        let untrust = try XCTUnwrap(connectedCase.range(of: "let currentAtDrop = beginResync()"),
                                    "a reconnect no longer withdraws trust")
        let spawn = try XCTUnwrap(connectedCase.range(of: "reconnectTask = Task {"),
                                  "a reconnect no longer re-fetches the threads on screen")
        XCTAssertLessThan(untrust.lowerBound, spawn.lowerBound,
                          "trust must be withdrawn in order with the events, before the re-fetches start")
        XCTAssertTrue(connectedCase.contains("await self?.refetchAfterReconnect(currentAtDrop: currentAtDrop)"))
        // Awaited in the event loop, the re-fetches back events up past the stream's
        // 64-event buffer and messages are dropped (CodeRabbit, review of 02512f0).
        XCTAssertFalse(connectedCase.contains("await resyncAfterReconnect()"),
                       "the re-fetches block the realtime event loop again")
        XCTAssertTrue(connectedCase.contains("reconnectTask?.cancel()"),
                      "an older re-sync is not superseded by a newer one")
        let reset = try XCTUnwrap(store.range(of: "    func reset() {"))
        XCTAssertTrue(store[reset.upperBound...].prefix(300).contains("reconnectTask?.cancel()"),
                      "a sign-out leaves the last session's re-sync running")

        let view = try source("Features/Chat/ChatView.swift")
        XCTAssertTrue(view.contains(".onAppear { chat.threadDidAppear(conversationID) }"),
                      "the thread screen no longer reports itself on screen")
        XCTAssertTrue(view.contains(".onDisappear { chat.threadDidDisappear(conversationID) }"),
                      "the thread screen no longer reports itself gone")
        XCTAssertTrue(view.contains("if (!isAtBottom || hasNewer) && !isSelecting {"),
                      "the end of a jump's slice no longer offers a way back to the newest messages")
        XCTAssertTrue(view.contains("Task { await backToLatest(proxy) }"),
                      "the way back no longer fetches the newest page before scrolling")

        XCTAssertTrue(store.contains("socketStateWatch = auth.realtime.$state.sink"),
                      "nothing tells the store when the socket drops")

        // Coming back to the thread must not reload over a jump or scroll the reader away.
        let reappear = try XCTUnwrap(view.range(of: "if didInitialScroll {"), "open() has no reappear branch")
        let firstLoad = try XCTUnwrap(view.range(of: "let unread = conversation?.unreadCount ?? 0"))
        XCTAssertLessThan(reappear.lowerBound, firstLoad.lowerBound)
        XCTAssertTrue(view[reappear.upperBound..<firstLoad.lowerBound].contains("if !hasNewer && !isJumping {"),
                      "coming back reloads over a jump or a slice")
        XCTAssertFalse(view[reappear.upperBound..<firstLoad.lowerBound].contains("scrollToBottom"),
                       "coming back scrolls the reader away from their place")

        // A jump is marked in progress before its task starts, so a screen popping at the
        // same moment sees it.
        XCTAssertTrue(view.contains("isJumping = true\n        Task {\n            let resolved = await chat.loadWindow("),
                      "a jump is marked in progress only once its task runs")

        XCTAssertTrue(view.contains(".onChange(of: messages.last?.id) { _, _ in newMessagesArrived() }"),
                      "arrivals are detected by row count, which a sliding re-fetch leaves unchanged")
        // Back-to-latest finishes after the user may have left: it must check before the
        // failure toast (which would land on another screen) AND before the scroll and
        // receipt, not merely somewhere.
        let latest = try XCTUnwrap(view.range(of: "private func backToLatest(_ proxy: ScrollViewProxy) async {"))
        let latestBody = String(view[latest.upperBound...].prefix(1400))
        let onScreen = "guard chat.isThreadOnScreen(conversationID) else { return }"
        let toast = try XCTUnwrap(latestBody.range(of: "toasts.error(\"Couldn't load the latest messages\")"))
        let scroll = try XCTUnwrap(latestBody.range(of: "scrollToBottom(proxy, animated: true)"))
        let beforeToast = latestBody[..<toast.lowerBound]
        let betweenToastAndScroll = latestBody[toast.upperBound..<scroll.lowerBound]
        XCTAssertTrue(beforeToast.contains(onScreen), "back-to-latest toasts a failure over whatever screen the user moved to")
        XCTAssertTrue(betweenToastAndScroll.contains(onScreen), "back-to-latest scrolls and marks read after the user has left")

        // Every read receipt the thread screen sends comes after at least one await, and
        // work the screen started can resume after the user has left it. Each one has to
        // re-check that the thread is still on screen immediately before it (CodeRabbit,
        // review of 64c638e) — otherwise a newest page fetched as they left is marked read.
        let viewLines = view.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        let receipts = viewLines.indices.filter { viewLines[$0].hasPrefix("await chat.markRead(") }
        XCTAssertEqual(receipts.count, 5, "the thread screen's read receipts changed; re-check each is guarded")
        for index in receipts {
            // Walking back from the receipt, the on-screen guard must come before any
            // suspension point: nothing can change between a guard and code that does not
            // await, but anything can across an await.
            var guarded = false
            for line in viewLines[..<index].reversed() where !line.hasPrefix("//") {
                if line == "guard chat.isThreadOnScreen(conversationID) else { return }" { guarded = true; break }
                if line.contains("await ") { break }
            }
            XCTAssertTrue(guarded, "the read receipt at line \(index + 1) can be sent after the user left the thread")
        }

        // The unread divider counts the rows the server's unread count counts.
        XCTAssertTrue(view.contains("let countable = messages.filter { $0.senderId != nil && $0.senderId != me && !$0.isDeleted }"),
                      "the unread divider counts my own carried sends and shifts past an unread message")
        XCTAssertTrue(view.contains("unreadAnchorID = countable[countable.count - unread].id"),
                      "the unread divider is anchored on every row, not the countable ones")

        // A live arrival at the bottom marks read only a thread that is current, and
        // fetches one that is not rather than vouching for it; a slice is left alone.
        let arrived = try XCTUnwrap(view.range(of: "private func newMessagesArrived() {"))
        let arrivedBody = view[arrived.upperBound...].prefix(1200)
        XCTAssertTrue(arrivedBody.contains("guard !hasNewer, !isJumping else { return }"),
                      "a live arrival replaces a jump's slice, or marks it read")
        XCTAssertTrue(arrivedBody.contains("let current = await chat.loadMessages(conversationID: conversationID)"),
                      "a live arrival marks read a thread whose last fetch failed")
    }

    /// An app source file, read from the checkout, for the wiring checks.
    /// Returning to the foreground marks an open, trusted thread read — the receipts
    /// withheld while the app was not active are otherwise owed until the next arrival
    /// (CodeRabbit, review of f0f668e, on the web twin of this gap).
    func testComingBackToTheForegroundMarksAnOpenTrustedThreadRead() throws {
        let view = try source("Features/Chat/ChatView.swift")
        let handler = try XCTUnwrap(view.range(of: ".onChange(of: scenePhase) { _, phase in"),
                                    "nothing marks the thread read when the app comes back")
        let body = String(view[handler.upperBound...].prefix(500))
        XCTAssertTrue(body.contains("guard phase == .active, !hasNewer, !isJumping else { return }"),
                      "coming back marks a jump's slice read, or does so on the way out")
        XCTAssertTrue(body.contains("await chat.markRead(conversationID: conversationID)\n"),
                      "coming back vouches for a window that was not trusted")
        XCTAssertFalse(body.contains("justFetched"), "coming back has not fetched anything to vouch for")
    }

    /// `RxHiveApp` reports the scene phase to the store; without that the app-active
    /// gate above never closes.
    func testTheAppReportsItsScenePhaseToTheStore() throws {
        let app = try source("RxHiveApp.swift")
        let handler = try XCTUnwrap(app.range(of: ".onChange(of: scenePhase) { _, phase in"))
        let body = app[handler.upperBound...].prefix(400)
        XCTAssertTrue(body.contains("chat.scenePhaseChanged(isActive: phase == .active)"),
                      "the store never learns the app went to the background")
    }

    private func source(_ path: String) throws -> String {
        let url = URL(fileURLWithPath: "\(#filePath)")
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("RxHive/\(path)")
        return try String(contentsOf: url, encoding: .utf8)
    }
}
