"""Web Push delivery. Best-effort: a failed/expired subscription is pruned,
never blocks the request that triggered it. No-op when VAPID is unconfigured.
"""

import json
import logging

import anyio
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.models import PushSubscription

logger = logging.getLogger(__name__)

try:
    from pywebpush import WebPushException, webpush

    _HAS_WEBPUSH = True
except ImportError:  # optional dependency; feature simply disabled if absent
    _HAS_WEBPUSH = False


async def push_to_users(db: AsyncSession, user_ids, payload: dict) -> None:
    settings = get_settings()
    if not _HAS_WEBPUSH or not settings.vapid_private_key or not user_ids:
        return
    subs = (
        (
            await db.execute(
                select(PushSubscription).where(PushSubscription.user_id.in_(list(user_ids)))
            )
        )
        .scalars()
        .all()
    )
    if not subs:
        return
    data = json.dumps(payload)
    dead: list[str] = []
    for sub in subs:
        try:
            await anyio.to_thread.run_sync(_send_one, sub, data, settings)
        except WebPushException as exc:  # noqa: PERF203
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in (404, 410):
                dead.append(sub.endpoint)
            else:
                logger.warning("web push failed: %s", exc)
        except Exception:
            logger.exception("web push error")
    if dead:
        await db.execute(delete(PushSubscription).where(PushSubscription.endpoint.in_(dead)))
        await db.commit()


def _send_one(sub: PushSubscription, data: str, settings) -> None:
    webpush(
        subscription_info={"endpoint": sub.endpoint, "keys": sub.keys},
        data=data,
        vapid_private_key=settings.vapid_private_key,
        vapid_claims={"sub": settings.vapid_subject},
    )
