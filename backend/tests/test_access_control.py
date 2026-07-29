"""Chat reachability rules and send policies.

These are the tests conftest.make_user's `link_peers` escape hatch exists for:
every test here builds its own rules with link_peers=False, so it sees the real
deny-by-default behaviour instead of the blanket allow the other suites get.
"""

import uuid

from sqlalchemy import delete

from app.db.models import (
    AccessPartyType,
    ChatAccessRule,
    Department,
    SendPolicy,
    Upload,
    User,
)
from app.db.session import SessionLocal
from app.services.access import can_converse, canonical_pair, reachable_user_ids, resolve_send_policy
from tests.conftest import login, make_org, make_user

USER = AccessPartyType.user
DEPT = AccessPartyType.department


async def _rule(org_id, one, two, allow: bool):
    (a_type, a_id), (b_type, b_id) = canonical_pair(one, two)
    async with SessionLocal() as db:
        db.add(
            ChatAccessRule(
                org_id=org_id, a_type=a_type, a_id=a_id, b_type=b_type, b_id=b_id, allow=allow
            )
        )
        await db.commit()


async def _dept(org_id, name) -> Department:
    async with SessionLocal() as db:
        d = Department(org_id=org_id, name=name)
        db.add(d)
        await db.commit()
        await db.refresh(d)
        return d


async def _policy(org_id, scope: tuple, **kwargs):
    async with SessionLocal() as db:
        db.add(SendPolicy(org_id=org_id, scope_type=scope[0], scope_id=scope[1], **kwargs))
        await db.commit()


async def _upload(user_id, org_id, filename, file_type, mime) -> str:
    """A claimable Upload row, without going through the upload endpoint.

    The endpoint is deliberately not policy-gated (it is shared with the avatar
    flow), so writing the row directly is exactly the bypass a restricted user
    would attempt — and the claim is what must refuse it.
    """
    async with SessionLocal() as db:
        up = Upload(
            uploader_id=user_id,
            org_id=org_id,
            storage_key=f"test/{uuid.uuid4()}/{filename}",
            filename=filename,
            mime_type=mime,
            file_type=file_type,
            file_size=1234,
        )
        db.add(up)
        await db.commit()
        return f"/api/media/up/{up.id}"


async def _direct(client, other_id):
    return await client.post(
        "/api/conversations/direct", json={"participant_id": str(other_id)}
    )


# --------------------------------------------------------------------------
# Reachability
# --------------------------------------------------------------------------


async def test_deny_by_default_blocks_a_pair_with_no_rule(client):
    org = await make_org("Deny Co")
    await make_user("a@deny.com", org_id=org.id, link_peers=False)
    b = await make_user("b@deny.com", org_id=org.id, link_peers=False)

    await login(client, "a@deny.com")
    resp = await _direct(client, b.id)
    assert resp.status_code == 403, resp.text
    assert "not permitted" in resp.json()["detail"]


async def test_department_pair_rule_grants_reachability(client):
    org = await make_org("Dept Co")
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    await make_user("a@dept.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@dept.com", org_id=org.id, dept_id=pharmacy.id, link_peers=False)

    await login(client, "a@dept.com")
    assert (await _direct(client, b.id)).status_code == 403

    await _rule(
        org.id,
        (AccessPartyType.department, ward.id),
        (AccessPartyType.department, pharmacy.id),
        allow=True,
    )
    assert (await _direct(client, b.id)).status_code == 200


async def test_user_rule_overrides_department_rule_in_both_directions(client):
    """Most specific wins — including a user ALLOW over a department DENY."""
    org = await make_org("Specific Co")
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    a = await make_user("a@spec.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@spec.com", org_id=org.id, dept_id=pharmacy.id, link_peers=False)

    # Departments are blocked from each other...
    await _rule(
        org.id,
        (AccessPartyType.department, ward.id),
        (AccessPartyType.department, pharmacy.id),
        allow=False,
    )
    await login(client, "a@spec.com")
    assert (await _direct(client, b.id)).status_code == 403

    # ...but these two individuals are explicitly permitted.
    await _rule(org.id, (AccessPartyType.user, a.id), (AccessPartyType.user, b.id), allow=True)
    assert (await _direct(client, b.id)).status_code == 200


async def test_deny_wins_when_two_equally_specific_rules_disagree(client):
    """The level-2 tie: "A <-> dept(B)" and "B <-> dept(A)" can both exist.

    Resolving that towards allow would let one department's admin quietly widen
    another department's restriction, so deny wins.
    """
    org = await make_org("Tie Co")
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    a = await make_user("a@tie.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@tie.com", org_id=org.id, dept_id=pharmacy.id, link_peers=False)

    await _rule(org.id, (AccessPartyType.user, a.id), (AccessPartyType.department, pharmacy.id), allow=True)
    await _rule(org.id, (AccessPartyType.user, b.id), (AccessPartyType.department, ward.id), allow=False)

    await login(client, "a@tie.com")
    assert (await _direct(client, b.id)).status_code == 403


async def test_revoking_a_pair_makes_the_existing_conversation_read_only(client):
    """Revocation must not delete or hide history — the composer stops, that is all."""
    org = await make_org("Revoke Co")
    await make_user("a@rev.com", org_id=org.id)
    b = await make_user("b@rev.com", org_id=org.id)

    await login(client, "a@rev.com")
    conv = (await _direct(client, b.id)).json()["_id"]
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"content": "before"})
    ).status_code in (200, 201)

    async with SessionLocal() as db:
        await db.execute(delete(ChatAccessRule))
        await db.commit()

    # Still readable...
    listing = await client.get(f"/api/conversations/{conv}/messages")
    assert listing.status_code == 200
    assert any(m["content"] == "before" for m in listing.json()["messages"])

    # ...but no longer writable.
    blocked = await client.post(f"/api/conversations/{conv}/messages", json={"content": "after"})
    assert blocked.status_code == 403, blocked.text


async def test_unreachable_users_are_absent_from_contacts_and_search(client):
    org = await make_org("Roster Co")
    a = await make_user("a@roster.com", org_id=org.id, display_name="Aaron", link_peers=False)
    visible = await make_user("v@roster.com", org_id=org.id, display_name="Vera", link_peers=False)
    await make_user("h@roster.com", org_id=org.id, display_name="Hidden", link_peers=False)

    await _rule(org.id, (AccessPartyType.user, a.id), (AccessPartyType.user, visible.id), allow=True)
    await login(client, "a@roster.com")

    names = [c["display_name"] for c in (await client.get("/api/users/contacts")).json()]
    assert names == ["Vera"]

    found = (await client.get("/api/search", params={"q": "e", "types": "contacts"})).json()
    assert [c["display_name"] for c in found["contacts"]] == ["Vera"]


async def test_reachable_set_never_disagrees_with_the_pairwise_check(client):
    """The two implementations of one rule must always agree.

    can_converse answers for a pair; reachable_user_ids answers for a whole
    roster in two queries so the contact list does not N+1. They evaluate the
    same precedence by different means, which is exactly the shape of bug that
    ships quietly: the directory shows someone you cannot actually message, or
    hides someone you can. This drives both over a matrix that exercises every
    specificity level, both dept_id-NULL positions, and the level-2 tie.
    """
    org = await make_org("Agree Co")
    d1 = await _dept(org.id, "D1")
    d2 = await _dept(org.id, "D2")
    me = await make_user("me@agree.com", org_id=org.id, dept_id=d1.id, link_peers=False)

    same_dept = await make_user("p0@agree.com", org_id=org.id, dept_id=d1.id, link_peers=False)
    other_dept_denied = await make_user("p1@agree.com", org_id=org.id, dept_id=d2.id, link_peers=False)
    no_dept_allowed = await make_user("p2@agree.com", org_id=org.id, dept_id=None, link_peers=False)
    tie_case = await make_user("p3@agree.com", org_id=org.id, dept_id=d2.id, link_peers=False)
    no_rule_at_all = await make_user("p4@agree.com", org_id=org.id, dept_id=None, link_peers=False)

    await _rule(org.id, (DEPT, d1.id), (DEPT, d2.id), allow=True)  # level 1
    await _rule(org.id, (USER, me.id), (DEPT, d2.id), allow=True)  # level 2
    await _rule(org.id, (USER, me.id), (USER, same_dept.id), allow=True)  # level 3
    # level 3 deny beats the level-1 department allow
    await _rule(org.id, (USER, me.id), (USER, other_dept_denied.id), allow=False)
    await _rule(org.id, (USER, me.id), (USER, no_dept_allowed.id), allow=True)
    # the level-2 tie: my allow toward d2 vs their deny toward d1 -> deny wins
    await _rule(org.id, (USER, tie_case.id), (DEPT, d1.id), allow=False)

    everyone = [same_dept, other_dept_denied, no_dept_allowed, tie_case, no_rule_at_all]
    async with SessionLocal() as db:
        me_row = await db.get(User, me.id)
        reachable = await reachable_user_ids(db, me_row)
        for peer in everyone:
            peer_row = await db.get(User, peer.id)
            pairwise = await can_converse(db, me_row, peer_row)
            assert (peer.id in reachable) is pairwise, (
                f"divergence for {peer.email}: set={peer.id in reachable} pairwise={pairwise}"
            )

        # And the verdicts are the ones the precedence rules actually call for,
        # so the two agreeing on a WRONG answer would still fail here.
        assert same_dept.id in reachable  # level 3 allow
        assert other_dept_denied.id not in reachable  # level 3 deny beats level 1 allow
        assert no_dept_allowed.id in reachable  # user rule works without a department
        assert tie_case.id not in reachable  # deny wins the level-2 tie
        assert no_rule_at_all.id not in reachable  # deny by default


async def test_same_department_rule_is_honoured_by_both_implementations(client):
    """A department paired with ITSELF — the most common rule there is.

    The migration writes exactly this for two colleagues who already share a
    conversation: LEAST(D,D)/GREATEST(D,D). An earlier reachable_user_ids
    classified rules by "the end that is not me" and therefore skipped any rule
    whose BOTH ends were mine, so a user's own department vanished from their
    contact list and search while direct messaging still worked.
    """
    org = await make_org("SelfDept Co")
    ward = await _dept(org.id, "Ward")
    a = await make_user("a@sd.com", org_id=org.id, dept_id=ward.id, display_name="Aaron", link_peers=False)
    b = await make_user("b@sd.com", org_id=org.id, dept_id=ward.id, display_name="Beth", link_peers=False)

    await _rule(org.id, (DEPT, ward.id), (DEPT, ward.id), allow=True)

    async with SessionLocal() as db:
        ua, ub = await db.get(User, a.id), await db.get(User, b.id)
        assert await can_converse(db, ua, ub) is True
        assert b.id in await reachable_user_ids(db, ua)

    await login(client, "a@sd.com")
    assert (await _direct(client, b.id)).status_code == 200
    assert [c["display_name"] for c in (await client.get("/api/users/contacts")).json()] == ["Beth"]


async def test_user_paired_with_their_own_department_is_honoured(client):
    """"Aaron may reach everyone in Ward", where Aaron is himself in Ward.

    The other case where both ends of a rule are mine.
    """
    org = await make_org("OwnDept Co")
    ward = await _dept(org.id, "Ward")
    a = await make_user("a@od.com", org_id=org.id, dept_id=ward.id, display_name="Aaron", link_peers=False)
    b = await make_user("b@od.com", org_id=org.id, dept_id=ward.id, display_name="Beth", link_peers=False)

    await _rule(org.id, (USER, a.id), (DEPT, ward.id), allow=True)

    async with SessionLocal() as db:
        ua, ub = await db.get(User, a.id), await db.get(User, b.id)
        assert await can_converse(db, ua, ub) is True
        assert b.id in await reachable_user_ids(db, ua)

    await login(client, "a@od.com")
    assert (await _direct(client, b.id)).status_code == 200
    assert [c["display_name"] for c in (await client.get("/api/users/contacts")).json()] == ["Beth"]


# --------------------------------------------------------------------------
# Send policy
# --------------------------------------------------------------------------


async def test_empty_document_whitelist_blocks_every_document(client):
    """[] must mean "no documents", not "no restriction".

    NULL is the "all document types" sentinel. An empty list is a distinct state
    an admin can reach by clearing the field, and collapsing the two would turn
    the tightest possible setting into the loosest.
    """
    org = await make_org("EmptyWl Co")
    a = await make_user("a@ewl.com", org_id=org.id)
    await _policy(org.id, (USER, a.id), allow_document=True, doc_extensions=[])

    async with SessionLocal() as db:
        policy = await resolve_send_policy(db, await db.get(User, a.id))
        assert policy.doc_extensions == frozenset()
        assert policy.allows_extension(".pdf") is False
        assert policy.allows_extension(".docx") is False
        # Other categories are untouched by a document whitelist.
        assert policy.allows_extension(".png") is True


async def test_text_only_policy_blocks_an_image_attachment(client):
    org = await make_org("TextOnly Co")
    a = await make_user("a@txt.com", org_id=org.id)
    b = await make_user("b@txt.com", org_id=org.id)
    await _policy(
        org.id,
        (AccessPartyType.user, a.id),
        allow_text=True,
        allow_image=False,
        allow_video=False,
        allow_audio=False,
        allow_document=False,
    )

    await login(client, "a@txt.com")
    conv = (await _direct(client, b.id)).json()["_id"]
    url = await _upload(a.id, org.id, "scan.png", "image", "image/png")

    resp = await client.post(
        f"/api/conversations/{conv}/messages", json={"type": "image", "media_url": url}
    )
    assert resp.status_code == 403, resp.text
    assert "not permitted" in resp.json()["detail"]

    # Text still goes through.
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"content": "words"})
    ).status_code in (200, 201)


async def test_policy_is_keyed_off_the_upload_not_the_declared_type(client):
    """`{type: "text", media_url: ...}` must not smuggle a blocked attachment.

    send_message coerces unknown types to "text" and attaches uploads regardless
    of type, so the declared type is not evidence of what is being sent.
    """
    org = await make_org("Smuggle Co")
    a = await make_user("a@smug.com", org_id=org.id)
    b = await make_user("b@smug.com", org_id=org.id)
    await _policy(org.id, (AccessPartyType.user, a.id), allow_image=False)

    await login(client, "a@smug.com")
    conv = (await _direct(client, b.id)).json()["_id"]
    url = await _upload(a.id, org.id, "scan.png", "image", "image/png")

    resp = await client.post(
        f"/api/conversations/{conv}/messages",
        json={"type": "text", "content": "just text honest", "media_url": url},
    )
    assert resp.status_code == 403, resp.text


async def test_document_whitelist_narrows_and_cannot_widen(client):
    """A whitelist restricts within DOC_EXTS; it cannot admit a new type."""
    org = await make_org("Whitelist Co")
    a = await make_user("a@wl.com", org_id=org.id)
    b = await make_user("b@wl.com", org_id=org.id)
    await _policy(
        org.id,
        (AccessPartyType.user, a.id),
        allow_document=True,
        doc_extensions=[".pdf", ".exe"],  # .exe is not a document the server accepts
    )

    await login(client, "a@wl.com")
    conv = (await _direct(client, b.id)).json()["_id"]

    pdf = await _upload(a.id, org.id, "report.pdf", "document", "application/pdf")
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"type": "file", "media_url": pdf})
    ).status_code in (200, 201)

    docx = await _upload(a.id, org.id, "notes.docx", "document", "application/msword")
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"type": "file", "media_url": docx})
    ).status_code == 403

    # Whitelisting ".exe" does not make it sendable — the intersection with
    # DOC_EXTS drops it, so it is refused like any unknown type.
    exe = await _upload(a.id, org.id, "tool.exe", "document", "application/octet-stream")
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"type": "file", "media_url": exe})
    ).status_code == 403


async def test_department_policy_applies_and_user_policy_replaces_it(client):
    org = await make_org("Scope Co")
    ward = await _dept(org.id, "Ward")
    a = await make_user("a@scope.com", org_id=org.id, dept_id=ward.id)
    b = await make_user("b@scope.com", org_id=org.id, dept_id=ward.id)

    await _policy(org.id, (AccessPartyType.department, ward.id), allow_image=False)
    await login(client, "a@scope.com")
    conv = (await _direct(client, b.id)).json()["_id"]

    url = await _upload(a.id, org.id, "a.png", "image", "image/png")
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"type": "image", "media_url": url})
    ).status_code == 403

    # A user-scoped row REPLACES the department's outright, re-permitting images.
    await _policy(org.id, (AccessPartyType.user, a.id), allow_image=True)
    url2 = await _upload(a.id, org.id, "b.png", "image", "image/png")
    assert (
        await client.post(f"/api/conversations/{conv}/messages", json={"type": "image", "media_url": url2})
    ).status_code in (200, 201)


async def test_forwarding_cannot_bypass_the_send_policy(client):
    """Forward copies attachments with no Upload row, so it skips the claim check."""
    org = await make_org("Fwd Co")
    a = await make_user("a@fwd.com", org_id=org.id)
    b = await make_user("b@fwd.com", org_id=org.id)

    # b sends a photo to a while unrestricted.
    await login(client, "b@fwd.com")
    conv = (await _direct(client, a.id)).json()["_id"]
    url = await _upload(b.id, org.id, "xray.png", "image", "image/png")
    sent = await client.post(
        f"/api/conversations/{conv}/messages", json={"type": "image", "media_url": url}
    )
    assert sent.status_code in (200, 201), sent.text
    msg_id = sent.json()["_id"]

    # a is now text-only, and tries to forward b's photo onward.
    await _policy(org.id, (AccessPartyType.user, a.id), allow_image=False)
    await login(client, "a@fwd.com")
    resp = await client.post(
        "/api/conversations/messages/forward",
        json={"message_id": msg_id, "conversation_ids": [conv], "contact_ids": []},
    )
    assert resp.status_code == 403, resp.text
