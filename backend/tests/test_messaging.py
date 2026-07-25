"""Messaging core contracts: replies, editing, deletes, reactions, unread."""

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


async def test_reply_is_persisted_and_enriched(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    first = await _send(client, conv, "original")
    reply = await _send(client, conv, "the reply", reply_to=first["_id"])
    assert reply["reply_to"] == first["_id"]
    assert reply["reply_to_message"]["content"] == "original"

    # reload from DB — the classic RxHivexx bug was replies lost on reload
    resp = await client.get(f"/api/conversations/{conv}/messages")
    stored = [m for m in resp.json()["messages"] if m["_id"] == reply["_id"]][0]
    assert stored["reply_to"] == first["_id"]
    assert stored["reply_to_message"]["content"] == "original"


async def test_reply_to_foreign_conversation_message_is_dropped(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv1 = await _direct(client, users["bob"].id)
    await _send(client, conv1, "in conv1")

    async with _client_for("bob@a.com") as bob:
        conv2_resp = await bob.post(
            "/api/conversations/group",
            json={"name": "G", "member_ids": [str(users["alice"].id), str(users["carol"].id)]},
        )
        # carol is foreign-org → group creation must fail entirely
        assert conv2_resp.status_code == 403


async def test_edit_message(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "tyop here")
    resp = await client.put(f"/api/conversations/messages/{msg['_id']}", json={"content": "typo fixed"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["content"] == "typo fixed"
    assert body["edited_at"] is not None

    async with _client_for("bob@a.com") as bob:
        resp = await bob.put(f"/api/conversations/messages/{msg['_id']}", json={"content": "hijack"})
        assert resp.status_code == 403


async def test_delete_for_me_actually_filters(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "delete me for alice only")

    resp = await client.delete(f"/api/conversations/messages/{msg['_id']}")
    assert resp.status_code == 200

    resp = await client.get(f"/api/conversations/{conv}/messages")
    assert msg["_id"] not in [m["_id"] for m in resp.json()["messages"]]

    async with _client_for("bob@a.com") as bob:
        resp = await bob.get(f"/api/conversations/{conv}/messages")
        assert msg["_id"] in [m["_id"] for m in resp.json()["messages"]]


async def test_delete_for_everyone_tombstones_and_only_sender(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "retracted")

    async with _client_for("bob@a.com") as bob:
        resp = await bob.delete(f"/api/conversations/messages/{msg['_id']}", params={"for_everyone": "true"})
        assert resp.status_code == 403

    resp = await client.delete(f"/api/conversations/messages/{msg['_id']}", params={"for_everyone": "true"})
    assert resp.status_code == 200

    resp = await client.get(f"/api/conversations/{conv}/messages")
    tomb = [m for m in resp.json()["messages"] if m["_id"] == msg["_id"]][0]
    assert tomb["is_deleted"] is True and tomb["content"] == ""


async def test_reaction_toggle_and_shape(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "react to me")

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/react", json={"emoji": "👍"})
    reactions = resp.json()["reactions"]
    assert reactions == [{"user_id": str(users["alice"].id), "user_name": "Alice", "emoji": "👍"}]

    # The loaded message must name the reactor too, or the client's reaction
    # tooltip is blank until the viewer happens to react themselves.
    resp = await client.get(f"/api/conversations/{conv}/messages")
    loaded = [m for m in resp.json()["messages"] if m["_id"] == msg["_id"]][0]
    assert loaded["reactions"][0]["user_name"] == "Alice"
    assert loaded["reactions"][0]["user_id"] == str(users["alice"].id)

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/react", json={"emoji": "👍"})
    assert resp.json()["reactions"] == []


async def test_unread_counts_and_read_receipts(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    await _send(client, conv, "one")
    await _send(client, conv, "two")

    async with _client_for("bob@a.com") as bob:
        data = (await bob.get("/api/conversations")).json()["data"]
        assert data[0]["unread_count"] == 2

        await bob.put(f"/api/conversations/{conv}/read")
        data = (await bob.get("/api/conversations")).json()["data"]
        assert data[0]["unread_count"] == 0

    # Alice now sees read receipts derived from Bob's last_read_at
    resp = await client.get(f"/api/conversations/{conv}/messages")
    for m in resp.json()["messages"]:
        if m["type"] == "text":
            assert any(r["user_id"] == str(users["bob"].id) for r in m["read_by"])


async def test_text_message_requires_content_and_media_requires_upload(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    resp = await client.post(f"/api/conversations/{conv}/messages", json={"content": "   ", "type": "text"})
    assert resp.status_code == 400
    resp = await client.post(f"/api/conversations/{conv}/messages", json={"content": "", "type": "image"})
    assert resp.status_code == 400  # media without a claimed upload URL
    resp = await client.post(
        f"/api/conversations/{conv}/messages",
        json={"content": "", "type": "image", "media_url": "https://evil.example/x.png"},
    )
    assert resp.status_code == 400  # foreign URLs can't be claimed


async def test_content_is_sanitized(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "<script>alert(1)</script>hello")
    assert "<script>" not in msg["content"]
    assert "hello" in msg["content"]


async def test_group_lifecycle_roles_and_admin_only(client, two_orgs_with_users):
    users = two_orgs_with_users
    from tests.conftest import make_user

    await make_user("erin@a.com", org_id=users["org_a"].id, display_name="Erin")

    await login(client, "alice@a.com")
    erin_id = None
    contacts = (await client.get("/api/users/contacts")).json()
    for c in contacts:
        if c["display_name"] == "Erin":
            erin_id = c["id"]

    resp = await client.post(
        "/api/conversations/group",
        json={"name": "Launch <b>Team</b>", "member_ids": [str(users["bob"].id), erin_id]},
    )
    assert resp.status_code == 200, resp.text
    group = resp.json()
    assert group["name"] == "Launch Team"  # sanitized
    roles = {p["display_name"]: p["role"] for p in group["participants"]}
    assert roles["Alice"] == "creator" and roles["Bob"] == "member"

    # admin-only messages: toggle on, member send rejected
    resp = await client.put(f"/api/conversations/{group['_id']}/group", json={"admin_only_messages": True})
    assert resp.status_code == 200
    async with _client_for("bob@a.com") as dave:  # bob is a plain member
        resp = await dave.post(
            f"/api/conversations/{group['_id']}/messages",
            json={"content": "member speaking", "type": "text"},
        )
        assert resp.status_code == 403
