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

import uuid

from httpx import ASGITransport, AsyncClient

from app.db.models import User
from app.db.session import SessionLocal
from app.main import app
from app.realtime import hub
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
        conv = (
            await c.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).json()["_id"]

    await _deactivate(a.id)

    # The websocket send path re-loads the sender row per frame, so this is
    # exactly the object hub.py would hand to send_message after deactivation.
    async with SessionLocal() as db:
        sender = await db.get(User, a.id)
        try:
            await send_message(
                db, conversation_id=uuid.UUID(conv), sender=sender, content="should not land"
            )
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
        conv = (
            await c.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).json()["_id"]
        sent = await c.post(f"/api/conversations/{conv}/messages", json={"content": "fine"})
        assert sent.status_code == 200, sent.text
