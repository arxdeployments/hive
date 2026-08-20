import Foundation

// MARK: - Enums
//
// Raw values are the exact strings the API sends (`db/models.py`). Every one of
// these decodes leniently via `unknown`: a server that gains a new message type
// or call status must not make an entire conversation undecodable on an app
// version that predates it.

enum UserRoleWire: String, Codable, Hashable {
    /// Web-only. Present for completeness — a superadmin can never reach this app
    /// (`api/auth.py:_assert_mobile_allowed`), so seeing it means a bug.
    case superadmin
    /// NB: the wire value is "admin", not "org_admin" — `auth.py:wire_role`
    /// translates the DB enum for the client contract.
    case admin
    case member
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = UserRoleWire(rawValue: raw) ?? .unknown
    }
}

enum ConversationType: String, Codable, Hashable {
    case direct, group, crossOrg = "cross_org", unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ConversationType(rawValue: raw) ?? .unknown
    }

    var isGroup: Bool { self == .group || self == .crossOrg }
}

enum ParticipantRole: String, Codable, Hashable {
    case creator, admin, member, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ParticipantRole(rawValue: raw) ?? .unknown
    }

    /// Creator and admin both get group-admin powers.
    var canAdminister: Bool { self == .creator || self == .admin }
}

enum MessageType: String, Codable, Hashable {
    case text, image, video, audio, file, system, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MessageType(rawValue: raw) ?? .unknown
    }
}

enum PresenceStatus: String, Codable, Hashable {
    case online, offline, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = PresenceStatus(rawValue: raw) ?? .unknown
    }
}

// MARK: - Identity

/// The signed-in user, as returned by `POST /api/auth/login` (inside `user`) and
/// `GET /api/auth/me` (at the top level).
///
/// The two payloads differ: `_user_payload` is the common core, and `/me` adds
/// avatar/about/status/last_seen/mobile_access for non-superadmins. Everything
/// beyond the core is therefore optional here — one struct for both shapes, with
/// optionality that mirrors exactly which fields the server may omit.
/// `Decodable`, not `Codable`: this is only ever read from the server, and the
/// `display_name` alias below is a `CodingKeys` case with no matching stored property,
/// which makes an `Encodable` conformance impossible to synthesise. Adding one back
/// would mean hand-writing `encode(to:)` for a type nothing encodes.
struct CurrentUser: Decodable, Identifiable, Hashable {
    let id: String
    let email: String
    /// The API sends `name`, not `display_name`, on this payload only.
    let name: String
    let role: UserRoleWire
    /// Absent for superadmins (`_user_payload` omits org/dept for them).
    let orgId: String?
    let deptId: String?

    // /me only.
    let avatarURL: String?
    let about: String?
    let status: PresenceStatus?
    let lastSeen: Date?
    /// Added for the native client: whether the superadmin granted mobile access.
    /// Always true in practice once signed in — the login gate refuses otherwise —
    /// but read so the app can react if it is revoked mid-session.
    let mobileAccess: Bool?

    /// Org name and department name, when the payload carries them. `/me` and
    /// `/login` do not; `PUT /api/users/profile` does.
    let orgName: String?
    let deptName: String?

    var isOrgAdmin: Bool { role == .admin }

    enum CodingKeys: String, CodingKey {
        case id, email, name, role
        case displayName = "display_name"
        case orgId = "org_id"
        case deptId = "dept_id"
        case avatarURL = "avatar_url"
        case about, status
        case lastSeen = "last_seen"
        case mobileAccess = "mobile_access"
        case orgName = "org_name"
        case deptName = "dept_name"
    }

    /// Custom because **the backend spells this user's name two different ways.**
    ///
    /// `/api/auth/me` and `/api/auth/login` send `name`; `PUT /api/users/profile`
    /// returns the same user as `display_name` (`search.py:update_profile`). With a
    /// synthesised decoder the profile write landed on the server and *then* threw
    /// `APIError.decoding` on the way back, so a successful save looked like a failure.
    /// Either key satisfies `name` here, which is why `ProfileEditView` can treat this
    /// response as the plain success it is.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = try c.decode(String.self, forKey: .email)
        if let name = try c.decodeIfPresent(String.self, forKey: .name) {
            self.name = name
        } else {
            name = try c.decode(String.self, forKey: .displayName)
        }
        role = try c.decode(UserRoleWire.self, forKey: .role)
        orgId = try c.decodeIfPresent(String.self, forKey: .orgId)
        deptId = try c.decodeIfPresent(String.self, forKey: .deptId)
        avatarURL = try c.decodeIfPresent(String.self, forKey: .avatarURL)
        about = try c.decodeIfPresent(String.self, forKey: .about)
        status = try c.decodeIfPresent(PresenceStatus.self, forKey: .status)
        lastSeen = try c.decodeIfPresent(Date.self, forKey: .lastSeen)
        mobileAccess = try c.decodeIfPresent(Bool.self, forKey: .mobileAccess)
        orgName = try c.decodeIfPresent(String.self, forKey: .orgName)
        deptName = try c.decodeIfPresent(String.self, forKey: .deptName)
    }
}

/// A user as embedded in a conversation's participant list
/// (`enrich.serialize_user_brief`). Note the key is `user_id`, not `_id`.
struct UserBrief: Codable, Identifiable, Hashable {
    let userId: String
    let displayName: String
    let avatarURL: String?
    let status: PresenceStatus
    let lastSeen: Date?
    /// Only non-zero for the requesting user's own participant row.
    let unreadCount: Int?
    let role: ParticipantRole?
    /// Groups only.
    let joinedAt: Date?

    var id: String { userId }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
        case status
        case lastSeen = "last_seen"
        case unreadCount = "unread_count"
        case role
        case joinedAt = "joined_at"
    }
}

// MARK: - Conversations

/// `enrich.serialize_conversation`.
struct Conversation: Codable, Identifiable, Hashable {
    var id: String
    var type: ConversationType
    var orgId: String?
    /// nil for direct chats — the title is derived from the other participant.
    var name: String?
    var avatarURL: String?
    var crossOrg: Bool
    var allowedOrgIds: [String]
    var createdBy: String?
    var createdAt: Date?
    var lastMessageAt: Date?
    var pinnedBy: [String]
    var isActive: Bool
    var participants: [UserBrief]
    var lastMessage: LastMessage?
    var unreadCount: Int
    var isPinned: Bool
    /// My position within my pinned block; nil = pinned but unordered.
    var pinOrder: Int?
    var isMuted: Bool

    // Groups only.
    var description: String?
    var adminOnlyMessages: Bool?
    // cross_org only.
    var purposeTag: String?

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case type
        case orgId = "org_id"
        case name
        case avatarURL = "avatar_url"
        case crossOrg = "cross_org"
        case allowedOrgIds = "allowed_org_ids"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case lastMessageAt = "last_message_at"
        case pinnedBy = "pinned_by"
        case isActive = "is_active"
        case participants
        case lastMessage = "last_message"
        case unreadCount = "unread_count"
        case isPinned = "is_pinned"
        case pinOrder = "pin_order"
        case isMuted = "is_muted"
        case description
        case adminOnlyMessages = "admin_only_messages"
        case purposeTag = "purpose_tag"
    }
}

/// The conversation-list preview (`enrich.last_messages`). A reduced shape — not
/// a `Message`.
struct LastMessage: Codable, Hashable {
    let content: String
    let senderId: String?
    let senderName: String
    let createdAt: Date?
    let type: MessageType

    enum CodingKeys: String, CodingKey {
        case content
        case senderId = "sender_id"
        case senderName = "sender_name"
        case createdAt = "created_at"
        case type
    }
}

/// `enrich.serialize_permissions` — the group settings object.
///
/// ONE key. `send_messages` is `admin_only_messages` inverted, and the message
/// routes honour it. The backend deliberately does not expose `send_history` /
/// `invite_via_link` / `approve_new_members` because no read path enforces them,
/// and `edit_info` / `add_members` have now joined them for the same reason:
/// nothing read `perm_edit_info` or `perm_add_members`, because `PUT /{id}/group`
/// and `POST /{id}/members` gate on group-admin role alone. Showing a toggle the
/// server ignores is worse than not having it.
///
/// `editInfo` and `addMembers` are kept as OPTIONALS rather than deleted, and that
/// is deliberate. They were non-optional with a synthesized decoder, so a payload
/// without them throws `keyNotFound` and takes the whole group panel down — the
/// same failure `MediaItem.id` caused before it was fixed. Optional means this
/// build decodes both the old wire and the new one, so the app and the server can
/// be deployed in either order. Nothing reads them; they exist to not crash.
struct GroupPermissions: Codable, Hashable {
    let editInfo: Bool?
    let addMembers: Bool?
    let sendMessages: Bool

    enum CodingKeys: String, CodingKey {
        case editInfo = "edit_info"
        case addMembers = "add_members"
        case sendMessages = "send_messages"
    }
}

// MARK: - Messages

/// `enrich.serialize_message`.
struct Message: Codable, Identifiable, Hashable {
    var id: String
    var conversationId: String
    var senderId: String?
    var type: MessageType
    /// Empty string when `isDeleted` — the server blanks tombstoned content.
    var content: String
    /// Id of the replied-to message.
    var replyTo: String?
    var reactions: [Reaction]
    var readBy: [ReadReceipt]
    var deliveredTo: [DeliveryReceipt]
    var isDeleted: Bool
    var isForwarded: Bool
    var isStarred: Bool
    var isPinned: Bool
    var createdAt: Date?
    var editedAt: Date?
    var senderName: String
    var senderAvatar: String?

    // Flattened first-attachment fields, kept from the legacy contract. Prefer
    // `attachments` for anything new; these exist because the server still sends
    // them and some responses populate only these.
    var mediaURL: String?
    var thumbnailURL: String?
    var fileSize: Int?
    var filename: String?
    var duration: Double?
    /// Mirrors `attachments[0].page_count` (`enrich.py` sets both).
    var pageCount: Int?
    var attachments: [Attachment]

    /// Present only when the message is a reply.
    var replyToMessage: ReplyPreview?

    var isEdited: Bool { editedAt != nil }

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case conversationId = "conversation_id"
        case senderId = "sender_id"
        case type, content
        case replyTo = "reply_to"
        case reactions
        case readBy = "read_by"
        case deliveredTo = "delivered_to"
        case isDeleted = "is_deleted"
        case isForwarded = "is_forwarded"
        case isStarred = "is_starred"
        case isPinned = "is_pinned"
        case createdAt = "created_at"
        case editedAt = "edited_at"
        case senderName = "sender_name"
        case senderAvatar = "sender_avatar"
        case mediaURL = "media_url"
        case thumbnailURL = "thumbnail_url"
        case fileSize = "file_size"
        case filename, duration, attachments
        case pageCount = "page_count"
        case replyToMessage = "reply_to_message"
    }
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: String
    /// Server-relative, e.g. `/api/media/<id>`. Requires the session cookie.
    let mediaURL: String
    let thumbnailURL: String?
    let filename: String
    let mimeType: String
    let fileSize: Int
    /// Seconds, for audio/video. Sent so a voice note can render its length
    /// without fetching the file.
    let duration: Double?
    /// PDF page count, from `pypdfium2` at upload time.
    ///
    /// **nil is meaningful and must not be coerced to 0** — it means "not a PDF, or
    /// uploaded before previews existed" (`db/models.py` says so explicitly). The
    /// bubble uses it to decide between the preview layout and the plain icon row,
    /// and the reader uses it as the page count to request. A 0 would make a real
    /// PDF render as an empty reader.
    let pageCount: Int?

    /// True when this is a PDF the server managed to rasterise, so a page-1 preview
    /// and a page-by-page reader are both available.
    var hasPDFPreview: Bool {
        mimeType == "application/pdf" && (pageCount ?? 0) > 0
            && !(thumbnailURL ?? "").isEmpty
    }

    /// `GET /api/media/{id}/page/{n}` — one rendered page, 1-indexed. The server
    /// renders in windows of 10 and caches each page back to object storage, so
    /// scrolling a long document does not re-render it.
    func pdfPagePath(_ page: Int) -> String {
        "\(mediaURL)/page/\(page)"
    }

    enum CodingKeys: String, CodingKey {
        case id
        case mediaURL = "media_url"
        case thumbnailURL = "thumbnail_url"
        case filename
        case mimeType = "mime_type"
        case fileSize = "file_size"
        case duration
        case pageCount = "page_count"
    }
}

/// The quoted message shown above a reply. A reduced shape, not a `Message`.
struct ReplyPreview: Codable, Hashable {
    let id: String
    let senderId: String?
    let senderName: String
    let content: String
    let type: MessageType
    let mediaURL: String?
    let isDeleted: Bool

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case senderId = "sender_id"
        case senderName = "sender_name"
        case content, type
        case mediaURL = "media_url"
        case isDeleted = "is_deleted"
    }
}

struct Reaction: Codable, Hashable, Identifiable {
    let userId: String
    let userName: String
    let emoji: String
    /// The react endpoint's inline shape omits this; the message shape includes it.
    let createdAt: Date?

    var id: String { "\(userId)-\(emoji)" }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case userName = "user_name"
        case emoji
        case createdAt = "created_at"
    }
}

struct ReadReceipt: Codable, Hashable {
    let userId: String
    let readAt: Date?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case readAt = "read_at"
    }
}

struct DeliveryReceipt: Codable, Hashable {
    let userId: String
    let deliveredAt: Date?

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case deliveredAt = "delivered_at"
    }
}

// MARK: - Envelopes

/// The admin/list envelope: `{data, total, page, limit}`.
///
/// `Decodable`, not `Codable`: this is a response envelope and is never sent. The
/// distinction is load-bearing — `AdminUser` and `AdminDepartment` are deliberately
/// `Decodable`-only (nothing writes an admin row from this app), so a `Codable`
/// constraint here would make `Paginated<AdminUser>` fail to satisfy it and break
/// the build at `RxHiveAPI.orgUsers` / `orgDepartments`.
struct Paginated<Item: Decodable>: Decodable {
    let data: [Item]
    let total: Int
    let page: Int?
    let limit: Int?
}

/// `{"message": "..."}` — the shape most mutations answer with.
struct MessageResponse: Codable {
    let message: String
}

/// `POST /api/auth/login` -> `{"user": {...}}`.
///
/// `Decodable` only, following `CurrentUser`.
struct LoginResponse: Decodable {
    let user: CurrentUser
}
