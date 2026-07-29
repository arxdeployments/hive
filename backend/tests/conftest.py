"""Test harness: real Postgres + real Redis, app exercised through ASGI.

Each session runs in its own Postgres schema (migrated via Alembic) and its own
Redis logical database, with tables truncated between tests, so every test sees
the schema production runs on without two concurrent runs sharing state.
"""

import os

os.environ.setdefault("RXHIVE_DATABASE_URL", "postgresql+asyncpg://rxhive:rxhive@localhost:5432/rxhive_test")
os.environ.setdefault("RXHIVE_REDIS_URL", "redis://localhost:6379/9")
os.environ.setdefault("RXHIVE_ENVIRONMENT", "test")
os.environ.setdefault("RXHIVE_SEED_SUPERADMIN_EMAIL", "")
os.environ.setdefault("RXHIVE_SEED_SUPERADMIN_PASSWORD", "")

import asyncio  # noqa: E402
import fcntl  # noqa: E402
import tempfile  # noqa: E402
from collections.abc import Coroutine  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import urlparse, urlunparse  # noqa: E402

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import event, select, text  # noqa: E402
from sqlalchemy.ext.asyncio import create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402

# Two pytest runs sharing one Postgres/Redis used to corrupt each other: the
# autouse TRUNCATE below landed between the other run's fixture INSERTs
# (UniqueViolation on organizations_slug_key, then users_org_id_fkey). Give each
# session private state instead of making every fixture use random identities.
# The pid is enough to be unique among *live* runs; the xdist worker id is only
# there to make orphaned schemas readable.
SCHEMA = f"test_{os.environ.get('PYTEST_XDIST_WORKER', 'main')}_{os.getpid()}"

BACKEND_DIR = Path(__file__).resolve().parent.parent
REDIS_DB_COUNT = 16  # Redis' default `databases`
_redis_db_lock_fds: list[int] = []


def _reserve_redis_db() -> None:
    """Claim a Redis logical DB no other run is using.

    `_clean_state` flushes the whole logical DB and the rate limiter keys on
    client IP — identical in every run — so runs sharing one DB would flush each
    other's keys and share one rate-limit budget. The flock is held by the
    process, so a crashed run releases it automatically.

    Only the configured DB and the ones above it are fair game: lower indexes
    belong to whatever else is on this Redis (a local dev stack lives on 0), and
    the flush would take its keys with ours.
    """
    url = urlparse(os.environ["RXHIVE_REDIS_URL"])
    try:
        preferred = int(url.path.lstrip("/") or 0)
    except ValueError:
        preferred = 0
    lock_dir = Path(tempfile.gettempdir())
    for db in range(preferred, REDIS_DB_COUNT):
        try:
            fd = os.open(lock_dir / f"rxhive-test-redis-{db}.lock", os.O_CREAT | os.O_RDWR, 0o666)
        except OSError:
            continue  # e.g. lock file owned by another user
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            continue
        _redis_db_lock_fds.append(fd)  # never closed: closing the fd drops the lock
        os.environ["RXHIVE_REDIS_URL"] = urlunparse(url._replace(path=f"/{db}"))
        return
    raise RuntimeError(
        f"Redis logical databases {preferred}-{REDIS_DB_COUNT - 1} are all held by other test runs — "
        "point RXHIVE_REDIS_URL at another Redis server"
    )


_reserve_redis_db()

from app.core.config import get_settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db.models import Base, User, UserRole  # noqa: E402
from app.db.session import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.realtime.redis_bus import get_redis  # noqa: E402

CSRF = {"X-Requested-With": "XMLHttpRequest"}


# The app engine is built at import time from the URL alone, so the schema has
# to be pinned per connection. public stays on the path for the citext type.
@event.listens_for(engine.sync_engine, "connect")
def _pin_search_path(dbapi_connection, _record) -> None:
    dbapi_connection.run_async(lambda conn: conn.execute(f'SET search_path TO "{SCHEMA}", public'))


def _ddl_engine():
    """Throwaway engine for session setup/teardown, pinned to the same schema."""
    return create_async_engine(
        get_settings().database_url,
        poolclass=NullPool,
        connect_args={"server_settings": {"search_path": f"{SCHEMA},public"}},
    )


def _run(coro: Coroutine):
    """Run setup/teardown on a throwaway loop, leaving the process-wide current
    event loop alone for pytest-asyncio."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _upgrade_to_head(sync_connection) -> None:
    # Alembic runs on our connection so the migration lands in SCHEMA. Config()
    # is deliberately file-less: alembic.ini's fileConfig would reconfigure
    # logging for the whole pytest process.
    cfg = Config()
    cfg.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    cfg.attributes["connection"] = sync_connection
    cfg.attributes["version_table_schema"] = SCHEMA
    command.upgrade(cfg, "head")


async def _create_schema() -> None:
    ddl = _ddl_engine()
    try:
        async with ddl.begin() as conn:
            # citext has to live in a shared schema: left to the migration it
            # would land in SCHEMA and be dropped out from under other sessions.
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public"))
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
            await conn.execute(text(f'CREATE SCHEMA "{SCHEMA}"'))
        async with ddl.begin() as conn:
            await conn.run_sync(_upgrade_to_head)
        async with ddl.connect() as conn:
            rows = await conn.execute(
                text("SELECT tablename FROM pg_tables WHERE schemaname = :schema"), {"schema": SCHEMA}
            )
            missing = {t.name for t in Base.metadata.sorted_tables} - {r[0] for r in rows}
        if missing:
            # Unqualified names would silently fall through to same-named tables
            # in public, putting every session back on shared state.
            raise RuntimeError(f"migrations left {sorted(missing)} out of schema {SCHEMA}")
    finally:
        await ddl.dispose()


async def _drop_schema() -> None:
    ddl = _ddl_engine()
    try:
        async with ddl.begin() as conn:
            await conn.execute(text("SET lock_timeout = '10s'"))
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE'))
    except Exception as exc:  # a leftover schema must not fail an otherwise green run
        print(f"warning: could not drop test schema {SCHEMA}: {exc}")
    finally:
        await ddl.dispose()


@pytest.fixture(scope="session", autouse=True)
def _migrated_schema():
    try:
        _run(_create_schema())
    except Exception:
        _run(_drop_schema())  # a half-built schema must not outlive the run
        raise
    yield
    _run(_drop_schema())


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
    mobile_access: bool = False,
    link_peers: bool = True,
) -> User:
    """Create a user and, by default, make them reachable by their org-mates.

    `link_peers` exists because chat reachability is DENY BY DEFAULT: with no
    ChatAccessRule a pair cannot hold a conversation at all, so without this
    every test that sends a message would fail with 403 and would have to grow
    access-control setup it is not about.

    Granting explicit user-pair rules mirrors what the production migration does
    for existing relationships, so tests still exercise the real enforcement
    path rather than a bypass — the rules are genuinely evaluated, they just say
    yes. Tests ABOUT access control pass link_peers=False and build their own.

    Rules are only created between users of the SAME org, so cross-tenant tests
    keep failing closed exactly as they should.
    """
    async with SessionLocal() as db:
        user = User(
            email=email,
            display_name=display_name or email.split("@")[0].title(),
            password_hash=hash_password(password),
            role=role,
            org_id=org_id,
            dept_id=dept_id,
            is_active=True,
            mobile_access=mobile_access,
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        if link_peers and org_id is not None and role != UserRole.superadmin:
            from app.db.models import AccessPartyType, ChatAccessRule
            from app.services.access import canonical_pair

            peers = (
                (
                    await db.execute(
                        select(User.id).where(
                            User.org_id == org_id,
                            User.id != user.id,
                            User.role != UserRole.superadmin,
                        )
                    )
                )
                .scalars()
                .all()
            )
            # Only the NEW user is paired with each existing one, so this cannot
            # collide with the canonical-pair unique constraint.
            for peer_id in peers:
                (a_type, a_id), (b_type, b_id) = canonical_pair(
                    (AccessPartyType.user, user.id), (AccessPartyType.user, peer_id)
                )
                db.add(
                    ChatAccessRule(
                        org_id=org_id, a_type=a_type, a_id=a_id, b_type=b_type, b_id=b_id, allow=True
                    )
                )
            await db.commit()
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
