"""Conversation list + direct-conversation lifecycle (RxHivexx wire contract).

Deliberate fixes vs the Mongo build (docs/reference/api-conversations-messages.md):
- Sort uses MY pin (not the shared pinned_by array), so other users' pins can't
  perturb my ordering or break cursor pagination.
- `search` is applied in SQL BEFORE pagination — no more near-empty pages with
  has_more=true while matches are silently skipped. Patterns are escaped, never
  interpolated (closes the regex-injection class).
- Z-suffixed cursors parse correctly (fromisoformat after Z -> +00:00).
- DELETE /{conv_id} actually hides history: bulk delete-for-me rows for every
  current message (the old participants.deleted_at was write-only — a no-op).
- PUT /{conv_id}/read requires membership (404) instead of silently 200ing,
  and broadcasts messages_read via the unified messaging service.
- POST /direct notifies the other participant (conversation_created) on create.
- Enrichment is batched: one query each for unread counts, last messages, and
  presence per page — not one per participant per conversation.
"""

import datetime as dt
import uuid

from anyio import to_thread
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import TenantContext, get_current_user, get_tenant
from app.core.rate_limit import export_limiter
from app.db.models import (
    Conversation,
    ConversationParticipant,
    ConversationType,
    Message,
    MessageDeletion,
    User,
)
from app.db.session import get_db
from app.realtime.redis_bus import publish_to_users
from app.services import enrich, messaging, presence
from app.services.conversations import get_or_create_direct
from app.utils import iso_z, parse_uuid

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

# Export holds the rows, the formatted lines and the joined body in memory at
# once, so an uncapped transcript of a busy group is hundreds of MB per
# concurrent request. Cap it and tell the reader when history was cut.
EXPORT_MAX_MESSAGES = 20_000

# How many chats one user may pin. The pinned block sorts above everything else,
# so an unbounded count lets the "pinned" section become the whole list and the
# feature stops meaning anything. Mirrors the existing MAX_PINS_PER_CONVERSATION
# precedent for message pins; raise this single constant if it proves tight.
MAX_PINNED_CONVERSATIONS = 10


def _escape_like(value: str) -> str:
    """Escape LIKE/ILIKE metacharacters so user input is matched literally."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _parse_cursor(cursor: str | None) -> dt.datetime | None:
    if not cursor:
        return None
    try:
        parsed = dt.datetime.fromisoformat(cursor.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed


def _conv_uuid(conv_id: str) -> uuid.UUID:
    parsed = parse_uuid(conv_id)
    if parsed is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    return parsed


class DirectConversationRequest(BaseModel):
    participant_id: str


@router.get("")
async def list_conversations(
    cursor: str | None = None,
    limit: int = Query(30, ge=1, le=100),
    search: str = "",
    filter_: str = Query("all", alias="filter"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.org_id is None:
        return {"data": [], "has_more": False}

    my_cp = ConversationParticipant
    stmt = (
        select(Conversation)
        .join(my_cp, and_(my_cp.conversation_id == Conversation.id, my_cp.user_id == user.id))
        .options(selectinload(Conversation.participants).selectinload(ConversationParticipant.user))
        .where(
            Conversation.is_active.is_(True),
            or_(
                Conversation.org_id == user.org_id,
                and_(
                    Conversation.type == ConversationType.cross_org,
                    Conversation.allowed_org_ids.contains([str(user.org_id)]),
                ),
            ),
        )
        .order_by(
            my_cp.is_pinned.desc(),
            # Explicit user order within the pinned block. NULLS LAST so pins
            # made before pin_order existed fall back to recency instead of
            # jumping to the top.
            my_cp.pin_order.asc().nulls_last(),
            Conversation.last_message_at.desc().nulls_last(),
        )
    )

    if filter_ == "groups":
        stmt = stmt.where(Conversation.type == ConversationType.group)

    term = (search or "").strip()
    if term:
        pattern = f"%{_escape_like(term)}%"
        direct_name_match = (
            select(ConversationParticipant.conversation_id)
            .join(User, User.id == ConversationParticipant.user_id)
            .where(
                ConversationParticipant.user_id != user.id,
                User.display_name.ilike(pattern, escape="\\"),
            )
        )
        stmt = stmt.where(
            or_(
                Conversation.name.ilike(pattern, escape="\\"),
                and_(
                    Conversation.type == ConversationType.direct,
                    Conversation.id.in_(direct_name_match),
                ),
            )
        )

    cursor_dt = _parse_cursor(cursor)
    if cursor_dt is not None:
        stmt = stmt.where(Conversation.last_message_at < cursor_dt)

    if filter_ == "unread":
        # Unread-ness is derived (last_read_at), so filter after one batched count
        # over the full candidate set, then paginate the filtered ordering.
        candidates = (await db.execute(stmt)).scalars().all()
        unread = await enrich.unread_counts(db, [c.id for c in candidates], user.id)
        matched = [c for c in candidates if unread.get(c.id, 0) > 0]
        has_more = len(matched) > limit
        page = matched[:limit]
    else:
        rows = (await db.execute(stmt.limit(limit + 1))).scalars().all()
        has_more = len(rows) > limit
        page = rows[:limit]
        unread = await enrich.unread_counts(db, [c.id for c in page], user.id)

    conv_ids = [c.id for c in page]
    last_msgs = await enrich.last_messages(db, conv_ids, user.id)
    all_participant_ids = {p.user_id for c in page for p in c.participants}
    statuses = await presence.get_statuses(list(all_participant_ids))

    data = [
        await enrich.serialize_conversation(
            db, c, user.id, statuses=statuses, unread=unread, last_msgs=last_msgs
        )
        for c in page
    ]
    return {"data": data, "has_more": has_more}


@router.post("/direct")
async def create_direct_conversation(
    body: DirectConversationRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if user.org_id is None:
        raise HTTPException(status_code=403, detail="No organization")
    other_id = parse_uuid(body.participant_id)
    if other_id is None:
        raise HTTPException(status_code=400, detail="Invalid participant ID")
    if other_id == user.id:
        raise HTTPException(status_code=400, detail="Cannot start a conversation with yourself")

    other = (await db.execute(select(User).where(User.id == other_id))).scalar_one_or_none()
    if other is None or not other.is_active:
        raise HTTPException(status_code=404, detail="User not found")
    if other.org_id != user.org_id:
        raise HTTPException(status_code=403, detail="Cannot message users from a different organization")

    conv = await get_or_create_direct(db, user, other, notify=True)
    loaded = await enrich.load_conversation_with_participants(db, conv.id)
    return await enrich.serialize_conversation(db, loaded, user.id)


@router.put("/{conv_id}/pin")
async def toggle_pin(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Toggle MY pin on this conversation, maintaining MY pin order.

    Per-participant, so it cannot perturb anyone else's ordering — the list query
    joins only the caller's participant row.

    A newly pinned chat goes to the TOP of the pinned block: it takes
    min(pin_order) - 1 rather than max + 1. That is O(1) and needs no renumbering
    of the other pins, which matters because renumbering would be a write per
    pinned row on every pin. Ordinals may go negative; nothing reads them as a
    magnitude, only as a sort key.

    Unpinning clears pin_order back to NULL so a stale ordinal cannot resurrect a
    position if the chat is pinned again later.
    """
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    if not conv.is_active:
        raise HTTPException(status_code=404, detail="Conversation not found")

    me = await tenant.db.get(ConversationParticipant, (conv_uuid, tenant.user.id))

    if me.is_pinned:
        me.is_pinned = False
        me.pin_order = None
    else:
        pinned_count = await tenant.db.scalar(
            select(func.count())
            .select_from(ConversationParticipant)
            .where(
                ConversationParticipant.user_id == tenant.user.id,
                ConversationParticipant.is_pinned.is_(True),
            )
        )
        if (pinned_count or 0) >= MAX_PINNED_CONVERSATIONS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"You can pin up to {MAX_PINNED_CONVERSATIONS} chats. "
                    "Unpin one first."
                ),
            )
        lowest = await tenant.db.scalar(
            select(func.min(ConversationParticipant.pin_order)).where(
                ConversationParticipant.user_id == tenant.user.id,
                ConversationParticipant.is_pinned.is_(True),
            )
        )
        me.is_pinned = True
        me.pin_order = (lowest - 1) if lowest is not None else 0

    await tenant.db.commit()

    # Tell MY other tabs/devices only — a pin is per-user, so no other
    # participant has any interest in it. Mirrors message_pin_update, without
    # which a second device kept showing the old order until it refetched.
    await publish_to_users(
        [tenant.user.id],
        {
            "type": "conversation_pin_update",
            "conversation_id": str(conv_uuid),
            "is_pinned": me.is_pinned,
            "pin_order": me.pin_order,
        },
    )
    return {"is_pinned": me.is_pinned, "pin_order": me.pin_order}


@router.put("/{conv_id}/mute")
async def toggle_mute(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Toggle MY mute flag. Per-participant, so it can't perturb anyone else."""
    conv_uuid = _conv_uuid(conv_id)
    conv = await tenant.require_membership(conv_uuid)
    if not conv.is_active:
        raise HTTPException(status_code=404, detail="Conversation not found")

    me = await tenant.db.get(ConversationParticipant, (conv_uuid, tenant.user.id))
    me.is_muted = not me.is_muted
    await tenant.db.commit()
    return {"is_muted": me.is_muted}


async def _hide_all_messages_for_caller(db: AsyncSession, conv_uuid: uuid.UUID, user_id: uuid.UUID) -> None:
    """Delete-for-me every message in the conversation, in one INSERT ... SELECT.

    Only ever writes the caller's own rows — other users' history is untouched.
    """
    already_deleted = select(MessageDeletion.message_id).where(
        MessageDeletion.user_id == user_id,
        MessageDeletion.message_id == Message.id,
    )
    to_hide = select(Message.id, literal(user_id, type_=PG_UUID(as_uuid=True))).where(
        Message.conversation_id == conv_uuid, ~already_deleted.exists()
    )
    insert_stmt = (
        pg_insert(MessageDeletion).from_select(["message_id", "user_id"], to_hide).on_conflict_do_nothing()
    )
    await db.execute(insert_stmt)
    await db.commit()


@router.delete("/{conv_id}")
async def delete_conversation(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    conv_uuid = _conv_uuid(conv_id)
    await tenant.require_membership(conv_uuid)
    await _hide_all_messages_for_caller(tenant.db, conv_uuid, tenant.user.id)
    return {"message": "Conversation deleted"}


@router.post("/{conv_id}/clear")
async def clear_conversation(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Clear the chat for ME only — delete-for-me rows, never a destructive wipe."""
    conv_uuid = _conv_uuid(conv_id)
    await tenant.require_membership(conv_uuid)
    await _hide_all_messages_for_caller(tenant.db, conv_uuid, tenant.user.id)
    return {"message": "Chat cleared"}


@router.get("/{conv_id}/export")
async def export_conversation(
    conv_id: str,
    tenant: TenantContext = Depends(get_tenant),
    _rl: None = Depends(export_limiter),
):
    """Plain-text transcript, oldest-first, of the caller's most recent history."""
    conv_uuid = _conv_uuid(conv_id)
    await tenant.require_membership(conv_uuid)

    stmt = (
        select(Message, User.display_name)
        .outerjoin(User, User.id == Message.sender_id)
        .outerjoin(
            MessageDeletion,
            and_(
                MessageDeletion.message_id == Message.id,
                MessageDeletion.user_id == tenant.user.id,
            ),
        )
        .where(
            Message.conversation_id == conv_uuid,
            MessageDeletion.message_id.is_(None),  # exclude the caller's delete-for-me
        )
        # Newest-first + LIMIT so the cap keeps the RECENT tail; reversed below
        # to restore the oldest-first wire order. The extra row only detects
        # truncation and is dropped. id breaks created_at ties into a total
        # order, so the reverse is an exact inverse rather than arbitrary.
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(EXPORT_MAX_MESSAGES + 1)
    )
    rows = list((await tenant.db.execute(stmt)).all())
    truncated = len(rows) > EXPORT_MAX_MESSAGES
    rows = rows[:EXPORT_MAX_MESSAGES]
    rows.reverse()

    def _render() -> str:
        lines = []
        if truncated:
            # Oldest history is what got dropped, so the notice leads the file —
            # a reader sees it before the first surviving message.
            lines.append(
                f"[Note] Truncated: only the most recent {EXPORT_MAX_MESSAGES} messages are "
                "included; earlier history was omitted."
            )
        for msg, display_name in rows:
            content = "This message was deleted" if msg.deleted_at else (msg.content or "")
            lines.append(f"[{iso_z(msg.created_at)}] {display_name or 'System'}: {content}")
        return "\n".join(lines) + ("\n" if lines else "")

    # Formatting up to 20k rows is CPU-bound; inline it would block the event
    # loop and stall every other request on the worker. Only already-loaded
    # column attributes are touched, so no lazy IO happens off-loop.
    body = await to_thread.run_sync(_render)

    # Filename is derived from the id, never from the (user-controlled)
    # conversation name — no header injection, no encoding surprises.
    return PlainTextResponse(
        body,
        headers={"Content-Disposition": f'attachment; filename="rxhive-chat-{conv_uuid}.txt"'},
    )


@router.put("/{conv_id}/read")
async def mark_conversation_read(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conv_uuid = _conv_uuid(conv_id)
    # Membership enforced inside mark_read (404 "Conversation not found").
    await messaging.mark_read(db, conversation_id=conv_uuid, reader=user)
    return {"message": "Marked as read"}
