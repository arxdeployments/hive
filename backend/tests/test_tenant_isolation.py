"""THE P1 exit gate: org A can provably never read org B.

Every historical IDOR from the security punch-list gets a regression test:
message react, forward, delete, info, conversation reads, contacts, search.
"""

from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.conftest import CSRF, login


async def _fresh_client() -> AsyncClient:
    c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    c.headers.update(CSRF)
    return c


async def _setup_conversation_with_message(client, users):
    """Alice (org A) messages Bob (org A); returns conv id + message id."""
    await login(client, "alice@a.com")
    resp = await client.post("/api/conversations/direct", json={"participant_id": str(users["bob"].id)})
    assert resp.status_code == 200, resp.text
    conv_id = resp.json()["_id"]
    resp = await client.post(
        f"/api/conversations/{conv_id}/messages",
        json={"content": "org A secret", "type": "text", "temp_id": "t1"},
    )
    assert resp.status_code == 200, resp.text
    return conv_id, resp.json()["_id"]


async def test_cross_org_message_actions_all_404(client, two_orgs_with_users):
    conv_id, msg_id = await _setup_conversation_with_message(client, two_orgs_with_users)

    carol = await _fresh_client()
    async with carol:
        await login(carol, "carol@b.com")

        # read messages
        resp = await carol.get(f"/api/conversations/{conv_id}/messages")
        assert resp.status_code == 404
        # react (was CRITICAL IDOR)
        resp = await carol.post(f"/api/conversations/messages/{msg_id}/react", json={"emoji": "x"})
        assert resp.status_code == 404
        # forward (was exfiltration IDOR)
        resp = await carol.post(
            "/api/conversations/messages/forward",
            json={"message_id": msg_id, "conversation_ids": [], "contact_ids": []},
        )
        assert resp.status_code == 404
        # delete-for-me on foreign message
        resp = await carol.delete(f"/api/conversations/messages/{msg_id}")
        assert resp.status_code == 404
        # message info
        resp = await carol.get(f"/api/conversations/messages/{msg_id}/info")
        assert resp.status_code == 404
        # membership actions
        resp = await carol.put(f"/api/conversations/{conv_id}/pin")
        assert resp.status_code == 404
        resp = await carol.put(f"/api/conversations/{conv_id}/read")
        assert resp.status_code == 404
        # sending into the conversation
        resp = await carol.post(
            f"/api/conversations/{conv_id}/messages",
            json={"content": "intrusion", "type": "text"},
        )
        assert resp.status_code in (403, 404)


async def test_conversation_list_and_search_are_org_scoped(client, two_orgs_with_users):
    conv_id, _ = await _setup_conversation_with_message(client, two_orgs_with_users)

    carol = await _fresh_client()
    async with carol:
        await login(carol, "carol@b.com")
        resp = await carol.get("/api/conversations")
        assert resp.json() == {"data": [], "has_more": False}

        resp = await carol.get("/api/search", params={"q": "secret"})
        body = resp.json()
        assert body["conversations"] == [] and body["messages"] == [] and body["contacts"] == []

        resp = await carol.get("/api/users/contacts")
        names = [c["display_name"] for c in resp.json()]
        assert "Alice" not in names and "Bob" not in names


async def test_direct_conversation_across_orgs_rejected(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    resp = await client.post("/api/conversations/direct", json={"participant_id": str(users["carol"].id)})
    assert resp.status_code in (403, 404)


async def test_org_admin_portal_is_org_scoped(client, two_orgs_with_users):
    users = two_orgs_with_users
    from app.db.models import User, UserRole
    from app.db.session import SessionLocal

    async with SessionLocal() as db:
        alice = await db.get(User, users["alice"].id)
        alice.role = UserRole.org_admin
        await db.commit()

    await login(client, "alice@a.com")
    resp = await client.get("/api/org-admin/users")
    emails = [u["email"] for u in resp.json()["data"]]
    assert "carol@b.com" not in emails
    assert "bob@a.com" in emails

    # org admin cannot manage a foreign-org user
    resp = await client.put(f"/api/org-admin/users/{users['carol'].id}", json={"is_active": False})
    assert resp.status_code == 404

    resp = await client.post(f"/api/org-admin/users/{users['carol'].id}/reset-password")
    assert resp.status_code == 404


async def test_superadmin_rejected_from_org_admin_portal(client, two_orgs_with_users):
    from app.db.models import UserRole
    from tests.conftest import make_user

    await make_user("root@x.com", role=UserRole.superadmin)
    await login(client, "root@x.com")
    resp = await client.get("/api/org-admin/stats")
    assert resp.status_code == 403
