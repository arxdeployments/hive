import Foundation

// Copy-and-mutate helpers.
//
// `Message` and `Conversation` are wire DTOs with `var` properties, so these are
// thin `var copy = self` wrappers rather than 20-argument initialisers. They exist
// as named methods anyway because the call sites in `ChatStore` read as intent
// ("applying(isPinned:)") instead of as field surgery, and because that keeps the
// set of fields the client is allowed to locally override small and greppable.

extension Message {

    func applying(reactions: [Reaction]) -> Message {
        var copy = self
        copy.reactions = reactions
        return copy
    }

    func applying(isStarred: Bool) -> Message {
        var copy = self
        copy.isStarred = isStarred
        return copy
    }

    func applying(isPinned: Bool) -> Message {
        var copy = self
        copy.isPinned = isPinned
        return copy
    }

    func applying(content: String, editedAt: Date?) -> Message {
        var copy = self
        copy.content = content
        copy.editedAt = editedAt
        return copy
    }

    func applying(readBy: [ReadReceipt], deliveredTo: [DeliveryReceipt]) -> Message {
        var copy = self
        copy.readBy = readBy
        copy.deliveredTo = deliveredTo
        return copy
    }

    /// Re-key an optimistic placeholder to its real server id once acked.
    func applying(id: String, createdAt: Date?) -> Message {
        var copy = self
        copy.id = id
        copy.createdAt = createdAt
        return copy
    }

    /// True when this is a local placeholder that the server has not confirmed.
    var isOptimistic: Bool { id.hasPrefix("temp-") }

    /// A locally-created message shown immediately, before the server confirms it.
    ///
    /// Fields the server owns are left empty rather than guessed: no receipts, no
    /// reactions, not starred, not pinned. Guessing them would make the bubble
    /// change appearance when the real message replaces it, which reads as a bug.
    static func optimistic(
        id: String,
        conversationID: String,
        senderID: String,
        senderName: String,
        senderAvatar: String?,
        content: String,
        type: String,
        replyTo: String?,
        mediaURL: String?,
        duration: Double?,
        filename: String?,
        fileSize: Int?
    ) -> Message {
        Message(
            id: id,
            conversationId: conversationID,
            senderId: senderID,
            type: MessageType(rawValue: type) ?? .text,
            content: content,
            replyTo: replyTo,
            reactions: [],
            readBy: [],
            deliveredTo: [],
            isDeleted: false,
            isForwarded: false,
            isStarred: false,
            isPinned: false,
            createdAt: Date(),
            editedAt: nil,
            senderName: senderName,
            senderAvatar: senderAvatar,
            mediaURL: mediaURL,
            thumbnailURL: nil,
            fileSize: fileSize,
            filename: filename,
            duration: duration,
            attachments: [],
            replyToMessage: nil
        )
    }
}

extension Conversation {

    func applying(unreadCount: Int) -> Conversation {
        var copy = self
        copy.unreadCount = max(0, unreadCount)
        return copy
    }

    func applying(isMuted: Bool) -> Conversation {
        var copy = self
        copy.isMuted = isMuted
        return copy
    }

    func applying(isPinned: Bool, pinOrder: Int?) -> Conversation {
        var copy = self
        copy.isPinned = isPinned
        copy.pinOrder = pinOrder
        return copy
    }

    func applying(lastMessageAt: Date, lastMessage: LastMessage) -> Conversation {
        var copy = self
        copy.lastMessageAt = lastMessageAt
        copy.lastMessage = lastMessage
        return copy
    }

    func applying(name: String?, description: String?, avatarURL: String?) -> Conversation {
        var copy = self
        if let name { copy.name = name }
        if let description { copy.description = description }
        if let avatarURL { copy.avatarURL = avatarURL }
        return copy
    }

    /// My participant row, which is where per-user state (role, unread) lives.
    func myParticipant(userID: String?) -> UserBrief? {
        guard let userID else { return nil }
        return participants.first { $0.userId == userID }
    }

    /// Whether I may post here.
    ///
    /// The wire exposes this as `admin_only_messages` on the conversation, which is
    /// `send_messages` inverted (`enrich.PERMISSION_COLUMNS`). Creators and admins
    /// are never blocked by it.
    func canIPost(userID: String?) -> Bool {
        guard adminOnlyMessages == true else { return true }
        return myParticipant(userID: userID)?.role?.canAdminister ?? false
    }
}
