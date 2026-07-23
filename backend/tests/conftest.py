"""Test harness: real Postgres + real Redis, app exercised through ASGI.

The suite runs against rxhive_test (migrated via Alembic) with tables truncated
between tests, so every test sees the schema production runs on.
"""

import os

os.environ.setdefault("RXHIVE_DATABASE_URL", "postgresql+asyncpg://rxhive:rxhive@localhost:5432/rxhive_test")
os.environ.setdefault("RXHIVE_REDIS_URL", "redis://localhost:6379/9")
os.environ.setdefault("RXHIVE_ENVIRONMENT", "test")
os.environ.setdefault("RXHIVE_SEED_SUPERADMIN_EMAIL", "")
os.environ.setdefault("RXHIVE_SEED_SUPERADMIN_PASSWORD", "")

import asyncio  # noqa: E402
import subprocess  # noqa: E402

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.security import hash_password  # noqa: E402
from app.db.models import Base, User, UserRole  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.realtime.redis_bus import get_redis  # noqa: E402

CSRF = {"X-Requested-With": "XMLHttpRequest"}


@pytest.fixture(scope="session", autouse=True)
def _migrated_schema():
    subprocess.run(
        [".venv/bin/alembic" if os.path.exists(".venv/bin/alembic") else "alembic", "upgrade", "head"],
        check=True,
        env={**os.environ},
        capture_output=True,
    )
    yield


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(autouse=True)
async def _clean_state(_migrated_schema):
    tables = ", ".join(t.name for t in Base.metadata.sorted_tables)
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {tables} CASCADE"))
    await get_redis().flushdb()
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        c.headers.update(CSRF)
        yield c


async def make_user(
    email: str,
    *,
    role: UserRole = UserRole.member,
    org_id=None,
    dept_id=None,
    password: str = "TestPass1234",
    display_name: str | None = None,
) -> User:
    async with SessionLocal() as db:
        user = User(
            email=email,
            display_name=display_name or email.split("@")[0].title(),
            password_hash=hash_password(password),
            role=role,
            org_id=org_id,
            dept_id=dept_id,
            is_active=True,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
        return user


async def make_org(name: str):
    from app.db.models import Organization
    from app.utils import slugify

    async with SessionLocal() as db:
        org = Organization(name=name, slug=slugify(name), is_active=True)
        db.add(org)
        await db.commit()
        await db.refresh(org)
        return org


async def login(client: AsyncClient, email: str, password: str = "TestPass1234") -> dict:
    resp = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["user"]


@pytest.fixture
async def two_orgs_with_users(client):
    """Org A (alice, bob) + Org B (carol) — the standing isolation scenario."""
    org_a = await make_org("Org Alpha")
    org_b = await make_org("Org Beta")
    alice = await make_user("alice@a.com", org_id=org_a.id, display_name="Alice")
    bob = await make_user("bob@a.com", org_id=org_a.id, display_name="Bob")
    carol = await make_user("carol@b.com", org_id=org_b.id, display_name="Carol")
    return {"org_a": org_a, "org_b": org_b, "alice": alice, "bob": bob, "carol": carol}


def cookies_of(resp_client: AsyncClient) -> dict:
    return {c.name: c.value for c in resp_client.cookies.jar}
