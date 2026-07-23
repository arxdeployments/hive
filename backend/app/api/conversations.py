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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, literal, or_, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import TenantContext, get_current_user, get_tenant
from app.db.models import (
    Conversation,
    ConversationParticipant,
    ConversationType,
    Message,
    MessageDeletion,
    User,
)
from app.db.session import get_db
from app.services import enrich, messaging, presence
from app.services.conversations import get_or_create_direct
from app.utils import parse_uuid

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


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
        .order_by(my_cp.is_pinned.desc(), Conversation.last_message_at.desc().nulls_last())
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
    conv_uuid = parse_uuid(conv_id)
    if conv_uuid is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    conv = await tenant.require_membership(conv_uuid)
    if not conv.is_active:
        raise HTTPException(status_code=404, detail="Conversation not found")

    me = await tenant.db.get(ConversationParticipant, (conv_uuid, tenant.user.id))
    me.is_pinned = not me.is_pinned
    await tenant.db.commit()
    return {"is_pinned": me.is_pinned}


@router.delete("/{conv_id}")
async def delete_conversation(conv_id: str, tenant: TenantContext = Depends(get_tenant)):
    conv_uuid = parse_uuid(conv_id)
    if conv_uuid is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    await tenant.require_membership(conv_uuid)

    db = tenant.db
    already_deleted = select(MessageDeletion.message_id).where(
        MessageDeletion.user_id == tenant.user.id,
        MessageDeletion.message_id == Message.id,
    )
    to_hide = select(Message.id, literal(tenant.user.id, type_=PG_UUID(as_uuid=True))).where(
        Message.conversation_id == conv_uuid, ~already_deleted.exists()
    )
    insert_stmt = (
        pg_insert(MessageDeletion).from_select(["message_id", "user_id"], to_hide).on_conflict_do_nothing()
    )
    await db.execute(insert_stmt)
    await db.commit()
    return {"message": "Conversation deleted"}


@router.put("/{conv_id}/read")
async def mark_conversation_read(
    conv_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conv_uuid = parse_uuid(conv_id)
    if conv_uuid is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    # Membership enforced inside mark_read (404 "Conversation not found").
    await messaging.mark_read(db, conversation_id=conv_uuid, reader=user)
    return {"message": "Marked as read"}
