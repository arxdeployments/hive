import XCTest

@testable import RxHive

/// What a sign-out leaves behind in memory.
///
/// `ChatStore` is a `@StateObject` on `RxHiveApp`, so it lives for the whole
/// process — signing out swaps the root view, it does not rebuild the store. Until
/// `reset()` existed nothing could put its contents down, and `AuthStore` held no
/// reference with which to try, so the previous person's threads and message
/// bodies were still there for whoever signed in next on a shared device.
///
/// `ConversationsListView` is what makes that visible rather than merely retained:
/// it renders `chat.conversations` directly and shows its spinner only while that
/// array is EMPTY, so a carry-over skips the spinner and paints the previous
/// user's list until the new session's first fetch returns.
@MainActor
final class SessionTeardownTests: XCTestCase {

    private static let conversationJSON = """
    {"_id":"conv-a","type":"direct","cross_org":false,"allowed_org_ids":[],
     "pinned_by":[],"is_active":true,"participants":[],"unread_count":3,
     "is_pinned":false,"is_muted":false}
    """

    private static let messageJSON = """
    {"_id":"m1","conversation_id":"conv-a","type":"text",
     "content":"patient in bed 4 is spiking a temp","reactions":[],"read_by":[],
     "delivered_to":[],"is_deleted":false,"is_forwarded":false,"is_starred":false,
     "is_pinned":false,"sender_name":"Dr Okafor","attachments":[]}
    """

    private func decode<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func filledChatStore() throws -> ChatStore {
        let chat = ChatStore()
        chat.applyForTesting(
            conversations: [try decode(Self.conversationJSON, as: Conversation.self)],
            messages: ["conv-a": [try decode(Self.messageJSON, as: Message.self)]],
            typingUsers: ["conv-a": ["u1": "Dr Okafor"]],
            presence: ["u1": .online],
            pendingSends: ["temp-1"],
            failedSends: ["temp-2"],
            loadingThreads: ["conv-a"],
            hasMoreHistory: ["conv-a": true],
            isLoadingConversations: true,
            hasMoreConversations: true,
            conversationsError: "stale"
        )
        return chat
    }

    func testResetLeavesNothingOfThePreviousSession() throws {
        let chat = try filledChatStore()
        XCTAssertEqual(chat.messages["conv-a"]?.first?.content,
                       "patient in bed 4 is spiking a temp",
                       "precondition: a real message body is in the store")

        chat.reset()

        XCTAssertTrue(chat.conversations.isEmpty)
        XCTAssertTrue(chat.messages.isEmpty, "message bodies survived the sign-out")
        XCTAssertTrue(chat.typingUsers.isEmpty)
        XCTAssertTrue(chat.presence.isEmpty)
        XCTAssertTrue(chat.pendingSends.isEmpty)
        XCTAssertTrue(chat.failedSends.isEmpty)
        XCTAssertTrue(chat.loadingThreads.isEmpty)
        XCTAssertTrue(chat.hasMoreHistory.isEmpty)
        XCTAssertNil(chat.conversationsError)
        XCTAssertFalse(chat.isLoadingConversations)
        XCTAssertFalse(chat.hasMoreConversations)
    }

    /// The precise shape of the leak, not the fields in aggregate. An empty
    /// `conversations` is what restores the list's loading spinner; without it the
    /// next user is shown the previous one's conversations instead of a spinner.
    func testResetRestoresTheEmptyStateTheListSpinnerDependsOn() throws {
        let chat = try filledChatStore()
        chat.reset()

        XCTAssertTrue(
            chat.conversations.isEmpty,
            "ConversationsListView shows its spinner only while conversations is empty"
        )
    }

    func testResetIsSafeWhenNothingWasEverLoaded() {
        let chat = ChatStore()
        chat.reset()
        chat.reset()
        XCTAssertTrue(chat.conversations.isEmpty)
    }

    // MARK: - The wiring

    private func makeClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        config.httpCookieStorage = URLSessionConfiguration.ephemeral.httpCookieStorage
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return APIClient(session: URLSession(configuration: config))
    }

    /// The half that matters: `reset()` existing proves nothing on its own if
    /// nothing calls it, and before this change nothing could — `AuthStore` held
    /// no reference to the store at all. Drives the real `signOut()`.
    func testSigningOutClearsTheStoreItRegistered() async throws {
        MockURLProtocol.reset()
        MockURLProtocol.install { _, _ in .json(200, "{}") }
        defer { MockURLProtocol.reset() }

        let auth = AuthStore(api: makeClient())
        let chat = try filledChatStore()
        chat.attach(auth: auth)

        await auth.signOut()

        XCTAssertTrue(chat.conversations.isEmpty, "sign-out did not reach the chat store")
        XCTAssertTrue(chat.messages.isEmpty, "the previous session's message bodies survived sign-out")
        XCTAssertEqual(auth.phase, .signedOut)
    }

    /// Registration is what connects the two, and it happens in `attach`. A store
    /// that never attached must not be reachable — and, more usefully, this pins
    /// that `attach` is the thing doing the registering, so moving it silently
    /// breaks this rather than the product.
    func testAStoreThatNeverAttachedIsNotClearedByAnUnrelatedAuthStore() async throws {
        MockURLProtocol.reset()
        MockURLProtocol.install { _, _ in .json(200, "{}") }
        defer { MockURLProtocol.reset() }

        let auth = AuthStore(api: makeClient())
        let orphan = try filledChatStore()  // deliberately not attached

        await auth.signOut()

        XCTAssertFalse(orphan.conversations.isEmpty)
    }

    /// A sign-out that lands during a live call must not tear the call down — the
    /// LiveKit session would be left connected with its signalling gone. But
    /// `.ended` is not a live call: it is the two-second "Call ended" card, shown
    /// only after `teardown(to:)` has already awaited `session.leave()`. Guarding
    /// on `case .idle` treated it as one and carried the badge into the next
    /// account; `hasLiveCall` is the predicate that draws the line correctly.
    func testCallStoreClearsUnlessACallIsActuallyLive() throws {
        let calls = CallStore()

        calls.applyForTesting(missedCallCount: 4)
        calls.resetSessionState()
        XCTAssertEqual(calls.missedCallCount, 0, "an idle store drops the previous account's badge")

        // The epitaph. Nothing left to strand, so it must clear.
        calls.applyForTesting(missedCallCount: 3, phase: .ended)
        calls.resetSessionState()
        XCTAssertEqual(calls.missedCallCount, 0, "a terminal .ended phase kept the previous account's badge")

        // Genuinely live: leave every last thing alone.
        let ringing = try decode("{}", as: CallSignal.self)
        calls.applyForTesting(missedCallCount: 2, phase: .incoming(ringing))
        calls.resetSessionState()
        XCTAssertEqual(calls.missedCallCount, 2, "a live call must be left entirely alone")
    }

}
