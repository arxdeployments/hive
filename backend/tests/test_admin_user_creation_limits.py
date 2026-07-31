"""What an org admin may create, and where.

Two rules, each with more than one route that could grant it:

  1. An admin creates MEMBERS, never admins. POST /users is the obvious route;
     PUT /users/{id} with role=admin is the same grant reached through a member
     who already exists.
  2. An admin places people only in departments they administer. POST /users is
     again the obvious route; PUT /users/{id} with a foreign dept_id moves an
     account out of their own reach, which is both an escape and irreversible
     for them.

The promotion case matters more than it looks. An admin with no
admin_departments rows is ORGANIZATION-WIDE by definition (see
managed_dept_ids), so a single-department admin who can mint an admin can mint
one with org-wide reach and sign in as it — they choose the password. Department
scoping would be decorative rather than enforced.
"""

import contextlib

from httpx import ASGITransport, AsyncClient

from app.db.models import AdminDepartment, Department, User, UserRole
from app.db.session import SessionLocal
from app.main import app
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


async def _scope(admin_id, *dept_ids):
    """Assign managed departments directly.

    Written through the model rather than the superadmin API so these tests fail
    for one reason only — the org-admin routes — and not because the delegation
    endpoint changed shape.
    """
    async with SessionLocal() as db:
        for did in dept_ids:
            db.add(AdminDepartment(user_id=admin_id, dept_id=did))
        await db.commit()


async def _role_of(email) -> UserRole:
    async with SessionLocal() as db:
        return (await db.execute(User.__table__.select().where(User.email == email))).one().role


async def _fixture(name: str):
    """An org with two departments and an admin scoped to the first."""
    org = await make_org(name)
    ward = await _dept(org.id, "Ward")
    pharmacy = await _dept(org.id, "Pharmacy")
    admin = await make_user(
        f"adm@{name.replace(' ', '')}.com", org_id=org.id, role=UserRole.org_admin, dept_id=ward.id
    )
    return org, ward, pharmacy, admin


# ---------------------------------------------------------------------------
# Rule 1: members only
# ---------------------------------------------------------------------------


async def test_admin_cannot_create_another_admin(client):
    org, ward, _, _ = await _fixture("Members Only Co")

    async with _as("adm@MembersOnlyCo.com") as c:
        resp = await c.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(ward.id),
                "email": "new.admin@members.com",
                "display_name": "New Admin",
                "password": "TestPass1234",
                "role": "admin",
            },
        )
    assert resp.status_code == 403, resp.text
    assert "members only" in resp.json()["detail"].lower()

    # Refused, not quietly downgraded to a member — an admin who asked for an
    # admin and silently got a member would hand out the wrong credentials.
    async with SessionLocal() as db:
        assert (
            await db.execute(User.__table__.select().where(User.email == "new.admin@members.com"))
        ).one_or_none() is None


async def test_admin_can_still_create_members(client):
    """The negative tests above are only meaningful if the positive path works."""
    org, ward, _, _ = await _fixture("Happy Path Co")

    async with _as("adm@HappyPathCo.com") as c:
        resp = await c.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(ward.id),
                "email": "nurse@happy.com",
                "display_name": "Nurse Joy",
                "password": "TestPass1234",
                "role": "member",
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["role"] == "member"
    assert await _role_of("nurse@happy.com") is UserRole.member


async def test_admin_cannot_promote_a_member_to_admin(client):
    """The second route to the same grant."""
    org, ward, _, _ = await _fixture("No Promotion Co")
    member = await make_user("member@noprom.com", org_id=org.id, dept_id=ward.id)

    async with _as("adm@NoPromotionCo.com") as c:
        resp = await c.put(f"/api/org-admin/users/{member.id}", json={"role": "admin"})
    assert resp.status_code == 403, resp.text
    assert await _role_of("member@noprom.com") is UserRole.member


async def test_promotion_is_refused_without_applying_the_rest_of_the_edit(client):
    """A rejected role must not leave a half-applied request behind.

    The route mutates the ORM object field by field, so a 403 raised after
    display_name was already assigned would still be rolled back by the session
    teardown — but only because nothing commits first. Worth pinning: the order
    of those assignments is not obviously load-bearing, and someone moving the
    role check below the commit would break it silently.
    """
    org, ward, _, _ = await _fixture("Atomic Co")
    member = await make_user("atomic@members.com", org_id=org.id, dept_id=ward.id, display_name="Before")

    async with _as("adm@AtomicCo.com") as c:
        resp = await c.put(
            f"/api/org-admin/users/{member.id}", json={"display_name": "After", "role": "admin"}
        )
        assert resp.status_code == 403
        again = await c.get(f"/api/org-admin/users/{member.id}")
    assert again.json()["display_name"] == "Before"


async def test_admin_can_still_demote_an_admin(client):
    """Asymmetric on purpose: removing reach is not escalation."""
    org, ward, _, _ = await _fixture("Demote Co")
    other = await make_user("other@demote.com", org_id=org.id, dept_id=ward.id, role=UserRole.org_admin)

    async with _as("adm@DemoteCo.com") as c:
        resp = await c.put(f"/api/org-admin/users/{other.id}", json={"role": "member"})
    assert resp.status_code == 200, resp.text
    assert await _role_of("other@demote.com") is UserRole.member


async def test_role_admin_on_an_existing_admin_is_a_no_op_not_a_403(client):
    """Saving the edit form unchanged must not fail.

    The drawer sends every field on save, so an admin editing a colleague's name
    posts role=admin alongside it. If the check keyed on the REQUESTED role alone
    rather than on whether it is a change, renaming an admin would be impossible.
    """
    org, ward, _, _ = await _fixture("No Op Co")
    other = await make_user("noop@admins.com", org_id=org.id, dept_id=ward.id, role=UserRole.org_admin)

    async with _as("adm@NoOpCo.com") as c:
        resp = await c.put(
            f"/api/org-admin/users/{other.id}", json={"display_name": "Renamed", "role": "admin"}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["display_name"] == "Renamed"
    assert await _role_of("noop@admins.com") is UserRole.org_admin


# ---------------------------------------------------------------------------
# Rule 2: their own departments only
# ---------------------------------------------------------------------------


async def test_scoped_admin_cannot_create_a_user_in_another_department(client):
    org, ward, pharmacy, admin = await _fixture("Scoped Create Co")
    await _scope(admin.id, ward.id)

    async with _as("adm@ScopedCreateCo.com") as c:
        mine = await c.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(ward.id),
                "email": "in.scope@scoped.com",
                "display_name": "In Scope",
                "password": "TestPass1234",
                "role": "member",
            },
        )
        theirs = await c.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(pharmacy.id),
                "email": "out.of.scope@scoped.com",
                "display_name": "Out Of Scope",
                "password": "TestPass1234",
                "role": "member",
            },
        )

    assert mine.status_code == 200, mine.text
    # 404, not 403: an admin must not be able to enumerate the departments they
    # do not manage by watching which ids answer differently.
    assert theirs.status_code == 404, theirs.text
    async with SessionLocal() as db:
        assert (
            await db.execute(User.__table__.select().where(User.email == "out.of.scope@scoped.com"))
        ).one_or_none() is None


async def test_scoped_admin_cannot_move_a_user_into_another_department(client):
    """Create-in-my-department then move is the two-step around a create check."""
    org, ward, pharmacy, admin = await _fixture("No Escape Co")
    await _scope(admin.id, ward.id)
    member = await make_user("stays@noescape.com", org_id=org.id, dept_id=ward.id)

    async with _as("adm@NoEscapeCo.com") as c:
        resp = await c.put(f"/api/org-admin/users/{member.id}", json={"dept_id": str(pharmacy.id)})
    assert resp.status_code == 404, resp.text

    async with SessionLocal() as db:
        assert (await db.get(User, member.id)).dept_id == ward.id


async def test_org_wide_admin_is_unaffected(client):
    """No admin_departments rows means organization-wide.

    Every admin in production is in this state, so a regression here is a
    regression for all of them rather than for a new opt-in feature.
    """
    org, ward, pharmacy, _ = await _fixture("Org Wide Co")

    async with _as("adm@OrgWideCo.com") as c:
        resp = await c.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(pharmacy.id),
                "email": "anywhere@orgwide.com",
                "display_name": "Anywhere",
                "password": "TestPass1234",
                "role": "member",
            },
        )
        depts = await c.get("/api/org-admin/departments")
        made = await c.post("/api/org-admin/departments", json={"name": "Radiology"})
    assert resp.status_code == 200, resp.text
    assert len(depts.json()) == 2
    assert made.status_code == 200, made.text


async def test_scoped_admin_only_sees_their_departments_in_the_picker(client):
    """The listing IS the create form's department dropdown.

    Without this the restriction only shows up as a 404 after the admin has
    filled the whole form in.
    """
    org, ward, pharmacy, admin = await _fixture("Picker Co")
    await _scope(admin.id, ward.id)

    async with _as("adm@PickerCo.com") as c:
        names = [d["name"] for d in (await c.get("/api/org-admin/departments")).json()]
        # Renaming or deleting a department they do not manage is refused too.
        rename = await c.put(f"/api/org-admin/departments/{pharmacy.id}", json={"name": "Renamed"})
        drop = await c.delete(f"/api/org-admin/departments/{pharmacy.id}")
        made = await c.post("/api/org-admin/departments", json={"name": "Radiology"})

    assert names == ["Ward"]
    assert rename.status_code == 404
    assert drop.status_code == 404
    # A department they create would fall outside their own scope immediately.
    assert made.status_code == 403, made.text


async def test_dashboard_counts_match_the_scoped_listings(client):
    """A count that disagrees with the list beside it reads as a broken list."""
    org, ward, pharmacy, admin = await _fixture("Counts Co")
    await _scope(admin.id, ward.id)
    await make_user("one@counts.com", org_id=org.id, dept_id=ward.id)
    await make_user("two@counts.com", org_id=org.id, dept_id=pharmacy.id)

    async with _as("adm@CountsCo.com") as c:
        stats = (await c.get("/api/org-admin/stats")).json()
        listed = (await c.get("/api/org-admin/users")).json()["total"]

    assert stats["total_departments"] == 1
    assert stats["total_users"] == listed


async def test_me_reports_managed_departments(client):
    """The console needs the scope to hide what the API would refuse."""
    org, ward, _, admin = await _fixture("Me Scope Co")

    async with _as("adm@MeScopeCo.com") as c:
        assert (await c.get("/api/auth/me")).json()["managed_departments"] == []

    await _scope(admin.id, ward.id)

    async with _as("adm@MeScopeCo.com") as c:
        assert (await c.get("/api/auth/me")).json()["managed_departments"] == [
            {"_id": str(ward.id), "name": "Ward"}
        ]

    # Members have no such field to misread as "manages nothing".
    member = await make_user("plain@mescope.com", org_id=org.id, dept_id=ward.id)
    assert member.role is UserRole.member
    async with _as("plain@mescope.com") as c:
        assert "managed_departments" not in (await c.get("/api/auth/me")).json()
