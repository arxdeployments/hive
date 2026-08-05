"""Presence backed by Redis — works across any number of API workers.

A user is online while at least one worker holds a live WebSocket for them.
Each connection registers itself under presence:{user_id} with a TTL that the
connection's heartbeat keeps refreshing, so crashed workers can't leak
"online forever" state.
"""

import uuid

from app.realtime.redis_bus import degrade_on_outage, get_redis

_TTL = 90  # seconds; heartbeats arrive at least every 60s


def _key(user_id) -> str:
    return f"presence:{user_id}"


async def mark_online(user_id: uuid.UUID, conn_id: str) -> bool:
    """Register a connection. Returns True if the user just came online.

    MULTI, because the caller uses the result as an edge trigger and separate
    round trips lose that edge: when a phone and a browser tab connect within the
    same few milliseconds both SADDs land before either SCARD, so both read
    count == 2, both return False, and nobody ever publishes the `online`
    presence event — the user stays grey to every conversation partner until
    something unrelated forces a refetch.
    """
    pipe = get_redis().pipeline(transaction=True)
    key = _key(user_id)
    pipe.sadd(key, conn_id)
    pipe.expire(key, _TTL)
    pipe.scard(key)
    added, _, count = await pipe.execute()
    return bool(added) and count == 1


async def refresh(user_id: uuid.UUID) -> None:
    await get_redis().expire(_key(user_id), _TTL)


async def mark_offline(user_id: uuid.UUID, conn_id: str) -> bool:
    """Deregister a connection. Returns True if the user just went offline.

    MULTI for the same reason as mark_online: the `offline` broadcast is an edge.
    """
    pipe = get_redis().pipeline(transaction=True)
    key = _key(user_id)
    pipe.srem(key, conn_id)
    pipe.scard(key)
    _, count = await pipe.execute()
    return count == 0


async def is_online(user_id) -> bool:
    online = False
    async with degrade_on_outage("presence.is_online"):
        online = await get_redis().exists(_key(user_id)) > 0
    return online


async def get_statuses(user_ids: list) -> dict[str, str]:
    """Batch presence lookup: {user_id_str: "online"|"offline"}.

    Degrades to all-offline when Redis is unreachable. This lookup decorates
    responses whose real payload came from Postgres — including the login and
    send paths — so an outage must cost a green dot, not the whole request.
    """
    if not user_ids:
        return {}
    statuses = {str(uid): "offline" for uid in user_ids}
    async with degrade_on_outage("presence.get_statuses"):
        redis = get_redis()
        pipe = redis.pipeline()
        for uid in user_ids:
            pipe.exists(_key(uid))
        results = await pipe.execute()
        for uid, exists in zip(user_ids, results, strict=True):
            statuses[str(uid)] = "online" if exists else "offline"
    return statuses
