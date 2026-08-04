import Foundation

/// Frames the client sends. Names are the exact `type` strings
/// `realtime/hub.py:_handle_inbound` and `services/calls.py:handle_call_ws_message`
/// dispatch on.
enum OutboundFrame: Encodable {
    case ping
    /// Send a message over the socket. HTTP `POST .../messages` does the same
    /// thing; the socket path is used because it carries `temp_id` through to the
    /// `message_ack`, which is what reconciles an optimistic bubble.
    case message(conversationID: String, content: String, msgType: String, replyTo: String?, tempID: String, mediaURL: String?)
    case typingStart(conversationID: String)
    case typingStop(conversationID: String)
    case readReceipt(conversationID: String, lastReadMessageID: String?)

    // Calls
    case callInitiate(calleeID: String, callType: String, conversationID: String?)
    case callGroupInitiate(conversationID: String, callType: String)
    case callAccept(callID: String)
    case callDecline(callID: String)
    case callCancel(callID: String)
    case callEnd(callID: String)
    case callJoin(callID: String)
    case callLeave(callID: String)
    case callToggleMedia(callID: String, mediaType: String, enabled: Bool)
    /// Tell the other participants how OUR media link is doing.
    ///
    /// The SFU reports connection quality to the affected participant only, and says
    /// nothing at all to the others about a peer reconnecting. Without this frame a
    /// user whose network was failing looked completely healthy from the other side —
    /// a frozen picture and a running duration timer with no explanation — so only
    /// one of the two people in the call could tell what was happening.
    /// Relayed by `services/calls._relay_peer_state` as `call:peer_state`.
    case callLinkState(callID: String, state: String?, quality: String?)

    private enum CodingKeys: String, CodingKey {
        case type
        case conversationID = "conversation_id"
        case content
        case msgType = "msg_type"
        case replyTo = "reply_to"
        case tempID = "temp_id"
        case mediaURL = "media_url"
        case lastReadMessageID = "last_read_message_id"
        case calleeID = "callee_id"
        case callType = "call_type"
        case callID = "call_id"
        case mediaType = "media_type"
        case enabled
        case state
        case quality
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ping:
            try c.encode("ping", forKey: .type)

        case let .message(conversationID, content, msgType, replyTo, tempID, mediaURL):
            try c.encode("message", forKey: .type)
            try c.encode(conversationID, forKey: .conversationID)
            try c.encode(content, forKey: .content)
            try c.encode(msgType, forKey: .msgType)
            try c.encodeIfPresent(replyTo, forKey: .replyTo)
            try c.encode(tempID, forKey: .tempID)
            try c.encodeIfPresent(mediaURL, forKey: .mediaURL)

        case .typingStart(let id):
            try c.encode("typing_start", forKey: .type)
            try c.encode(id, forKey: .conversationID)

        case .typingStop(let id):
            try c.encode("typing_stop", forKey: .type)
            try c.encode(id, forKey: .conversationID)

        case let .readReceipt(conversationID, lastReadMessageID):
            try c.encode("read_receipt", forKey: .type)
            try c.encode(conversationID, forKey: .conversationID)
            try c.encodeIfPresent(lastReadMessageID, forKey: .lastReadMessageID)

        case let .callInitiate(calleeID, callType, conversationID):
            try c.encode("call:initiate", forKey: .type)
            try c.encode(calleeID, forKey: .calleeID)
            try c.encode(callType, forKey: .callType)
            try c.encodeIfPresent(conversationID, forKey: .conversationID)

        case let .callGroupInitiate(conversationID, callType):
            try c.encode("call:group_initiate", forKey: .type)
            try c.encode(conversationID, forKey: .conversationID)
            try c.encode(callType, forKey: .callType)

        case .callAccept(let id):   try c.encode("call:accept", forKey: .type);   try c.encode(id, forKey: .callID)
        case .callDecline(let id):  try c.encode("call:decline", forKey: .type);  try c.encode(id, forKey: .callID)
        case .callCancel(let id):   try c.encode("call:cancel", forKey: .type);   try c.encode(id, forKey: .callID)
        case .callEnd(let id):      try c.encode("call:end", forKey: .type);      try c.encode(id, forKey: .callID)
        case .callJoin(let id):     try c.encode("call:join", forKey: .type);     try c.encode(id, forKey: .callID)
        case .callLeave(let id):    try c.encode("call:leave", forKey: .type);    try c.encode(id, forKey: .callID)

        case let .callToggleMedia(callID, mediaType, enabled):
            try c.encode("call:toggle_media", forKey: .type)
            try c.encode(callID, forKey: .callID)
            try c.encode(mediaType, forKey: .mediaType)
            try c.encode(enabled, forKey: .enabled)

        case let .callLinkState(callID, state, quality):
            try c.encode("call:link_state", forKey: .type)
            try c.encode(callID, forKey: .callID)
            try c.encodeIfPresent(state, forKey: .state)
            try c.encodeIfPresent(quality, forKey: .quality)
        }
    }
}

/// A frame from the server.
///
/// Decoded in two steps — the `type` string first, then the payload — because the
/// event set is open: the server has 40+ types and gains more. An unrecognised
/// type becomes `.unknown` and is ignored, never a decode failure that kills the
/// socket's read loop.
struct InboundFrame {
    let type: String
    let json: [String: Any]

    init?(text: String) {
        guard
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String
        else { return nil }
        self.type = type
        self.json = object
        self.raw = data
    }

    /// Kept so a payload can be re-decoded into a real Codable model
    /// (`new_message` carries a full serialized message, for instance).
    let raw: Data

    // MARK: Typed accessors

    func string(_ key: String) -> String? { json[key] as? String }
    func bool(_ key: String) -> Bool? { json[key] as? Bool }
    func int(_ key: String) -> Int? { json[key] as? Int }
    func date(_ key: String) -> Date? { (json[key] as? String).flatMap(RxDate.parse) }

    /// Decode a nested object under `key` into a model.
    func decode<T: Decodable>(_ type: T.Type, at key: String, using decoder: JSONDecoder) -> T? {
        guard
            let nested = json[key],
            let data = try? JSONSerialization.data(withJSONObject: nested)
        else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    /// Decode the whole frame into a model (for frames that ARE the object).
    func decodeSelf<T: Decodable>(_ type: T.Type, using decoder: JSONDecoder) -> T? {
        try? decoder.decode(T.self, from: raw)
    }
}

/// The event vocabulary, as the app consumes it.
///
/// Every case corresponds to a `"type"` the backend publishes — grepped from
/// `services/` and `realtime/` so nothing is invented and nothing is missed.
enum RealtimeEvent {
    // Session
    case connected(userID: String)
    case pong
    /// `error` frames carry `detail`, and `temp_id` when a send failed — that is
    /// how an optimistic bubble learns to show as failed rather than hang.
    case error(detail: String, tempID: String?)

    // Messaging
    case newMessage(Message)
    case messageAck(tempID: String?, messageID: String, createdAt: Date?, status: String)
    case messageStatus(messageID: String?, status: String?)
    case messagesRead(conversationID: String?, userID: String?, readAt: Date?)
    /// A patch, not a whole message: the server publishes only the fields that
    /// changed (`services/messaging.py:edit_message`), so the client edits the
    /// bubble it already has rather than replacing it.
    case messageEdited(messageID: String, conversationID: String?, content: String, editedAt: Date?)
    case reactionUpdate(messageID: String?, conversationID: String?, reactions: [Reaction])
    case messagePinUpdate(messageID: String?, conversationID: String?, isPinned: Bool)
    case typing(conversationID: String, userID: String, userName: String?, isTyping: Bool)
    case presence(userID: String, status: PresenceStatus, lastSeen: Date?)

    // Conversations & membership
    case conversationCreated(Conversation?)
    case conversationUpdated(conversationID: String?)
    /// Carries `pin_order` as well as the flag, so the client can reproduce the
    /// server's ordering of the pinned block instead of guessing.
    case conversationPinUpdate(conversationID: String?, isPinned: Bool, pinOrder: Int?)
    case permissionsUpdated(conversationID: String?, permissions: GroupPermissions?)
    case memberAdded(conversationID: String?, userID: String?)
    case memberRemoved(conversationID: String?, userID: String?)
    case memberLeft(conversationID: String?, userID: String?)
    case roleChanged(conversationID: String?, userID: String?, role: ParticipantRole?)
    case removedFromConversation(conversationID: String?)
    case profileUpdated(userID: String?)
    case crossOrg

    // Calls
    case callIncoming(CallSignal)
    case callAccepted(CallSignal)
    case callDeclined(CallSignal)
    case callCancelled(CallSignal)
    case callEnded(CallSignal)
    case callBusy(CallSignal)
    case callMissed(CallSignal)
    case callUnavailable(CallSignal)
    case callFull(CallSignal)
    case callError(detail: String)
    case callRingingStarted(CallSignal)
    case callParticipantJoined(CallSignal)
    case callParticipantLeft(CallSignal)
    case callMediaToggle(callID: String?, userID: String?, mediaType: String?, enabled: Bool)
    /// A peer told us about ITS OWN link — `reconnecting`/`connected`, and/or a
    /// quality grade. The only channel by which this device can learn the other
    /// side is struggling; see `OutboundFrame.callLinkState`.
    case callPeerState(callID: String?, userID: String?, state: String?, quality: String?)
    /// The server's full picture of a call, sent on (re)connect. Everything this
    /// client may have missed while its socket was down, in one frame — the
    /// `call:*` events themselves are fire-and-forget publishes and are simply gone.
    case callResume(ActiveCallState?)
    case callGroupStarted(CallSignal)
    case callGroupEnded(CallSignal)
    case callGroupActive(CallSignal)
    case callGroupAlreadyActive(CallSignal)
    case callGroupParticipants(CallSignal)
    /// Somebody in the call added people. Carries the briefs of the invitees, so the
    /// grid can show them ringing rather than having them appear from nowhere when
    /// they answer — and so an invite nobody answers leaves visible evidence.
    case callParticipantsInvited(CallSignal)
    /// An invitee said no. Group calls only: a declined 1:1 is `call:declined`, which
    /// ends the call, whereas one person refusing a group call must leave it running.
    case callParticipantDeclined(CallSignal)

    /// A type this build does not know. Kept as a case so it can be logged rather
    /// than silently dropped, which is how a protocol addition goes unnoticed.
    case unknown(type: String)
}
