"""Unified messaging service: ONE path that persists and broadcasts.

Every message — REST-sent, WebSocket-sent, system — goes through send_message,
so persistence and realtime fan-out can never diverge (the defining defect of
the Mongo build: HTTP sends were stored but never broadcast).
"""

import datetime as dt
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Conversation,
    ConversationParticipant,
    Message,
    MessageAttachment,
    MessageDeletion,
    MessageReaction,
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

DELETE_FOR_EVERYONE_WINDOW_SECONDS = 3600


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
            )
        )

    conv.last_message_at = now
    await db.commit()

    loaded = await enrich.load_message(db, msg.id)
    doc = await enrich.serialize_message(
        db, loaded, conv_participants=participants, sender=sender, include_reply=True
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

    # Web Push to recipients who are offline (best-effort, never blocks the send).
    offline = [uid for uid in others if uid not in set(online)]
    if offline:
        from app.services.push import push_to_users

        preview = _push_preview(doc)
        await push_to_users(
            db,
            offline,
            {
                "title": sender.display_name,
                "body": preview,
                "tag": str(conv.id),
                "url": "/chat",
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
    doc = await enrich.serialize_message(db, loaded, include_reply=False)
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


async def delete_message(db: AsyncSession, *, message_id: uuid.UUID, actor: User, for_everyone: bool) -> None:
    msg = await db.get(Message, message_id)
    if msg is None:
        raise SendError(status_code=404, detail="Message not found")
    me = await db.get(ConversationParticipant, (msg.conversation_id, actor.id))
    if me is None:
        raise SendError(status_code=404, detail="Message not found")

    if for_everyone:
        if msg.sender_id != actor.id:
            raise SendError(status_code=403, detail="Can only delete your own messages")
        created = msg.created_at if msg.created_at.tzinfo else msg.created_at.replace(tzinfo=dt.UTC)
        if (now_utc() - created).total_seconds() > DELETE_FOR_EVERYONE_WINDOW_SECONDS:
            raise SendError(status_code=400, detail="Can only delete within 60 minutes")
        msg.deleted_at = now_utc()
        msg.content = ""
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
                "type": "message_deleted",
                "message_id": str(message_id),
                "conversation_id": str(msg.conversation_id),
            },
        )
    else:
        existing = await db.get(MessageDeletion, (message_id, actor.id))
        if existing is None:
            db.add(MessageDeletion(message_id=message_id, user_id=actor.id))
        await db.commit()


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
    doc = await enrich.serialize_message(db, msg)
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
                )
            )
        conv.last_message_at = now
        await db.commit()
        loaded = await enrich.load_message(db, copy.id)
        doc = await enrich.serialize_message(
            db, loaded, conv_participants=participants, sender=actor, include_reply=False
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
