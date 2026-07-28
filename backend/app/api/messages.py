"""Message-level routes under /api/conversations.

Wire contract: docs/reference/api-conversations-messages.md. Deliberate fixes
vs the Mongo build: delete-for-me rows are filtered on every read, search input
is LIKE-escaped (no regex injection), every message-level action requires
conversation membership (closes the cross-org IDOR class), and message editing
(PUT /messages/{msg_id}) is net-new.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, select, tuple_

from app.core.deps import TenantContext, get_tenant
from app.db.models import (
    Conversation,
    ConversationParticipant,
    Message,
    MessageDeletion,
    MessagePin,
    MessageStar,
    MessageType,
    User,
)
from app.services import enrich, messaging
from app.utils import iso_z, parse_uuid

router = APIRouter(prefix="/api/conversations", tags=["messages"])

# Stars are per-user and unbounded over a conversation's lifetime; the endpoint
# has no pagination, so cap the page rather than serializing every star ever made.
_STARRED_PAGE_LIMIT = 200

_SEARCHABLE_TYPES = (
    MessageType.text,
    MessageType.image,
    MessageType.video,
    MessageType.audio,
    MessageType.file,
)


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so user input is matched literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _conv_uuid(conv_id: str) -> uuid.UUID:
    parsed = parse_uuid(conv_id)
    if parsed is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    return parsed


def _msg_uuid(msg_id: str) -> uuid.UUID:
    parsed = parse_uuid(msg_id)
    if parsed is None:
        raise HTTPException(status_code=400, detail="Invalid message ID")
    return parsed


def _require_org_access(conv: Conversation, tenant: TenantContext) -> None:
    # Mirrors the send path: non-cross-org conversations must match the caller's org.
    if conv.type.value != "cross_org" and conv.org_id != tenant.user.org_id:
        raise HTTPException(status_code=403, detail="Access denied")


async def _participants_of(db, conv_uuid: uuid.UUID) -> list[ConversationParticipant]:
    return (
        (
            await db.execute(
                select(ConversationParticipant).where(ConversationParticipant.conversation_id == conv_uuid)
            )
        )
        .scalars()
        .all()
    )


async def _serialize_page(
    db,
    messages: list[Message],
    *,
    user_id: uuid.UUID,
    participants: list[ConversationParticipant],
    include_reply: bool = True,
) -> list[dict]:
    """Serialize a page of messages with star/pin state batch-loaded once."""
    ids = [m.id for m in messages]
    starred_ids = await enrich.starred_message_ids(db, ids, user_id)
    pinned_ids = await enrich.pinned_message_ids(db, ids)
    # Senders arrive batch-loaded via MESSAGE_LOAD_OPTIONS (one IN query, no N+1).
    senders: dict[uuid.UUID, User] = {
        m.sender_id: m.sender for m in messages if m.sender_id is not None and m.sender is not None
    }
    return [
        await enrich.serialize_message(
            db,
            m,
            conv_participants=participants,
            sender=senders.get(m.sender_id) if m.sender_id else None,
            include_reply=include_reply,
            for_user=user_id,
            starred_ids=starred_ids,
            pinned_ids=pinned_ids,
        )
        for m in messages
    ]


class SendMessageRequest(BaseModel):
    content: str = ""
    type: str = "text"
    reply_to: str | None = None
    temp_id: str | None = None
    media_url: str | None = None
    media_urls: list[str] | None = None
    # Legacy fields, accepted but ignored: media metadata comes from the upload claim.
    thumbnail_url: str | None = None
    file_size: int | None = None
    filename: str | None = None


class ReactRequest(BaseModel):
    emoji: str


class ForwardRequest(BaseModel):
    message_id: str
    conversation_ids: list[str] = []
    contact_ids: list[str] = []


class EditMessageRequest(BaseModel):
    content: str


@router.get("/{conv_id}/messages")
async def list_messages(
    conv_id: str,
    before: str | None = Query(default=None),
    around: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    tenant: TenantContext = Depends(get_tenant),
):
    """A window of history, oldest-first.

    Three modes:
      * default        — the newest `limit` messages.
      * before=<id>    — the `limit` messages strictly older than that message.
      * around=<id>    — a window CENTRED on that message.

    `around` exists so a client can jump to a message it has not loaded: pinned
    messages, reply targets and search hits can all be arbitrarily far back, and
    with only `before` the only way to reach one was to page backwards until it
    happened to appear.

    Ordering and cursor comparisons use the (created_at, id) TUPLE, not created_at
    alone. Bulk-inserted or same-instant messages share a timestamp, and a
    scalar comparison there either drops rows or returns them twice at the seam
    between the two halves of an `around` window.

    `has_more` means older messages exist, `has_newer` means newer ones do.
    has_newer is always false in the default and `before` modes, since both are
    anchored to the newest end — so the shape stays backwards-compatible.
    """
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    _require_org_access(conv, tenant)
    db = tenant.db

    def base():
        return (
            select(Message)
            .options(*enrich.MESSAGE_LOAD_OPTIONS)
            .outerjoin(
                MessageDeletion,
                and_(
                    MessageDeletion.message_id == Message.id,
                    MessageDeletion.user_id == tenant.user.id,
                ),
            )
            .where(
                Message.conversation_id == conv_uuid,
                # Delete-for-me rows are filtered out; tombstones (deleted_at set)
                # ARE returned, serialized with is_deleted=true and blank content.
                MessageDeletion.message_id.is_(None),
            )
        )

    async def resolve_anchor(raw: str | None) -> Message | None:
        parsed = parse_uuid(raw)
        if parsed is None:
            return None
        found = await db.get(Message, parsed)
        # Invalid or foreign-conversation anchors are silently ignored (contract).
        if found is None or found.conversation_id != conv_uuid:
            return None
        return found

    key = tuple_(Message.created_at, Message.id)

    around_anchor = await resolve_anchor(around)
    if around_anchor is not None:
        anchor_key = (around_anchor.created_at, around_anchor.id)
        # Split the budget around the anchor, which is itself included in the
        # older half so it is always present in the result even at limit=1.
        older_budget = (limit + 1) // 2
        newer_budget = limit - older_budget

        older_rows = (
            await db.execute(
                base()
                .where(key <= anchor_key)
                .order_by(Message.created_at.desc(), Message.id.desc())
                .limit(older_budget + 1)
            )
        ).scalars().all()
        has_more = len(older_rows) > older_budget
        older = list(older_rows[:older_budget])
        older.reverse()

        newer: list[Message] = []
        has_newer = False
        if newer_budget > 0:
            newer_rows = (
                await db.execute(
                    base()
                    .where(key > anchor_key)
                    .order_by(Message.created_at.asc(), Message.id.asc())
                    .limit(newer_budget + 1)
                )
            ).scalars().all()
            has_newer = len(newer_rows) > newer_budget
            newer = list(newer_rows[:newer_budget])
        else:
            # limit=1 leaves no newer budget; report truthfully whether any exist.
            has_newer = (
                await db.scalar(
                    select(Message.id)
                    .where(Message.conversation_id == conv_uuid, key > anchor_key)
                    .limit(1)
                )
            ) is not None

        page = older + newer
    else:
        stmt = base()
        before_anchor = await resolve_anchor(before)
        if before_anchor is not None:
            stmt = stmt.where(key < (before_anchor.created_at, before_anchor.id))
        stmt = stmt.order_by(Message.created_at.desc(), Message.id.desc()).limit(limit + 1)

        rows = (await db.execute(stmt)).scalars().all()
        has_more = len(rows) > limit
        page = list(rows[:limit])
        page.reverse()  # wire order is oldest-first
        has_newer = False

    participants = await _participants_of(db, conv_uuid)
    messages = await _serialize_page(db, page, user_id=tenant.user.id, participants=participants)
    return {
        "messages": messages,
        "has_more": has_more,
        "has_newer": has_newer,
        # Echoed so a client can tell "your anchor was resolved" from "it wasn't,
        # here is the newest window instead" without diffing the payload.
        "anchor_id": str(around_anchor.id) if around_anchor is not None else None,
    }


@router.post("/{conv_id}/messages")
async def send_message(
    conv_id: str,
    body: SendMessageRequest,
    tenant: TenantContext = Depends(get_tenant),
):
    return await messaging.send_message(
        tenant.db,
        conversation_id=_conv_uuid(conv_id),
        sender=tenant.user,
        content=body.content,
        msg_type=body.type,
        reply_to=body.reply_to,
        temp_id=body.temp_id,
        media_url=body.media_url,
        media_urls=body.media_urls,
    )


@router.post("/{conv_id}/messages/search")
async def search_messages(
    conv_id: str,
    q: str = Query(default=""),
    tenant: TenantContext = Depends(get_tenant),
):
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    _require_org_access(conv, tenant)

    query = q.strip()
    if not query:
        return {"matches": [], "total": 0}

    pattern = f"%{_escape_like(query)}%"
    stmt = (
        select(Message.id, Message.content, Message.created_at)
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == tenant.user.id,
            ),
        )
        .where(
            Message.conversation_id == conv_uuid,
            Message.type.in_(_SEARCHABLE_TYPES),
            Message.deleted_at.is_(None),
            MessageDeletion.message_id.is_(None),
            Message.content.ilike(pattern, escape="\\"),
        )
        .order_by(Message.created_at.desc())
        .limit(100)
    )
    rows = (await tenant.db.execute(stmt)).all()
    matches = [
        {
            "message_id": str(message_id),
            "content_snippet": (content or "")[:200],
            "created_at": iso_z(created_at),
        }
        for message_id, content, created_at in rows
    ]
    return {"matches": matches, "total": len(matches)}


@router.post("/messages/{msg_id}/react")
async def react_to_message(
    msg_id: str,
    body: ReactRequest,
    tenant: TenantContext = Depends(get_tenant),
):
    reactions = await messaging.toggle_reaction(
        tenant.db, message_id=_msg_uuid(msg_id), actor=tenant.user, emoji=body.emoji
    )
    return {"reactions": reactions}


@router.post("/messages/{msg_id}/star")
async def star_message(msg_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Toggle the caller's private star. Membership-checked (404 otherwise)."""
    starred = await messaging.toggle_star(tenant.db, message_id=_msg_uuid(msg_id), actor=tenant.user)
    return {"starred": starred}


@router.post("/messages/{msg_id}/pin")
async def pin_message(msg_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Toggle the conversation-wide pin. Membership-checked (404 otherwise)."""
    pinned = await messaging.toggle_pin(tenant.db, message_id=_msg_uuid(msg_id), actor=tenant.user)
    return {"pinned": pinned}


@router.get("/{conv_id}/starred")
async def list_starred_messages(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    _require_org_access(conv, tenant)
    db = tenant.db

    stmt = (
        select(Message)
        .options(*enrich.MESSAGE_LOAD_OPTIONS)
        .join(MessageStar, MessageStar.message_id == Message.id)
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == tenant.user.id,
            ),
        )
        .where(
            Message.conversation_id == conv_uuid,
            MessageStar.user_id == tenant.user.id,
            MessageDeletion.message_id.is_(None),
        )
        .order_by(Message.created_at.desc())
        .limit(_STARRED_PAGE_LIMIT)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    participants = await _participants_of(db, conv_uuid)
    data = await _serialize_page(db, rows, user_id=tenant.user.id, participants=participants)
    return {"data": data}


@router.get("/{conv_id}/pinned")
async def list_pinned_messages(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    _require_org_access(conv, tenant)
    db = tenant.db

    stmt = (
        select(Message)
        .options(*enrich.MESSAGE_LOAD_OPTIONS)
        .join(MessagePin, MessagePin.message_id == Message.id)
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == tenant.user.id,
            ),
        )
        .where(
            Message.conversation_id == conv_uuid,
            MessageDeletion.message_id.is_(None),
        )
        # Bounded by the same cap the pin endpoint enforces, so a full pin set
        # still serializes completely on this (conversation-open) hot path.
        .order_by(MessagePin.created_at.desc())
        .limit(messaging.MAX_PINS_PER_CONVERSATION)
    )
    rows = list((await db.execute(stmt)).scalars().all())
    participants = await _participants_of(db, conv_uuid)
    data = await _serialize_page(db, rows, user_id=tenant.user.id, participants=participants)
    return {"data": data}


@router.post("/messages/forward")
async def forward_message(
    body: ForwardRequest,
    tenant: TenantContext = Depends(get_tenant),
):
    forwarded = await messaging.forward_message(
        tenant.db,
        actor=tenant.user,
        message_id=_msg_uuid(body.message_id),
        conversation_ids=body.conversation_ids,
        contact_ids=body.contact_ids,
    )
    return {"forwarded_to": forwarded}


# DELETE /messages/{msg_id} removed along with the message-deletion feature. The
# read side still understands tombstones written before the removal — see the note
# above messaging.edit_message.


@router.put("/messages/{msg_id}")
async def edit_message(
    msg_id: str,
    body: EditMessageRequest,
    tenant: TenantContext = Depends(get_tenant),
):
    # Net-new endpoint (absent from the Mongo build): returns the edited message doc.
    return await messaging.edit_message(
        tenant.db, message_id=_msg_uuid(msg_id), actor=tenant.user, content=body.content
    )


@router.get("/messages/{msg_id}/info")
async def message_info(msg_id: str, tenant: TenantContext = Depends(get_tenant)):
    db = tenant.db
    msg = await db.get(Message, _msg_uuid(msg_id))
    if msg is None:
        raise HTTPException(status_code=404, detail="Message not found")
    # Membership before the sender check: outsiders get 404, never a 403 probe.
    me = await db.get(ConversationParticipant, (msg.conversation_id, tenant.user.id))
    if me is None:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg.sender_id != tenant.user.id:
        raise HTTPException(status_code=403, detail="Can only view info for your own messages")

    participants = (
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
    other_ids = [p.user_id for p in participants if p.user_id != msg.sender_id]
    names: dict[uuid.UUID, str] = {}
    if other_ids:
        rows = (await db.execute(select(User.id, User.display_name).where(User.id.in_(other_ids)))).all()
        names = {user_id: display_name for user_id, display_name in rows}

    read_by: list[dict] = []
    delivered_to: list[dict] = []
    pending: list[dict] = []
    for p in participants:
        if p.user_id == msg.sender_id:
            continue  # the sender is excluded from all three lists
        user_name = names.get(p.user_id, "Unknown")
        if p.last_read_at is not None and p.last_read_at >= msg.created_at:
            ts = iso_z(p.last_read_at)
            read_by.append({"user_name": user_name, "read_at": ts})
            # Receipts are derived from last_read_at: delivered == read.
            delivered_to.append({"user_name": user_name, "delivered_at": ts})
        else:
            pending.append({"user_name": user_name})
    return {
        "sent_at": iso_z(msg.created_at),
        "delivered_to": delivered_to,
        "read_by": read_by,
        "pending": pending,
    }
