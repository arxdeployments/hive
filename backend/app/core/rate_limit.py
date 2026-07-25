"""Redis-backed fixed-window rate limiting.

The Mongo build shipped a limiter attached to a route path that never matched —
dead code. This one is a plain dependency wired directly onto the routes it
protects, with a test proving it fires.
"""

from fastapi import HTTPException, Request

from app.core.config import get_settings
from app.realtime.redis_bus import get_redis


def _client_ip(request: Request) -> str:
    """Real client IP. Behind our own reverse proxy (Caddy) the peer is the
    proxy, so trust the first X-Forwarded-For hop; otherwise use the peer.
    Without this, every request shares the proxy's IP and the limiter degrades
    into a single global bucket."""
    if get_settings().trust_proxy:
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class RateLimiter:
    """Fixed-window limiter. `times` is resolved per-request from settings so
    limits are tunable per deployment (and can be relaxed for E2E runs, where
    every request legitimately shares one source IP) without touching code."""

    def __init__(self, scope: str, default_times: int, seconds: int = 60):
        self.scope = scope
        self.default_times = default_times
        self.seconds = seconds

    def _limit(self) -> int:
        return getattr(get_settings(), f"rate_limit_{self.scope}", self.default_times)

    async def __call__(self, request: Request) -> None:
        limit = self._limit()
        if limit <= 0:
            return  # 0 disables the limiter for this scope
        redis = get_redis()
        key = f"ratelimit:{self.scope}:{_client_ip(request)}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, self.seconds)
        if count > limit:
            ttl = await redis.ttl(key)
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Try again later.",
                headers={"Retry-After": str(max(ttl, 1))},
            )


login_limiter = RateLimiter("login", default_times=10)
refresh_limiter = RateLimiter("refresh", default_times=30)
password_limiter = RateLimiter("password", default_times=5)
upload_limiter = RateLimiter("upload", default_times=30)
# Export materializes a whole transcript in memory, so it needs its own (tight)
# bucket rather than sharing one with cheap reads.
export_limiter = RateLimiter("export", default_times=10)
