import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import get_settings
from app.core.observability import AccessLogMiddleware, snapshot
from app.db.session import engine
from app.realtime import hub
from app.realtime.redis_bus import close_redis, get_redis
from app.utils import iso_z, now_utc

logger = logging.getLogger("rxhive")
logging.basicConfig(level=logging.INFO)

MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
# Cookie-authed browsers must present the custom header (CSRF defense: cross-site
# forms can't set custom headers without passing a CORS preflight we control).
CSRF_EXEMPT_PATHS = {"/api/auth/login", "/api/auth/refresh", "/api/livekit/webhook"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Production secret validation happens in Settings (config.py) and raises at
    # instantiation, so an unsafe production config never reaches here.
    with contextlib.suppress(Exception):
        from app.services.storage import ensure_bucket

        ensure_bucket()
    await hub.registry.start()
    yield
    await hub.registry.stop()
    await close_redis()
    await engine.dispose()


settings = get_settings()
# Interactive API docs are dev-only — no schema/enumeration surface in prod.
app = FastAPI(
    title="RX HIVE API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None if settings.is_production else "/docs",
    redoc_url=None if settings.is_production else "/redoc",
    openapi_url=None if settings.is_production else "/openapi.json",
)

if settings.cors_origin_list:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
    )
# No wildcard fallback: with no configured origins, cross-origin browsers are
# simply refused (same-origin deployments behind Caddy need no CORS at all).

app.add_middleware(AccessLogMiddleware)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    # CSRF: cookie-authenticated mutating requests must carry the custom header.
    if (
        request.method in MUTATING_METHODS
        and request.url.path.startswith("/api")
        and request.url.path not in CSRF_EXEMPT_PATHS
        and "authorization" not in request.headers
        and request.cookies
        and request.headers.get("x-requested-with") != "XMLHttpRequest"
    ):
        return JSONResponse(status_code=403, content={"detail": "Missing CSRF header"})

    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if settings.cookies_secure:
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    return response


from app.api import (  # noqa: E402
    admin,
    auth,
    calls,
    contacts,
    conversations,
    cross_org,
    groups,
    media,
    messages,
    notifications,
    org_admin,
    search,
    validation,
)

app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(validation.router)
app.include_router(conversations.router)
app.include_router(messages.router)
app.include_router(contacts.router)
app.include_router(groups.router)
app.include_router(media.router)
app.include_router(search.router)
app.include_router(cross_org.router)
app.include_router(org_admin.router)
app.include_router(calls.router)
app.include_router(notifications.router)
app.include_router(hub.router)


@app.get("/api/health")
async def health():
    db_status = "connected"
    redis_status = "connected"
    healthy = True
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        db_status, healthy = "disconnected", False
    try:
        await get_redis().ping()
    except Exception:
        redis_status, healthy = "disconnected", False
    body = {
        "status": "healthy" if healthy else "unhealthy",
        "version": "1.0.0",
        "service": "RxHive API",
        "timestamp": iso_z(now_utc()),
        "database": db_status,
        "redis": redis_status,
    }
    return JSONResponse(status_code=200 if healthy else 503, content=body)


@app.get("/api/metrics")
async def metrics():
    """In-process request counters + average latencies for scraping/dashboards.
    Cheap and dependency-free; swap for Prometheus if/when scale demands."""
    data = snapshot()
    data["ws_local_sockets"] = hub.registry.local_socket_count()
    return data
