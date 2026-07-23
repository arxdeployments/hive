"""Presence backed by Redis — works across any number of API workers.

A user is online while at least one worker holds a live WebSocket for them.
Each connection registers itself under presence:{user_id} with a TTL that the
connection's heartbeat keeps refreshing, so crashed workers can't leak
"online forever" state.
"""

import uuid

from app.realtime.redis_bus import get_redis

_TTL = 90  # seconds; heartbeats arrive at least every 60s


def _key(user_id) -> str:
    return f"presence:{user_id}"


async def mark_online(user_id: uuid.UUID, conn_id: str) -> bool:
    """Register a connection. Returns True if the user just came online."""
    redis = get_redis()
    key = _key(user_id)
    added = await redis.sadd(key, conn_id)
    await redis.expire(key, _TTL)
    count = await redis.scard(key)
    return bool(added) and count == 1


async def refresh(user_id: uuid.UUID) -> None:
    await get_redis().expire(_key(user_id), _TTL)


async def mark_offline(user_id: uuid.UUID, conn_id: str) -> bool:
    """Deregister a connection. Returns True if the user just went offline."""
    redis = get_redis()
    key = _key(user_id)
    await redis.srem(key, conn_id)
    return await redis.scard(key) == 0


async def is_online(user_id) -> bool:
    return await get_redis().exists(_key(user_id)) > 0


async def get_statuses(user_ids: list) -> dict[str, str]:
    """Batch presence lookup: {user_id_str: "online"|"offline"}."""
    if not user_ids:
        return {}
    redis = get_redis()
    pipe = redis.pipeline()
    for uid in user_ids:
        pipe.exists(_key(uid))
    results = await pipe.execute()
    return {
        str(uid): ("online" if exists else "offline") for uid, exists in zip(user_ids, results, strict=True)
    }
