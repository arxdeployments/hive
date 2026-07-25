"""Search: parameterized FTS/ILIKE, org-scoped, injection-safe."""

from tests.conftest import login


async def _seed(client, users):
    await login(client, "alice@a.com")
    conv = (
        await client.post("/api/conversations/direct", json={"participant_id": str(users["bob"].id)})
    ).json()["_id"]
    await client.post(
        f"/api/conversations/{conv}/messages",
        json={"content": "quarterly financials review", "type": "text", "temp_id": "s1"},
    )
    return conv


async def test_search_is_org_scoped_and_finds_messages(client, two_orgs_with_users):
    users = two_orgs_with_users
    await _seed(client, users)

    # message search
    resp = await client.get("/api/search", params={"q": "quarterly"})
    assert any("quarterly" in m["content_snippet"] for m in resp.json()["messages"])

    # contact search (a term that matches the contact's name)
    resp = await client.get("/api/search", params={"q": "Bob"})
    assert any(c["display_name"] == "Bob" for c in resp.json()["contacts"])


async def test_search_special_characters_do_not_crash_or_injection(client, two_orgs_with_users):
    users = two_orgs_with_users
    await _seed(client, users)

    # ReDoS / LIKE-wildcard / SQL-ish payloads must be treated as literals
    for payload in ["(a+)+$", "100%", "under_score", "'; DROP TABLE messages;--", "%"]:
        resp = await client.get("/api/search", params={"q": payload})
        assert resp.status_code == 200
        # a literal "%" must NOT match everything
        if payload == "%":
            assert resp.json()["messages"] == []


async def test_conversation_message_search_escapes_wildcards(client, two_orgs_with_users):
    users = two_orgs_with_users
    conv = await _seed(client, users)
    resp = await client.post(f"/api/conversations/{conv}/messages/search", params={"q": "%"})
    assert resp.status_code == 200
    # "%" is a literal here — the "quarterly financials" message has no percent sign
    assert resp.json()["total"] == 0
