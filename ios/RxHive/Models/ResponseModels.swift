import Foundation

// MARK: - Pagination envelopes

/// `GET /api/conversations` -> `{data, has_more}`.
///
/// There is no cursor in the response: the `cursor` query param is an **ISO
/// timestamp**, parsed server-side with `fromisoformat` (`_parse_cursor`), so the
/// next page is requested with the `last_message_at` of the last row you got.
/// `nextCursor` computes that, so call sites don't have to know.
struct ConversationPage: Decodable {
    let data: [Conversation]
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case data
        case hasMore = "has_more"
    }

    /// Cursor for the following page, or nil when there is nothing more.
    var nextCursor: String? {
        guard hasMore, let last = data.last?.lastMessageAt else { return nil }
        return RxDate.format(last)
    }
}

/// `GET /api/conversations/{id}/messages` -> `{messages, has_more, has_newer, anchor_id}`.
///
/// Messages arrive oldest-first. `hasMore` = older exist, `hasNewer` = newer exist
/// (only ever true in `around` mode). `anchorID` is echoed so the client can tell
/// "your anchor resolved" from "it didn't, here's the newest window instead".
struct MessagePage: Decodable {
    let messages: [Message]
    let hasMore: Bool
    let hasNewer: Bool
    let anchorID: String?

    enum CodingKeys: String, CodingKey {
        case messages
        case hasMore = "has_more"
        case hasNewer = "has_newer"
        case anchorID = "anchor_id"
    }
}

// MARK: - Small mutation results

/// `PUT /api/conversations/{id}/pin`.
struct PinState: Decodable {
    let isPinned: Bool
    let pinOrder: Int?

    enum CodingKeys: String, CodingKey {
        case isPinned = "is_pinned"
        case pinOrder = "pin_order"
    }
}

/// `PUT /api/conversations/{id}/mute`.
struct MuteState: Decodable {
    let isMuted: Bool

    enum CodingKeys: String, CodingKey {
        case isMuted = "is_muted"
    }
}

// MARK: - Search

/// `POST /api/conversations/{id}/messages/search`.
struct InConversationSearch: Decodable {
    let matches: [Match]
    let total: Int

    struct Match: Decodable, Identifiable, Hashable {
        let messageID: String
        /// First 200 characters of the matching message.
        let contentSnippet: String
        let createdAt: Date?

        var id: String { messageID }

        enum CodingKeys: String, CodingKey {
            case messageID = "message_id"
            case contentSnippet = "content_snippet"
            case createdAt = "created_at"
        }
    }
}

/// `GET /api/search` — all three buckets are always present, max 5 hits each.
///
/// **Every bucket is a reduced shape, not a reusable model.** `search.py:global_search`
/// hand-builds its rows and shares none of them with the list endpoints: conversations
/// come back as `{id, name, type, avatar_url}` (no participants, no unread, and `id`
/// rather than `_id`), contacts as `{id, display_name, email, avatar_url, department}`
/// (`department`, not `department_name`), and message hits as
/// `{message_id, conversation_id, conversation_name, content_snippet, sender_name,
/// created_at}`. This model declared full `Conversation` / `Contact` values and
/// `_id`-keyed hits, so every search threw `APIError.decoding`. Do not "simplify" these
/// back to `Conversation` / `Contact` — the payload cannot populate them.
struct GlobalSearchResults: Decodable {
    let conversations: [ConversationHit]
    let contacts: [ContactHit]
    let messages: [MessageHit]

    struct ConversationHit: Decodable, Identifiable, Hashable {
        let id: String
        /// nil for a direct chat — the router leaves the partner's name to the client.
        let name: String?
        let type: ConversationType?
        let avatarURL: String?

        var isGroup: Bool { type?.isGroup == true }

        enum CodingKeys: String, CodingKey {
            case id, name, type
            case avatarURL = "avatar_url"
        }
    }

    struct ContactHit: Decodable, Identifiable, Hashable {
        let id: String
        let displayName: String
        let email: String?
        let avatarURL: String?
        /// Empty string when the user has no department — the router sends `""`, not null.
        let department: String?

        enum CodingKeys: String, CodingKey {
            case id, email, department
            case displayName = "display_name"
            case avatarURL = "avatar_url"
        }
    }

    /// Enough to render a row and jump to the message, but not a `Message`.
    struct MessageHit: Decodable, Identifiable, Hashable {
        let messageID: String
        let conversationID: String?
        let conversationName: String?
        /// First 200 characters of the match.
        let contentSnippet: String?
        let senderName: String?
        let createdAt: Date?

        var id: String { messageID }

        enum CodingKeys: String, CodingKey {
            case messageID = "message_id"
            case conversationID = "conversation_id"
            case conversationName = "conversation_name"
            case contentSnippet = "content_snippet"
            case senderName = "sender_name"
            case createdAt = "created_at"
        }
    }
}

// MARK: - Directory

/// `GET /api/users/contacts`. Keyed `id`, and carries `department_name` —
/// the org directory row.
struct Contact: Codable, Identifiable, Hashable {
    let id: String
    let displayName: String
    let email: String
    let avatarURL: String?
    let departmentName: String
    let status: PresenceStatus
    let lastSeen: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case email
        case avatarURL = "avatar_url"
        case departmentName = "department_name"
        case status
        case lastSeen = "last_seen"
    }
}

// MARK: - Message info

/// `GET /api/conversations/messages/{id}/info` — own messages only.
///
/// Receipts are derived from `last_read_at`, which is why delivered and read are
/// always the same set: the backend has no separate delivery signal. Rendering two
/// identical lists would look broken, so the UI shows "Read by" and "Pending".
struct MessageInfo: Decodable {
    let sentAt: Date?
    let deliveredTo: [Entry]
    let readBy: [Entry]
    let pending: [Entry]

    struct Entry: Decodable, Hashable, Identifiable {
        let userName: String
        let readAt: Date?
        let deliveredAt: Date?

        var id: String { userName }

        enum CodingKeys: String, CodingKey {
            case userName = "user_name"
            case readAt = "read_at"
            case deliveredAt = "delivered_at"
        }
    }

    enum CodingKeys: String, CodingKey {
        case sentAt = "sent_at"
        case deliveredTo = "delivered_to"
        case readBy = "read_by"
        case pending
    }
}

// MARK: - Media

/// `POST /api/upload`.
///
/// `fileURL` is a server-relative path (`/api/media/up/{id}`) that the send-message
/// call passes back as `media_url`. `thumbnailURL` is only present for images, and
/// deliberately falls back to the file itself when thumbnailing failed.
struct UploadResult: Decodable {
    let fileID: String
    let filename: String
    let fileURL: String
    /// image | video | audio | document
    let fileType: String
    let fileSize: Int
    let mimeType: String
    let thumbnailURL: String?

    enum CodingKeys: String, CodingKey {
        case fileID = "file_id"
        case filename
        case fileURL = "file_url"
        case fileType = "file_type"
        case fileSize = "file_size"
        case mimeType = "mime_type"
        case thumbnailURL = "thumbnail_url"
    }
}

/// `GET /api/conversations/{id}/media?type=…`.
struct MediaPage: Decodable {
    let data: [MediaItem]
    let total: Int
    let page: Int?
    let limit: Int?
}

/// One entry in the media / links / docs gallery. Link rows carry `url`; media
/// rows carry the attachment fields.
struct MediaItem: Decodable, Identifiable, Hashable {
    let id: String
    let messageID: String?
    let type: String?
    let mediaURL: String?
    let thumbnailURL: String?
    let filename: String?
    let mimeType: String?
    let fileSize: Int?
    let duration: Double?
    let createdAt: Date?
    let senderName: String?
    /// Links tab only.
    let url: String?
    let content: String?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case messageID = "message_id"
        case type
        case mediaURL = "media_url"
        case thumbnailURL = "thumbnail_url"
        case filename
        case mimeType = "mime_type"
        case fileSize = "file_size"
        case duration
        case createdAt = "created_at"
        case senderName = "sender_name"
        case url, content
    }
}

// MARK: - Calls

/// `POST /api/calls/create-link` and `GET /api/calls/link/{code}`.
struct CallLinkInfo: Decodable {
    let code: String
    /// Web-relative (`/call/{code}`) — meaningful to the web app, not to iOS.
    let url: String?
    let callType: String?

    enum CodingKeys: String, CodingKey {
        case code, url
        case callType = "call_type"
    }
}

struct ScheduledCallInfo: Decodable, Identifiable, Hashable {
    let id: String
    let title: String
    let description: String?
    let callType: CallType?
    let startTime: Date?
    let endTime: Date?
    let reminderMinutes: Int?
    let participantIDs: [String]?
    let status: String?
    let callLinkCode: String?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case title, description
        case callType = "call_type"
        case startTime = "start_time"
        case endTime = "end_time"
        case reminderMinutes = "reminder_minutes"
        case participantIDs = "participant_ids"
        case status
        case callLinkCode = "call_link_code"
    }
}

// MARK: - Notifications

struct AppNotification: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let isRead: Bool
    let createdAt: Date?
    /// Free-form JSONB on the server. Kept as text so a payload shape this build
    /// does not know cannot fail the whole list.
    let payloadDescription: String?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case type
        case isRead = "is_read"
        case createdAt = "created_at"
        case payload
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
        isRead = try c.decodeIfPresent(Bool.self, forKey: .isRead) ?? false
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt)
        if let nested = try? c.decode([String: String].self, forKey: .payload) {
            payloadDescription = nested["title"] ?? nested["body"] ?? nested.values.first
        } else {
            payloadDescription = nil
        }
    }
}

// MARK: - Org admin

/// `GET /api/org-admin/stats`. Every field optional: the endpoint's keys have
/// shifted between builds and a missing counter should blank one tile, not fail
/// the screen.
struct OrgStats: Decodable {
    let totalUsers: Int?
    /// `active_today` — the key the current backend actually sends
    /// (`org_admin.py:org_stats`), counting active users presence reports as online.
    /// Was missing entirely, so the server sent this number and the client dropped it.
    let activeToday: Int?
    let activeUsers: Int?
    let totalDepartments: Int?
    let onlineUsers: Int?
    let totalConversations: Int?
    let totalMessages: Int?

    enum CodingKeys: String, CodingKey {
        case totalUsers = "total_users"
        case activeToday = "active_today"
        case activeUsers = "active_users"
        case totalDepartments = "total_departments"
        case onlineUsers = "online_users"
        case totalConversations = "total_conversations"
        case totalMessages = "total_messages"
    }
}

/// A user row from either admin portal. `_id` keys, per the admin contract.
struct AdminUser: Decodable, Identifiable, Hashable {
    let id: String
    let orgID: String?
    let deptID: String?
    let email: String
    let displayName: String
    let avatarURL: String?
    let role: UserRoleWire
    let status: PresenceStatus?
    let lastSeen: Date?
    let about: String?
    let createdAt: Date?
    let isActive: Bool
    /// The mobile grant. Read-only in the org-admin portal — only a superadmin can
    /// change it, and the superadmin portal is web-only.
    let mobileAccess: Bool?
    let deptName: String?
    let orgName: String?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case orgID = "org_id"
        case deptID = "dept_id"
        case email
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case role, status
        case lastSeen = "last_seen"
        case about
        case createdAt = "created_at"
        case isActive = "is_active"
        case mobileAccess = "mobile_access"
        case deptName = "dept_name"
        case orgName = "org_name"
    }
}

struct AdminDepartment: Decodable, Identifiable, Hashable {
    let id: String
    let orgID: String?
    let name: String
    let description: String?
    let createdAt: Date?
    /// Active users in this department. Sent by `org_admin.py:list_departments`
    /// alongside the department row; optional because the create/update responses
    /// return the bare `_serialize_department` shape without it.
    let memberCount: Int?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case orgID = "org_id"
        case name, description
        case createdAt = "created_at"
        case memberCount = "member_count"
    }
}
