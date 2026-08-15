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
from app.core.security import MOBILE_CLIENT
from app.db.models import ConversationParticipant, User, UserRole
from app.db.session import SessionLocal
from app.realtime.redis_bus import get_redis, publish_to_users, user_channel
from app.services import presence
from app.utils import iso_z, now_utc

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_MESSAGE_BYTES = 10 * 1024
RATE_LIMIT_PER_MINUTE = 120
HEARTBEAT_TIMEOUT = 65
# How stale the account state behind an open socket may get. One row read per
# socket per interval, so this is a cost/latency dial rather than a correctness
# one: sending is separately re-checked per message against the live row, and
# HTTP was already refusing the moment the change landed. This bounds how long a
# revoked session keeps RECEIVING.
REVALIDATE_SECONDS = 30

# How far behind one socket may fall before it is dropped rather than waited for.
# A healthy socket's outbox is empty between events, so this is only ever reached by
# a client that has stopped draining. 128 small frames bounds what a wedged client
# can pin in memory while being far more headroom than any client legitimately uses.
OUTBOX_MAX_FRAMES = 128


class _Conn:
    """One socket, its outbound queue, and the single task that drains it.

    The queue exists because _reader is ONE task per worker. Awaiting send_text
    there serialised delivery for every user behind the slowest socket, and a client
    that stops reading does not fail fast: uvicorn's websocket send awaits the
    transport drain, so the await stays pending until TCP gives up — minutes, not
    seconds. Measured on the real registry with one socket wedged, a second user
    received 0 of 5 events for the whole stall and all 5 only once it was released.

    One writer task per socket means the socket has exactly ONE sender, so its frames
    keep their order without a lock. That covers the whole outbound stream, not just
    the pub/sub half: websocket_endpoint queues its own `pong` and protocol-error
    frames through registry.send_to rather than writing to the socket, so nothing
    races the reader's frames.

    The single exception is `connected`, and it is deliberate — it is written directly
    BEFORE the socket is registered, when no writer exists and nothing can have been
    queued yet, which is what makes it provably the first frame rather than merely
    usually first. Everything after registration goes through this queue.
    """

    __slots__ = ("ws", "outbox", "writer", "closing")

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.outbox: asyncio.Queue[str] = asyncio.Queue(maxsize=OUTBOX_MAX_FRAMES)
        self.writer: asyncio.Task | None = None
        self.closing = False


class LocalRegistry:
    """Sockets held by THIS worker. Multiple tabs per user are allowed —
    each connection gets its own id (the Mongo build kicked older tabs and
    caused reconnect wars)."""

    def __init__(self) -> None:
        self.connections: dict[str, dict[str, _Conn]] = {}
        self._pubsub_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    async def add(self, user_id: uuid.UUID, conn_id: str, ws: WebSocket) -> None:
        # SUBSCRIBE FIRST, then register the socket.
        #
        # The other order leaves a window in which this worker holds a live socket it
        # has not yet subscribed a channel for, so anything published to that user in
        # the meantime is dropped by the broker with no subscriber. It is a small
        # window, but a reconnecting client's first act is to be sent its resumed call
        # state, and losing that frame is precisely the failure this whole path exists
        # to prevent. Subscribing to a channel with no sockets yet is harmless: the
        # reader simply finds an empty bucket and moves on.
        if self._pubsub is not None and str(user_id) not in self.connections:
            with contextlib.suppress(Exception):
                await self._pubsub.subscribe(user_channel(user_id))
        conn = _Conn(ws)
        conn.writer = asyncio.create_task(self._writer(conn))
        async with self._lock:
            self.connections.setdefault(str(user_id), {})[conn_id] = conn

    async def remove(self, user_id: uuid.UUID, conn_id: str) -> None:
        async with self._lock:
            bucket = self.connections.get(str(user_id), {})
            conn = bucket.pop(conn_id, None)
            last_for_user = not bucket
            if last_for_user:
                self.connections.pop(str(user_id), None)
        # The writer holds a reference to the socket and would otherwise sit awaiting
        # an outbox nothing will fill again.
        if conn is not None and conn.writer is not None:
            conn.writer.cancel()
        if last_for_user and self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.unsubscribe(user_channel(user_id))
            # A reconnect that landed between the pop above and this unsubscribe would
            # otherwise be left holding a live socket on an unsubscribed channel — the
            # user would appear online and receive nothing at all until their next
            # reconnect. Cheap to re-check, and the window is exactly the one a client
            # hits when it drops and immediately reconnects, which is the common case
            # mid-call.
            async with self._lock:
                resubscribe = str(user_id) in self.connections
            if resubscribe:
                with contextlib.suppress(Exception):
                    await self._pubsub.subscribe(user_channel(user_id))

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
        async with self._lock:
            writers = [c.writer for bucket in self.connections.values() for c in bucket.values() if c.writer]
        for writer in writers:
            writer.cancel()
        if self._pubsub is not None:
            with contextlib.suppress(Exception):
                await self._pubsub.aclose()

    async def send_to(self, user_id: uuid.UUID, conn_id: str, payload: str) -> bool:
        """Queue one frame for ONE socket, through that socket's writer.

        This is how websocket_endpoint writes its own frames — pong and the protocol
        errors — so that every frame a registered socket receives goes through a single
        sender and the whole stream is ordered, not just the pub/sub half of it.

        Returns False when the socket is gone or has just been dropped for being
        wedged, so a caller is never told a frame was queued when it was not.

        Lookup, the closing check and the enqueue are ONE critical section, because
        that return value is a promise. Releasing the lock in between let `remove` pop
        the connection and cancel its writer before the enqueue landed, and this then
        answered True for a frame no live writer would ever pick up.

        _reader deliberately does not take the lock for its own enqueue: it makes no
        promise to anyone, so the worst a removal race costs there is a frame left in
        the outbox of a connection about to be collected — and taking this lock per
        message would put every event on the worker behind add/remove.
        """
        async with self._lock:
            conn = self.connections.get(str(user_id), {}).get(conn_id)
            if conn is None or conn.closing:
                return False
            try:
                conn.outbox.put_nowait(payload)
            except asyncio.QueueFull:
                # Safe under the lock: _drop_wedged never awaits.
                self._drop_wedged(conn)
                return False
            return True

    async def _writer(self, conn: _Conn) -> None:
        """Drain one socket's outbox. The only place send_text is called."""
        while True:
            data = await conn.outbox.get()
            try:
                await conn.ws.send_text(data)
            except Exception:
                return  # dead socket; the endpoint's finally block deregisters it

    def _drop_wedged(self, conn: _Conn) -> None:
        """Close a socket that has fallen OUTBOX_MAX_FRAMES behind.

        Dropping the frame instead would leave a client that looks connected and
        silently receives nothing. Closing makes it reconnect and refetch, which is
        how every other lost-frame case in this file already self-heals. Code 1011,
        not 4001: both clients treat 4001 as "refresh the session" and any other code
        as a plain disconnect to retry with backoff.

        Never awaited, and that is the point — close() sends a frame too, so on a
        socket that is already not draining it can block exactly like send_text, and
        awaiting it here would hand the stall straight back to _reader.
        """
        if conn.closing:
            return
        conn.closing = True
        if conn.writer is not None:
            conn.writer.cancel()
        asyncio.create_task(self._close_quietly(conn))

    async def _close_quietly(self, conn: _Conn) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(conn.ws.close(code=1011, reason="Outbound backlog exceeded"), timeout=5)

    async def _reader(self) -> None:
        while True:
            try:
                message = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
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
            conns = list(self.connections.get(target_user, {}).values())
            if not conns:
                continue
            # ENQUEUE, never send. This loop is the worker's only pub/sub consumer,
            # so anything awaited here is awaited on behalf of every other user too.
            for conn in conns:
                try:
                    conn.outbox.put_nowait(message["data"])
                except asyncio.QueueFull:
                    self._drop_wedged(conn)
            # Hand control back so the writers above can actually drain.
            #
            # get_message() returns already-buffered messages without suspending, and
            # awaiting a coroutine that returns immediately does NOT yield in asyncio.
            # So a backlog — anything that stalled this worker for a moment, including
            # the very stalls this queue exists to survive — would be drained here in
            # one tight loop, filling a HEALTHY socket's outbox and getting it closed
            # for a burst it could have absorbed. With this yield, queue depth measures
            # how slow a socket is rather than how bursty the reader was.
            await asyncio.sleep(0)

    def local_socket_count(self) -> int:
        return sum(len(b) for b in self.connections.values())


registry = LocalRegistry()


async def _conversation_partner_ids(db, user_id: uuid.UUID) -> list[uuid.UUID]:
    """Distinct users sharing at least one conversation with user_id."""
    mine = select(ConversationParticipant.conversation_id).where(ConversationParticipant.user_id == user_id)
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
    return (await db.get(ConversationParticipant, (conversation_id, user_id))) is not None


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
        auth = await get_current_user_ws(websocket, db)
    if auth is None:
        await websocket.accept()
        await websocket.close(code=4001, reason="Invalid token")
        return
    user, token_exp, client = auth

    await websocket.accept()
    # `connected` goes out BEFORE the socket is registered, and that ordering is the
    # point. Once registry.add subscribes the user's channel and starts the writer, a
    # published event can be queued for this socket at any moment — so a `connected`
    # sent after registration is not reliably the first frame on the wire. Sent here
    # there is no writer yet and nothing can be queued, which makes it provably first;
    # every frame after it goes through registry.send_to or the pub/sub path, so the
    # socket's whole stream has exactly one sender and one order.
    #
    # Safe to sit outside the try below: nothing has been registered yet, so a client
    # that vanished mid-handshake leaves nothing to tear down.
    await websocket.send_text(
        json.dumps({"type": "connected", "user_id": str(user.id), "timestamp": iso_z(now_utc())})
    )
    last_active_check = now_utc()
    conn_id = uuid.uuid4().hex
    await registry.add(user.id, conn_id, websocket)
    # The try opens HERE — immediately after the socket enters the registry —
    # rather than after the handshake below, because the teardown in `finally` is
    # the only thing that ever removes it. Three of the awaits between this line
    # and the receive loop raise in ordinary operation: presence.mark_online talks
    # to Redis, the last_seen_at block talks to Postgres, and send_text fails
    # outright for a tab that navigated away mid-handshake. With the guard
    # starting later, any of those escaping left the entry in
    # LocalRegistry.connections and the user's Redis channel subscribed for the
    # life of the process — nothing else prunes them. A Redis blip during a
    # reconnect storm therefore leaked a socket per failed handshake, left _reader
    # fanning every future event at a dead connection, drifted the ws_local_sockets
    # gauge upward permanently, and skipped handle_user_link_down so a call the
    # user was in never got its grace window.
    try:
        came_online = await presence.mark_online(user.id, conn_id, org_id=user.org_id)
        if came_online:
            async with SessionLocal() as db:
                db_user = await db.get(User, user.id)
                if db_user:
                    db_user.last_seen_at = now_utc()
                    await db.commit()
            await _broadcast_presence(user, "online")

        # A socket coming up is the only moment we can repair call state this user missed
        # while it was down: closing any grace window a previous drop opened, and
        # re-delivering the ring (or full connected state) that was published to a channel
        # with no subscriber. That second half is what makes a call placed during the
        # callee's reconnect survive at all — previously the ring was simply lost and the
        # phone never rang, while the server went on ringing for another forty seconds.
        #
        # Best-effort: a Redis hiccup here must not refuse an otherwise good socket.
        # Clients additionally fetch GET /api/calls/active on connect, so a frame lost
        # here still self-heals.
        from app.services.calls import resume_calls_for

        with contextlib.suppress(Exception):
            await resume_calls_for(user.id)

        window_start = now_utc()
        window_count = 0
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=HEARTBEAT_TIMEOUT)
            except TimeoutError:
                break  # no ping for >60s — drop the connection
            except RuntimeError:
                # Starlette raises RuntimeError, not WebSocketDisconnect, when a receive
                # follows a disconnect it has already recorded internally — which happens
                # when the client vanishes at roughly the same moment as the heartbeat
                # deadline. It is an ordinary disconnect and the teardown in `finally`
                # handles it identically; letting it escape logged a full "Exception in
                # ASGI application" traceback for each one, which is exactly the noise
                # that hides the errors worth reading.
                break

            if len(raw) > MAX_MESSAGE_BYTES:
                await registry.send_to(
                    user.id, conn_id, json.dumps({"type": "error", "detail": "Message too large"})
                )
                continue

            now = now_utc()
            if (now - window_start).total_seconds() > 60:
                window_start, window_count = now, 0
            window_count += 1
            if window_count > RATE_LIMIT_PER_MINUTE:
                await registry.send_to(
                    user.id, conn_id, json.dumps({"type": "error", "detail": "Rate limited"})
                )
                continue

            try:
                data = json.loads(raw)
                if not isinstance(data, dict) or not isinstance(data.get("type"), str):
                    raise ValueError
            except ValueError:
                await registry.send_to(
                    user.id, conn_id, json.dumps({"type": "error", "detail": "Invalid frame"})
                )
                continue

            # REVALIDATION — on every frame, not only on ping.
            #
            # These checks used to live inside the `ping` branch below, which was
            # a real bypass rather than a theoretical one: the 65s receive
            # timeout resets on ANY frame, so a client that sent `typing_start`
            # every 30s and never pinged kept its socket open indefinitely and
            # was never re-checked. A deactivated account, a revoked mobile
            # grant and an expired access token all survived for as long as the
            # client cared to keep typing.
            #
            # Hoisted here, after the frame has parsed and before it is
            # dispatched, so no frame can be handled without the account having
            # been validated within REVALIDATE_SECONDS.
            #
            # The wall-clock gate means the cost stays one row read per socket
            # per interval regardless of how chatty the client is.
            if token_exp and now.timestamp() > token_exp:
                await websocket.close(code=4001, reason="Token expired")
                break
            if (now - last_active_check).total_seconds() > REVALIDATE_SECONDS:
                last_active_check = now
                async with SessionLocal() as db:
                    fresh = await db.get(User, user.id)
                if fresh is None or not fresh.is_active:
                    await websocket.close(code=4001, reason="Account inactive")
                    break
                # Same re-check for the mobile grant. Without it a phone whose
                # access a superadmin just revoked would keep receiving messages
                # on this socket until its access token lapsed — up to the full
                # token lifetime — even though its HTTP calls were already 401ing.
                if client == MOBILE_CLIENT and (fresh.role == UserRole.superadmin or not fresh.mobile_access):
                    await websocket.close(code=4001, reason="Mobile access revoked")
                    break

            if data["type"] == "ping":
                await presence.refresh(user.id, org_id=user.org_id)
                await registry.send_to(
                    user.id, conn_id, json.dumps({"type": "pong", "timestamp": iso_z(now_utc())})
                )
                continue

            try:
                await _handle_inbound(user, data)
            except Exception:
                logger.exception("error handling ws frame type=%s", data.get("type"))
                with contextlib.suppress(Exception):
                    await registry.send_to(
                        user.id, conn_id, json.dumps({"type": "error", "detail": "Internal error"})
                    )
    except WebSocketDisconnect:
        pass
    finally:
        await registry.remove(user.id, conn_id)
        went_offline = await presence.mark_offline(user.id, conn_id, org_id=user.org_id)
        if went_offline:
            async with SessionLocal() as db:
                db_user = await db.get(User, user.id)
                if db_user:
                    db_user.last_seen_at = now_utc()
                    await db.commit()
            await _broadcast_presence(user, "offline")
            # NOT a hang-up. This opens a grace window and tells the peers to show
            # "Connecting…"; the call is only resolved if the user is still missing
            # when the window closes. See services/calls.handle_user_link_down for
            # why ending the call here was wrong — most importantly, this path runs
            # every time the 15-minute access cookie lapses, and it used to kill
            # every call that outlived the remaining cookie lifetime.
            from app.services.calls import handle_user_link_down

            with contextlib.suppress(Exception):
                await handle_user_link_down(user)
