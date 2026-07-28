"""Unified messaging service: ONE path that persists and broadcasts.

Every message — REST-sent, WebSocket-sent, system — goes through send_message,
so persistence and realtime fan-out can never diverge (the defining defect of
the Mongo build: HTTP sends were stored but never broadcast).
"""

import datetime as dt
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Conversation,
    ConversationParticipant,
    Message,
    MessageAttachment,
    MessagePin,
    MessageReaction,
    MessageStar,
    MessageType,
    ParticipantRole,
    Upload,
    User,
)
from app.realtime.redis_bus import publish_to_users
from app.services import enrich, presence
from app.utils import now_utc, sanitize_text

_MEDIA_TYPES = {"image", "video", "audio", "file"}
_UPLOAD_URL_RE = re.compile(r"/api/media/up/([0-9a-f-]{36})")

# Pins are conversation-wide and the whole set is fetched on conversation open,
# so they must stay bounded — otherwise one member can pin every message and
# make the hot path unbounded for everyone. Keep in sync with the /pinned limit.
MAX_PINS_PER_CONVERSATION = 50


def _push_preview(doc: dict) -> str:
    t = doc.get("type")
    if t == "image":
        return "📷 Photo"
    if t == "video":
        return "🎬 Video"
    if t == "audio":
        return "🎤 Voice message"
    if t == "file":
        return f"📄 {doc.get('filename') or 'Document'}"
    body = doc.get("content") or ""
    return body[:120]


class SendError(HTTPException):
    pass


async def _require_send_access(
    db: AsyncSession, conv: Conversation, sender: User
) -> list[ConversationParticipant]:
    participants = (
        (
            await db.execute(
                select(ConversationParticipant).where(ConversationParticipant.conversation_id == conv.id)
            )
        )
        .scalars()
        .all()
    )
    me = next((p for p in participants if p.user_id == sender.id), None)
    if me is None or not conv.is_active:
        raise SendError(status_code=404, detail="Conversation not found")
    # Org isolation: non-cross-org conversations must match the sender's org.
    if conv.type.value != "cross_org" and conv.org_id != sender.org_id:
        raise SendError(status_code=403, detail="Access denied")
    if (
        conv.admin_only_messages
        and conv.type.value in ("group", "cross_org")
        and me.role not in (ParticipantRole.creator, ParticipantRole.admin)
    ):
        raise SendError(status_code=403, detail="Only admins can send messages")
    return participants


async def _claim_upload(db: AsyncSession, media_url: str, sender: User) -> Upload:
    m = _UPLOAD_URL_RE.search(media_url or "")
    if not m:
        raise SendError(status_code=400, detail="Invalid media_url")
    upload = await db.get(Upload, uuid.UUID(m.group(1)))
    if upload is None or upload.uploader_id != sender.id:
        raise SendError(status_code=400, detail="Invalid media_url")
    return upload


async def send_message(
    db: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    sender: User,
    content: str = "",
    msg_type: str = "text",
    reply_to: str | None = None,
    temp_id: str | None = None,
    media_url: str | None = None,
    media_urls: list[str] | None = None,
    duration: float | None = None,
) -> dict:
    """Persist a message and fan it out. Returns the serialized message
    (with temp_id + status echoed for the sender's optimistic UI)."""
    conv = await db.get(Conversation, conversation_id)
    if conv is None:
        raise SendError(status_code=404, detail="Conversation not found")
    participants = await _require_send_access(db, conv, sender)

    if msg_type not in _MEDIA_TYPES and msg_type != "text":
        msg_type = "text"  # clients may not mint system/other types
    content = sanitize_text(content).strip()
    if msg_type == "text" and not content:
        raise SendError(status_code=400, detail="Message content required")

    urls = [u for u in ([media_url] if media_url else []) + list(media_urls or []) if u]
    if msg_type in _MEDIA_TYPES and not urls:
        raise SendError(status_code=400, detail="media_url required for media messages")

    reply_to_id = None
    if reply_to:
        try:
            candidate = uuid.UUID(str(reply_to))
        except ValueError:
            candidate = None
        if candidate:
            replied = await db.get(Message, candidate)
            # Replies must reference a message in the same conversation.
            if replied and replied.conversation_id == conv.id:
                reply_to_id = replied.id

    now = now_utc()
    msg = Message(
        conversation_id=conv.id,
        sender_id=sender.id,
        type=MessageType(msg_type),
        content=content,
        reply_to_id=reply_to_id,
        created_at=now,
    )
    db.add(msg)
    await db.flush()

    seen_keys: set[str] = set()
    for url in urls:
        upload = await _claim_upload(db, url, sender)
        if upload.storage_key in seen_keys:
            continue
        seen_keys.add(upload.storage_key)
        upload.claimed = True
        db.add(
            MessageAttachment(
                message_id=msg.id,
                storage_key=upload.storage_key,
                thumbnail_key=upload.thumbnail_key,
                filename=upload.filename,
                mime_type=upload.mime_type,
                file_size=upload.file_size,
                # Only meaningful for audio/video, and only the first attachment
                # can carry it — a voice note is always a single file.
                duration_seconds=duration if not seen_keys or len(seen_keys) == 1 else None,
            )
        )

    conv.last_message_at = now
    await db.commit()

    loaded = await enrich.load_message(db, msg.id)
    doc = await enrich.serialize_message(
        db,
        loaded,
        conv_participants=participants,
        sender=sender,
        include_reply=True,
        # Brand-new message: it cannot be starred or pinned yet, so hand the
        # serializer empty sets instead of paying two lookups on the send path.
        starred_ids=set(),
        pinned_ids=set(),
    )

    others = [p.user_id for p in participants if p.user_id != sender.id]
    statuses = await presence.get_statuses(others)
    online = [uid for uid in others if statuses.get(str(uid)) == "online"]

    broadcast_doc = {**doc, "status": "delivered"}
    await publish_to_users(others, {"type": "new_message", "message": broadcast_doc})

    if online:
        await publish_to_users(
            [sender.id],
            {
                "type": "message_status",
                "message_id": str(msg.id),
                "status": "delivered",
                "delivered_to": [str(u) for u in online],
            },
        )

    # Web Push to recipients who are offline. Dispatched, never awaited: these
    # are remote HTTPS POSTs to third-party push services, and a slow or dead
    # endpoint must not delay — or fail — the sender's send.
    offline = [uid for uid in others if uid not in set(online)]
    # Respect each recipient's mute. is_muted has been on the participant row and
    # served on every conversation all along, and NOTHING read it — so "Mute
    # notifications" silenced neither the in-app path nor push. Filter here rather
    # than inside push_to_users so the mute is evaluated against this
    # conversation's participants, which we already hold.
    muted = {p.user_id for p in participants if p.is_muted}
    offline = [uid for uid in offline if uid not in muted]
    if offline:
        from app.services.push import dispatch_push_to_users

        preview = _push_preview(doc)
        dispatch_push_to_users(
            offline,
            {
                "title": sender.display_name,
                "body": preview,
                "tag": str(conv.id),
                # conversation_id lets sw.js tell a focused tab WHICH chat to open;
                # the url is the fallback for when it has to open a new window.
                "conversation_id": str(conv.id),
                "url": f"/chat?c={conv.id}",
            },
        )

    doc["temp_id"] = temp_id
    doc["status"] = "sent"
    return doc


async def send_system_message(
    db: AsyncSession, conversation_id: uuid.UUID, content: str, *, broadcast: bool = True
) -> dict:
    """System messages (group events, call records). Not user-attributable."""
    conv = await db.get(Conversation, conversation_id)
    now = now_utc()
    msg = Message(
        conversation_id=conversation_id,
        sender_id=None,
        type=MessageType.system,
        content=content,
        created_at=now,
    )
    db.add(msg)
    if conv is not None:
        conv.last_message_at = now
    await db.commit()
    loaded = await enrich.load_message(db, msg.id)
    doc = await enrich.serialize_message(db, loaded, include_reply=False, starred_ids=set(), pinned_ids=set())
    if broadcast and conv is not None:
        participants = (
            (
                await db.execute(
                    select(ConversationParticipant.user_id).where(
                        ConversationParticipant.conversation_id == conversation_id
                    )
                )
            )
            .scalars()
            .all()
        )
        await publish_to_users(
            participants, {"type": "new_message", "message": {**doc, "status": "delivered"}}
        )
    return doc


async def mark_read(
    db: AsyncSession,
    *,
    conversation_id: uuid.UUID,
    reader: User,
    last_read_message_id: str | None = None,
) -> None:
    """Set last_read_at and broadcast messages_read to other participants."""
    me = await db.get(ConversationParticipant, (conversation_id, reader.id))
    if me is None:
        raise SendError(status_code=404, detail="Conversation not found")

    read_time = now_utc()
    anchor_id = None
    if last_read_message_id:
        try:
            anchor = await db.get(Message, uuid.UUID(str(last_read_message_id)))
        except ValueError:
            anchor = None
        if anchor and anchor.conversation_id == conversation_id:
            anchor_id = str(anchor.id)
            read_time = max(
                read_time,
                anchor.created_at if anchor.created_at.tzinfo else anchor.created_at.replace(tzinfo=dt.UTC),
            )
    if me.last_read_at is None or read_time > me.last_read_at:
        me.last_read_at = read_time
    await db.commit()

    others = (
        (
            await db.execute(
                select(ConversationParticipant.user_id).where(
                    ConversationParticipant.conversation_id == conversation_id,
                    ConversationParticipant.user_id != reader.id,
                )
            )
        )
        .scalars()
        .all()
    )
    await publish_to_users(
        others,
        {
            "type": "messages_read",
            "conversation_id": str(conversation_id),
            "reader_id": str(reader.id),
            "last_read_message_id": anchor_id,
        },
    )


async def toggle_reaction(db: AsyncSession, *, message_id: uuid.UUID, actor: User, emoji: str) -> list[dict]:
    """Toggle a reaction. Requires conversation membership (closes the IDOR)."""
    msg = await enrich.load_message(db, message_id)
    if msg is None:
        raise SendError(status_code=404, detail="Message not found")
    me = await db.get(ConversationParticipant, (msg.conversation_id, actor.id))
    if me is None:
        raise SendError(status_code=404, detail="Message not found")

    emoji = (emoji or "").strip()[:32]
    if not emoji:
        raise SendError(status_code=400, detail="Emoji required")

    existing = await db.get(MessageReaction, (message_id, actor.id, emoji))
    if existing:
        await db.delete(existing)
    else:
        db.add(MessageReaction(message_id=message_id, user_id=actor.id, emoji=emoji))
    await db.commit()

    msg = await enrich.load_message(db, message_id)
    user_ids = {r.user_id for r in msg.reactions}
    users = {}
    if user_ids:
        rows = (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars().all()
        users = {u.id: u for u in rows}
    reactions = enrich.enriched_reactions(list(msg.reactions), users)

    participants = (
        (
            await db.execute(
                select(ConversationParticipant.user_id).where(
                    ConversationParticipant.conversation_id == msg.conversation_id
                )
            )
        )
        .scalars()
        .all()
    )
    await publish_to_users(
        participants,
        {
            "type": "reaction_update",
            "message_id": str(message_id),
            "conversation_id": str(msg.conversation_id),
            "reactions": reactions,
        },
    )
    return reactions


async def _member_message(db: AsyncSession, message_id: uuid.UUID, actor: User) -> Message:
    """Load a message iff the actor participates in its conversation.

    404 either way — a non-member must not be able to tell a foreign message
    from a nonexistent one (same posture as toggle_reaction).
    """
    msg = await db.get(Message, message_id)
    if msg is None:
        raise SendError(status_code=404, detail="Message not found")
    me = await db.get(ConversationParticipant, (msg.conversation_id, actor.id))
    if me is None:
        raise SendError(status_code=404, detail="Message not found")
    return msg


async def toggle_star(db: AsyncSession, *, message_id: uuid.UUID, actor: User) -> bool:
    """Star/unstar for the actor only. Private: never broadcast, never visible
    to other participants."""
    await _member_message(db, message_id, actor)
    existing = await db.get(MessageStar, (message_id, actor.id))
    if existing is not None:
        await db.delete(existing)
        starred = False
    else:
        db.add(MessageStar(message_id=message_id, user_id=actor.id))
        starred = True
    await db.commit()
    return starred


async def toggle_pin(db: AsyncSession, *, message_id: uuid.UUID, actor: User) -> bool:
    """Pin/unpin for the whole conversation, then tell every participant."""
    msg = await _member_message(db, message_id, actor)
    existing = await db.get(MessagePin, message_id)
    if existing is not None:
        await db.delete(existing)
        pinned = False
    else:
        pin_count = (
            await db.execute(
                select(func.count())
                .select_from(MessagePin)
                .where(MessagePin.conversation_id == msg.conversation_id)
            )
        ).scalar_one()
        if pin_count >= MAX_PINS_PER_CONVERSATION:
            raise SendError(
                status_code=400,
                detail=(
                    f"This conversation already has the maximum of {MAX_PINS_PER_CONVERSATION} "
                    "pinned messages. Unpin one first."
                ),
            )
        db.add(
            MessagePin(
                message_id=message_id,
                conversation_id=msg.conversation_id,
                pinned_by=actor.id,
            )
        )
        pinned = True
    await db.commit()

    participants = (
        (
            await db.execute(
                select(ConversationParticipant.user_id).where(
                    ConversationParticipant.conversation_id == msg.conversation_id
                )
            )
        )
        .scalars()
        .all()
    )
    await publish_to_users(
        participants,
        {
            "type": "message_pin_update",
            "message_id": str(message_id),
            "conversation_id": str(msg.conversation_id),
            "is_pinned": pinned,
        },
    )
    return pinned


# Message deletion was REMOVED as a product feature. `delete_message` and the
# DELETE /messages/{id} route that called it are gone, so nothing can tombstone a
# message (Message.deleted_at) any more.
#
# NOTE: delete-for-me as a MECHANISM is still live and still reachable — "Clear
# chat" (POST /conversations/{id}/clear -> _hide_all_messages_for_caller) writes
# MessageDeletion rows for the caller. That is a separate feature and was left
# alone; only the per-message Delete for me / Delete for everyone actions were
# removed. So the MessageDeletion read filters below are load-bearing, not legacy.
#
# The READ side is deliberately untouched, because rows already exist:
#   * Message.deleted_at stays on the model and in the schema. Dropping it would
#     need a destructive migration, and any message deleted before this change
#     would lose its tombstone and reappear with its original content — the one
#     outcome a user who deleted a message must never get.
#   * enrich.serialize_message keeps emitting is_deleted and blanking content, so
#     historical tombstones still render as "This message was deleted".
#   * MessageDeletion rows stay filtered out of every read path — required both
#     for history hidden before this change and for Clear chat, which still
#     writes them.
#   * edit_message and forward_message keep refusing to operate on a tombstone.
# The result is that removing the feature changes what users can DO without
# changing what they SEE.


async def edit_message(db: AsyncSession, *, message_id: uuid.UUID, actor: User, content: str) -> dict:
    """Message editing — absent from the Mongo build, built new here."""
    msg = await enrich.load_message(db, message_id)
    if msg is None:
        raise SendError(status_code=404, detail="Message not found")
    me = await db.get(ConversationParticipant, (msg.conversation_id, actor.id))
    if me is None:
        raise SendError(status_code=404, detail="Message not found")
    if msg.sender_id != actor.id:
        raise SendError(status_code=403, detail="Can only edit your own messages")
    if msg.deleted_at is not None:
        raise SendError(status_code=400, detail="Cannot edit a deleted message")
    if msg.type.value not in ("text", "image", "video", "audio", "file"):
        raise SendError(status_code=400, detail="Cannot edit this message")

    content = sanitize_text(content).strip()
    if msg.type.value == "text" and not content:
        raise SendError(status_code=400, detail="Message content required")
    msg.content = content
    msg.edited_at = now_utc()
    await db.commit()

    msg = await enrich.load_message(db, message_id)
    doc = await enrich.serialize_message(db, msg, for_user=actor.id)
    participants = (
        (
            await db.execute(
                select(ConversationParticipant.user_id).where(
                    ConversationParticipant.conversation_id == msg.conversation_id
                )
            )
        )
        .scalars()
        .all()
    )
    await publish_to_users(
        participants,
        {
            "type": "message_edited",
            "message_id": str(message_id),
            "conversation_id": str(msg.conversation_id),
            "content": doc["content"],
            "edited_at": doc["edited_at"],
        },
    )
    return doc


async def forward_message(
    db: AsyncSession,
    *,
    actor: User,
    message_id: uuid.UUID,
    conversation_ids: list[str],
    contact_ids: list[str],
) -> list[str]:
    """Forward a message. The actor must be a member of the SOURCE conversation
    (closes the exfiltration IDOR) and of every target conversation."""
    original = await enrich.load_message(db, message_id)
    if original is None:
        raise SendError(status_code=404, detail="Message not found")
    src_membership = await db.get(ConversationParticipant, (original.conversation_id, actor.id))
    if src_membership is None:
        raise SendError(status_code=404, detail="Message not found")
    if original.deleted_at is not None:
        raise SendError(status_code=400, detail="Cannot forward a deleted message")

    forwarded_to: list[str] = []

    async def _copy_into(conv: Conversation, participants: list[ConversationParticipant]):
        now = now_utc()
        copy = Message(
            conversation_id=conv.id,
            sender_id=actor.id,
            type=original.type,
            content=original.content,
            is_forwarded=True,
            created_at=now,
        )
        db.add(copy)
        await db.flush()
        for a in original.attachments:
            db.add(
                MessageAttachment(
                    message_id=copy.id,
                    storage_key=a.storage_key,
                    thumbnail_key=a.thumbnail_key,
                    filename=a.filename,
                    mime_type=a.mime_type,
                    file_size=a.file_size,
                    # Carried, or a forwarded voice note loses its length and the
                    # bubble falls back to reading it out of the file.
                    duration_seconds=a.duration_seconds,
                )
            )
        conv.last_message_at = now
        await db.commit()
        loaded = await enrich.load_message(db, copy.id)
        doc = await enrich.serialize_message(
            db,
            loaded,
            conv_participants=participants,
            sender=actor,
            include_reply=False,
            starred_ids=set(),  # the forwarded copy is new — no stars, no pin
            pinned_ids=set(),
        )
        others = [p.user_id for p in participants if p.user_id != actor.id]
        await publish_to_users(others, {"type": "new_message", "message": {**doc, "status": "delivered"}})
        forwarded_to.append(str(conv.id))

    for cid in conversation_ids or []:
        try:
            conv_uuid = uuid.UUID(str(cid))
        except ValueError:
            continue
        conv = await db.get(Conversation, conv_uuid)
        if conv is None or not conv.is_active:
            continue
        participants = (
            (
                await db.execute(
                    select(ConversationParticipant).where(ConversationParticipant.conversation_id == conv.id)
                )
            )
            .scalars()
            .all()
        )
        if not any(p.user_id == actor.id for p in participants):
            continue
        if conv.type.value != "cross_org" and conv.org_id != actor.org_id:
            continue
        await _copy_into(conv, participants)

    from app.services.conversations import get_or_create_direct  # local import: avoids cycle

    for uid in contact_ids or []:
        try:
            contact_uuid = uuid.UUID(str(uid))
        except ValueError:
            continue
        contact = await db.get(User, contact_uuid)
        if contact is None or contact.org_id != actor.org_id or not contact.is_active:
            continue
        conv = await get_or_create_direct(db, actor, contact, notify=True)
        participants = (
            (
                await db.execute(
                    select(ConversationParticipant).where(ConversationParticipant.conversation_id == conv.id)
                )
            )
            .scalars()
            .all()
        )
        await _copy_into(conv, participants)

    return forwarded_to
