"""WebSocket hub: per-worker connection registry + Redis pub/sub delivery.

Any worker can serve any user: events are published to user:{id} channels
(app.realtime.redis_bus) and each worker's single pub/sub reader forwards to
the sockets it holds locally. Presence lives in Redis, so worker count is
invisible to clients — the single-node ceiling of the Mongo build is gone.

Client-facing protocol preserved from RxHivexx (docs/reference/ws-protocol.md):
inbound  ping / message / typing_start / typing_stop / read_receipt / call:*
outbound connected / pong / error / message_ack / new_message / message_status /
         messages_read / typing / presence / conversation + call events.
"""

import asyncio
import contextlib
import json
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from app.core.deps import get_current_user_ws
from app.db.models import ConversationParticipant, User
from app.db.session import SessionLocal
from app.realtime.redis_bus import get_redis, publish_to_users, user_channel
from app.services import presence
from app.utils import iso_z, now_utc

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MESSAGE_BYTES = 10 * 1024
RATE_LIMIT_PER_MINUTE = 120
HEARTBEAT_TIMEOUT = 65


class LocalRegistry:
    """Sockets held by THIS worker. Multiple tabs per user are allowed —
    each connection gets its own id (the Mongo build kicked older tabs and
    caused reconnect wars)."""

    def __init__(self) -> None:
        self.connections: dict[str, dict[str, WebSocket]] = {}
        self._pubsub_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def add(self, user_id: uuid.UUID, conn_id: str, ws: WebSocket) -> None:
        async with self._lock:
            bucket = self.connections.setdefault(str(user_id), {})
            first_for_user = not bucket
            bucket[conn_id] = ws
        if first_for_user and self._pubsub is not None:
            await self._pubsub.subscribe(user_channel(user_id))

    async def remove(self, user_id: uuid.UUID, conn_id: str) -> None:
        async with self._lock:
            bucket = self.connections.get(str(user_id), {})
            bucket.pop(conn_id, None)
            last_for_user = not bucket
            if last_for_user:
                self.connections.pop(str(user_id), None)
        if last_for_user and self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.unsubscribe(user_channel(user_id))

    _pubsub = None

    async def start(self) -> None:
        redis = get_redis()
        self._pubsub = redis.pubsub()
        # Subscribe to a placeholder so the reader loop has at least one channel.
        await self._pubsub.subscribe("rxhive:noop")
        self._pubsub_task = asyncio.create_task(self._reader())

    async def stop(self) -> None:
        if self._pubsub_task:
            self._pubsub_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._pubsub_task
        if self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.aclose()

    async def _reader(self) -> None:
        while True:
            try:
                message = await self._pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=1.0
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("pubsub reader error; reconnecting in 1s")
                await asyncio.sleep(1)
                continue
            if message is None:
                continue
            channel = message["channel"]
            if not channel.startswith("user:"):
                continue
            target_user = channel.removeprefix("user:")
            sockets = list(self.connections.get(target_user, {}).values())
            if not sockets:
                continue
            for ws in sockets:
                try:
                    await ws.send_text(message["data"])
                except Exception:
                    pass  # dead socket; its receive loop will clean up

    def local_socket_count(self) -> int:
        return sum(len(b) for b in self.connections.values())


registry = LocalRegistry()


async def _conversation_partner_ids(db, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Distinct users sharing at least one conversation with user_id."""
    mine = select(ConversationParticipant.conversation_id).where(
        ConversationParticipant.user_id == user_id
    )
    stmt = (
        select(ConversationParticipant.user_id)
        .where(
            ConversationParticipant.conversation_id.in_(mine),
            ConversationParticipant.user_id != user_id,
        )
        .distinct()
    )
    return (await db.execute(stmt)).scalars().all()


async def _broadcast_presence(user: User, status: str) -> None:
    async with SessionLocal() as db:
        partners = await _conversation_partner_ids(db, user.id)
    await publish_to_users(
        partners,
        {
            "type": "presence",
            "user_id": str(user.id),
            "status": status,
            "last_seen": iso_z(now_utc()) if status == "offline" else None,
        },
    )


async def _is_participant(db, conversation_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    return (
        await db.get(ConversationParticipant, (conversation_id, user_id))
    ) is not None


async def _handle_inbound(user: User, data: dict) -> None:
    """Dispatch one client frame. Every subscription/broadcast is
    membership-checked — no client-supplied identity is trusted."""
    from app.services import messaging  # late import to avoid module cycle
    from app.services.calls import handle_call_ws_message

    msg_type = data.get("type")

    if msg_type == "message":
        conv_id = _parse_uuid(data.get("conversation_id"))
        if conv_id is None:
            return
        async with SessionLocal() as db:
            sender = await db.get(User, user.id)
            try:
                doc = await messaging.send_message(
                    db,
                    conversation_id=conv_id,
                    sender=sender,
                    content=data.get("content", ""),
                    msg_type=data.get("msg_type", "text"),
                    reply_to=data.get("reply_to"),
                    temp_id=data.get("temp_id"),
                    media_url=data.get("media_url"),
                )
            except Exception as exc:  # surface an error frame with temp_id
                detail = getattr(exc, "detail", "Failed to send message")
                await publish_to_users(
                    [user.id],
                    {"type": "error", "detail": detail, "temp_id": data.get("temp_id")},
                )
                return
        await publish_to_users(
            [user.id],
            {
                "type": "message_ack",
                "temp_id": data.get("temp_id"),
                "message_id": doc["_id"],
                "created_at": doc["created_at"],
                "status": "sent",
            },
        )

    elif msg_type in ("typing_start", "typing_stop"):
        conv_id = _parse_uuid(data.get("conversation_id"))
        if conv_id is None:
            return
        async with SessionLocal() as db:
            if not await _is_participant(db, conv_id, user.id):
                return
            others = [
                uid
                for uid in (
                    (
                        await db.execute(
                            select(ConversationParticipant.user_id).where(
                                ConversationParticipant.conversation_id == conv_id
                            )
                        )
                    )
                    .scalars()
                    .all()
                )
                if uid != user.id
            ]
        await publish_to_users(
            others,
            {
                "type": "typing",
                "conversation_id": str(conv_id),
                "user_id": str(user.id),
                "user_name": user.display_name,
                "is_typing": msg_type == "typing_start",
            },
        )

    elif msg_type == "read_receipt":
        conv_id = _parse_uuid(data.get("conversation_id"))
        if conv_id is None:
            return
        async with SessionLocal() as db:
            reader = await db.get(User, user.id)
            with contextlib.suppress(Exception):
                await messaging.mark_read(
                    db,
                    conversation_id=conv_id,
                    reader=reader,
                    last_read_message_id=data.get("last_read_message_id"),
                )

    elif isinstance(msg_type, str) and msg_type.startswith("call:"):
        await handle_call_ws_message(user, data)


def _parse_uuid(value) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError):
        return None


@router.websocket("/api/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    async with SessionLocal() as db:
        user = await get_current_user_ws(websocket, db)
    if user is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="Invalid token")
        return

    await websocket.accept()
    conn_id = uuid.uuid4().hex
    await registry.add(user.id, conn_id, websocket)
    came_online = await presence.mark_online(user.id, conn_id)
    if came_online:
        async with SessionLocal() as db:
            db_user = await db.get(User, user.id)
            if db_user:
                db_user.last_seen_at = now_utc()
                await db.commit()
        await _broadcast_presence(user, "online")

    await websocket.send_text(
        json.dumps({"type": "connected", "user_id": str(user.id), "timestamp": iso_z(now_utc())})
    )

    window_start = now_utc()
    window_count = 0
    try:
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=HEARTBEAT_TIMEOUT)
            except TimeoutError:
                break  # no ping for >60s — drop the connection

            if len(raw) > MAX_MESSAGE_BYTES:
                await websocket.send_text(
                    json.dumps({"type": "error", "detail": "Message too large"})
                )
                continue

            now = now_utc()
            if (now - window_start).total_seconds() > 60:
                window_start, window_count = now, 0
            window_count += 1
            if window_count > RATE_LIMIT_PER_MINUTE:
                await websocket.send_text(json.dumps({"type": "error", "detail": "Rate limited"}))
                continue

            try:
                data = json.loads(raw)
                if not isinstance(data, dict) or not isinstance(data.get("type"), str):
                    raise ValueError
            except ValueError:
                await websocket.send_text(json.dumps({"type": "error", "detail": "Invalid frame"}))
                continue

            if data["type"] == "ping":
                await presence.refresh(user.id)
                await websocket.send_text(
                    json.dumps({"type": "pong", "timestamp": iso_z(now_utc())})
                )
                continue

            try:
                await _handle_inbound(user, data)
            except Exception:
                logger.exception("error handling ws frame type=%s", data.get("type"))
                with contextlib.suppress(Exception):
                    await websocket.send_text(
                        json.dumps({"type": "error", "detail": "Internal error"})
                    )
    except WebSocketDisconnect:
        pass
    finally:
        await registry.remove(user.id, conn_id)
        went_offline = await presence.mark_offline(user.id, conn_id)
        if went_offline:
            async with SessionLocal() as db:
                db_user = await db.get(User, user.id)
                if db_user:
                    db_user.last_seen_at = now_utc()
                    await db.commit()
            await _broadcast_presence(user, "offline")
            from app.services.calls import handle_user_disconnect

            with contextlib.suppress(Exception):
                await handle_user_disconnect(user)
