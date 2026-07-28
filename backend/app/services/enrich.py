"""Wire-format serialization of conversations and messages.

Shapes mirror the RxHivexx contract the salvaged frontend expects
(docs/reference/api-conversations-messages.md): serialized docs use `_id`
string keys, ISO-Z datetimes, participants carry display data + per-user
unread counts, messages carry sender enrichment + reply preview.

Unread counts and read receipts are DERIVED from conversation_participants.
last_read_at instead of stored counters — one source of truth, no drift.
"""

import datetime as dt
import uuid

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models import (
    Conversation,
    ConversationParticipant,
    Message,
    MessageAttachment,
    MessageDeletion,
    MessagePin,
    MessageReaction,
    MessageStar,
    MessageType,
    User,
)
from app.services import presence
from app.utils import iso_z


def media_url_for(attachment_id) -> str:
    return f"/api/media/{attachment_id}"


def thumb_url_for(attachment_id) -> str:
    return f"/api/media/{attachment_id}/thumb"


def serialize_user_brief(user: User, status: str = "offline") -> dict:
    return {
        "user_id": str(user.id),
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "status": status,
        "last_seen": iso_z(user.last_seen_at),
    }


async def unread_counts(
    db: AsyncSession, conversation_ids: list[uuid.UUID], user_id: uuid.UUID
) -> dict[uuid.UUID, int]:
    """Unread messages per conversation for one user: messages newer than the
    user's last_read_at, not sent by them, not deleted-for-them, not system."""
    if not conversation_ids:
        return {}
    cp = ConversationParticipant
    stmt = (
        select(Message.conversation_id, func.count(Message.id))
        .join(
            cp,
            and_(cp.conversation_id == Message.conversation_id, cp.user_id == user_id),
        )
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == user_id,
            ),
        )
        .where(
            Message.conversation_id.in_(conversation_ids),
            Message.sender_id != user_id,
            Message.deleted_at.is_(None),
            MessageDeletion.message_id.is_(None),
            (cp.last_read_at.is_(None)) | (Message.created_at > cp.last_read_at),
        )
        .group_by(Message.conversation_id)
    )
    rows = (await db.execute(stmt)).all()
    return {conv_id: count for conv_id, count in rows}


async def last_messages(
    db: AsyncSession, conversation_ids: list[uuid.UUID], for_user: uuid.UUID
) -> dict[uuid.UUID, dict]:
    """Latest visible message per conversation (excludes delete-for-me)."""
    if not conversation_ids:
        return {}
    ranked = (
        select(
            Message,
            func.row_number()
            .over(
                partition_by=Message.conversation_id,
                order_by=Message.created_at.desc(),
            )
            .label("rn"),
        )
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == for_user,
            ),
        )
        .where(
            Message.conversation_id.in_(conversation_ids),
            MessageDeletion.message_id.is_(None),
        )
        .subquery()
    )
    msg = Message.__table__.alias("m")
    stmt = (
        select(ranked, User.display_name)
        .outerjoin(User, User.id == ranked.c.sender_id)
        .where(ranked.c.rn == 1)
    )
    _ = msg  # alias kept for readability of the generated SQL
    rows = (await db.execute(stmt)).all()
    out: dict[uuid.UUID, dict] = {}
    for row in rows:
        m = row._mapping
        out[m["conversation_id"]] = {
            "content": "" if m["deleted_at"] else (m["content"] or ""),
            "sender_id": str(m["sender_id"]) if m["sender_id"] else None,
            "sender_name": row.display_name or "System",
            "created_at": iso_z(m["created_at"]),
            "type": m["type"].value if hasattr(m["type"], "value") else (m["type"] or "text"),
        }
    return out


async def load_conversation_with_participants(
    db: AsyncSession, conversation_id: uuid.UUID
) -> Conversation | None:
    stmt = (
        select(Conversation)
        .options(selectinload(Conversation.participants).selectinload(ConversationParticipant.user))
        .where(Conversation.id == conversation_id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def serialize_conversation(
    db: AsyncSession,
    conv: Conversation,
    for_user: uuid.UUID,
    *,
    statuses: dict[str, str] | None = None,
    unread: dict[uuid.UUID, int] | None = None,
    last_msgs: dict[uuid.UUID, dict] | None = None,
) -> dict:
    """Full enriched conversation object. Batch inputs (statuses/unread/last
    messages) may be supplied by list endpoints; otherwise fetched here."""
    participants = conv.participants
    if statuses is None:
        statuses = await presence.get_statuses([p.user_id for p in participants])
    if unread is None:
        unread = await unread_counts(db, [conv.id], for_user)
    if last_msgs is None:
        last_msgs = await last_messages(db, [conv.id], for_user)

    me = next((p for p in participants if p.user_id == for_user), None)
    is_group = conv.type.value in ("group", "cross_org")

    part_dicts = []
    for p in participants:
        if p.user is None:
            continue
        d = serialize_user_brief(p.user, statuses.get(str(p.user_id), "offline"))
        d["unread_count"] = unread.get(conv.id, 0) if p.user_id == for_user else 0
        d["role"] = p.role.value
        if is_group:
            d["joined_at"] = iso_z(p.joined_at)
        part_dicts.append(d)

    doc = {
        "_id": str(conv.id),
        "type": conv.type.value,
        "org_id": str(conv.org_id) if conv.org_id else None,
        "name": conv.name,
        "avatar_url": conv.avatar_url,
        "cross_org": conv.type.value == "cross_org",
        "allowed_org_ids": list(conv.allowed_org_ids or []),
        "created_by": str(conv.created_by) if conv.created_by else None,
        "created_at": iso_z(conv.created_at),
        "last_message_at": iso_z(conv.last_message_at),
        "pinned_by": [str(p.user_id) for p in participants if p.is_pinned],
        "is_active": conv.is_active,
        "participants": part_dicts,
        "last_message": last_msgs.get(conv.id),
        "unread_count": unread.get(conv.id, 0),
        "is_pinned": bool(me and me.is_pinned),
        # My explicit position within the pinned block, or null when unordered.
        # Sent so the client's own re-sort in bumpConversation can reproduce the
        # server's ORDER BY instead of keeping pins in arrival order.
        "pin_order": me.pin_order if me else None,
        # Mute was stored and toggleable but never sent back, so every client read
        # it as False after a reload — and since PUT /mute is a blind flip, the
        # menu offered "Mute" on an already-muted chat and unmuted it instead.
        "is_muted": bool(me and me.is_muted),
    }
    if is_group:
        doc["description"] = conv.description
        doc["admin_only_messages"] = conv.admin_only_messages
    if conv.type.value == "cross_org":
        doc["purpose_tag"] = conv.purpose_tag
    return doc


# Wire permission name -> Conversation column. `send_messages` is deliberately
# absent: it maps to the existing admin_only_messages column, INVERTED.
# Only enforced permissions are exposed. perm_send_history / perm_invite_via_link /
# perm_approve_new_members are stored but no read path honours them (a later member
# still sees the full pre-join history via messages, search, starred, pinned, media
# and export), so serving them would advertise privacy the server does not provide.
PERMISSION_COLUMNS = {
    "edit_info": "perm_edit_info",
    "add_members": "perm_add_members",
}


def serialize_permissions(conv: Conversation) -> dict:
    """The three-boolean permissions object the group settings UI reads/writes."""
    doc = {name: bool(getattr(conv, column)) for name, column in PERMISSION_COLUMNS.items()}
    doc["send_messages"] = not conv.admin_only_messages
    return doc


def _attachment_fields(attachments: list[MessageAttachment]) -> dict:
    """Legacy top-level media fields from the first attachment + full list."""
    out: dict = {
        "media_url": None,
        "thumbnail_url": None,
        "file_size": None,
        "filename": None,
        "attachments": [],
    }
    for a in attachments:
        item = {
            "id": str(a.id),
            "media_url": media_url_for(a.id),
            "thumbnail_url": thumb_url_for(a.id) if a.thumbnail_key else None,
            "filename": a.filename,
            "mime_type": a.mime_type,
            "file_size": a.file_size,
        }
        out["attachments"].append(item)
    if attachments:
        first = attachments[0]
        out["media_url"] = media_url_for(first.id)
        out["thumbnail_url"] = thumb_url_for(first.id) if first.thumbnail_key else None
        out["file_size"] = first.file_size
        out["filename"] = first.filename
    return out


def receipts_for_message(
    msg_created_at: dt.datetime,
    sender_id,
    participants: list[ConversationParticipant],
) -> tuple[list[dict], list[dict]]:
    """Derive read_by/delivered_to arrays from participants' last_read_at."""
    read_by, delivered_to = [], []
    for p in participants:
        if p.user_id == sender_id:
            continue
        if p.last_read_at and msg_created_at and p.last_read_at >= msg_created_at:
            ts = iso_z(p.last_read_at)
            read_by.append({"user_id": str(p.user_id), "read_at": ts})
            delivered_to.append({"user_id": str(p.user_id), "delivered_at": ts})
    return read_by, delivered_to


async def starred_message_ids(
    db: AsyncSession, message_ids: list[uuid.UUID], user_id: uuid.UUID
) -> set[uuid.UUID]:
    """Which of these messages the given user has starred (one batched query)."""
    if not message_ids:
        return set()
    rows = await db.execute(
        select(MessageStar.message_id).where(
            MessageStar.message_id.in_(message_ids), MessageStar.user_id == user_id
        )
    )
    return set(rows.scalars().all())


async def pinned_message_ids(db: AsyncSession, message_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """Which of these messages are pinned (conversation-wide, one batched query)."""
    if not message_ids:
        return set()
    rows = await db.execute(select(MessagePin.message_id).where(MessagePin.message_id.in_(message_ids)))
    return set(rows.scalars().all())


async def serialize_message(
    db: AsyncSession,
    msg: Message,
    *,
    conv_participants: list[ConversationParticipant] | None = None,
    sender: User | None = None,
    include_reply: bool = True,
    for_user: uuid.UUID | None = None,
    starred_ids: set[uuid.UUID] | None = None,
    pinned_ids: set[uuid.UUID] | None = None,
) -> dict:
    """Serialize one message.

    `is_starred` is the REQUESTING user's star, so it needs `for_user`; with no
    user context it is False. List endpoints pass pre-computed `starred_ids` /
    `pinned_ids` sets so a page costs two queries instead of two per message.
    """
    if sender is None and msg.sender_id:
        sender = await db.get(User, msg.sender_id)
    if conv_participants is None:
        conv_participants = (
            (
                await db.execute(
                    select(ConversationParticipant).where(
                        ConversationParticipant.conversation_id == msg.conversation_id
                    )
                )
            )
            .scalars()
            .all()
        )

    read_by, delivered_to = receipts_for_message(msg.created_at, msg.sender_id, conv_participants)

    if starred_ids is not None:
        is_starred = msg.id in starred_ids
    elif for_user is not None:
        is_starred = await db.get(MessageStar, (msg.id, for_user)) is not None
    else:
        is_starred = False
    if pinned_ids is not None:
        is_pinned = msg.id in pinned_ids
    else:
        is_pinned = await db.get(MessagePin, msg.id) is not None

    reactions = []
    for r in msg.reactions:
        reactions.append(
            {
                "user_id": str(r.user_id),
                # user_name is what the client's reaction tooltip reads. Only the
                # react endpoint used to send it, so tooltips were blank on load and
                # filled in only for whoever had just reacted. The reactor is
                # batch-loaded with the message (MESSAGE_LOAD_OPTIONS), not per row.
                "user_name": r.user.display_name if r.user else "Unknown",
                "emoji": r.emoji,
                "created_at": iso_z(r.created_at),
            }
        )

    doc = {
        "_id": str(msg.id),
        "conversation_id": str(msg.conversation_id),
        "sender_id": str(msg.sender_id) if msg.sender_id else None,
        "type": msg.type.value,
        "content": "" if msg.deleted_at else (msg.content or ""),
        "reply_to": str(msg.reply_to_id) if msg.reply_to_id else None,
        "reactions": reactions,
        "read_by": read_by,
        "delivered_to": delivered_to,
        "is_deleted": msg.deleted_at is not None,
        "is_forwarded": msg.is_forwarded,
        "is_starred": is_starred,
        "is_pinned": is_pinned,
        "created_at": iso_z(msg.created_at),
        "edited_at": iso_z(msg.edited_at),
        "sender_name": sender.display_name if sender else "System",
        "sender_avatar": sender.avatar_url if sender else None,
    }
    doc.update(_attachment_fields([] if msg.deleted_at else list(msg.attachments)))

    if include_reply and msg.reply_to_id:
        # Explicit select (not db.get): an identity-map hit would skip the
        # eager-load options and later lazy-loads would blow up in async.
        reply = (
            await db.execute(
                select(Message)
                .options(selectinload(Message.sender), selectinload(Message.attachments))
                .where(Message.id == msg.reply_to_id)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if reply:
            reply_media = _attachment_fields([] if reply.deleted_at else list(reply.attachments))
            doc["reply_to_message"] = {
                "_id": str(reply.id),
                "sender_id": str(reply.sender_id) if reply.sender_id else None,
                "sender_name": reply.sender.display_name if reply.sender else "System",
                "content": "" if reply.deleted_at else (reply.content or ""),
                "type": reply.type.value,
                "media_url": reply_media["media_url"],
                "is_deleted": reply.deleted_at is not None,
            }
        else:
            doc["reply_to_message"] = None
    return doc


MESSAGE_LOAD_OPTIONS = [
    # The nested load is what keeps serialize_message's reactor names off an N+1:
    # one IN query for the reactions of the page, one more for their users.
    selectinload(Message.reactions).selectinload(MessageReaction.user),
    selectinload(Message.attachments),
    selectinload(Message.sender),
]


async def load_message(db: AsyncSession, message_id: uuid.UUID) -> Message | None:
    # populate_existing refreshes an identity-map hit so freshly committed
    # reactions/attachments are re-read instead of served from a stale collection.
    stmt = (
        select(Message)
        .options(*MESSAGE_LOAD_OPTIONS)
        .where(Message.id == message_id)
        .execution_options(populate_existing=True)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


def enriched_reactions(msg_reactions: list[MessageReaction], users: dict[uuid.UUID, User]) -> list[dict]:
    """The react endpoint's shape: [{user_id, user_name, emoji}]."""
    out = []
    for r in msg_reactions:
        user = users.get(r.user_id)
        out.append(
            {
                "user_id": str(r.user_id),
                "user_name": user.display_name if user else "Unknown",
                "emoji": r.emoji,
            }
        )
    return out


def is_system_type(t) -> bool:
    return (t.value if hasattr(t, "value") else t) == MessageType.system.value
