"""Stars, pins, mute, group permissions, groups-in-common, export/clear, links.

Every one of these endpoints is membership-scoped, so the last test in this
module re-runs the whole surface as a foreign-org caller and demands a 404.
"""

import contextlib

from httpx import ASGITransport, AsyncClient

from app.db.models import UserRole
from app.main import app
from tests.conftest import CSRF, login, make_user


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


async def _send(client, conv_id, content, **extra) -> dict:
    resp = await client.post(
        f"/api/conversations/{conv_id}/messages",
        json={"content": content, "type": "text", **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _group_with_bob_and_erin(client, users) -> str:
    erin = await make_user("erin@a.com", org_id=users["org_a"].id, display_name="Erin")
    resp = await client.post(
        "/api/conversations/group",
        json={"name": "Ops", "member_ids": [str(users["bob"].id), str(erin.id)]},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["_id"]


async def _messages(client, conv_id) -> list[dict]:
    resp = await client.get(f"/api/conversations/{conv_id}/messages")
    assert resp.status_code == 200, resp.text
    return resp.json()["messages"]


async def test_star_toggle_round_trip_and_starred_list(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "worth keeping")

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/star")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"starred": True}

    stored = [m for m in await _messages(client, conv) if m["_id"] == msg["_id"]][0]
    assert stored["is_starred"] is True and stored["is_pinned"] is False

    resp = await client.get(f"/api/conversations/{conv}/starred")
    assert [m["_id"] for m in resp.json()["data"]] == [msg["_id"]]

    # Stars are private: Bob sees the same message unstarred and an empty list.
    async with _client_for("bob@a.com") as bob:
        theirs = [m for m in await _messages(bob, conv) if m["_id"] == msg["_id"]][0]
        assert theirs["is_starred"] is False
        assert (await bob.get(f"/api/conversations/{conv}/starred")).json() == {"data": []}

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/star")
    assert resp.json() == {"starred": False}
    assert (await client.get(f"/api/conversations/{conv}/starred")).json() == {"data": []}


async def test_pin_toggle_round_trip_is_conversation_wide(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    msg = await _send(client, conv, "pin this")

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/pin")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"pinned": True}

    resp = await client.get(f"/api/conversations/{conv}/pinned")
    assert [m["_id"] for m in resp.json()["data"]] == [msg["_id"]]

    # Pins are shared state — Bob sees the pin too.
    async with _client_for("bob@a.com") as bob:
        theirs = [m for m in await _messages(bob, conv) if m["_id"] == msg["_id"]][0]
        assert theirs["is_pinned"] is True
        assert [m["_id"] for m in (await bob.get(f"/api/conversations/{conv}/pinned")).json()["data"]] == [
            msg["_id"]
        ]

    resp = await client.post(f"/api/conversations/messages/{msg['_id']}/pin")
    assert resp.json() == {"pinned": False}
    assert (await client.get(f"/api/conversations/{conv}/pinned")).json() == {"data": []}


async def test_mute_toggle(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)

    assert (await client.put(f"/api/conversations/{conv}/mute")).json() == {"is_muted": True}
    assert (await client.put(f"/api/conversations/{conv}/mute")).json() == {"is_muted": False}


async def test_permissions_read_write_and_non_admin_403(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    group = await _group_with_bob_and_erin(client, users)

    resp = await client.get(f"/api/conversations/{group}/permissions")
    assert resp.status_code == 200, resp.text
    # Only enforced permissions are on the wire: send_history / invite_via_link /
    # approve_new_members were removed because nothing honoured them.
    assert resp.json() == {
        "edit_info": True,
        "send_messages": True,
        "add_members": True,
    }

    resp = await client.put(
        f"/api/conversations/{group}/permissions",
        json={"send_messages": False, "add_members": False},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["send_messages"] is False
    assert body["add_members"] is False
    assert body["edit_info"] is True  # untouched keys keep their value

    # send_messages=False is admin_only_messages=True: a plain member is refused.
    async with _client_for("bob@a.com") as bob:
        resp = await bob.post(f"/api/conversations/{group}/messages", json={"content": "hi", "type": "text"})
        assert resp.status_code == 403

        # Members may read permissions but never write them.
        assert (await bob.get(f"/api/conversations/{group}/permissions")).status_code == 200
        resp = await bob.put(f"/api/conversations/{group}/permissions", json={"send_messages": True})
        assert resp.status_code == 403

    resp = await client.get(f"/api/conversations/{group}/permissions")
    assert resp.json()["send_messages"] is False  # bob's 403 changed nothing


async def test_cross_org_group_admin_gets_404_from_permissions(client, two_orgs_with_users):
    """A cross-org participant with ParticipantRole.admin is not a group admin.

    These routes used to gate on membership alone, so this user could read and flip
    a superadmin-managed group's permissions — silencing another organization's
    participants, unaudited. Both verbs must 404 like every other /group route.
    """
    users = two_orgs_with_users
    await make_user("root@x.com", role=UserRole.superadmin)
    async with _client_for("root@x.com") as root:
        resp = await root.post(
            "/api/admin/cross-org-groups",
            json={
                "name": "Joint Programme",
                "org_ids": [str(users["org_a"].id), str(users["org_b"].id)],
                "members": [
                    {"user_id": str(users["alice"].id), "role": "admin"},
                    {"user_id": str(users["carol"].id), "role": "member"},
                ],
            },
        )
        assert resp.status_code == 200, resp.text
        group = resp.json()["_id"]

    await login(client, "alice@a.com")
    assert (await client.get(f"/api/conversations/{group}/permissions")).status_code == 404
    resp = await client.put(f"/api/conversations/{group}/permissions", json={"send_messages": False})
    assert resp.status_code == 404

    # Nothing was silenced: Carol's org can still post in the cross-org group.
    async with _client_for("carol@b.com") as carol:
        resp = await carol.post(
            f"/api/conversations/{group}/messages", json={"content": "hi", "type": "text"}
        )
        assert resp.status_code == 200, resp.text


async def test_groups_in_common(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    await _direct(client, users["bob"].id)  # direct chats are not "groups in common"
    group = await _group_with_bob_and_erin(client, users)

    resp = await client.get(f"/api/users/{users['bob'].id}/groups-in-common")
    assert resp.status_code == 200, resp.text
    assert [c["_id"] for c in resp.json()["data"]] == [group]

    # Bob sees the same shared group from his side.
    async with _client_for("bob@a.com") as bob:
        resp = await bob.get(f"/api/users/{users['alice'].id}/groups-in-common")
        assert [c["_id"] for c in resp.json()["data"]] == [group]


async def test_export_transcript_is_plain_text_and_respects_delete_for_me(client, two_orgs_with_users):
    """Export format, plus: export honours the caller's own delete-for-me rows.

    The per-message "Delete for me" action was removed, so the hiding is driven
    through "Clear chat" instead — the surviving feature that still writes
    MessageDeletion rows. The property under test is unchanged: one participant's
    hidden history must not affect anyone else's transcript.
    """
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    await _send(client, conv, "hello")
    await _send(client, conv, "world")

    resp = await client.get(f"/api/conversations/{conv}/export")
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("text/plain")
    assert f'filename="rxhive-chat-{conv}.txt"' in resp.headers["content-disposition"]
    lines = resp.text.strip().split("\n")
    assert lines[0].startswith("[") and "System: Conversation started" in lines[0]
    assert lines[1].endswith("Alice: hello") and lines[2].endswith("Alice: world")

    # Hide Alice's copy of the history.
    resp = await client.post(f"/api/conversations/{conv}/clear")
    assert resp.status_code == 200, resp.text

    alice_after = (await client.get(f"/api/conversations/{conv}/export")).text
    assert "hello" not in alice_after
    assert "world" not in alice_after

    # Bob's transcript is untouched.
    async with _client_for("bob@a.com") as bob:
        bob_after = (await bob.get(f"/api/conversations/{conv}/export")).text
        assert "hello" in bob_after
        assert "world" in bob_after


async def test_clear_chat_is_delete_for_me_only(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    await _send(client, conv, "keep me for bob")

    resp = await client.post(f"/api/conversations/{conv}/clear")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"message": "Chat cleared"}
    assert await _messages(client, conv) == []

    async with _client_for("bob@a.com") as bob:
        contents = [m["content"] for m in await _messages(bob, conv)]
        assert "keep me for bob" in contents


async def test_media_type_link_extracts_urls_without_fetching(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    conv = await _direct(client, users["bob"].id)
    await _send(client, conv, "specs at https://docs.example.com/a?b=1 and https://cdn.example.org/x.pdf.")
    await _send(client, conv, "no links here")

    resp = await client.get(f"/api/conversations/{conv}/media", params={"type": "link"})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert [item["url"] for item in data] == [
        "https://docs.example.com/a?b=1",
        "https://cdn.example.org/x.pdf",  # trailing sentence period is not part of the URL
    ]
    assert [item["domain"] for item in data] == ["docs.example.com", "cdn.example.org"]
    assert all(item["sender_name"] == "Alice" for item in data)
    assert all(item["title"] and item["created_at"] for item in data)


async def test_cross_tenant_404_on_every_new_endpoint(client, two_orgs_with_users):
    users = two_orgs_with_users
    await login(client, "alice@a.com")
    group = await _group_with_bob_and_erin(client, users)
    msg = await _send(client, group, "org A only")

    async with _client_for("carol@b.com") as carol:
        assert (await carol.post(f"/api/conversations/messages/{msg['_id']}/star")).status_code == 404
        assert (await carol.post(f"/api/conversations/messages/{msg['_id']}/pin")).status_code == 404
        assert (await carol.get(f"/api/conversations/{group}/starred")).status_code == 404
        assert (await carol.get(f"/api/conversations/{group}/pinned")).status_code == 404
        assert (await carol.put(f"/api/conversations/{group}/mute")).status_code == 404
        assert (await carol.get(f"/api/conversations/{group}/permissions")).status_code == 404
        resp = await carol.put(f"/api/conversations/{group}/permissions", json={"send_messages": False})
        assert resp.status_code == 404
        assert (await carol.get(f"/api/conversations/{group}/export")).status_code == 404
        assert (await carol.post(f"/api/conversations/{group}/clear")).status_code == 404
        resp = await carol.get(f"/api/conversations/{group}/media", params={"type": "link"})
        assert resp.status_code == 404
        resp = await carol.get(f"/api/users/{users['alice'].id}/groups-in-common")
        assert resp.status_code == 404

    # Nothing leaked and nothing changed: Alice's view is untouched.
    assert (await client.get(f"/api/conversations/{group}/pinned")).json() == {"data": []}
    assert (await client.get(f"/api/conversations/{group}/permissions")).json()["send_messages"] is True
