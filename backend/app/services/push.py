"""Web Push delivery. Best-effort: a failed/expired subscription is pruned,
never blocks the request that triggered it. No-op when VAPID is unconfigured.
"""

import asyncio
import ipaddress
import json
import logging
import socket
from urllib.parse import urlsplit

import anyio
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import PushSubscription
from app.db.session import SessionLocal


def validate_push_endpoint(endpoint: str) -> bool:
    """Reject SSRF-prone push endpoints: must be https to a public host, never
    an internal/loopback/link-local address. The server POSTs to this URL."""
    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    if parts.scheme != "https" or not parts.hostname:
        return False
    host = parts.hostname
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


logger = logging.getLogger(__name__)

try:
    from pywebpush import WebPushException, webpush

    _HAS_WEBPUSH = True
except ImportError:  # optional dependency; feature simply disabled if absent
    _HAS_WEBPUSH = False


SEND_TIMEOUT_SECONDS = 5
_MAX_CONCURRENT_SENDS = 10

# asyncio keeps only a weak reference to a running task, so a fire-and-forget
# task with no other referent can be garbage-collected mid-flight. Hold a
# strong reference until it completes.
_background_tasks: set[asyncio.Task] = set()


def dispatch_push_to_users(user_ids, payload: dict) -> None:
    """Fan out Web Push off the caller's path, fire-and-forget.

    Awaited inline this put N remote HTTPS POSTs into the sender's latency and
    pinned the request's DB session (pool size 10) for their whole duration.
    """
    settings = get_settings()
    if not _HAS_WEBPUSH or not settings.vapid_private_key or not user_ids:
        return
    task = asyncio.create_task(_push_in_background(list(user_ids), payload))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)


async def _push_in_background(user_ids, payload: dict) -> None:
    # Own session: the request that triggered this has already returned and
    # closed its own. Nothing may escape — push is best-effort, and an
    # exception here has no caller left to surface it to.
    try:
        async with SessionLocal() as db:
            await push_to_users(db, user_ids, payload)
    except Exception:
        logger.exception("background web push failed")


async def push_to_users(db: AsyncSession, user_ids, payload: dict) -> None:
    settings = get_settings()
    if not _HAS_WEBPUSH or not settings.vapid_private_key or not user_ids:
        return
    subs = (
        (await db.execute(select(PushSubscription).where(PushSubscription.user_id.in_(list(user_ids)))))
        .scalars()
        .all()
    )
    if not subs:
        return
    data = json.dumps(payload)
    dead: list[str] = []
    # Concurrent, but bounded: a large group must not hand the whole worker
    # thread pool to one push fan-out.
    limiter = anyio.CapacityLimiter(_MAX_CONCURRENT_SENDS)
    async with anyio.create_task_group() as tg:
        for sub in subs:
            tg.start_soon(_deliver, sub, data, settings, limiter, dead)
    if dead:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
        await db.commit()


async def _deliver(
    sub: PushSubscription, data: str, settings, limiter: anyio.CapacityLimiter, dead: list[str]
) -> None:
    """Deliver to one subscription. Must never raise: an exception out of a
    task-group child cancels its siblings, so one bad endpoint would take down
    the rest of the fan-out."""
    try:
        await anyio.to_thread.run_sync(_send_one, sub, data, settings, limiter=limiter)
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status in (404, 410):
            dead.append(sub.endpoint)
        else:
            logger.warning("web push failed: %s", exc)
    except Exception:
        logger.exception("web push error")


def _send_one(sub: PushSubscription, data: str, settings) -> None:
    webpush(
        subscription_info={"endpoint": sub.endpoint, "keys": sub.keys},
        data=data,
        vapid_private_key=settings.vapid_private_key,
        vapid_claims={"sub": settings.vapid_subject},
        # pywebpush uses requests, which has no default timeout: a blackholed
        # push endpoint would hang this worker thread forever.
        timeout=SEND_TIMEOUT_SECONDS,
    )
