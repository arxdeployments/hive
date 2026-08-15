"""Super-admin & org-admin portal contracts on Postgres (P1 exit gate)."""

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.models import RefreshToken, User, UserRole
from app.db.session import SessionLocal
from tests.conftest import CSRF, login, make_user


async def _superadmin_client(client):
    await make_user("root@x.com", role=UserRole.superadmin)
    await login(client, "root@x.com")
    return client


async def test_org_department_user_crud_flow(client):
    await _superadmin_client(client)

    # create org
    resp = await client.post("/api/admin/organizations", json={"name": "Acme Corp"})
    assert resp.status_code == 200, resp.text
    org = resp.json()
    assert org["slug"] == "acme-corp" and org["is_active"] is True
    org_id = org["_id"]

    # list uses _id + envelope
    resp = await client.get("/api/admin/organizations")
    body = resp.json()
    assert body["total"] == 1 and body["data"][0]["_id"] == org_id

    # name-availability validator
    resp = await client.get("/api/admin/validate/org-name", params={"name": "Acme Corp"})
    assert resp.json()["available"] is False
    resp = await client.get("/api/admin/validate/org-name", params={"name": "Totally New"})
    assert resp.json()["available"] is True

    # department
    resp = await client.post("/api/admin/departments", json={"org_id": org_id, "name": "Engineering"})
    assert resp.status_code == 200
    dept_id = resp.json()["_id"]

    # duplicate department rejected
    resp = await client.post("/api/admin/departments", json={"org_id": org_id, "name": "Engineering"})
    assert resp.status_code == 400

    # user with weak password rejected (400 policy, or 422 schema min_length)
    resp = await client.post(
        "/api/admin/users",
        json={
            "org_id": org_id,
            "dept_id": dept_id,
            "email": "weak@acme.com",
            "display_name": "Weak",
            "password": "short",
        },
    )
    assert resp.status_code in (400, 422)

    # user created ok
    resp = await client.post(
        "/api/admin/users",
        json={
            "org_id": org_id,
            "dept_id": dept_id,
            "email": "sam@acme.com",
            "display_name": "Sam Rivera",
            "password": "GoodPass1234",
            "role": "member",
        },
    )
    assert resp.status_code == 200, resp.text
    user = resp.json()
    assert "password_hash" not in user and user["org_name"] == "Acme Corp"
    user_id = user["_id"]

    # duplicate email (case-insensitive) rejected
    resp = await client.post(
        "/api/admin/users",
        json={
            "org_id": org_id,
            "dept_id": dept_id,
            "email": "SAM@acme.com",
            "display_name": "Dup",
            "password": "GoodPass1234",
        },
    )
    assert resp.status_code == 400

    # reset password returns a temp password + flags must_change
    resp = await client.post(f"/api/admin/users/{user_id}/reset-password")
    assert resp.status_code == 200 and len(resp.json()["temporary_password"]) >= 10
    async with SessionLocal() as db:
        u = await db.get(User, __import__("uuid").UUID(user_id))
        assert u.must_change_password is True


async def test_deactivation_revokes_refresh_tokens(client):
    await _superadmin_client(client)
    resp = await client.post("/api/admin/organizations", json={"name": "RevokeCo"})
    org_id = resp.json()["_id"]
    resp = await client.post("/api/admin/departments", json={"org_id": org_id, "name": "Ops"})
    dept_id = resp.json()["_id"]
    resp = await client.post(
        "/api/admin/users",
        json={
            "org_id": org_id,
            "dept_id": dept_id,
            "email": "victim@revoke.com",
            "display_name": "Victim",
            "password": "GoodPass1234",
        },
    )
    user_id = resp.json()["_id"]

    # victim logs in (gets a refresh token)
    victim = AsyncClient(
        transport=ASGITransport(app=__import__("app.main", fromlist=["app"]).app), base_url="http://test"
    )
    victim.headers.update(CSRF)
    async with victim:
        await login(victim, "victim@revoke.com", "GoodPass1234")
        assert (await victim.get("/api/auth/me")).status_code == 200

        # admin deactivates the user
        resp = await client.put(f"/api/admin/users/{user_id}", json={"is_active": False})
        assert resp.status_code == 200

        # every refresh token for the user is revoked
        import uuid as _uuid

        async with SessionLocal() as db:
            tokens = (
                (await db.execute(select(RefreshToken).where(RefreshToken.user_id == _uuid.UUID(user_id))))
                .scalars()
                .all()
            )
            assert tokens and all(t.revoked_at is not None for t in tokens)

        # victim can no longer refresh
        assert (await victim.post("/api/auth/refresh")).status_code == 401


async def test_bulk_change_dept_skips_cross_org(client):
    await _superadmin_client(client)
    a = (await client.post("/api/admin/organizations", json={"name": "OrgA bulk"})).json()["_id"]
    b = (await client.post("/api/admin/organizations", json={"name": "OrgB bulk"})).json()["_id"]
    da = (await client.post("/api/admin/departments", json={"org_id": a, "name": "DA"})).json()["_id"]
    db_ = (await client.post("/api/admin/departments", json={"org_id": b, "name": "DB"})).json()["_id"]
    ua = (
        await client.post(
            "/api/admin/users",
            json={
                "org_id": a,
                "dept_id": da,
                "email": "ua@a.com",
                "display_name": "UA",
                "password": "GoodPass1234",
            },
        )
    ).json()["_id"]

    # moving OrgA's user into OrgB's dept must be skipped (0 moved)
    resp = await client.post(
        "/api/admin/users/bulk-action",
        json={"user_ids": [ua], "action": "change_dept", "dept_id": db_},
    )
    assert resp.status_code == 200
    assert "0" in resp.json()["message"]


async def test_org_suspension_survives_user_create_and_activate(client):
    """A suspended org must stay suspended.

    Nothing on the login path reads Organization.is_active — the suspension is
    carried entirely by the users.is_active cascade — so any route that creates
    or reactivates an account inside a suspended org silently restores login to
    a tenant that is supposed to be shut off.
    """
    import uuid as _uuid

    await _superadmin_client(client)
    org_id = (await client.post("/api/admin/organizations", json={"name": "Suspend Co"})).json()["_id"]
    dept_id = (
        await client.post("/api/admin/departments", json={"org_id": org_id, "name": "Ward"})
    ).json()["_id"]

    async def _new_user(email: str):
        return await client.post(
            "/api/admin/users",
            json={
                "org_id": org_id,
                "dept_id": dept_id,
                "email": email,
                "display_name": email.split("@")[0],
                "password": "GoodPass1234",
            },
        )

    first = (await _new_user("first@suspend.co")).json()["_id"]
    second = (await _new_user("second@suspend.co")).json()["_id"]

    async def _assert_active(expected: bool):
        async with SessionLocal() as db:
            for uid in (first, second):
                assert (await db.get(User, _uuid.UUID(uid))).is_active is expected

    async def _login_first():
        return await client.post(
            "/api/auth/login", json={"email": "first@suspend.co", "password": "GoodPass1234"}
        )

    async def _set_org_active(active: bool):
        resp = await client.put(f"/api/admin/organizations/{org_id}", json={"is_active": active})
        assert resp.status_code == 200, resp.text

    # suspending the org cascades to its members, who can no longer sign in
    await _set_org_active(False)
    await _assert_active(False)
    assert (await _login_first()).status_code == 401

    # a fresh account may not be minted inside the suspended org
    resp = await _new_user("backdoor@suspend.co")
    assert resp.status_code == 400, resp.text

    # nor may an existing one be reactivated, one at a time...
    resp = await client.put(f"/api/admin/users/{first}", json={"is_active": True})
    assert resp.status_code == 400, resp.text

    # ...nor in bulk, which is the call that could restore a whole tenant at once.
    # The batch succeeds and skips them, so a mixed batch still does its real work.
    resp = await client.post(
        "/api/admin/users/bulk-action", json={"user_ids": [first, second], "action": "activate"}
    )
    assert resp.status_code == 200
    assert "0 users" in resp.json()["message"]
    await _assert_active(False)
    assert (await _login_first()).status_code == 401

    # the guard tracks the org's current state rather than freezing the accounts:
    # restoring the org makes both activation paths work again.
    await _set_org_active(True)
    resp = await client.put(f"/api/admin/users/{first}", json={"is_active": True})
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        "/api/admin/users/bulk-action", json={"user_ids": [second], "action": "activate"}
    )
    assert resp.status_code == 200
    assert "1 users" in resp.json()["message"]
    await _assert_active(True)
    assert (await _login_first()).status_code == 200
