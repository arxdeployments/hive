"""Account revalidation behind a live websocket.

WHAT IS AND IS NOT COVERED HERE

The websocket's periodic revalidation was moved out of the `ping` branch so that
EVERY frame revalidates. That was a real bypass: the 65s receive timeout resets
on any frame, so a client sending `typing_start` every 30s and never pinging
kept its socket open indefinitely and was never re-checked — a deactivated
account, a revoked mobile grant and an expired access token all survived for as
long as it kept typing.

That hoist is NOT covered end to end here. Driving the real socket needs
Starlette's synchronous TestClient, which runs its own event loop and cannot
share the async session engine these tests use — it fails in teardown with
asyncpg futures attached to a different loop, not on the assertion. Making it
work needs either a live-server fixture or reworking the engine's loop
ownership, both larger than this change.

What IS covered is the gate the hoist backstops: a deactivated user cannot send,
checked per message against the live row. Revalidation bounds how long a revoked
session keeps RECEIVING; the check below is what stops it SENDING, and it is the
security-relevant half.
"""

import asyncio
import uuid

from httpx import ASGITransport, AsyncClient

from app.db.models import User
from app.db.session import SessionLocal
from app.main import app
from app.realtime import hub
from app.realtime.redis_bus import publish_to_users
from app.services.messaging import SendError, send_message
from tests.conftest import CSRF, login, make_org, make_user


async def _deactivate(user_id):
    async with SessionLocal() as db:
        row = await db.get(User, user_id)
        row.is_active = False
        await db.commit()


def test_revalidation_is_a_timer_not_a_frame_type():
    """Weak alone, but it pins the shape the fix depends on.

    REVALIDATE_SECONDS existing at module scope is what lets the check sit
    outside the ping branch and be gated by the wall clock rather than by which
    frame happened to arrive. It must also be shorter than the heartbeat
    timeout, or a socket could close before ever revalidating.
    """
    assert isinstance(hub.REVALIDATE_SECONDS, int)
    assert 0 < hub.REVALIDATE_SECONDS <= hub.HEARTBEAT_TIMEOUT


async def test_deactivated_sender_cannot_post_even_with_a_live_session(client):
    org = await make_org("WS Send Co")
    a = await make_user("a@wssend.com", org_id=org.id)
    b = await make_user("b@wssend.com", org_id=org.id)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, "a@wssend.com")
        conv = (await c.post("/api/conversations/direct", json={"participant_id": str(b.id)})).json()["_id"]

    await _deactivate(a.id)

    # The websocket send path re-loads the sender row per frame, so this is
    # exactly the object hub.py would hand to send_message after deactivation.
    async with SessionLocal() as db:
        sender = await db.get(User, a.id)
        try:
            await send_message(db, conversation_id=uuid.UUID(conv), sender=sender, content="should not land")
            raise AssertionError("a deactivated user was able to send")
        except SendError as exc:
            assert exc.status_code == 403
            assert "no longer active" in exc.detail


async def test_an_active_sender_is_unaffected(client):
    """Negative control: the new gate must not block ordinary sending."""
    org = await make_org("WS Active Co")
    await make_user("a@wsact.com", org_id=org.id)
    b = await make_user("b@wsact.com", org_id=org.id)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, "a@wsact.com")
        conv = (await c.post("/api/conversations/direct", json={"participant_id": str(b.id)})).json()["_id"]
        sent = await c.post(f"/api/conversations/{conv}/messages", json={"content": "fine"})
        assert sent.status_code == 200, sent.text


class _WedgedSocket:
    """A client that has stopped reading: its send never completes until released.

    Not artificial. uvicorn's ASGI websocket send awaits the transport drain, so a
    real socket behaves exactly like this once a non-reading peer's buffers fill —
    measured at ~0.8MB on loopback, and it stays pending until TCP gives up.
    """

    def __init__(self) -> None:
        self.release = asyncio.Event()
        self.entered = asyncio.Event()
        self.closed: tuple[int, str] | None = None

    async def send_text(self, data: str) -> None:
        self.entered.set()
        await self.release.wait()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


class _HealthySocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed: tuple[int, str] | None = None

    async def send_text(self, data: str) -> None:
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


async def test_one_stalled_socket_does_not_block_delivery_to_other_users():
    """A worker's fan-out must not serialise behind its slowest socket.

    _reader is ONE task per worker. It used to `await ws.send_text(...)` inline, so a
    client that stopped reading stalled delivery for EVERY user that worker served —
    no messages, no typing, no presence, no call ring — until TCP gave up, which is
    minutes rather than seconds. Measured against the old code: the bystander below
    received 0 of its events during the stall and all of them only once the wedged
    socket was released, at 2.0s latency.

    Uses the real LocalRegistry and the real Redis pub/sub; only the sockets are
    stubs, because the behaviour under test is what the registry does with a send
    that does not return.
    """
    registry = hub.LocalRegistry()
    await registry.start()
    stalled, bystander = _WedgedSocket(), _HealthySocket()
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    try:
        await registry.add(user_a, "conn-a", stalled)
        await registry.add(user_b, "conn-b", bystander)
        await asyncio.sleep(0.3)  # let SUBSCRIBE take effect

        await publish_to_users([user_a], {"type": "wedge"})
        await asyncio.wait_for(stalled.entered.wait(), timeout=5)

        for i in range(5):
            await publish_to_users([user_b], {"type": "for_b", "n": i})
        for _ in range(40):  # up to 4s, but returns as soon as they land
            if len(bystander.sent) == 5:
                break
            await asyncio.sleep(0.1)

        assert len(bystander.sent) == 5, (
            f"only {len(bystander.sent)}/5 events reached a second user while one "
            "socket was stalled — the worker's fan-out is head-of-line blocked"
        )
        assert bystander.closed is None
    finally:
        stalled.release.set()
        await registry.stop()


async def test_a_socket_that_never_drains_is_dropped_rather_than_waited_for():
    """Overflow closes the wedged socket, and only it.

    Dropping frames silently would leave a client that looks connected and receives
    nothing. 1011 rather than 4001 because both clients treat 4001 as "refresh the
    session" and any other code as a plain disconnect to retry with backoff — so the
    close is what makes this self-heal via reconnect-and-refetch.
    """
    registry = hub.LocalRegistry()
    await registry.start()
    stalled, bystander = _WedgedSocket(), _HealthySocket()
    user_a, user_b = uuid.uuid4(), uuid.uuid4()
    try:
        await registry.add(user_a, "conn-a", stalled)
        await registry.add(user_b, "conn-b", bystander)
        await asyncio.sleep(0.3)

        overflow_by = 10
        total = hub.OUTBOX_MAX_FRAMES + overflow_by
        for i in range(total):
            await publish_to_users([user_a], {"n": i})
            await publish_to_users([user_b], {"n": i})
        for _ in range(60):  # up to 6s
            if stalled.closed is not None and len(bystander.sent) == total:
                break
            await asyncio.sleep(0.1)

        assert stalled.closed is not None, "a socket that never drains was never dropped"
        assert stalled.closed[0] == 1011, stalled.closed
        assert bystander.closed is None, "the healthy socket must not be collateral"
        assert len(bystander.sent) == total, f"{len(bystander.sent)}/{total} reached the healthy socket"
    finally:
        stalled.release.set()
        await registry.stop()


async def test_a_burst_larger_than_the_outbox_does_not_close_a_healthy_socket():
    """Queue depth must measure socket slowness, not reader burstiness.

    get_message() returns already-buffered messages without suspending, and awaiting
    a coroutine that returns immediately does not yield in asyncio. Without a yield
    in the reader, a backlog gets drained in one tight loop, so a healthy socket's
    outbox fills and it is closed with 1011 for a burst it could easily have
    absorbed — a false positive on exactly the clients this change is meant to
    protect.
    """
    registry = hub.LocalRegistry()
    await registry.start()
    healthy = _HealthySocket()
    user = uuid.uuid4()
    try:
        await registry.add(user, "conn", healthy)
        await asyncio.sleep(0.3)

        # ONE pipeline, one round trip: Redis then hands the reader a buffered run of
        # messages, which is the condition that makes get_message stop suspending.
        # Publishing them one await at a time would yield between each and never
        # reproduce it — the mistake this test was written wrong with the first time.
        burst = hub.OUTBOX_MAX_FRAMES * 3
        await publish_to_users([user] * burst, {"burst": True})
        for _ in range(80):  # up to 8s
            if len(healthy.sent) == burst:
                break
            await asyncio.sleep(0.1)

        assert healthy.closed is None, f"a healthy socket was dropped: {healthy.closed}"
        assert len(healthy.sent) == burst, f"{len(healthy.sent)}/{burst} delivered"
    finally:
        await registry.stop()
