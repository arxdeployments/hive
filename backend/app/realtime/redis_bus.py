"""Shared async Redis client + pub/sub event bus.

Fan-out model: every realtime event is published to the per-user channel
`user:{user_id}` of each intended recipient. A worker runs one pub/sub reader
and subscribes to the channels of the users connected to *it*. Delivery is
therefore scoped at publish time — a socket can never receive an event for a
user or org it doesn't belong to, on any worker.
"""

import contextlib
import json
import logging
from collections.abc import AsyncIterator

import redis.asyncio as aioredis

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_redis: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(get_settings().redis_url, decode_responses=True)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


def user_channel(user_id) -> str:
    return f"user:{user_id}"


@contextlib.asynccontextmanager
async def degrade_on_outage(operation: str) -> AsyncIterator[None]:
    """Run best-effort Redis work, logging and continuing if Redis is down.

    Realtime fan-out and presence sit AFTER the database commit that is the real
    result of a request. Letting a Redis outage escape from there turned an
    already-persisted message into a 500: the sender was told the send failed for
    a message the server had stored, and clients resend on failure. Only wrap
    post-commit, best-effort work — a failed DB write must still surface as 500.
    """
    try:
        yield
    except Exception:
        logger.warning("Redis unavailable; skipped %s", operation, exc_info=True)


async def publish_to_users(user_ids, event: dict) -> None:
    """Publish one event to every recipient's channel. Best-effort: a broker
    outage costs the live event (clients refetch on reconnect), not the request."""
    # Serialized outside the guard: an unserializable payload is a bug in the
    # caller, not an outage, and must not be silently swallowed.
    payload = json.dumps(event, default=str)
    async with degrade_on_outage("publish_to_users"):
        redis = get_redis()
        pipe = redis.pipeline()
        for uid in user_ids:
            pipe.publish(user_channel(uid), payload)
        await pipe.execute()
