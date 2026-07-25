"""Calling on LiveKit: the backend mints scoped room tokens and tracks
lifecycle/history; media never touches this process (SFU's job).

Replaces the hand-rolled 6-person WebRTC mesh + public TURN + blind signaling
relay. Client-facing WS events keep the RxHivexx names (call:incoming,
call:accepted, …) so the salvaged UI flow survives; SDP/ICE relay events are
gone — the LiveKit client SDK talks to the SFU directly.

Cross-worker state (who is in which call) lives in Redis.
"""

import asyncio
import contextlib
import datetime as dt
import logging
import uuid

from livekit import api as lk_api
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import (
    Call,
    CallParticipant,
    CallStatus,
    CallType,
    Conversation,
    ConversationParticipant,
    User,
)
from app.db.session import SessionLocal
from app.realtime.redis_bus import get_redis, publish_to_users
from app.services import presence
from app.utils import iso_z, now_utc

logger = logging.getLogger(__name__)

RING_TIMEOUT_SECONDS = 30
GROUP_CALL_CAP = 32
_CALL_TTL = 24 * 3600

_ring_timers: dict[str, asyncio.Task] = {}


def _user_key(user_id) -> str:
    return f"call:user:{user_id}"


def _conv_key(conversation_id) -> str:
    return f"call:conv:{conversation_id}"


def room_name_for(call_id) -> str:
    return f"call_{call_id}"


async def _set_in_call(user_ids, call_id) -> None:
    redis = get_redis()
    pipe = redis.pipeline()
    for uid in user_ids:
        pipe.set(_user_key(uid), str(call_id), ex=_CALL_TTL)
    await pipe.execute()


async def _clear_in_call(user_ids, call_id) -> None:
    redis = get_redis()
    for uid in user_ids:
        current = await redis.get(_user_key(uid))
        if current == str(call_id):
            await redis.delete(_user_key(uid))


async def current_call_of(user_id) -> str | None:
    return await get_redis().get(_user_key(user_id))


def _brief(user: User) -> dict:
    return {
        "id": str(user.id),
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
    }


async def _load_call(db: AsyncSession, call_id: uuid.UUID) -> Call | None:
    stmt = select(Call).where(Call.id == call_id)
    return (await db.execute(stmt)).scalar_one_or_none()


async def _call_participant_ids(db: AsyncSession, call_id: uuid.UUID) -> list[uuid.UUID]:
    return (
        (await db.execute(select(CallParticipant.user_id).where(CallParticipant.call_id == call_id)))
        .scalars()
        .all()
    )


async def _finalize(
    db: AsyncSession,
    call: Call,
    status: CallStatus,
    *,
    system_note: str | None = None,
) -> None:
    call.status = status
    call.ended_at = now_utc()
    await db.commit()
    ids = await _call_participant_ids(db, call.id)
    await _clear_in_call(ids, call.id)
    if call.conversation_id:
        await get_redis().delete(_conv_key(call.conversation_id))
    task = _ring_timers.pop(str(call.id), None)
    if task:
        task.cancel()
    if system_note and call.conversation_id:
        from app.services.messaging import send_system_message

        with contextlib.suppress(Exception):
            await send_system_message(db, call.conversation_id, system_note)


def _duration_of(call: Call) -> int:
    if not call.answered_at or not call.ended_at:
        return 0
    a = call.answered_at if call.answered_at.tzinfo else call.answered_at.replace(tzinfo=dt.UTC)
    e = call.ended_at if call.ended_at.tzinfo else call.ended_at.replace(tzinfo=dt.UTC)
    return max(0, int((e - a).total_seconds()))


def _fmt_duration(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


def _call_emoji(call: Call) -> str:
    return "📹" if call.type == CallType.video else "📞"


async def _ring_timeout(call_id: uuid.UUID) -> None:
    await asyncio.sleep(RING_TIMEOUT_SECONDS)
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None or call.status != CallStatus.ringing:
            return
        ids = await _call_participant_ids(db, call_id)
        caller_id = call.initiated_by
        callee_ids = [u for u in ids if u != caller_id]
        caller = await db.get(User, caller_id) if caller_id else None
        await _finalize(db, call, CallStatus.missed, system_note=f"{_call_emoji(call)} Missed call")
        if caller_id:
            await publish_to_users([caller_id], {"type": "call:missed", "call_id": str(call_id)})
        await publish_to_users(
            callee_ids,
            {
                "type": "call:missed",
                "call_id": str(call_id),
                "caller": _brief(caller) if caller else None,
                "call_type": call.type.value,
            },
        )


async def initiate_direct_call(
    user: User, callee_id: uuid.UUID, call_type: str, conversation_id: str | None
) -> None:
    async with SessionLocal() as db:
        caller = await db.get(User, user.id)
        callee = await db.get(User, callee_id)
        if callee is None or not callee.is_active or callee.org_id != caller.org_id:
            await publish_to_users([caller.id], {"type": "call:error", "message": "User not available"})
            return
        if await current_call_of(caller.id):
            await publish_to_users([caller.id], {"type": "call:error", "message": "Already in a call"})
            return

        from app.services.conversations import get_or_create_direct

        conv = await get_or_create_direct(db, caller, callee)

        ctype = CallType.video if call_type == "video" else CallType.voice
        call = Call(
            org_id=caller.org_id,
            conversation_id=conv.id,
            initiated_by=caller.id,
            type=ctype,
            status=CallStatus.ringing,
            is_group=False,
            room_name="",
        )
        db.add(call)
        await db.flush()
        call.room_name = room_name_for(call.id)
        db.add_all(
            [
                CallParticipant(call_id=call.id, user_id=caller.id),
                CallParticipant(call_id=call.id, user_id=callee.id),
            ]
        )
        await db.commit()
        call_id = call.id

        if await current_call_of(callee.id):
            await _finalize(db, call, CallStatus.busy)
            await publish_to_users([caller.id], {"type": "call:busy", "call_id": str(call_id)})
            return
        if not await presence.is_online(callee.id):
            await _finalize(db, call, CallStatus.no_answer)
            await publish_to_users([caller.id], {"type": "call:unavailable", "call_id": str(call_id)})
            return

        await _set_in_call([caller.id, callee.id], call_id)
        await publish_to_users(
            [callee.id],
            {
                "type": "call:incoming",
                "call_id": str(call_id),
                "caller": _brief(caller),
                "call_type": ctype.value,
                "conversation_id": str(conv.id),
            },
        )
        await publish_to_users(
            [caller.id],
            {"type": "call:ringing_started", "call_id": str(call_id), "callee_id": str(callee.id)},
        )
        _ring_timers[str(call_id)] = asyncio.create_task(_ring_timeout(call_id))


async def initiate_group_call(user: User, conversation_id: uuid.UUID, call_type: str) -> None:
    async with SessionLocal() as db:
        caller = await db.get(User, user.id)
        conv = await db.get(Conversation, conversation_id)
        me = await db.get(ConversationParticipant, (conversation_id, caller.id))
        if conv is None or me is None or not conv.is_active:
            await publish_to_users([caller.id], {"type": "call:error", "message": "Conversation not found"})
            return
        if conv.type.value != "cross_org" and conv.org_id != caller.org_id:
            await publish_to_users([caller.id], {"type": "call:error", "message": "Access denied"})
            return

        redis = get_redis()
        existing = await redis.get(_conv_key(conversation_id))
        if existing:
            await publish_to_users(
                [caller.id],
                {
                    "type": "call:group_already_active",
                    "call_id": existing,
                    "conversation_id": str(conversation_id),
                },
            )
            return
        if await current_call_of(caller.id):
            await publish_to_users([caller.id], {"type": "call:error", "message": "Already in a call"})
            return

        member_ids = (
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

        ctype = CallType.video if call_type == "video" else CallType.voice
        now = now_utc()
        call = Call(
            org_id=conv.org_id or caller.org_id,
            conversation_id=conversation_id,
            initiated_by=caller.id,
            type=ctype,
            status=CallStatus.connected,
            is_group=True,
            room_name="",
            answered_at=now,
        )
        db.add(call)
        await db.flush()
        call.room_name = room_name_for(call.id)
        for uid in member_ids:
            db.add(CallParticipant(call_id=call.id, user_id=uid, joined_at=now if uid == caller.id else None))
        await db.commit()
        call_id = call.id

        await redis.set(_conv_key(conversation_id), str(call_id), ex=_CALL_TTL)
        await _set_in_call([caller.id], call_id)

        others = [u for u in member_ids if u != caller.id]
        await publish_to_users(
            others,
            {
                "type": "call:incoming",
                "call_id": str(call_id),
                "caller": _brief(caller),
                "call_type": ctype.value,
                "conversation_id": str(conversation_id),
                "is_group": True,
                "group_name": conv.name or "Group call",
            },
        )
        await publish_to_users(
            others,
            {
                "type": "call:group_active",
                "call_id": str(call_id),
                "conversation_id": str(conversation_id),
                "participants": [_brief(caller)],
                "call_type": ctype.value,
            },
        )
        await publish_to_users(
            [caller.id],
            {
                "type": "call:group_started",
                "call_id": str(call_id),
                "conversation_id": str(conversation_id),
            },
        )


async def _accept(user: User, call_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None:
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None or user.id == call.initiated_by:
            return
        if call.status != CallStatus.ringing:
            return
        call.status = CallStatus.connected
        call.answered_at = now_utc()
        await db.commit()
        task = _ring_timers.pop(str(call_id), None)
        if task:
            task.cancel()
        await publish_to_users(
            [call.initiated_by],
            {"type": "call:accepted", "call_id": str(call_id), "accepter_id": str(user.id)},
        )


async def _decline(user: User, call_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None or call.status != CallStatus.ringing:
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None or user.id == call.initiated_by:
            return
        await _finalize(db, call, CallStatus.declined, system_note=f"{_call_emoji(call)} Call declined")
        await publish_to_users([call.initiated_by], {"type": "call:declined", "call_id": str(call_id)})


async def _cancel(user: User, call_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None or call.status != CallStatus.ringing or call.initiated_by != user.id:
            return
        ids = await _call_participant_ids(db, call_id)
        await _finalize(db, call, CallStatus.cancelled)
        await publish_to_users(
            [u for u in ids if u != user.id], {"type": "call:cancelled", "call_id": str(call_id)}
        )


async def _end(user: User, call_id: uuid.UUID, reason: str = "normal") -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None:
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None:
            return
        if call.status not in (CallStatus.ringing, CallStatus.connected):
            return
        if call.status == CallStatus.ringing and call.initiated_by == user.id:
            await _cancel(user, call_id)
            return
    # In a group call, an ordinary participant hanging up is a LEAVE — it must
    # not tear down the room for everyone. Only the initiator (or the last one
    # out, handled in _leave) ends the whole call.
    if call.is_group and call.initiated_by != user.id:
        await _leave(user, call_id)
        return
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None or call.status not in (CallStatus.ringing, CallStatus.connected):
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None:
            return
        member.left_at = now_utc()
        ids = await _call_participant_ids(db, call_id)
        final = CallStatus.answered if call.answered_at else CallStatus.cancelled
        duration_note = None
        if call.answered_at:
            call.ended_at = now_utc()
            duration_note = (
                f"{_call_emoji(call)} "
                f"{'Video' if call.type == CallType.video else 'Voice'} call · "
                f"{_fmt_duration(_duration_of(call))}"
            )
        await _finalize(db, call, final, system_note=duration_note)
        await publish_to_users(
            [u for u in ids if u != user.id],
            {
                "type": "call:ended",
                "call_id": str(call_id),
                "reason": reason,
                "duration": _duration_of(call),
            },
        )


async def _join(user: User, call_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None or call.status != CallStatus.connected or not call.is_group:
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None:
            return  # only invited conversation members may join
        joined = (
            (
                await db.execute(
                    select(CallParticipant).where(
                        CallParticipant.call_id == call_id,
                        CallParticipant.joined_at.is_not(None),
                        CallParticipant.left_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        if len(joined) >= GROUP_CALL_CAP:
            await publish_to_users(
                [user.id],
                {
                    "type": "call:full",
                    "call_id": str(call_id),
                    "message": f"Call is full ({GROUP_CALL_CAP}/{GROUP_CALL_CAP} participants)",
                },
            )
            return
        member.joined_at = member.joined_at or now_utc()
        member.left_at = None
        await db.commit()
        await _set_in_call([user.id], call_id)

        users = {}
        joined_ids = [p.user_id for p in joined if p.user_id != user.id]
        if joined_ids:
            rows = (await db.execute(select(User).where(User.id.in_(joined_ids)))).scalars().all()
            users = {u.id: u for u in rows}
        me = await db.get(User, user.id)
        await publish_to_users(
            [user.id],
            {
                "type": "call:group_participants",
                "call_id": str(call_id),
                "participants": [_brief(users[uid]) for uid in joined_ids if uid in users],
            },
        )
        await publish_to_users(
            joined_ids,
            {
                "type": "call:participant_joined",
                "call_id": str(call_id),
                "participant": _brief(me),
            },
        )


async def _leave(user: User, call_id: uuid.UUID) -> None:
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None:
            return
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None:
            return
        if not call.is_group:
            await _end(user, call_id, reason="normal")
            return
        member.left_at = now_utc()
        await db.commit()
        await _clear_in_call([user.id], call_id)
        remaining = (
            (
                await db.execute(
                    select(CallParticipant.user_id).where(
                        CallParticipant.call_id == call_id,
                        CallParticipant.joined_at.is_not(None),
                        CallParticipant.left_at.is_(None),
                    )
                )
            )
            .scalars()
            .all()
        )
        ids = await _call_participant_ids(db, call_id)
        await publish_to_users(
            [u for u in ids if u != user.id],
            {"type": "call:participant_left", "call_id": str(call_id), "participant_id": str(user.id)},
        )
        if not remaining and call.status == CallStatus.connected:
            duration_note = (
                f"{_call_emoji(call)} Group call · {_fmt_duration(_duration_of(call))}"
                if call.answered_at
                else None
            )
            call.ended_at = now_utc()
            await _finalize(db, call, CallStatus.answered, system_note=duration_note)
            await publish_to_users(
                ids,
                {
                    "type": "call:group_ended",
                    "call_id": str(call_id),
                    "conversation_id": str(call.conversation_id) if call.conversation_id else None,
                },
            )


async def _toggle_media(user: User, call_id: uuid.UUID, media_type: str, enabled: bool) -> None:
    async with SessionLocal() as db:
        member = await db.get(CallParticipant, (call_id, user.id))
        if member is None:
            return
        ids = await _call_participant_ids(db, call_id)
    await publish_to_users(
        [u for u in ids if u != user.id],
        {
            "type": "call:media_toggle",
            "call_id": str(call_id),
            "user_id": str(user.id),
            "media_type": "audio" if media_type == "audio" else "video",
            "enabled": bool(enabled),
        },
    )


async def handle_call_ws_message(user: User, data: dict) -> None:
    msg_type = data.get("type")
    call_id = _parse_uuid(data.get("call_id"))

    if msg_type == "call:initiate":
        callee = _parse_uuid(data.get("callee_id"))
        if callee:
            await initiate_direct_call(
                user, callee, data.get("call_type", "voice"), data.get("conversation_id")
            )
    elif msg_type == "call:group_initiate":
        conv = _parse_uuid(data.get("conversation_id"))
        if conv:
            await initiate_group_call(user, conv, data.get("call_type", "video"))
    elif call_id is None:
        return
    elif msg_type == "call:accept":
        await _accept(user, call_id)
    elif msg_type == "call:decline":
        await _decline(user, call_id)
    elif msg_type == "call:cancel":
        await _cancel(user, call_id)
    elif msg_type == "call:end":
        await _end(user, call_id)
    elif msg_type == "call:join":
        await _join(user, call_id)
    elif msg_type == "call:leave":
        await _leave(user, call_id)
    elif msg_type == "call:toggle_media":
        await _toggle_media(user, call_id, data.get("media_type", "audio"), data.get("enabled", True))


async def handle_user_disconnect(user: User) -> None:
    """All of a user's sockets dropped: resolve any call they were in."""
    call_id = _parse_uuid(await current_call_of(user.id))
    if call_id is None:
        return
    async with SessionLocal() as db:
        call = await _load_call(db, call_id)
        if call is None:
            return
        if call.status == CallStatus.ringing:
            if call.initiated_by == user.id:
                await _cancel(user, call_id)
            else:
                ids = await _call_participant_ids(db, call_id)
                caller = await db.get(User, call.initiated_by) if call.initiated_by else None
                await _finalize(db, call, CallStatus.missed, system_note=f"{_call_emoji(call)} Missed call")
                if call.initiated_by:
                    await publish_to_users(
                        [call.initiated_by], {"type": "call:missed", "call_id": str(call_id)}
                    )
                _ = ids, caller
        elif call.status == CallStatus.connected:
            if call.is_group:
                await _leave(user, call_id)
            else:
                await _end(user, call_id, reason="disconnected")


def mint_token(call: Call, user: User) -> str:
    settings = get_settings()
    token = (
        lk_api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(str(user.id))
        .with_name(user.display_name)
        .with_grants(
            lk_api.VideoGrants(
                room_join=True,
                room=call.room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .with_ttl(dt.timedelta(hours=6))
    )
    return token.to_jwt()


def _parse_uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


async def serialize_call(db: AsyncSession, call: Call, for_user: uuid.UUID) -> dict:
    parts = (
        await db.execute(
            select(CallParticipant, User)
            .join(User, User.id == CallParticipant.user_id)
            .where(CallParticipant.call_id == call.id)
        )
    ).all()
    participants = []
    initiator = None
    seen_by = []
    for cp, u in parts:
        entry = {"user_id": str(u.id), "display_name": u.display_name, "avatar_url": u.avatar_url}
        participants.append(entry)
        if u.id == call.initiated_by:
            initiator = entry
        if cp.seen_at is not None:
            seen_by.append(str(u.id))
    direction = "outgoing" if call.initiated_by == for_user else "incoming"
    other = next((p for p in participants if p["user_id"] != str(for_user)), None)
    return {
        "_id": str(call.id),
        "call_id": str(call.id),
        "call_type": call.type.value,
        "is_group": call.is_group,
        "status": call.status.value,
        "conversation_id": str(call.conversation_id) if call.conversation_id else None,
        "initiator": initiator,
        "participants": participants,
        "started_at": iso_z(call.started_at),
        "answered_at": iso_z(call.answered_at),
        "ended_at": iso_z(call.ended_at),
        "duration": _duration_of(call),
        "org_id": str(call.org_id) if call.org_id else None,
        "created_at": iso_z(call.started_at),
        "seen_by": seen_by,
        "direction": direction,
        "other_participant": other,
    }
