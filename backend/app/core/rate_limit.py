"""Redis-backed fixed-window rate limiting.

The Mongo build shipped a limiter attached to a route path that never matched —
dead code. This one is a plain dependency wired directly onto the routes it
protects, with a test proving it fires.
"""

from fastapi import HTTPException, Request

from app.realtime.redis_bus import get_redis


class RateLimiter:
    def __init__(self, times: int, seconds: int, scope: str):
        self.times = times
        self.seconds = seconds
        self.scope = scope

    async def __call__(self, request: Request) -> None:
        redis = get_redis()
        client_ip = request.client.host if request.client else "unknown"
        key = f"ratelimit:{self.scope}:{client_ip}"
        count = await redis.incr(key)
        if count == 1:
            await redis.expire(key, self.seconds)
        if count > self.times:
            ttl = await redis.ttl(key)
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Try again later.",
                headers={"Retry-After": str(max(ttl, 1))},
            )


login_limiter = RateLimiter(times=10, seconds=60, scope="login")
refresh_limiter = RateLimiter(times=30, seconds=60, scope="refresh")
password_limiter = RateLimiter(times=5, seconds=60, scope="password")
upload_limiter = RateLimiter(times=30, seconds=60, scope="upload")
