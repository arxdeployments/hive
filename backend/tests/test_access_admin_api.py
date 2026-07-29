"""Super-admin authoring API for reachability rules, send policy and delegation."""

import contextlib

from httpx import ASGITransport, AsyncClient

from app.db.models import AccessPartyType, ChatAccessRule, Department, UserRole
from app.db.session import SessionLocal
from app.main import app
from app.services import storage
from tests.conftest import CSRF, login, make_org, make_user


@contextlib.asynccontextmanager
async def _as(email):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, email)
        yield c


async def _dept(org_id, name):
    async with SessionLocal() as db:
        d = Department(org_id=org_id, name=name)
        db.add(d)
        await db.commit()
        await db.refresh(d)
        return d


async def _superadmin(client):
    await make_user("root@access.com", role=UserRole.superadmin)
    await login(client, "root@access.com")


async def test_rule_is_stored_canonically_whichever_order_it_is_written(client):
    """(A,B) and (B,A) must be ONE row, or the UI can create contradictory rules."""
    org = await make_org("Canon Co")
    d1 = await _dept(org.id, "D1")
    d2 = await _dept(org.id, "D2")
    await _superadmin(client)

    first = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "department", "id": str(d1.id)},
            "b": {"type": "department", "id": str(d2.id)},
            "allow": True,
        },
    )
    assert first.status_code == 200, first.text

    # Same pair, opposite order, opposite verdict — must UPDATE, not insert.
    second = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "department", "id": str(d2.id)},
            "b": {"type": "department", "id": str(d1.id)},
            "allow": False,
        },
    )
    assert second.status_code == 200, second.text
    assert second.json()["id"] == first.json()["id"]

    listing = (await client.get("/api/admin/access/rules", params={"org_id": str(org.id)})).json()
    assert len(listing["data"]) == 1
    assert listing["data"][0]["allow"] is False


async def test_rule_cannot_reference_another_organizations_rows(client):
    """a_id/b_id are polymorphic and have no FK — this check is the only guard."""
    org_a = await make_org("Tenant A")
    org_b = await make_org("Tenant B")
    mine = await make_user("mine@ta.com", org_id=org_a.id, link_peers=False)
    theirs = await make_user("theirs@tb.com", org_id=org_b.id, link_peers=False)
    await _superadmin(client)

    resp = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org_a.id),
            "a": {"type": "user", "id": str(mine.id)},
            "b": {"type": "user", "id": str(theirs.id)},
            "allow": True,
        },
    )
    assert resp.status_code == 404, resp.text


async def test_explain_names_the_rule_that_decided(client):
    """A user allow overriding a department deny must be visible as such."""
    org = await make_org("Explain Co")
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    a = await make_user("a@ex.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@ex.com", org_id=org.id, dept_id=pharmacy.id, link_peers=False)
    await _superadmin(client)

    for payload in (
        {"a": {"type": "department", "id": str(ward.id)},
         "b": {"type": "department", "id": str(pharmacy.id)}, "allow": False},
        {"a": {"type": "user", "id": str(a.id)},
         "b": {"type": "user", "id": str(b.id)}, "allow": True},
    ):
        resp = await client.put("/api/admin/access/rules", json={"org_id": str(org.id), **payload})
        assert resp.status_code == 200, resp.text

    result = (
        await client.get(
            "/api/admin/access/explain", params={"user_a": str(a.id), "user_b": str(b.id)}
        )
    ).json()
    assert result["allowed"] is True
    decisive = [m for m in result["matched"] if m["decisive"]]
    assert len(decisive) == 1
    assert decisive[0]["level"] == 3 and decisive[0]["allow"] is True
    # The overridden department deny is still reported, not hidden.
    assert any(m["level"] == 1 and m["allow"] is False and not m["decisive"] for m in result["matched"])


async def test_deleting_an_allow_rule_falls_back_to_deny(client):
    org = await make_org("Delete Co")
    a = await make_user("a@del.com", org_id=org.id, link_peers=False)
    b = await make_user("b@del.com", org_id=org.id, link_peers=False)
    await _superadmin(client)

    created = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "user", "id": str(a.id)},
            "b": {"type": "user", "id": str(b.id)},
            "allow": True,
        },
    )
    rule_id = created.json()["id"]

    async with _as("a@del.com") as ua:
        assert (
            await ua.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).status_code == 200

    removed = await client.delete(f"/api/admin/access/rules/{rule_id}")
    assert removed.status_code == 200
    assert "deny-by-default" in removed.json()["note"]

    async with _as("a@del.com") as ua:
        assert (
            await ua.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).status_code == 403


async def test_document_whitelist_is_intersected_with_what_the_server_accepts(client):
    """An admin cannot whitelist a type into existence — it may only narrow."""
    org = await make_org("Narrow Co")
    a = await make_user("a@narrow.com", org_id=org.id)
    await _superadmin(client)

    resp = await client.put(
        "/api/admin/access/send-policies",
        json={
            "org_id": str(org.id),
            "scope": {"type": "user", "id": str(a.id)},
            "doc_extensions": ["pdf", ".EXE", "  .xlsx ", ".pdf"],
        },
    )
    assert resp.status_code == 200, resp.text
    # Normalised (dot-prefixed, lowercased, de-duplicated) and .exe dropped.
    assert resp.json()["doc_extensions"] == [".pdf", ".xlsx"]
    assert ".exe" not in storage.DOC_EXTS

    effective = (await client.get(f"/api/admin/access/effective-policy/{a.id}")).json()
    assert effective["source"] == "user"
    assert ".exe" not in effective["allowed_extensions"]
    assert ".pdf" in effective["allowed_extensions"]


async def test_effective_policy_reports_which_level_won(client):
    org = await make_org("Effective Co")
    ward = await _dept(org.id, "Ward")
    a = await make_user("a@eff.com", org_id=org.id, dept_id=ward.id)
    await _superadmin(client)

    await client.put(
        "/api/admin/access/send-policies",
        json={"org_id": str(org.id), "scope": {"type": "department", "id": str(ward.id)},
              "allow_image": False},
    )
    assert (await client.get(f"/api/admin/access/effective-policy/{a.id}")).json()["source"] == "department"

    await client.put(
        "/api/admin/access/send-policies",
        json={"org_id": str(org.id), "scope": {"type": "user", "id": str(a.id)},
              "allow_image": True},
    )
    got = (await client.get(f"/api/admin/access/effective-policy/{a.id}")).json()
    assert got["source"] == "user" and got["image"] is True


async def test_admin_department_assignment_and_org_wide_default(client):
    org = await make_org("Delegate Co")
    ward = await _dept(org.id, "Ward")
    admin = await make_user("adm@del.com", org_id=org.id, role=UserRole.org_admin)
    await _superadmin(client)

    listing = (
        await client.get("/api/admin/access/admin-departments", params={"org_id": str(org.id)})
    ).json()["data"]
    assert len(listing) == 1
    # No rows means org-wide, NOT "manages nothing".
    assert listing[0]["org_wide"] is True and listing[0]["departments"] == []

    scoped = await client.put(
        f"/api/admin/access/admin-departments/{admin.id}",
        json={"department_ids": [str(ward.id)]},
    )
    assert scoped.status_code == 200
    assert scoped.json()["org_wide"] is False

    listing = (
        await client.get("/api/admin/access/admin-departments", params={"org_id": str(org.id)})
    ).json()["data"]
    assert [d["name"] for d in listing[0]["departments"]] == ["Ward"]

    # Clearing the list restores org-wide reach rather than revoking everything.
    cleared = await client.put(
        f"/api/admin/access/admin-departments/{admin.id}", json={"department_ids": []}
    )
    assert cleared.json()["org_wide"] is True


async def test_every_access_admin_route_rejects_non_superadmins(client):
    """org_admin must not be able to edit the policy that constrains them."""
    org = await make_org("Guard Co")
    admin = await make_user("adm@guard.com", org_id=org.id, role=UserRole.org_admin)
    member = await make_user("mem@guard.com", org_id=org.id)

    for email in ("adm@guard.com", "mem@guard.com"):
        async with _as(email) as c:
            assert (
                await c.get("/api/admin/access/rules", params={"org_id": str(org.id)})
            ).status_code == 403
            assert (
                await c.put(
                    "/api/admin/access/rules",
                    json={
                        "org_id": str(org.id),
                        "a": {"type": "user", "id": str(admin.id)},
                        "b": {"type": "user", "id": str(member.id)},
                        "allow": True,
                    },
                )
            ).status_code == 403
            assert (
                await c.get("/api/admin/access/send-policies", params={"org_id": str(org.id)})
            ).status_code == 403
            assert (
                await c.put(
                    f"/api/admin/access/admin-departments/{admin.id}",
                    json={"department_ids": []},
                )
            ).status_code == 403


async def test_a_user_cannot_be_paired_with_themselves(client):
    org = await make_org("Self Co")
    a = await make_user("a@self.com", org_id=org.id, link_peers=False)
    await _superadmin(client)

    resp = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "user", "id": str(a.id)},
            "b": {"type": "user", "id": str(a.id)},
            "allow": True,
        },
    )
    assert resp.status_code == 400, resp.text


async def test_a_department_may_be_paired_with_itself(client):
    """The self-department rule is legitimate: "people in Ward may talk to each other"."""
    org = await make_org("SelfDept API Co")
    ward = await _dept(org.id, "Ward")
    await make_user("a@sda.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@sda.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    await _superadmin(client)

    resp = await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "department", "id": str(ward.id)},
            "b": {"type": "department", "id": str(ward.id)},
            "allow": True,
        },
    )
    assert resp.status_code == 200, resp.text

    async with _as("a@sda.com") as ua:
        assert (
            await ua.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).status_code == 200
        names = [c["display_name"] for c in (await ua.get("/api/users/contacts")).json()]
        assert names == [b.display_name]


async def test_rules_listing_labels_a_deleted_party(client):
    """Polymorphic ids have no FK, so a rule can outlive its target."""
    org = await make_org("Orphan Co")
    d1 = await _dept(org.id, "D1")
    d2 = await _dept(org.id, "D2")
    await _superadmin(client)
    await client.put(
        "/api/admin/access/rules",
        json={
            "org_id": str(org.id),
            "a": {"type": "department", "id": str(d1.id)},
            "b": {"type": "department", "id": str(d2.id)},
            "allow": True,
        },
    )

    async with SessionLocal() as db:
        await db.delete(await db.get(Department, d2.id))
        await db.commit()

    listing = (await client.get("/api/admin/access/rules", params={"org_id": str(org.id)})).json()
    assert len(listing["data"]) == 1
    names = {listing["data"][0]["a"]["name"], listing["data"][0]["b"]["name"]}
    assert "(deleted)" in names


async def test_orphaned_rule_does_not_grant_access(client):
    """A rule pointing at a deleted department must simply stop matching."""
    org = await make_org("Orphan Grant Co")
    ward = await _dept(org.id, "Ward")
    gone = await _dept(org.id, "Gone")
    await make_user("a@og.com", org_id=org.id, dept_id=ward.id, link_peers=False)
    b = await make_user("b@og.com", org_id=org.id, dept_id=gone.id, link_peers=False)

    async with SessionLocal() as db:
        db.add(
            ChatAccessRule(
                org_id=org.id,
                a_type=AccessPartyType.department,
                a_id=min(ward.id, gone.id, key=str),
                b_type=AccessPartyType.department,
                b_id=max(ward.id, gone.id, key=str),
                allow=True,
            )
        )
        await db.commit()

    async with _as("a@og.com") as ua:
        assert (
            await ua.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).status_code == 200

    # Deleting the department NULLs b.dept_id (ondelete SET NULL), so the rule
    # no longer describes the pair and deny-by-default takes over.
    async with SessionLocal() as db:
        await db.delete(await db.get(Department, gone.id))
        await db.commit()

    async with _as("a@og.com") as ua:
        assert (
            await ua.post("/api/conversations/direct", json={"participant_id": str(b.id)})
        ).status_code == 403


async def test_department_scoped_admin_sees_only_their_departments(client):
    """admin_departments must be ENFORCED, not merely stored.

    The three perm_* columns on Conversation are stored, migrated and enforced
    nowhere; this asserts the delegation table did not repeat that.
    """
    org = await make_org("Scoped Admin Co")
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    admin = await make_user("adm@scoped.com", org_id=org.id, role=UserRole.org_admin, dept_id=ward.id)
    mine = await make_user("mine@scoped.com", org_id=org.id, dept_id=ward.id, display_name="Mine")
    theirs = await make_user("theirs@scoped.com", org_id=org.id, dept_id=pharmacy.id, display_name="Theirs")

    # No assignment yet: org-wide, so both are visible.
    async with _as("adm@scoped.com") as c:
        names = [u["display_name"] for u in (await c.get("/api/org-admin/users")).json()["data"]]
        assert "Mine" in names and "Theirs" in names

    await _superadmin(client)
    await client.put(
        f"/api/admin/access/admin-departments/{admin.id}", json={"department_ids": [str(ward.id)]}
    )

    async with _as("adm@scoped.com") as c:
        names = [u["display_name"] for u in (await c.get("/api/org-admin/users")).json()["data"]]
        assert "Mine" in names
        assert "Theirs" not in names
        # And the out-of-scope user cannot be reached directly either. Asserted
        # against GET /users/{id}, which resolves through _load_org_user — the
        # helper every single-user route in that module shares. The in-scope 200
        # is the important half: without it a 404 would prove nothing, since a
        # mistyped route also 404s.
        assert (await c.get(f"/api/org-admin/users/{mine.id}")).status_code == 200
        assert (await c.get(f"/api/org-admin/users/{theirs.id}")).status_code == 404
