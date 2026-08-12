"""Superadmin cross-org group management: invariants, validation, audit trail.

The create path is the one with teeth — it enforces >=2 organizations, >=2
members, >=1 admin and >=1 member per organization. These tests cover the places
the sibling paths did not hold the same line.
"""

import contextlib

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.models import AuditLog, Conversation, UserRole
from app.db.session import SessionLocal
from app.main import app
from tests.conftest import CSRF, login, make_user


@contextlib.asynccontextmanager
async def _superadmin():
    await make_user("root@x.com", role=UserRole.superadmin)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, "root@x.com")
        yield c


def _payload(users, org_ids):
    return {
        "name": "Joint Programme",
        "org_ids": org_ids,
        "members": [
            {"user_id": str(users["alice"].id), "role": "admin"},
            {"user_id": str(users["carol"].id), "role": "member"},
        ],
    }


async def test_duplicate_org_ids_cannot_create_a_single_org_cross_org_group(client, two_orgs_with_users):
    """The >=2-organizations check ran on the raw request, and the de-duplication
    ran after it, so passing one organization twice satisfied the check and then
    collapsed to a group spanning a single org — a cross-org group that crosses
    nothing. This is the same defect the members check was fixed for: count what
    survives filtering, not what was sent."""
    users = two_orgs_with_users
    org_a = str(users["org_a"].id)
    async with _superadmin() as root:
        resp = await root.post(
            "/api/admin/cross-org-groups",
            json={
                "name": "Not Actually Cross Org",
                "org_ids": [org_a, org_a],
                "members": [
                    {"user_id": str(users["alice"].id), "role": "admin"},
                    {"user_id": str(users["bob"].id), "role": "member"},
                ],
            },
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "At least 2 organizations required"

        # and nothing was persisted
        async with SessionLocal() as db:
            assert (await db.execute(select(Conversation))).scalars().all() == []

        # The genuine two-org case still works, including when one is sent twice.
        resp = await root.post(
            "/api/admin/cross-org-groups",
            json=_payload(users, [org_a, org_a, str(users["org_b"].id)]),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["allowed_org_ids"] == [org_a, str(users["org_b"].id)]


async def test_group_name_cannot_be_emptied_by_an_update(client, two_orgs_with_users):
    """create_group rejects a blank name; the update path applied one. A group
    whose name sanitizes away renders as a nameless row in every member's
    sidebar, so both paths hold the same line."""
    users = two_orgs_with_users
    async with _superadmin() as root:
        resp = await root.post(
            "/api/admin/cross-org-groups",
            json=_payload(users, [str(users["org_a"].id), str(users["org_b"].id)]),
        )
        assert resp.status_code == 200, resp.text
        group = resp.json()["_id"]

        # Empty, whitespace-only, and markup that sanitizes to nothing.
        for name in ("", "   ", "<b></b>"):
            resp = await root.put(f"/api/admin/cross-org-groups/{group}", json={"name": name})
            assert resp.status_code == 400, f"{name!r} was accepted: {resp.text}"
            assert resp.json()["detail"] == "Group name required"

        assert (await root.get(f"/api/admin/cross-org-groups/{group}")).json()["name"] == "Joint Programme"

        # A real rename is untouched.
        resp = await root.put(f"/api/admin/cross-org-groups/{group}", json={"name": "Renamed"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "Renamed"


async def test_archiving_a_group_is_audited(client, two_orgs_with_users):
    """Archiving drops the group out of every member's list — the same state
    change PUT /{id} makes and audits. Going through /archive left no record of
    who did it."""
    users = two_orgs_with_users
    async with _superadmin() as root:
        resp = await root.post(
            "/api/admin/cross-org-groups",
            json=_payload(users, [str(users["org_a"].id), str(users["org_b"].id)]),
        )
        assert resp.status_code == 200, resp.text
        group = resp.json()["_id"]

        assert (await root.post(f"/api/admin/cross-org-groups/{group}/archive")).json()["is_active"] is False
        assert (await root.post(f"/api/admin/cross-org-groups/{group}/archive")).json()["is_active"] is True

    async with SessionLocal() as db:
        actions = (
            (
                await db.execute(
                    select(AuditLog.action).where(AuditLog.target == group).order_by(AuditLog.created_at)
                )
            )
            .scalars()
            .all()
        )
    assert "cross_org_group_archived" in actions
    assert "cross_org_group_unarchived" in actions
