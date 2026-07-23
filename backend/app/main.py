import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import get_settings
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
    settings = get_settings()
    if settings.is_production and settings.secret_key == "dev-only-secret-change-in-production":
        raise RuntimeError("RXHIVE_SECRET_KEY must be set in production")
    with contextlib.suppress(Exception):
        from app.services.storage import ensure_bucket

        ensure_bucket()
    await hub.registry.start()
    yield
    await hub.registry.stop()
    await close_redis()
    await engine.dispose()


app = FastAPI(title="RX HIVE API", version="1.0.0", lifespan=lifespan)

settings = get_settings()
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
    if settings.cookie_secure:
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
