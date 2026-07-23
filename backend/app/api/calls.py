"""Call history, links, scheduling, and the LiveKit webhook.

REST surface of the LiveKit-backed calling stack (lifecycle itself lives in
app/services/calls.py). Wire shapes preserve the RxHivexx contract
(docs/reference/api-uploads-calls-misc.md): serialize_call docs use `_id`
string keys and ISO-Z datetimes.

Fixes vs the Mongo build: /schedule 400s on malformed datetimes instead of
500ing, validates participants against the caller's org, and inserts the
CallLink row for the generated code (the old build left the code dangling);
/ended verifies call membership via the calls service.
"""

import contextlib
import datetime as dt
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from livekit import api as lk_api
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user
from app.db.models import Call, CallLink, CallParticipant, CallStatus, CallType, ScheduledCall, User
from app.db.session import get_db
from app.realtime.redis_bus import publish_to_users
from app.services import calls as calls_service
from app.services.calls import handle_call_ws_message, mint_token, serialize_call
from app.utils import generate_call_code, iso_z, now_utc, parse_uuid, sanitize_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/calls", tags=["calls"])

# The LiveKit webhook lives outside the /api/calls prefix; mounted separately.
webhook_router = APIRouter(tags=["calls"])

_ACTIVE_STATUSES = (CallStatus.ringing, CallStatus.connected)


def _not_initiated_by(user_id: uuid.UUID):
    # Mongo `$ne` semantics: docs with a missing initiator also match.
    return or_(Call.initiated_by.is_(None), Call.initiated_by != user_id)


@router.get("/history")
async def call_history(
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    filter_: str = Query("all", alias="filter"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    base = (
        select(Call)
        .join(CallParticipant, CallParticipant.call_id == Call.id)
        .where(CallParticipant.user_id == user.id)
    )
    if filter_ == "missed":
        base = base.where(Call.status == CallStatus.missed, _not_initiated_by(user.id))
    elif filter_ == "incoming":
        base = base.where(_not_initiated_by(user.id))
    elif filter_ == "outgoing":
        base = base.where(Call.initiated_by == user.id)

    total = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    calls = (
        (
            await db.execute(
                base.order_by(Call.started_at.desc()).offset((page - 1) * limit).limit(limit)
            )
        )
        .scalars()
        .all()
    )
    data = [await serialize_call(db, call, user.id) for call in calls]
    return {"data": data, "total": total, "page": page, "limit": limit}


@router.get("/missed-count")
async def missed_count(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    stmt = (
        select(func.count())
        .select_from(CallParticipant)
        .join(Call, Call.id == CallParticipant.call_id)
        .where(
            CallParticipant.user_id == user.id,
            CallParticipant.seen_at.is_(None),
            Call.status == CallStatus.missed,
            _not_initiated_by(user.id),
        )
    )
    count = (await db.execute(stmt)).scalar_one()
    return {"count": count}


@router.post("/mark-seen")
async def mark_seen(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(
        update(CallParticipant)
        .where(CallParticipant.user_id == user.id, CallParticipant.seen_at.is_(None))
        .values(seen_at=now_utc())
    )
    await db.commit()
    return {"message": "Marked as seen"}


class CreateLinkRequest(BaseModel):
    call_type: str = "video"


@router.post("/create-link")
async def create_link(
    body: CreateLinkRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ctype = CallType.voice if body.call_type == "voice" else CallType.video
    link = CallLink(
        org_id=user.org_id, creator_id=user.id, code=generate_call_code(), call_type=ctype
    )
    db.add(link)
    await db.commit()
    return {"code": link.code, "url": f"/call/{link.code}", "call_type": ctype.value}


@router.get("/link/{code}")
async def get_link(
    code: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    _ = user  # any authenticated user may resolve a meet-style link
    link = (
        await db.execute(
            select(CallLink).where(CallLink.code == code, CallLink.is_active.is_(True))
        )
    ).scalar_one_or_none()
    if link is None:
        raise HTTPException(status_code=404, detail="Call link not found")
    return {
        "_id": str(link.id),
        "code": link.code,
        "creator_id": str(link.creator_id) if link.creator_id else None,
        "call_type": link.call_type.value,
        "created_at": iso_z(link.created_at),
        "is_active": link.is_active,
    }


class ScheduleCallRequest(BaseModel):
    title: str
    description: str | None = None
    start_time: str
    end_time: str | None = None
    call_type: str = "video"
    reminder_minutes: int = 15
    participant_ids: list[str] = Field(default_factory=list)


def _parse_iso(value: str, field: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {field} format") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed


def _serialize_scheduled(call: ScheduledCall) -> dict:
    return {
        "_id": str(call.id),
        "title": call.title,
        "description": call.description,
        "call_type": call.call_type.value,
        "call_link_code": call.call_link_code,
        "start_time": iso_z(call.start_time),
        "end_time": iso_z(call.end_time),
        "reminder_minutes": call.reminder_minutes,
        "creator_id": str(call.creator_id) if call.creator_id else None,
        "participant_ids": [str(p) for p in (call.participant_ids or [])],
        "org_id": str(call.org_id) if call.org_id else None,
        "status": call.status,
        "created_at": iso_z(call.created_at),
    }


@router.post("/schedule")
async def schedule_call(
    body: ScheduleCallRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    start = _parse_iso(body.start_time, "start_time")
    end = _parse_iso(body.end_time, "end_time") if body.end_time else None

    # Keep only requested participants that exist, are active, and share the
    # caller's org; invalid/foreign ids are silently skipped (contract).
    requested = list(
        dict.fromkeys(u for u in (parse_uuid(p) for p in body.participant_ids) if u is not None)
    )
    valid_ids: list[str] = []
    if requested:
        rows = (
            (
                await db.execute(
                    select(User.id).where(
                        User.id.in_(requested),
                        User.org_id == user.org_id,
                        User.is_active.is_(True),
                    )
                )
            )
            .scalars()
            .all()
        )
        keep = set(rows)
        valid_ids = [str(u) for u in requested if u in keep]

    ctype = CallType.voice if body.call_type == "voice" else CallType.video
    code = generate_call_code()
    now = now_utc()
    scheduled = ScheduledCall(
        org_id=user.org_id,
        creator_id=user.id,
        title=sanitize_text(body.title).strip(),
        description=sanitize_text(body.description) if body.description else None,
        call_type=ctype,
        call_link_code=code,
        start_time=start,
        end_time=end,
        reminder_minutes=body.reminder_minutes,
        participant_ids=valid_ids,
        status="scheduled",
        created_at=now,
    )
    db.add(scheduled)
    # The Mongo build generated a code but never inserted the link — fixed here.
    db.add(CallLink(org_id=user.org_id, creator_id=user.id, code=code, call_type=ctype))
    await db.commit()
    return _serialize_scheduled(scheduled)


@router.get("/scheduled")
async def list_scheduled(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    stmt = (
        select(ScheduledCall)
        .where(
            ScheduledCall.status == "scheduled",
            ScheduledCall.start_time >= now_utc(),
            or_(
                ScheduledCall.creator_id == user.id,
                ScheduledCall.participant_ids.contains([str(user.id)]),
            ),
        )
        .order_by(ScheduledCall.start_time.asc())
    )
    calls = (await db.execute(stmt)).scalars().all()
    return [_serialize_scheduled(c) for c in calls]


class CallEndedBeacon(BaseModel):
    call_id: str
    user_id: str


@router.post("/ended")
async def call_ended(body: CallEndedBeacon, user: User = Depends(get_current_user)):
    if body.user_id != str(user.id):
        raise HTTPException(status_code=403, detail="Cannot end call for another user")
    # The service verifies the caller is actually a call participant.
    await handle_call_ws_message(user, {"type": "call:end", "call_id": body.call_id})
    return {"message": "OK"}


@router.post("/{call_id}/token")
async def call_token(
    call_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    call = (
        await db.execute(select(Call).where(Call.id == call_id))
    ).scalar_one_or_none()
    member = await db.get(CallParticipant, (call_id, user.id)) if call else None
    if call is None or member is None:
        raise HTTPException(status_code=404, detail="Call not found")
    if call.status not in _ACTIVE_STATUSES:
        raise HTTPException(status_code=400, detail="Call is not active")
    if member.joined_at is None:
        member.joined_at = now_utc()
        await db.commit()
    with contextlib.suppress(Exception):
        await calls_service._set_in_call([user.id], call.id)
    settings = get_settings()
    return {"token": mint_token(call, user), "url": settings.livekit_url, "room": call.room_name}


async def _handle_webhook_event(db: AsyncSession, event) -> None:
    room = event.room.name or ""
    if not room.startswith("call_"):
        return
    call_id = parse_uuid(room.removeprefix("call_"))
    if call_id is None:
        return
    call = (
        await db.execute(select(Call).where(Call.id == call_id))
    ).scalar_one_or_none()
    if call is None:
        return

    name = event.event
    if name in ("participant_joined", "participant_left"):
        member_id = parse_uuid(event.participant.identity or "")
        if member_id is None:
            return
        member = await db.get(CallParticipant, (call.id, member_id))
        if member is None:
            return
        others = [
            u for u in await calls_service._call_participant_ids(db, call.id) if u != member_id
        ]
        if name == "participant_joined":
            if member.joined_at is None:
                member.joined_at = now_utc()
            member.left_at = None
            await db.commit()
            joined_user = await db.get(User, member_id)
            if joined_user is not None:
                await publish_to_users(
                    others,
                    {
                        "type": "call:participant_joined",
                        "call_id": str(call.id),
                        "participant": calls_service._brief(joined_user),
                    },
                )
        else:
            member.left_at = now_utc()
            await db.commit()
            await publish_to_users(
                others,
                {
                    "type": "call:participant_left",
                    "call_id": str(call.id),
                    "participant_id": str(member_id),
                },
            )
    elif name == "room_finished" and call.status == CallStatus.connected:
        ids = await calls_service._call_participant_ids(db, call.id)
        await calls_service._finalize(db, call, CallStatus.answered)
        await publish_to_users(
            ids,
            {
                "type": "call:ended",
                "call_id": str(call.id),
                "reason": "room_finished",
                "duration": calls_service._duration_of(call),
            },
        )


@webhook_router.post("/api/livekit/webhook")
async def livekit_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Server-to-server LiveKit events. Always 200: webhooks must not 500-loop.

    Unverifiable payloads are acknowledged but never processed.
    """
    try:
        body = (await request.body()).decode("utf-8")
        auth = request.headers.get("Authorization", "")
        settings = get_settings()
        verifier = lk_api.TokenVerifier(settings.livekit_api_key, settings.livekit_api_secret)
        event = lk_api.WebhookReceiver(verifier).receive(body, auth)
    except Exception:
        logger.warning("Rejected LiveKit webhook: verification failed")
        return {"message": "ignored"}
    try:
        await _handle_webhook_event(db, event)
    except Exception:
        logger.exception("LiveKit webhook handling failed")
    return {"message": "ok"}
