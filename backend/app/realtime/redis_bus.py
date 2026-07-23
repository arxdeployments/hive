"""Shared async Redis client + pub/sub event bus.

Fan-out model: every realtime event is published to the per-user channel
`user:{user_id}` of each intended recipient. A worker runs one pub/sub reader
and subscribes to the channels of the users connected to *it*. Delivery is
therefore scoped at publish time — a socket can never receive an event for a
user or org it doesn't belong to, on any worker.
"""

import json

import redis.asyncio as aioredis

from app.core.config import get_settings

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


async def publish_to_users(user_ids, event: dict) -> None:
    """Publish one event to every recipient's channel."""
    redis = get_redis()
    payload = json.dumps(event, default=str)
    pipe = redis.pipeline()
    for uid in user_ids:
        pipe.publish(user_channel(uid), payload)
    await pipe.execute()
