"""Regression tests for the closed security-review findings."""

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.services.push import validate_push_endpoint
from tests.conftest import login, make_user


def test_production_rejects_placeholder_secrets():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            environment="production",
            secret_key="change-me-openssl-rand-hex-32",
            livekit_api_secret="x" * 40,
            s3_secret_key="y" * 40,
        )


def test_production_rejects_short_secret():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            environment="production",
            secret_key="tooshort",
            livekit_api_secret="x" * 40,
            s3_secret_key="y" * 40,
        )


def test_production_accepts_strong_secrets_and_forces_secure_cookies():
    s = Settings(
        _env_file=None,
        environment="production",
        secret_key="a" * 48,
        livekit_api_secret="b" * 40,
        s3_secret_key="c" * 40,
    )
    assert s.cookies_secure is True
    assert s.is_production is True


def test_dev_uses_insecure_cookies_by_default():
    assert Settings(_env_file=None).cookies_secure is False


def test_explicit_cookie_secure_override_wins():
    assert (
        Settings(
            _env_file=None,
            cookie_secure=False,
            environment="production",
            secret_key="a" * 48,
            livekit_api_secret="b" * 40,
            s3_secret_key="c" * 40,
        ).cookies_secure
        is False
    )


@pytest.mark.parametrize(
    "endpoint,ok",
    [
        ("https://fcm.googleapis.com/fcm/send/abc", True),
        ("http://fcm.googleapis.com/fcm/send/abc", False),  # not https
        ("https://localhost/x", False),  # loopback
        ("https://127.0.0.1/x", False),  # loopback ip
        ("https://10.0.0.5/x", False),  # private
        ("https://169.254.169.254/x", False),  # link-local (cloud metadata)
        ("ftp://example.com/x", False),
        ("not a url", False),
    ],
)
def test_push_endpoint_ssrf_validation(endpoint, ok):
    assert validate_push_endpoint(endpoint) is ok


async def test_push_subscribe_rejects_ssrf_endpoint(client, two_orgs_with_users):
    await login(client, "alice@a.com")
    resp = await client.post(
        "/api/notifications/subscribe",
        json={"endpoint": "https://127.0.0.1:9200/push", "keys": {"p256dh": "x", "auth": "y"}},
    )
    assert resp.status_code == 400


async def test_change_password_revokes_other_sessions(client):
    from sqlalchemy import select

    from app.db.models import RefreshToken
    from app.db.session import SessionLocal

    user = await make_user("carla@x.com")
    await login(client, "carla@x.com")
    resp = await client.post(
        "/api/auth/change-password",
        json={"current_password": "TestPass1234", "new_password": "BrandNewPass99"},
    )
    assert resp.status_code == 200
    async with SessionLocal() as db:
        tokens = (
            (await db.execute(select(RefreshToken).where(RefreshToken.user_id == user.id))).scalars().all()
        )
        assert tokens and all(t.revoked_at is not None for t in tokens)


async def test_push_subscribe_unsubscribe_round_trip(client, two_orgs_with_users):
    """The frontend's subscribe/unsubscribe pair must match the routes the API
    actually exposes — a mismatch here silently 404s in the browser."""
    from sqlalchemy import select

    from app.db.models import PushSubscription
    from app.db.session import SessionLocal

    await login(client, "alice@a.com")
    endpoint = "https://fcm.googleapis.com/fcm/send/round-trip-test"

    resp = await client.post(
        "/api/notifications/subscribe",
        json={"endpoint": endpoint, "keys": {"p256dh": "x", "auth": "y"}},
    )
    assert resp.status_code == 200, resp.text

    async with SessionLocal() as db:
        rows = (await db.execute(select(PushSubscription))).scalars().all()
        assert [r.endpoint for r in rows] == [endpoint]

    resp = await client.request(
        "DELETE", "/api/notifications/subscribe", json={"endpoint": endpoint}
    )
    assert resp.status_code == 200, resp.text

    async with SessionLocal() as db:
        assert (await db.execute(select(PushSubscription))).scalars().all() == []
