"""must_change_password is enforced (batch 73).

Both admin resets set users.must_change_password and show the admin the temporary
password, change-password cleared it, and nothing else read it. So a reset account
stayed fully usable with a password somebody else had been shown, for as long as
nobody happened to change it.

The contract these tests pin, shared with the web and iOS clients:

  * login, refresh and me answer 200 and carry user.must_change_password;
  * every other authenticated route answers 403 PASSWORD_CHANGE_REQUIRED, except
    logout, change-password and DELETE /api/notifications/subscribe;
  * the refusals that existed before keep their 401 / mobile 403, ahead of it;
  * the websocket refuses with 4403 (never 4001, which both clients answer with a
    refresh that succeeds here and would loop);
  * change-password refuses an unchanged password and re-issues a session the
    reset revoked (never one a later logout revoked); both resets delete push
    subscriptions; an org admin cannot reset themselves;
  * the reset ends every session from before it (users.sessions_valid_after): an
    older access token is refused with 401 on every gated route and at the socket,
    and stays refused after the owner changes the password (batch 73 review).

The route walk at the bottom is the guard against the next route: it fails the
moment one is added that skips the gate, or that picks up the un-gated twin.
"""

import asyncio
import contextlib
import datetime as dt
import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.api.auth import MOBILE_NOT_APPROVED_CODE
from app.core import deps
from app.core.deps import (
    PASSWORD_CHANGE_REQUIRED_CODE,
    PASSWORD_CHANGE_REQUIRED_DETAIL,
    PasswordChangeRequiredError,
    get_current_user_ws,
)
from app.core.security import ACCESS_COOKIE, REFRESH_COOKIE, create_access_token
from app.db.models import Department, PushSubscription, RefreshToken, User, UserRole
from app.db.session import SessionLocal
from app.main import app
from app.realtime import hub
from app.services import messaging
from app.utils import now_utc
from tests.conftest import CSRF, login, make_org, make_user

REFUSAL = {"detail": PASSWORD_CHANGE_REQUIRED_DETAIL, "code": PASSWORD_CHANGE_REQUIRED_CODE}
TEMP = "TempPass1234"
NEW = "BrandNewPass99"

# The only APIRoutes that authenticate nobody. Every other route must reach
# get_current_user, which is where the gate lives.
PUBLIC_ROUTES = {
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/refresh"),
    ("POST", "/api/livekit/webhook"),
    ("GET", "/api/health"),
}
# The only routes a reset account may still reach, through the un-gated twin.
ALLOWED_WHILE_PENDING = {
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/change-password"),
    ("DELETE", "/api/notifications/subscribe"),
}


@contextlib.asynccontextmanager
async def _as(email: str, password: str = "TestPass1234", *, client: str = "web"):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        resp = await c.post("/api/auth/login", json={"email": email, "password": password, "client": client})
        assert resp.status_code == 200, resp.text
        yield c


async def _row(user_id) -> User:
    async with SessionLocal() as db:
        return await db.get(User, user_id)


async def _set(user_id, **fields) -> None:
    async with SessionLocal() as db:
        row = await db.get(User, user_id)
        for name, value in fields.items():
            setattr(row, name, value)
        await db.commit()


async def _subscribe(user_id, endpoint: str) -> None:
    async with SessionLocal() as db:
        db.add(PushSubscription(user_id=user_id, endpoint=endpoint, keys={"p256dh": "x", "auth": "y"}))
        await db.commit()


async def _endpoints_of(user_id) -> set[str]:
    async with SessionLocal() as db:
        rows = await db.execute(select(PushSubscription.endpoint).where(PushSubscription.user_id == user_id))
        return set(rows.scalars().all())


async def _sessions_of(user_id) -> list[RefreshToken]:
    async with SessionLocal() as db:
        rows = await db.execute(select(RefreshToken).where(RefreshToken.user_id == user_id))
        return list(rows.scalars().all())


async def _org_member(org_name: str, email: str, **kwargs) -> tuple:
    org = await make_org(org_name)
    async with SessionLocal() as db:
        dept = Department(org_id=org.id, name="Ward")
        db.add(dept)
        await db.commit()
        await db.refresh(dept)
    user = await make_user(email, org_id=org.id, dept_id=dept.id, **kwargs)
    return org, dept, user


def _assert_refused(resp) -> None:
    assert resp.status_code == 403, resp.text
    assert resp.json() == REFUSAL


def test_the_refusal_is_pinned_verbatim():
    """REFUSAL above is built from the constants, so it cannot notice them changing.
    The web and iOS clients match the code literally; the detail is the agreed text."""
    assert PASSWORD_CHANGE_REQUIRED_CODE == "PASSWORD_CHANGE_REQUIRED"
    assert PASSWORD_CHANGE_REQUIRED_DETAIL == "You must change your password before continuing."


# ---------------------------------------------------------------------------
# What a reset account can still reach
# ---------------------------------------------------------------------------


async def test_login_refresh_and_me_answer_200_and_carry_the_flag(client):
    org, _, _ = await _org_member("Flag Co", "flag@x.com", password=TEMP, must_change_password=True)

    resp = await client.post("/api/auth/login", json={"email": "flag@x.com", "password": TEMP})
    assert resp.status_code == 200, resp.text
    assert set(resp.json()) == {"user"}, "the flag belongs inside user, never at the top level"
    assert resp.json()["user"]["must_change_password"] is True

    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 200, resp.text
    assert resp.json()["user"]["must_change_password"] is True

    resp = await client.get("/api/auth/me")
    assert resp.status_code == 200, resp.text
    me = resp.json()
    assert me["must_change_password"] is True
    # The full payload, not a cut-down one: the client renders this screen with it.
    assert me["org_name"] == org.name and "avatar_url" in me and "mobile_access" in me


async def test_the_flag_is_false_for_an_ordinary_account_of_every_role(client):
    org = await make_org("Plain Co")
    await make_user("plain@x.com", org_id=org.id)
    await make_user("root@x.com", role=UserRole.superadmin)
    for email in ("plain@x.com", "root@x.com"):
        async with _as(email) as c:
            me = (await c.get("/api/auth/me")).json()
            assert me["must_change_password"] is False, email


async def test_logout_and_push_unsubscribe_stay_reachable(client):
    _, _, user = await _org_member("Leaving Co", "leaving@x.com", password=TEMP, must_change_password=True)
    endpoint = "https://push.example.test/fcm/send/leaving"
    await _subscribe(user.id, endpoint)
    await login(client, "leaving@x.com", TEMP)

    resp = await client.request("DELETE", "/api/notifications/subscribe", json={"endpoint": endpoint})
    assert resp.status_code == 200, resp.text
    assert await _endpoints_of(user.id) == set()

    resp = await client.post("/api/auth/logout")
    assert resp.status_code == 200, resp.text
    assert all(t.revoked_at is not None for t in await _sessions_of(user.id))


# ---------------------------------------------------------------------------
# What it cannot: one representative per dependency family
# ---------------------------------------------------------------------------


async def test_get_current_user_routes_refuse_with_the_code(client, monkeypatch):
    await _org_member("Gate Co", "gate@x.com", password=TEMP, must_change_password=True)
    monkeypatch.setattr("app.services.push.validate_push_endpoint", lambda _endpoint: True)
    await login(client, "gate@x.com", TEMP)

    _assert_refused(await client.get("/api/conversations"))
    # POST stays gated while DELETE does not: adding a push channel is exactly what
    # a reset account must not be able to do.
    _assert_refused(
        await client.post(
            "/api/notifications/subscribe",
            json={"endpoint": "https://push.example.test/fcm/send/gate", "keys": {}},
        )
    )


async def test_get_tenant_routes_refuse_with_the_code(client):
    await _org_member("Tenant Co", "tenant@x.com", password=TEMP, must_change_password=True)
    await login(client, "tenant@x.com", TEMP)
    _assert_refused(await client.get("/api/users/contacts"))
    _assert_refused(await client.get("/api/search", params={"q": "anything"}))


async def test_org_admin_routes_refuse_with_the_code(client):
    await _org_member(
        "Admin Gate Co", "oa@x.com", role=UserRole.org_admin, password=TEMP, must_change_password=True
    )
    await login(client, "oa@x.com", TEMP)
    _assert_refused(await client.get("/api/org-admin/users"))


async def test_superadmin_routes_refuse_with_the_code(client):
    root = await make_user("root@x.com", role=UserRole.superadmin)
    await login(client, "root@x.com")
    assert (await client.get("/api/admin/stats")).status_code == 200

    # Flagged on the row directly: nothing in the API resets a superadmin, and the
    # gate must not depend on how the flag got there.
    await _set(root.id, must_change_password=True)
    _assert_refused(await client.get("/api/admin/stats"))
    _assert_refused(await client.get("/api/metrics"))


# ---------------------------------------------------------------------------
# Refusals that existed before keep their answer
# ---------------------------------------------------------------------------


async def test_a_deactivated_flagged_account_gets_401_not_403(client):
    _, _, user = await _org_member("Gone Co", "gone@x.com", password=TEMP, must_change_password=True)
    await login(client, "gone@x.com", TEMP)
    await _set(user.id, is_active=False)

    for resp in (await client.get("/api/conversations"), await client.get("/api/auth/me")):
        assert resp.status_code == 401, resp.text
        assert resp.json() == {"detail": "Not authenticated"}


async def test_flagged_mobile_login_without_the_grant_still_gets_the_mobile_403(client):
    await _org_member("No Mobile Co", "nomob@x.com", password=TEMP, must_change_password=True)
    resp = await client.post(
        "/api/auth/login", json={"email": "nomob@x.com", "password": TEMP, "client": "mobile"}
    )
    assert resp.status_code == 403, resp.text
    assert resp.json()["code"] == MOBILE_NOT_APPROVED_CODE


async def test_a_revoked_mobile_grant_still_answers_401_ahead_of_the_flag(client):
    _, _, user = await _org_member(
        "Revoked Co", "rev@x.com", password=TEMP, must_change_password=True, mobile_access=True
    )
    async with _as("rev@x.com", TEMP, client="mobile") as phone:
        assert (await phone.get("/api/auth/me")).status_code == 200
        await _set(user.id, mobile_access=False)
        resp = await phone.get("/api/conversations")
        assert resp.status_code == 401, resp.text


# ---------------------------------------------------------------------------
# Getting out: change-password
# ---------------------------------------------------------------------------


async def test_change_password_clears_the_flag_and_the_same_session_carries_on(client):
    _, _, user = await _org_member("Change Co", "change@x.com", password=TEMP, must_change_password=True)
    await login(client, "change@x.com", TEMP)
    refresh_before = client.cookies.get(REFRESH_COOKIE)
    _assert_refused(await client.get("/api/conversations"))

    resp = await client.post(
        "/api/auth/change-password", json={"current_password": TEMP, "new_password": NEW}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"message": "Password changed"}
    # A live session is kept, not replaced: re-issuing it would be harmless here
    # but is the branch reserved for a session the reset revoked.
    assert "set-cookie" not in resp.headers

    assert (await _row(user.id)).must_change_password is False
    assert (await client.get("/api/conversations")).status_code == 200
    assert (await client.get("/api/auth/me")).json()["must_change_password"] is False
    assert client.cookies.get(REFRESH_COOKIE) == refresh_before
    assert (await client.post("/api/auth/refresh")).status_code == 200


async def test_an_unchanged_password_is_refused_and_the_flag_stays(client):
    _, _, user = await _org_member("Same Co", "same@x.com", password=TEMP, must_change_password=True)
    await login(client, "same@x.com", TEMP)
    hash_before = (await _row(user.id)).password_hash

    resp = await client.post(
        "/api/auth/change-password", json={"current_password": TEMP, "new_password": TEMP}
    )
    assert resp.status_code == 400, resp.text
    assert resp.json() == {"detail": "Choose a password different from your current one."}

    row = await _row(user.id)
    assert row.must_change_password is True
    assert row.password_hash == hash_before
    _assert_refused(await client.get("/api/conversations"))


async def test_an_unchanged_password_is_refused_for_an_ordinary_account_too(client):
    """For every account, not only reset ones: the rule is about the password."""
    await make_user("ordinary@x.com")
    await login(client, "ordinary@x.com")
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_password": "TestPass1234", "new_password": "TestPass1234"},
    )
    assert resp.status_code == 400, resp.text
    assert resp.json() == {"detail": "Choose a password different from your current one."}


async def test_a_wrong_temporary_password_is_401_and_the_flag_stays(client):
    _, _, user = await _org_member("Wrong Co", "wrong@x.com", password=TEMP, must_change_password=True)
    await login(client, "wrong@x.com", TEMP)

    resp = await client.post(
        "/api/auth/change-password", json={"current_password": "NotTheTemp99", "new_password": NEW}
    )
    assert resp.status_code == 401, resp.text
    assert resp.json() == {"detail": "Current password is incorrect"}

    # The unchanged-password rule runs only once the current password has verified,
    # so a wrong guess is a wrong guess whatever it is paired with.
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_password": "NotTheTemp99", "new_password": "NotTheTemp99"},
    )
    assert resp.status_code == 401, resp.text
    assert (await _row(user.id)).must_change_password is True


@pytest.mark.parametrize("session_client", ["web", "mobile"])
async def test_a_session_from_before_the_reset_can_finish_the_change(client, session_client):
    """The reset revokes every refresh token, so a client signed in before it is
    finishing the change on its access cookie alone. Without a fresh session it
    would be signed out when that cookie lapsed, minutes after doing as asked."""
    org, dept, user = await _org_member("Before Co", "before@x.com", mobile_access=True)
    await make_user("root@x.com", role=UserRole.superadmin)

    async with _as("before@x.com", client=session_client) as victim:
        refresh_before = victim.cookies.get(REFRESH_COOKIE)
        async with _as("root@x.com") as root:
            resp = await root.post(f"/api/admin/users/{user.id}/reset-password")
            assert resp.status_code == 200, resp.text
            temp = resp.json()["temporary_password"]
        assert all(t.revoked_at is not None for t in await _sessions_of(user.id))

        # Still signed in on the access cookie, and told what to do.
        assert (await victim.get("/api/auth/me")).json()["must_change_password"] is True

        resp = await victim.post(
            "/api/auth/change-password", json={"current_password": temp, "new_password": NEW}
        )
        assert resp.status_code == 200, resp.text
        set_cookie = " ".join(resp.headers.get_list("set-cookie"))
        assert ACCESS_COOKIE in set_cookie and REFRESH_COOKIE in set_cookie
        assert victim.cookies.get(REFRESH_COOKIE) != refresh_before

        live = [t for t in await _sessions_of(user.id) if t.revoked_at is None]
        assert len(live) == 1
        # Re-issued for the client the access token was minted for, so a phone
        # keeps a phone session and its mobile-grant checks keep applying.
        assert live[0].client == session_client

        resp = await victim.post("/api/auth/refresh")
        assert resp.status_code == 200, resp.text
        assert resp.json()["user"]["must_change_password"] is False
        assert (await victim.get("/api/conversations")).status_code == 200


# ---------------------------------------------------------------------------
# The resets
# ---------------------------------------------------------------------------


async def test_superadmin_reset_ends_the_targets_live_session_and_drops_its_push(client):
    org, dept, target = await _org_member("Reset Co", "target@x.com")
    bystander = await make_user("bystander@x.com", org_id=org.id, dept_id=dept.id)
    await make_user("root@x.com", role=UserRole.superadmin)
    await _subscribe(target.id, "https://push.example.test/fcm/send/target")
    await _subscribe(bystander.id, "https://push.example.test/fcm/send/bystander")

    async with _as("target@x.com") as victim:
        assert (await victim.get("/api/conversations")).status_code == 200
        async with _as("root@x.com") as root:
            resp = await root.post(f"/api/admin/users/{target.id}/reset-password")
            assert resp.status_code == 200, resp.text
        # The SAME access token, minted before the reset, is refused at once — not
        # at its expiry fifteen minutes later — and as a session that has ENDED
        # (401), not one waiting on a password change: the reset ended it.
        assert (await victim.get("/api/conversations")).status_code == 401

    assert (await _row(target.id)).must_change_password is True
    assert await _endpoints_of(target.id) == set()
    assert await _endpoints_of(bystander.id) == {"https://push.example.test/fcm/send/bystander"}


async def test_org_admin_reset_sets_the_flag_ends_the_targets_session_and_drops_its_push(client):
    org, dept, target = await _org_member("Org Reset Co", "member@x.com")
    await make_user("oa@x.com", org_id=org.id, dept_id=dept.id, role=UserRole.org_admin)
    await _subscribe(target.id, "https://push.example.test/fcm/send/member")

    async with _as("member@x.com") as victim:
        assert (await victim.get("/api/conversations")).status_code == 200
        async with _as("oa@x.com") as admin:
            resp = await admin.post(f"/api/org-admin/users/{target.id}/reset-password")
            assert resp.status_code == 200, resp.text
        assert (await victim.get("/api/conversations")).status_code == 401
        assert (await _row(target.id)).sessions_valid_after is not None

    assert (await _row(target.id)).must_change_password is True
    assert await _endpoints_of(target.id) == set()


async def test_a_token_from_before_the_reset_stays_dead_after_the_owner_changes_the_password(client):
    """The batch 73 review's attack. Someone holding the account's access cookie from
    before the reset was refused only while the flag was set; once the owner chose
    a new password the same cookie worked again for the rest of its life — long
    enough to register a push subscription, which never expires."""
    org, dept, user = await _org_member("Epoch Co", "epoch@x.com")
    await make_user("root@x.com", role=UserRole.superadmin)

    async with _as("epoch@x.com") as stale:
        async with _as("root@x.com") as root:
            resp = await root.post(f"/api/admin/users/{user.id}/reset-password")
            assert resp.status_code == 200, resp.text
            temp = resp.json()["temporary_password"]
        async with _as("epoch@x.com", temp) as owner:
            resp = await owner.post(
                "/api/auth/change-password", json={"current_password": temp, "new_password": NEW}
            )
            assert resp.status_code == 200, resp.text
            assert (await owner.get("/api/conversations")).status_code == 200  # control

        assert (await _row(user.id)).must_change_password is False
        assert (await stale.get("/api/conversations")).status_code == 401
        resp = await stale.post(
            "/api/notifications/subscribe",
            json={
                "endpoint": "https://push.example.test/fcm/send/stale",
                "keys": {"p256dh": "x", "auth": "y"},
            },
        )
        assert resp.status_code == 401, resp.text
        assert (await stale.post("/api/auth/refresh")).status_code == 401
    assert await _endpoints_of(user.id) == set()


async def test_change_password_does_not_reissue_a_session_a_logout_ended(client):
    """Sign-out pressed while the change was in flight: logout revoked the caller's
    row first, and finding no live row the route used to hand a fresh 30-day
    session to the device that had just signed out (batch 73 review)."""
    org, dept, user = await _org_member("Race Co", "race@x.com")
    await make_user("root@x.com", role=UserRole.superadmin)
    async with _as("root@x.com") as root:
        resp = await root.post(f"/api/admin/users/{user.id}/reset-password")
        temp = resp.json()["temporary_password"]

    async with _as("race@x.com", temp) as device:
        # What logout does to this device's row, landing after the reset.
        async with SessionLocal() as db:
            for row in (
                await db.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))
            ).scalars():
                if row.revoked_at is None:
                    row.revoked_at = now_utc()
            await db.commit()
        resp = await device.post(
            "/api/auth/change-password", json={"current_password": temp, "new_password": NEW}
        )
        assert resp.status_code == 200, resp.text
        set_cookie = " ".join(resp.headers.get_list("set-cookie"))
        assert REFRESH_COOKIE not in set_cookie and ACCESS_COOKIE not in set_cookie
    assert [t for t in await _sessions_of(user.id) if t.revoked_at is None] == []


async def test_change_password_does_not_reissue_for_an_account_no_reset_touched(client):
    await make_user("plain@x.com")
    async with _as("plain@x.com") as device:
        async with SessionLocal() as db:
            for row in (await db.execute(select(RefreshToken))).scalars():
                row.revoked_at = now_utc()
            await db.commit()
        resp = await device.post(
            "/api/auth/change-password", json={"current_password": "TestPass1234", "new_password": NEW}
        )
        assert resp.status_code == 200, resp.text
        assert REFRESH_COOKIE not in " ".join(resp.headers.get_list("set-cookie"))


def test_session_client_reads_the_claims_the_request_was_authenticated_with():
    """Never a second decode: change-password asks after two bcrypt rounds, by which
    time the token may have expired, and an expired token decodes to nothing — so a
    phone was re-issued a WEB session, outside every mobile-grant check."""

    def _request(claims, token=None):
        cookies = {ACCESS_COOKIE: token} if token else {}
        return SimpleNamespace(
            state=SimpleNamespace(**({"auth_claims": claims} if claims else {})), cookies=cookies, headers={}
        )

    assert deps.session_client(_request({"client": "mobile"})) == "mobile"
    assert deps.session_client(_request(None)) == "web"
    # A perfectly decodable mobile token on the request changes nothing: only the
    # claims the dependency verified count.
    token = create_access_token(uuid.uuid4(), "member", None, client="mobile")
    assert deps.session_client(_request(None, token)) == "web"


async def test_an_org_admin_cannot_reset_their_own_password(client):
    org, dept, admin = await _org_member("Self Co", "self@x.com", role=UserRole.org_admin)
    await _subscribe(admin.id, "https://push.example.test/fcm/send/self")
    hash_before = (await _row(admin.id)).password_hash

    await login(client, "self@x.com")
    resp = await client.post(f"/api/org-admin/users/{admin.id}/reset-password")
    assert resp.status_code == 400, resp.text
    assert resp.json() == {"detail": "Use Change Password to change your own password."}

    row = await _row(admin.id)
    assert row.password_hash == hash_before
    assert row.must_change_password is False
    assert await _endpoints_of(admin.id) == {"https://push.example.test/fcm/send/self"}
    assert all(t.revoked_at is None for t in await _sessions_of(admin.id))
    assert (await client.get("/api/org-admin/users")).status_code == 200


async def test_created_accounts_are_not_flagged(client):
    """Only a reset flags an account. e2e seeding signs straight in as the users
    it creates, so a create path that flagged them would wall off every run."""
    org, dept, _ = await _org_member("Create Co", "oa@create.com", role=UserRole.org_admin)
    await make_user("root@x.com", role=UserRole.superadmin)

    async with _as("root@x.com") as root:
        resp = await root.post(
            "/api/admin/users",
            json={
                "org_id": str(org.id),
                "dept_id": str(dept.id),
                "email": "bysuper@create.com",
                "display_name": "By Super",
                "password": "GoodPass1234",
                "role": "member",
            },
        )
        assert resp.status_code == 200, resp.text
    async with _as("oa@create.com") as admin:
        resp = await admin.post(
            "/api/org-admin/users",
            json={
                "dept_id": str(dept.id),
                "email": "byadmin@create.com",
                "display_name": "By Admin",
                "password": "GoodPass1234",
            },
        )
        assert resp.status_code == 200, resp.text

    for email in ("bysuper@create.com", "byadmin@create.com"):
        async with _as(email, "GoodPass1234") as c:
            assert (await c.get("/api/auth/me")).json()["must_change_password"] is False
            assert (await c.get("/api/conversations")).status_code == 200


# ---------------------------------------------------------------------------
# Messaging: the gate a socket opened before the reset still meets
# ---------------------------------------------------------------------------


async def test_a_flagged_sender_cannot_send_or_mutate(client):
    org, dept, a = await _org_member("Send Co", "a@send.com")
    b = await make_user("b@send.com", org_id=org.id, dept_id=dept.id)
    async with _as("a@send.com") as c:
        conv = (await c.post("/api/conversations/direct", json={"participant_id": str(b.id)})).json()["_id"]
        sent = await c.post(f"/api/conversations/{conv}/messages", json={"content": "before the reset"})
        assert sent.status_code == 200, sent.text
        message_id = sent.json()["_id"]

    await _set(a.id, must_change_password=True)

    # The hub re-loads the sender row per frame, so this is what it hands over.
    async with SessionLocal() as db:
        sender = await db.get(User, a.id)
        with pytest.raises(messaging.PasswordChangeRequired) as caught:
            await messaging.send_message(db, conversation_id=uuid.UUID(conv), sender=sender, content="after")
    assert caught.value.status_code == 403
    assert caught.value.code == PASSWORD_CHANGE_REQUIRED_CODE

    # The mutation paths collapse conversation refusals into 404 "Message not
    # found". This is an account refusal and must come through as one.
    async with SessionLocal() as db:
        actor = await db.get(User, a.id)
        with pytest.raises(messaging.PasswordChangeRequired):
            await messaging.toggle_reaction(db, message_id=uuid.UUID(message_id), actor=actor, emoji="👍")


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


class _HandshakeStub:
    """Exactly what get_current_user_ws reads off a WebSocket."""

    def __init__(self, token: str) -> None:
        self.cookies = {ACCESS_COOKIE: token}
        self.query_params: dict[str, str] = {}


def _token_for(user: User, client: str = "web") -> str:
    return create_access_token(user.id, user.role.value, user.org_id, client=client)


async def test_ws_auth_tells_a_flagged_account_apart_from_a_failed_one(client):
    _, _, user = await _org_member("WS Auth Co", "wsauth@x.com", mobile_access=True)

    async with SessionLocal() as db:
        auth = await get_current_user_ws(_HandshakeStub(_token_for(user)), db)
    assert auth is not None and auth[0].id == user.id  # control

    await _set(user.id, must_change_password=True)
    async with SessionLocal() as db:
        with pytest.raises(PasswordChangeRequiredError):
            await get_current_user_ws(_HandshakeStub(_token_for(user)), db)

    # A revoked mobile grant keeps its None (4001), flag or no flag.
    await _set(user.id, mobile_access=False)
    async with SessionLocal() as db:
        assert await get_current_user_ws(_HandshakeStub(_token_for(user, "mobile")), db) is None

    # So does a deactivated account.
    await _set(user.id, is_active=False)
    async with SessionLocal() as db:
        assert await get_current_user_ws(_HandshakeStub(_token_for(user)), db) is None


async def test_ws_handshake_refuses_a_token_from_before_the_reset(client):
    _, _, user = await _org_member("WS Epoch Co", "wsepoch@x.com")
    token = _token_for(user)
    # The epoch lands after the token's iat second, as a reset after sign-in does.
    await _set(user.id, sessions_valid_after=now_utc() + dt.timedelta(seconds=2))
    async with SessionLocal() as db:
        assert await get_current_user_ws(_HandshakeStub(token), db) is None


async def test_the_session_epoch_tells_tokens_apart_within_the_same_second(client):
    """`iat` is whole seconds, so at that precision a token minted moments before a
    reset could not be told from one minted moments after it. `iat_ms` can, and
    these three tokens all fall in the same second (batch 73 review)."""
    import jwt

    from app.core.config import get_settings
    from app.core.security import JWT_ALGORITHM

    _, _, user = await _org_member("Epoch Ms Co", "epochms@x.com")
    before = _token_for(user)
    await asyncio.sleep(0.005)
    epoch = now_utc()
    await _set(user.id, sessions_valid_after=epoch)
    await asyncio.sleep(0.005)
    after = _token_for(user)

    # A token minted before iat_ms existed, inside the reset's own second: whole
    # seconds are all it carries, and within that second it is refused.
    legacy_claims = jwt.decode(after, get_settings().secret_key, algorithms=[JWT_ALGORITHM])
    legacy_claims.pop("iat_ms")
    legacy = jwt.encode(legacy_claims, get_settings().secret_key, algorithm=JWT_ALGORITHM)

    async with SessionLocal() as db:
        assert await get_current_user_ws(_HandshakeStub(before), db) is None
        assert (await get_current_user_ws(_HandshakeStub(after), db))[0].id == user.id
        if int(legacy_claims["iat"]) == int(epoch.timestamp()):
            assert await get_current_user_ws(_HandshakeStub(legacy), db) is None


class _SocketStub:
    """Enough of a WebSocket to drive websocket_endpoint without Starlette's
    TestClient, which cannot share this suite's event loop (see the docstring of
    test_realtime_revalidation.py). `frames` are what the client sends; running out
    reads as a disconnect, so a missing close ends the loop instead of hanging it."""

    def __init__(self, token: str, frames=(), before_each_frame=None) -> None:
        self.cookies = {ACCESS_COOKIE: token}
        self.query_params: dict[str, str] = {}
        self.accepted = False
        self.closed: tuple[int, str] | None = None
        self.sent: list[dict] = []
        self._frames = list(frames)
        self._before_each_frame = before_each_frame

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def send_text(self, data: str) -> None:
        self.sent.append(json.loads(data))

    async def receive_text(self) -> str:
        if not self._frames:
            raise WebSocketDisconnect(code=1000)
        if self._before_each_frame is not None:
            await self._before_each_frame()
        return self._frames.pop(0)


def test_the_ws_close_code_is_4403_and_not_4001():
    """Both clients answer 4001 by refreshing and reconnecting, which succeeds for a
    reset account, so a 4001 here would loop. The clients match on 4403."""
    assert hub.WS_CLOSE_PASSWORD_CHANGE_REQUIRED == 4403
    assert hub.WS_CLOSE_PASSWORD_CHANGE_REQUIRED_REASON == "Password change required"


async def test_ws_handshake_refuses_a_flagged_account_before_registering_anything(client, monkeypatch):
    _, _, user = await _org_member("WS Hand Co", "wshand@x.com", must_change_password=True)
    reached: list[str] = []

    async def _spy(name):
        reached.append(name)

    async def _add(*_a, **_k):
        await _spy("registry.add")

    async def _online(*_a, **_k):
        await _spy("presence.mark_online")
        return True

    async def _resume(*_a, **_k):
        await _spy("resume_calls_for")

    monkeypatch.setattr(hub.registry, "add", _add)
    monkeypatch.setattr(hub.presence, "mark_online", _online)
    monkeypatch.setattr("app.services.calls.resume_calls_for", _resume)

    ws = _SocketStub(_token_for(user), frames=['{"type": "ping"}'])
    await hub.websocket_endpoint(ws)

    assert ws.accepted
    assert ws.closed == (4403, "Password change required")
    assert ws.sent == [], "a refused socket must not even be told `connected`"
    assert reached == []


async def test_ws_handshake_keeps_4001_for_a_deactivated_flagged_account(client):
    _, _, user = await _org_member("WS Gone Co", "wsgone@x.com", must_change_password=True)
    await _set(user.id, is_active=False)
    ws = _SocketStub(_token_for(user))
    await hub.websocket_endpoint(ws)
    assert ws.closed == (4001, "Invalid token")


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"must_change_password": True}, (4403, "Password change required")),
        # Ordering: an account that is also deactivated keeps the existing 4001.
        ({"must_change_password": True, "is_active": False}, (4001, "Account inactive")),
        # What a real reset writes: the epoch ends the socket's session, ahead of the flag.
        ({"must_change_password": True, "sessions_valid_after": "now"}, (4001, "Session ended")),
    ],
)
async def test_ws_revalidation_closes_a_socket_the_reset_lands_on(client, monkeypatch, change, expected):
    _, _, user = await _org_member("WS Live Co", "wslive@x.com")
    # Revalidate on the first frame instead of waiting thirty seconds.
    monkeypatch.setattr(hub, "REVALIDATE_SECONDS", -1)

    async def _reset_lands():
        await _set(user.id, **{k: (now_utc() if v == "now" else v) for k, v in change.items()})

    ws = _SocketStub(_token_for(user), frames=['{"type": "ping"}'], before_each_frame=_reset_lands)
    await hub.websocket_endpoint(ws)

    assert ws.sent and ws.sent[0]["type"] == "connected", "the socket was open before the reset"
    assert ws.closed == expected
    assert str(user.id) not in hub.registry.connections


class _SilentSocketStub(_SocketStub):
    """A client that never sends anything, and is never told to hurry."""

    async def receive_text(self) -> str:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")


async def test_ws_revalidation_runs_on_the_clock_for_a_socket_that_sends_nothing(client, monkeypatch):
    """Revalidation used to run only when a frame arrived, so a silent socket kept
    receiving for up to REVALIDATE_SECONDS + HEARTBEAT_TIMEOUT after a reset."""
    _, _, user = await _org_member("WS Quiet Co", "wsquiet@x.com")
    monkeypatch.setattr(hub, "REVALIDATE_SECONDS", 0.05)
    ws = _SilentSocketStub(_token_for(user))
    task = asyncio.create_task(hub.websocket_endpoint(ws))
    for _ in range(200):
        if ws.sent:
            break
        await asyncio.sleep(0.01)
    assert ws.sent and ws.sent[0]["type"] == "connected"
    await _set(user.id, must_change_password=True)
    await asyncio.wait_for(task, timeout=5)
    assert ws.closed == (4403, "Password change required")


async def test_ws_junk_frames_do_not_skip_revalidation(client, monkeypatch):
    """An unparseable frame `continue`d past the checks, so a client sending junk
    every minute was never re-checked at all (batch 73 review)."""
    _, _, user = await _org_member("WS Junk Co", "wsjunk@x.com")
    monkeypatch.setattr(hub, "REVALIDATE_SECONDS", -1)

    async def _reset_lands():
        await _set(user.id, must_change_password=True)

    ws = _SocketStub(_token_for(user), frames=["not json"] * 3, before_each_frame=_reset_lands)
    await hub.websocket_endpoint(ws)
    assert ws.closed == (4403, "Password change required")


@pytest.mark.parametrize("change", [{"must_change_password": True}, {"is_active": False}])
async def test_call_frames_that_start_a_call_recheck_the_account_and_hang_ups_do_not(
    client, monkeypatch, change
):
    _, _, user = await _org_member("WS Call Co", "wscall@x.com")
    dispatched: list[str] = []
    published: list[dict] = []

    async def _dispatch(_user, data):
        dispatched.append(data["type"])

    async def _publish(_ids, payload):
        published.append(payload)

    monkeypatch.setattr("app.services.calls.handle_call_ws_message", _dispatch)
    monkeypatch.setattr(hub, "publish_to_users", _publish)
    handshake_user = await _row(user.id)  # loaded before the change, as the socket's is
    await _set(user.id, **change)

    for frame in ("call:initiate", "call:group_initiate", "call:accept", "call:join"):
        await hub._handle_inbound(handshake_user, {"type": frame, "call_id": "c1"})
    assert dispatched == []
    assert published and all(p["type"] == "call:error" for p in published)

    for frame in ("call:end", "call:cancel", "call:decline", "call:leave"):
        await hub._handle_inbound(handshake_user, {"type": frame, "call_id": "c1"})
    assert dispatched == ["call:end", "call:cancel", "call:decline", "call:leave"]


# ---------------------------------------------------------------------------
# Structural guard: every route is gated, and the exceptions are exactly these
# ---------------------------------------------------------------------------


def _reached(dependant, found: set) -> set:
    for sub in dependant.dependencies:
        # RateLimiter dependencies are instances, not functions, and carry no
        # __qualname__; identity against the two functions below is all that matters.
        found.add(sub.call)
        _reached(sub, found)
    return found


def test_every_route_is_gated_except_the_ones_that_must_not_be():
    gated, twin = deps.get_current_user, deps.get_current_user_pending_password_change
    neither, via_twin, both = set(), set(), set()
    for route in app.routes:
        # Only APIRoutes: the dev-only docs Routes authenticate nobody by design and
        # the websocket authenticates itself (tested above).
        if not isinstance(route, APIRoute):
            continue
        calls = _reached(route.dependant, set())
        for method in route.methods:
            key = (method, route.path)
            if gated in calls and twin in calls:
                both.add(key)
            elif twin in calls:
                via_twin.add(key)
            elif gated not in calls:
                neither.add(key)

    assert neither == PUBLIC_ROUTES, (
        "a route that reaches neither get_current_user nor its un-gated twin authenticates nobody — "
        "if that is deliberate, add it to PUBLIC_ROUTES"
    )
    assert via_twin == ALLOWED_WHILE_PENDING, (
        "the un-gated twin lets an account an administrator reset past the password-change gate; "
        "it belongs on logout, me, change-password and push unsubscribe only"
    )
    # Reaching both would gate the route anyway, which means the twin on it is dead
    # weight at best and a reset account locked out of the way out at worst.
    assert both == set()
