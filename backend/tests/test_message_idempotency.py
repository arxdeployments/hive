"""Retry safety: a repeated send must not create a second message.

send_message commits before the sender learns anything, so a lost response, a
timeout or a 502 leaves the client unable to tell "never arrived" from "arrived,
answer lost". Retrying was how that uncertainty became two copies of one message.
"""

import asyncio
import contextlib

from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.conftest import CSRF, login


@contextlib.asynccontextmanager
async def _client_for(email):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, email)
        yield c


async def _direct(client, other_id) -> str:
    resp = await client.post("/api/conversations/direct", json={"participant_id": str(other_id)})
    assert resp.status_code == 200, resp.text
    return resp.json()["_id"]


async def _send(client, conv_id, content, **extra):
    resp = await client.post(
        f"/api/conversations/{conv_id}/messages",
        json={"content": content, "type": "text", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _history(client, conv_id):
    """Sent messages only — opening a direct conversation writes a system row."""
    resp = await client.get(f"/api/conversations/{conv_id}/messages")
    assert resp.status_code == 200, resp.text
    return [m for m in resp.json()["messages"] if m["type"] != "system"]


async def test_resend_with_same_temp_id_returns_the_same_message(client, two_orgs_with_users):
    """The uncertain case: the client never learned the first send landed."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    first = await _send(client, conv, "only once", temp_id="key-abc")
    again = await _send(client, conv, "only once", temp_id="key-abc")

    assert again["_id"] == first["_id"], "the retry must resolve to the original row"
    assert again["temp_id"] == "key-abc", "the sender's key is still echoed"
    assert again["status"] == "sent"

    body = [m for m in await _history(client, conv) if m["content"] == "only once"]
    assert len(body) == 1, f"expected one stored message, got {len(body)}"


async def test_history_exposes_the_client_key_for_reconciliation(client, two_orgs_with_users):
    """The client cannot drop a stale local bubble without this on every row."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    await _send(client, conv, "reconcile me", temp_id="key-xyz")

    stored = [m for m in await _history(client, conv) if m["content"] == "reconcile me"][0]
    assert stored["client_msg_id"] == "key-xyz"


async def test_a_changed_body_under_the_same_key_does_not_create_a_second_row(client, two_orgs_with_users):
    """The key identifies the send, so a repeat is the original — not an edit."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    first = await _send(client, conv, "the real one", temp_id="key-dup")
    again = await _send(client, conv, "a different body", temp_id="key-dup")

    assert again["_id"] == first["_id"]
    assert again["content"] == "the real one", "the stored message wins, nothing is overwritten"
    assert len(await _history(client, conv)) == 1


async def test_distinct_keys_still_create_distinct_messages(client, two_orgs_with_users):
    """The guard must not collapse two genuinely different sends."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    a = await _send(client, conv, "same words", temp_id="key-1")
    b = await _send(client, conv, "same words", temp_id="key-2")

    assert a["_id"] != b["_id"]
    assert len(await _history(client, conv)) == 2


async def test_sends_without_a_key_are_never_collapsed(client, two_orgs_with_users):
    """No temp_id means no idempotency claim — every send is its own message."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    await _send(client, conv, "no key here")
    await _send(client, conv, "no key here")

    stored = await _history(client, conv)
    assert len(stored) == 2
    assert all(m["client_msg_id"] is None for m in stored)


async def test_system_messages_carry_no_client_key(client, two_orgs_with_users):
    """They are not client-originated, so they stay outside the partial index."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    resp = await client.get(f"/api/conversations/{conv}/messages")
    system = [m for m in resp.json()["messages"] if m["type"] == "system"]
    assert system, "expected the conversation-started row"
    assert all(m["client_msg_id"] is None for m in system)


async def test_one_users_key_does_not_block_another(client, two_orgs_with_users):
    """The key is scoped per sender, so it cannot be used to suppress a peer."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    mine = await _send(client, conv, "from alice", temp_id="shared-key")

    async with _client_for("bob@a.com") as bob:
        theirs = await _send(bob, conv, "from bob", temp_id="shared-key")

    assert theirs["_id"] != mine["_id"], "bob's send must not resolve to alice's message"
    assert len(await _history(client, conv)) == 2


async def test_concurrent_identical_sends_store_one_message(client, two_orgs_with_users):
    """The check-then-act lookup can be lost; the unique index is the backstop."""
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    async def send():
        async with _client_for("alice@a.com") as c:
            resp = await c.post(
                f"/api/conversations/{conv}/messages",
                json={"content": "race", "type": "text", "temp_id": "key-race"},
            )
            return resp

    results = await asyncio.gather(*(send() for _ in range(4)), return_exceptions=True)
    assert all(not isinstance(r, Exception) for r in results), results
    assert all(r.status_code == 200 for r in results), [r.status_code for r in results]

    ids = {r.json()["_id"] for r in results}
    assert len(ids) == 1, f"concurrent sends resolved to {len(ids)} different messages"

    body = [m for m in await _history(client, conv) if m["content"] == "race"]
    assert len(body) == 1, f"expected one stored message, got {len(body)}"
