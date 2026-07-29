import Foundation

enum CallType: String, Codable, Hashable {
    case voice, video, unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CallType(rawValue: raw) ?? .unknown
    }
}

/// `db/models.py:CallStatus`.
enum CallStatus: String, Codable, Hashable {
    case ringing, connected, answered, missed, declined, cancelled, busy
    case noAnswer = "no_answer"
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = CallStatus(rawValue: raw) ?? .unknown
    }

    /// Statuses that mean the call never connected — shown in red in history.
    var isMissedOrRejected: Bool {
        switch self {
        case .missed, .declined, .cancelled, .busy, .noAnswer: return true
        default: return false
        }
    }
}

/// The person on the other end of a call signal (`services/calls.py:_brief`).
///
/// Note the key is `id` here, unlike `UserBrief`'s `user_id` — the call service
/// has its own brief shape. Two structs rather than one lenient one, so a rename
/// on either side fails loudly instead of silently decoding to nil.
struct CallParticipantBrief: Codable, Identifiable, Hashable {
    let id: String
    let displayName: String
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case id
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}

/// One `call:*` frame's payload.
///
/// The backend's call frames are not uniform — `call:incoming` carries `caller`
/// and `call_type`, `call:accepted` carries `accepter_id` and `duration`,
/// `call:participant_joined` carries `participant`, and so on. Rather than a
/// struct per frame (20+ of them, most differing by one key), this is the union,
/// with everything optional. Each key below was read off an actual publish site
/// in `services/calls.py` / `api/calls.py`.
struct CallSignal: Codable, Hashable {
    let callID: String?
    let callType: CallType?
    let caller: CallParticipantBrief?
    let conversationID: String?
    let calleeID: String?
    let isGroup: Bool?
    let groupName: String?
    /// Present on `call:accepted` / `call:ended`.
    let accepterID: String?
    let duration: Double?
    let reason: String?
    /// `call:error`, `call:full`, `call:unavailable` explain themselves here.
    let message: String?
    /// `call:group_active` / `call:group_participants`.
    let participants: [CallParticipantBrief]?
    /// `call:participant_joined`.
    let participant: CallParticipantBrief?
    /// `call:participant_left`.
    let participantID: String?

    enum CodingKeys: String, CodingKey {
        case callID = "call_id"
        case callType = "call_type"
        case caller
        case conversationID = "conversation_id"
        case calleeID = "callee_id"
        case isGroup = "is_group"
        case groupName = "group_name"
        case accepterID = "accepter_id"
        case duration, reason, message, participants, participant
        case participantID = "participant_id"
    }
}

/// `POST /api/calls/{call_id}/token` — everything needed to join the LiveKit room.
struct CallToken: Codable {
    let token: String
    /// The SFU's URL as the *server* knows it. May be a browser-relative path like
    /// `/livekit` in a Caddy deployment, which a native client cannot use — see
    /// `CallService.resolveSFUURL` for how that is handled.
    let url: String?
    let room: String
}

/// A user inside a call-history row (`services/calls.py:serialize_call`).
///
/// Keyed `user_id`, unlike `CallParticipantBrief`'s `id` — the same service uses
/// both shapes depending on the endpoint, so both exist here rather than one
/// being coerced into the other.
struct CallHistoryPerson: Codable, Identifiable, Hashable {
    let userId: String
    let displayName: String
    let avatarURL: String?

    var id: String { userId }

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}

/// A row in `GET /api/calls/history` (`services/calls.py:serialize_call`).
///
/// The server does the work the UI would otherwise have to: `direction` and
/// `otherParticipant` are computed per-requester, so a history row renders without
/// the client knowing who it is.
struct CallHistoryEntry: Codable, Identifiable, Hashable {
    let id: String
    /// Duplicate of `id` in the payload; both are sent by the contract.
    let callID: String
    let callType: CallType
    let isGroup: Bool
    let status: CallStatus
    let conversationID: String?
    let initiator: CallHistoryPerson?
    let participants: [CallHistoryPerson]
    let startedAt: Date?
    let answeredAt: Date?
    let endedAt: Date?
    /// Seconds, server-computed.
    let duration: Double?
    let orgID: String?
    let createdAt: Date?
    /// User ids that have dismissed the missed-call badge for this call.
    let seenBy: [String]
    /// "outgoing" | "incoming", relative to the requesting user.
    let direction: String
    /// The first participant that isn't the requester — nil for a call with no
    /// other party recorded.
    let otherParticipant: CallHistoryPerson?

    var isOutgoing: Bool { direction == "outgoing" }

    enum CodingKeys: String, CodingKey {
        case id = "_id"
        case callID = "call_id"
        case callType = "call_type"
        case isGroup = "is_group"
        case status
        case conversationID = "conversation_id"
        case initiator, participants
        case startedAt = "started_at"
        case answeredAt = "answered_at"
        case endedAt = "ended_at"
        case duration
        case orgID = "org_id"
        case createdAt = "created_at"
        case seenBy = "seen_by"
        case direction
        case otherParticipant = "other_participant"
    }
}
