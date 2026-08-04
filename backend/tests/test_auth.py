"""Auth hardening: cookies, rotation, revocation, rate limit, password policy."""

from sqlalchemy import select

from app.core.security import ACCESS_COOKIE, REFRESH_COOKIE
from app.db.models import RefreshToken, User, UserRole
from app.db.session import SessionLocal
from tests.conftest import login, make_user


async def test_login_sets_httponly_cookies_and_returns_user(client):
    await make_user("dana@x.com", display_name="Dana")
    resp = await client.post("/api/auth/login", json={"email": "dana@x.com", "password": "TestPass1234"})
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"user"}  # no tokens in the body — cookies only
    assert body["user"]["name"] == "Dana"
    set_cookie = " ".join(resp.headers.get_list("set-cookie"))
    assert ACCESS_COOKIE in set_cookie and REFRESH_COOKIE in set_cookie
    assert set_cookie.count("HttpOnly") == 2


async def test_wrong_password_and_unknown_email_are_401(client):
    await make_user("erin@x.com")
    for payload in (
        {"email": "erin@x.com", "password": "nope-nope-1"},
        {"email": "ghost@x.com", "password": "TestPass1234"},
    ):
        resp = await client.post("/api/auth/login", json=payload)
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Invalid email or password"


async def test_email_login_is_case_insensitive(client):
    await make_user("frank@x.com")
    resp = await client.post("/api/auth/login", json={"email": "FRANK@X.com", "password": "TestPass1234"})
    assert resp.status_code == 200


async def test_refresh_rotates_and_old_token_is_single_use(client):
    await make_user("gina@x.com")
    await login(client, "gina@x.com")
    old_refresh = client.cookies.get(REFRESH_COOKIE)

    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 200
    assert client.cookies.get(REFRESH_COOKIE) != old_refresh

    # A consumed token buys at most one replay, and only while the successor it
    # carried is still unspent — the bounded delivery grace, covered in full by
    # test_refresh_rotation.py. Once the successor has been used the client
    # demonstrably received it, so replaying its predecessor is reuse and fails.
    assert (await client.post("/api/auth/refresh")).status_code == 200
    resp = await client.post("/api/auth/refresh", headers={"Cookie": f"{REFRESH_COOKIE}={old_refresh}"})
    assert resp.status_code == 401


async def test_deactivated_user_cannot_refresh(client):
    user = await make_user("hank@x.com")
    await login(client, "hank@x.com")

    async with SessionLocal() as db:
        target = await db.get(User, user.id)
        target.is_active = False
        await db.commit()

    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401
    # and the token was revoked server-side, not just rejected
    async with SessionLocal() as db:
        tokens = (
            (await db.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))).scalars().all()
        )
        assert tokens and all(t.revoked_at is not None for t in tokens)


async def test_deactivated_user_access_token_stops_working_immediately(client):
    user = await make_user("iris@x.com")
    await login(client, "iris@x.com")
    assert (await client.get("/api/auth/me")).status_code == 200

    async with SessionLocal() as db:
        target = await db.get(User, user.id)
        target.is_active = False
        await db.commit()

    # get_current_user re-checks is_active in the DB on every request
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_superadmin_gets_refresh_cookie_too(client):
    await make_user("root@x.com", role=UserRole.superadmin)
    resp = await client.post("/api/auth/login", json={"email": "root@x.com", "password": "TestPass1234"})
    set_cookie = " ".join(resp.headers.get_list("set-cookie"))
    assert REFRESH_COOKIE in set_cookie  # the Mongo build's superadmin 15-min logout bug

    await client.post("/api/auth/refresh")
    assert (await client.get("/api/auth/me")).status_code == 200


async def test_login_rate_limiter_fires(client):
    await make_user("judy@x.com")
    statuses = []
    for _ in range(12):
        resp = await client.post("/api/auth/login", json={"email": "judy@x.com", "password": "wrong-pass-1"})
        statuses.append(resp.status_code)
    assert 429 in statuses
    assert statuses[-1] == 429


async def test_csrf_header_required_for_cookie_mutations(client):
    await make_user("kyle@x.com", role=UserRole.superadmin)
    await login(client, "kyle@x.com")
    resp = await client.post(
        "/api/admin/organizations",
        json={"name": "No CSRF Org"},
        headers={"X-Requested-With": ""},
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Missing CSRF header"


async def test_password_policy_enforced_on_change(client):
    await make_user("lena@x.com")
    await login(client, "lena@x.com")
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_password": "TestPass1234", "new_password": "short1"},
    )
    assert resp.status_code == 400
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_password": "TestPass1234", "new_password": "LongEnoughPass99"},
    )
    assert resp.status_code == 200
