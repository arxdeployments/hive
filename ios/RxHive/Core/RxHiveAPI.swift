import Foundation

/// Every endpoint this app calls, in one place.
///
/// Paths and parameter names are transcribed from the FastAPI routers, not
/// inferred: `api/conversations.py`, `messages.py`, `groups.py`, `contacts.py`,
/// `media.py`, `search.py`, `calls.py`, `notifications.py`, `org_admin.py`,
/// `auth.py`. Two details bite repeatedly and are handled once, here:
///
///  * **`filter` is a reserved word in Python**, so the backend declares it as
///    `filter_` with `alias="filter"` — the wire name is `filter`.
///  * **`type` is likewise aliased** on the conversation-media endpoint.
///
/// There is no message-delete endpoint. It was removed from the product
/// (`api/messages.py` line ~452 keeps a note where it used to be), so this
/// enum has no `deleteMessage` and the UI must not offer one.
enum RxHiveAPI {

    private static var api: APIClient { APIClient.shared }

    // MARK: - Auth

    static func me() async throws -> CurrentUser {
        try await api.send(.get, "/api/auth/me", as: CurrentUser.self)
    }

    static func changePassword(current: String, new: String) async throws {
        struct Body: Encodable {
            let current_password: String
            let new_password: String
        }
        _ = try await api.sendIgnoringResponse(
            .post, "/api/auth/change-password",
            body: Body(current_password: current, new_password: new)
        )
    }

    // MARK: - Conversations

    /// `GET /api/conversations`. Cursor-paginated; `filter` is one of
    /// all | unread | groups | direct (see the router's branch on `filter_`).
    static func conversations(
        cursor: String? = nil,
        limit: Int = 30,
        search: String = "",
        filter: String = "all"
    ) async throws -> ConversationPage {
        try await api.send(
            .get, "/api/conversations",
            query: ["cursor": cursor, "limit": String(limit), "search": search, "filter": filter],
            as: ConversationPage.self
        )
    }

    /// Open (or find) the 1:1 conversation with someone.
    static func directConversation(participantID: String) async throws -> Conversation {
        struct Body: Encodable { let participant_id: String }
        return try await api.send(
            .post, "/api/conversations/direct",
            body: Body(participant_id: participantID),
            as: Conversation.self
        )
    }

    /// Toggle. The server flips the flag and answers the new state plus ordering.
    static func togglePin(conversationID: String) async throws -> PinState {
        try await api.send(.put, "/api/conversations/\(conversationID)/pin", as: PinState.self)
    }

    /// Toggle mute. Also a blind flip server-side.
    static func toggleMute(conversationID: String) async throws -> MuteState {
        try await api.send(.put, "/api/conversations/\(conversationID)/mute", as: MuteState.self)
    }

    /// Leaves the conversation for me (participant row removed).
    static func deleteConversation(id: String) async throws {
        _ = try await api.sendIgnoringResponse(.delete, "/api/conversations/\(id)")
    }

    /// Clear my copy of the history (writes delete-for-me rows).
    static func clearConversation(id: String) async throws {
        _ = try await api.sendIgnoringResponse(.post, "/api/conversations/\(id)/clear")
    }

    /// Plain-text transcript export.
    static func exportConversation(id: String) async throws -> Data {
        try await api.data(forPath: "/api/conversations/\(id)/export")
    }

    /// Mark read up to now. The socket's `read_receipt` frame does the same thing;
    /// this exists for the cold path (opening a chat before the socket is up).
    static func markRead(conversationID: String) async throws {
        _ = try await api.sendIgnoringResponse(.put, "/api/conversations/\(conversationID)/read")
    }

    // MARK: - Messages

    /// A window of history, oldest-first.
    ///
    /// Three modes, mutually exclusive: newest page (neither anchor), `before` for
    /// paging back, `around` to centre on a specific message — which is what makes
    /// "jump to pinned/replied/search-hit message" possible without paging back
    /// through everything.
    static func messages(
        conversationID: String,
        before: String? = nil,
        around: String? = nil,
        limit: Int = 50
    ) async throws -> MessagePage {
        try await api.send(
            .get, "/api/conversations/\(conversationID)/messages",
            query: ["before": before, "around": around, "limit": String(limit)],
            as: MessagePage.self
        )
    }

    /// HTTP send. The socket path is preferred for text (it round-trips `temp_id`),
    /// but attachments go through here because the upload already happened over HTTP.
    static func sendMessage(
        conversationID: String,
        content: String = "",
        type: String = "text",
        replyTo: String? = nil,
        tempID: String? = nil,
        mediaURL: String? = nil,
        mediaURLs: [String]? = nil,
        duration: Double? = nil,
        thumbnailURL: String? = nil,
        fileSize: Int? = nil,
        filename: String? = nil
    ) async throws -> Message {
        struct Body: Encodable {
            let content: String
            let type: String
            let reply_to: String?
            let temp_id: String?
            let media_url: String?
            let media_urls: [String]?
            let duration: Double?
            let thumbnail_url: String?
            let file_size: Int?
            let filename: String?
        }
        return try await api.send(
            .post, "/api/conversations/\(conversationID)/messages",
            body: Body(
                content: content, type: type, reply_to: replyTo, temp_id: tempID,
                media_url: mediaURL, media_urls: mediaURLs, duration: duration,
                thumbnail_url: thumbnailURL, file_size: fileSize, filename: filename
            ),
            as: Message.self
        )
    }

    /// In-conversation search. A POST with the query in the *query string* — not a
    /// body — which is unusual but is what the router declares.
    static func searchInConversation(conversationID: String, query: String) async throws -> InConversationSearch {
        try await api.send(
            .post, "/api/conversations/\(conversationID)/messages/search",
            query: ["q": query],
            as: InConversationSearch.self
        )
    }

    /// Toggle one emoji for me. Returns the message's full reaction list.
    static func react(messageID: String, emoji: String) async throws -> [Reaction] {
        struct Body: Encodable { let emoji: String }
        struct Response: Decodable { let reactions: [Reaction] }
        return try await api.send(
            .post, "/api/conversations/messages/\(messageID)/react",
            body: Body(emoji: emoji),
            as: Response.self
        ).reactions
    }

    /// Toggle my private star. Returns the new state.
    static func toggleStar(messageID: String) async throws -> Bool {
        struct Response: Decodable { let starred: Bool }
        return try await api.send(
            .post, "/api/conversations/messages/\(messageID)/star",
            as: Response.self
        ).starred
    }

    /// Toggle the conversation-wide pin. Returns the new state.
    static func togglePin(messageID: String) async throws -> Bool {
        struct Response: Decodable { let pinned: Bool }
        return try await api.send(
            .post, "/api/conversations/messages/\(messageID)/pin",
            as: Response.self
        ).pinned
    }

    /// Both of these answer `{"data": [...]}`, **not** `{"messages": [...]}` —
    /// `messages.py:list_starred_messages` / `list_pinned_messages` end
    /// `return {"data": data}`. Getting this wrong throws `APIError.decoding` on every
    /// call, which is how it was found.
    static func starredMessages(conversationID: String) async throws -> [Message] {
        struct Response: Decodable { let data: [Message] }
        return try await api.send(
            .get, "/api/conversations/\(conversationID)/starred",
            as: Response.self
        ).data
    }

    static func pinnedMessages(conversationID: String) async throws -> [Message] {
        struct Response: Decodable { let data: [Message] }
        return try await api.send(
            .get, "/api/conversations/\(conversationID)/pinned",
            as: Response.self
        ).data
    }

    /// Forward to conversations and/or straight to contacts (the server opens the
    /// direct conversation for a contact id).
    static func forward(
        messageID: String,
        conversationIDs: [String] = [],
        contactIDs: [String] = []
    ) async throws -> [String] {
        struct Body: Encodable {
            let message_id: String
            let conversation_ids: [String]
            let contact_ids: [String]
        }
        struct Response: Decodable { let forwarded_to: [String] }
        return try await api.send(
            .post, "/api/conversations/messages/forward",
            body: Body(message_id: messageID, conversation_ids: conversationIDs, contact_ids: contactIDs),
            as: Response.self
        ).forwarded_to
    }

    static func editMessage(messageID: String, content: String) async throws -> Message {
        struct Body: Encodable { let content: String }
        return try await api.send(
            .put, "/api/conversations/messages/\(messageID)",
            body: Body(content: content),
            as: Message.self
        )
    }

    /// Delivery/read detail. 403 unless it's your own message.
    static func messageInfo(messageID: String) async throws -> MessageInfo {
        try await api.send(.get, "/api/conversations/messages/\(messageID)/info", as: MessageInfo.self)
    }

    // MARK: - Groups

    static func createGroup(
        name: String,
        description: String? = nil,
        avatarURL: String? = nil,
        memberIDs: [String]
    ) async throws -> Conversation {
        struct Body: Encodable {
            let name: String
            let description: String?
            let avatar_url: String?
            let member_ids: [String]
        }
        return try await api.send(
            .post, "/api/conversations/group",
            body: Body(name: name, description: description, avatar_url: avatarURL, member_ids: memberIDs),
            as: Conversation.self
        )
    }

    static func updateGroup(
        conversationID: String,
        name: String? = nil,
        description: String? = nil,
        avatarURL: String? = nil,
        adminOnlyMessages: Bool? = nil
    ) async throws -> Conversation {
        struct Body: Encodable {
            let name: String?
            let description: String?
            let avatar_url: String?
            let admin_only_messages: Bool?
        }
        return try await api.send(
            .put, "/api/conversations/\(conversationID)/group",
            body: Body(
                name: name, description: description,
                avatar_url: avatarURL, admin_only_messages: adminOnlyMessages
            ),
            as: Conversation.self
        )
    }

    static func groupPermissions(conversationID: String) async throws -> GroupPermissions {
        try await api.send(.get, "/api/conversations/\(conversationID)/permissions", as: GroupPermissions.self)
    }

    /// PATCH semantics on a PUT: only the keys sent are applied.
    static func updateGroupPermissions(
        conversationID: String,
        editInfo: Bool? = nil,
        sendMessages: Bool? = nil,
        addMembers: Bool? = nil
    ) async throws -> GroupPermissions {
        struct Body: Encodable {
            let edit_info: Bool?
            let send_messages: Bool?
            let add_members: Bool?
        }
        return try await api.send(
            .put, "/api/conversations/\(conversationID)/permissions",
            body: Body(edit_info: editInfo, send_messages: sendMessages, add_members: addMembers),
            as: GroupPermissions.self
        )
    }

    static func addMembers(conversationID: String, userIDs: [String]) async throws {
        struct Body: Encodable { let user_ids: [String] }
        _ = try await api.sendIgnoringResponse(
            .post, "/api/conversations/\(conversationID)/members",
            body: Body(user_ids: userIDs)
        )
    }

    static func removeMember(conversationID: String, memberID: String) async throws {
        _ = try await api.sendIgnoringResponse(
            .delete, "/api/conversations/\(conversationID)/members/\(memberID)"
        )
    }

    /// role is "admin" or "member" (`ParticipantRole` minus `creator`, which is
    /// not assignable).
    static func changeMemberRole(conversationID: String, memberID: String, role: String) async throws {
        struct Body: Encodable { let role: String }
        _ = try await api.sendIgnoringResponse(
            .put, "/api/conversations/\(conversationID)/members/\(memberID)/role",
            body: Body(role: role)
        )
    }

    static func leaveGroup(conversationID: String) async throws {
        _ = try await api.sendIgnoringResponse(.post, "/api/conversations/\(conversationID)/leave")
    }

    // MARK: - Contacts & directory

    /// Everyone active in my org except me, name-ascending.
    static func contacts(search: String = "") async throws -> [Contact] {
        try await api.send(.get, "/api/users/contacts", query: ["search": search], as: [Contact].self)
    }

    /// `contacts.py:groups_in_common` answers `{"data": [...]}` — not `{"groups": …}`
    /// and not a bare list. Both of those were tried here before and both threw.
    static func groupsInCommon(userID: String) async throws -> [Conversation] {
        struct Response: Decodable { let data: [Conversation] }
        return try await api.send(
            .get, "/api/users/\(userID)/groups-in-common",
            as: Response.self
        ).data
    }

    /// Update my own profile.
    static func updateProfile(
        displayName: String? = nil,
        about: String? = nil,
        avatarURL: String? = nil
    ) async throws -> CurrentUser {
        struct Body: Encodable {
            let display_name: String?
            let about: String?
            let avatar_url: String?
        }
        return try await api.send(
            .put, "/api/users/profile",
            body: Body(display_name: displayName, about: about, avatar_url: avatarURL),
            as: CurrentUser.self
        )
    }

    // MARK: - Search

    /// Global search. `types` is a comma-joined subset of
    /// conversations,contacts,messages — all three buckets always come back.
    static func globalSearch(
        query: String,
        types: [String] = ["conversations", "contacts", "messages"]
    ) async throws -> GlobalSearchResults {
        try await api.send(
            .get, "/api/search",
            query: ["q": query, "types": types.joined(separator: ",")],
            as: GlobalSearchResults.self
        )
    }

    // MARK: - Media

    /// Upload one file, then send a message referencing the returned `file_url`.
    ///
    /// Two-step by design: `/api/upload` stages the bytes and returns an `Upload`
    /// row, and the message send claims it. The server derives Content-Type from
    /// the file *extension* and ignores what the client claims, so `filename` must
    /// carry a real extension or the upload is rejected as an unsupported type.
    static func upload(data: Data, filename: String, mimeType: String) async throws -> UploadResult {
        try await api.upload(
            "/api/upload",
            parts: [MultipartPart(name: "file", filename: filename, mimeType: mimeType, data: data)],
            as: UploadResult.self
        )
    }

    /// Media/links/docs gallery. `type` is image | video | audio | file | link.
    static func conversationMedia(
        conversationID: String,
        type: String,
        page: Int = 1,
        limit: Int = 30
    ) async throws -> MediaPage {
        try await api.send(
            .get, "/api/conversations/\(conversationID)/media",
            query: ["type": type, "page": String(page), "limit": String(limit)],
            as: MediaPage.self
        )
    }

    /// Bytes for an attachment. Cookie-authenticated — these are not public URLs.
    static func attachmentData(path: String) async throws -> Data {
        try await api.data(forPath: path)
    }

    // MARK: - Calls

    static func callHistory(page: Int = 1, limit: Int = 20, filter: String = "all") async throws -> Paginated<CallHistoryEntry> {
        try await api.send(
            .get, "/api/calls/history",
            query: ["page": String(page), "limit": String(limit), "filter": filter],
            as: Paginated<CallHistoryEntry>.self
        )
    }

    static func missedCallCount() async throws -> Int {
        struct Response: Decodable { let count: Int }
        return try await api.send(.get, "/api/calls/missed-count", as: Response.self).count
    }

    static func markCallsSeen() async throws {
        _ = try await api.sendIgnoringResponse(.post, "/api/calls/mark-seen")
    }

    /// LiveKit join credentials for a call I'm a participant of.
    static func callToken(callID: String) async throws -> CallToken {
        try await api.send(.post, "/api/calls/\(callID)/token", as: CallToken.self)
    }

    static func createCallLink(callType: String = "video") async throws -> CallLinkInfo {
        struct Body: Encodable { let call_type: String }
        return try await api.send(
            .post, "/api/calls/create-link",
            body: Body(call_type: callType),
            as: CallLinkInfo.self
        )
    }

    static func resolveCallLink(code: String) async throws -> CallLinkInfo {
        try await api.send(.get, "/api/calls/link/\(code)", as: CallLinkInfo.self)
    }

    static func scheduledCalls() async throws -> [ScheduledCallInfo] {
        struct Response: Decodable { let data: [ScheduledCallInfo] }
        if let envelope = try? await api.send(.get, "/api/calls/scheduled", as: Response.self) {
            return envelope.data
        }
        return try await api.send(.get, "/api/calls/scheduled", as: [ScheduledCallInfo].self)
    }

    /// Report that a call ended. Used on the way out of a call so a dropped socket
    /// doesn't leave it "connected" forever.
    static func reportCallEnded(callID: String, userID: String) async throws {
        struct Body: Encodable {
            let call_id: String
            let user_id: String
        }
        _ = try await api.sendIgnoringResponse(
            .post, "/api/calls/ended",
            body: Body(call_id: callID, user_id: userID)
        )
    }

    // MARK: - Notifications

    static func notifications() async throws -> [AppNotification] {
        struct Response: Decodable { let data: [AppNotification] }
        if let envelope = try? await api.send(.get, "/api/notifications", as: Response.self) {
            return envelope.data
        }
        return try await api.send(.get, "/api/notifications", as: [AppNotification].self)
    }

    static func markAllNotificationsRead() async throws {
        _ = try await api.sendIgnoringResponse(.post, "/api/notifications/read-all")
    }

    // MARK: - Org admin (org_admin role only)

    static func orgStats() async throws -> OrgStats {
        try await api.send(.get, "/api/org-admin/stats", as: OrgStats.self)
    }

    static func orgUsers(
        search: String = "",
        deptID: String? = nil,
        page: Int = 1,
        limit: Int = 20
    ) async throws -> Paginated<AdminUser> {
        try await api.send(
            .get, "/api/org-admin/users",
            query: ["search": search, "dept_id": deptID, "page": String(page), "limit": String(limit)],
            as: Paginated<AdminUser>.self
        )
    }

    /// A **bare array**, unlike every other admin list.
    ///
    /// `org_admin.py:list_departments` returns
    /// `[{...department, "member_count": n}]` with no `{data,total,…}` envelope, so this
    /// does not go through `Paginated`. It previously declared the envelope and threw
    /// `APIError.decoding` on every call.
    static func orgDepartments() async throws -> [AdminDepartment] {
        try await api.send(.get, "/api/org-admin/departments", as: [AdminDepartment].self)
    }

    static func orgUpdateUser(
        userID: String,
        displayName: String? = nil,
        deptID: String? = nil,
        role: String? = nil,
        isActive: Bool? = nil
    ) async throws -> AdminUser {
        struct Body: Encodable {
            let display_name: String?
            let dept_id: String?
            let role: String?
            let is_active: Bool?
        }
        return try await api.send(
            .put, "/api/org-admin/users/\(userID)",
            body: Body(display_name: displayName, dept_id: deptID, role: role, is_active: isActive),
            as: AdminUser.self
        )
    }

    static func orgResetPassword(userID: String) async throws -> String {
        struct Response: Decodable { let temporary_password: String }
        return try await api.send(
            .post, "/api/org-admin/users/\(userID)/reset-password",
            as: Response.self
        ).temporary_password
    }
}
