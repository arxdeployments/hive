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
    /// The room identity minted for this device: `{user_id}#{device_id}`.
    ///
    /// Not the bare user id, deliberately. A LiveKit identity must be unique per
    /// connection or the SFU evicts the earlier client as a duplicate — silently,
    /// which is why "the call connects and then one side goes quiet" produced no
    /// error anywhere. `LiveKitSession` splits it to correlate room participants
    /// with the user ids the socket talks about.
    let identity: String?
    /// How long the server will hold this call open while a participant's link is
    /// down. Echoed so the client's own retry budget can be sized against the
    /// server's policy rather than duplicating the number.
    let reconnectGraceSeconds: Double?

    enum CodingKeys: String, CodingKey {
        case token, url, room, identity
        case reconnectGraceSeconds = "reconnect_grace_seconds"
    }
}

/// `POST /api/calls/{call_id}/invite` — who was rung, and why anyone was not.
///
/// The per-invitee outcome is the point: a flat success for a partial result is how you
/// end up waiting for somebody the server never called. `outcome` is keyed by user id;
/// `invited` lists only the ones actually rung.
struct CallInviteResult: Codable, Hashable {
    let invited: [String]
    let outcome: [String: String]

    /// What to tell the user about one refusal. `nil` for `invited`, which is reported
    /// as a count rather than name by name.
    static func message(for outcome: String, who: String) -> String? {
        switch outcome {
        case "invited": return nil
        case "already_invited": return "\(who) is already on the call"
        case "unavailable": return "\(who) is unavailable"
        case "different_org": return "\(who) is outside your organisation"
        case "call_full": return "\(who) could not be added — the call is full"
        default: return "\(who) could not be added"
        }
    }
}

/// `GET /api/calls/active` and the `call:resume` frame
/// (`services/calls.active_call_state`).
///
/// The recovery path for every `call:*` frame lost while the socket was down. Those
/// are fire-and-forget publishes to a Redis channel: anything sent while this device
/// was reconnecting went to a channel with no subscriber and evaporated. A ring
/// delivered during a two-second Wi-Fi handover used to be gone for good — the
/// server rang on for the rest of its window while the phone showed nothing at all.
struct ActiveCallState: Codable, Hashable {
    let callID: String
    /// `ringing` | `connected`. Nothing else is ever live.
    let status: String
    let callType: CallType
    let isGroup: Bool
    let conversationID: String?
    let room: String
    let initiatedBy: String?
    let isInitiator: Bool
    let caller: CallParticipantBrief?
    let groupName: String?
    /// Everyone on the call row, joined or not.
    let participants: [CallParticipantBrief]
    /// Who has actually joined the room.
    let joined: [String]
    /// Whether *this* user has joined. The difference between resuming into a live
    /// room and being put back on the ringer — a callee who never accepted must not
    /// be dropped straight into a conversation.
    let selfJoined: Bool
    let startedAt: Date?
    let answeredAt: Date?
    /// Seconds of ring window left, so a resumed ringing screen counts down against
    /// the server's clock instead of restarting a timer of its own.
    let ringExpiresIn: Double?
    /// `{user_id: "up" | "down"}` — who is currently absent, so a resumed UI can
    /// show "Connecting…" for a peer that dropped while we were away.
    let peerLinks: [String: String]

    var isRinging: Bool { status == "ringing" }
    var isConnected: Bool { status == "connected" }

    /// The same call as a `CallSignal`, so a recovered call flows through exactly the
    /// code paths a live one does. One set of state transitions to reason about rather
    /// than a parallel "resumed call" path that drifts out of step with the real one.
    var asSignal: CallSignal {
        CallSignal(
            callID: callID,
            callType: callType,
            caller: caller,
            conversationID: conversationID,
            calleeID: nil,
            isGroup: isGroup,
            groupName: groupName,
            accepterID: nil,
            duration: nil,
            reason: nil,
            message: nil,
            participants: participants,
            participant: nil,
            participantID: nil
        )
    }

    enum CodingKeys: String, CodingKey {
        case callID = "call_id"
        case status
        case callType = "call_type"
        case isGroup = "is_group"
        case conversationID = "conversation_id"
        case room
        case initiatedBy = "initiated_by"
        case isInitiator = "is_initiator"
        case caller
        case groupName = "group_name"
        case participants, joined
        case selfJoined = "self_joined"
        case startedAt = "started_at"
        case answeredAt = "answered_at"
        case ringExpiresIn = "ring_expires_in"
        case peerLinks = "peer_links"
    }
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
