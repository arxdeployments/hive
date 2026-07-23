"""Notifications (net-new vs the Mongo build): in-app list + Web Push subs."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user
from app.db.models import Notification, PushSubscription, User
from app.db.session import get_db
from app.utils import iso_z

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("/vapid-key")
async def vapid_key(_: User = Depends(get_current_user)):
    """Public VAPID key for the browser Push subscription (empty if unconfigured)."""
    return {"public_key": get_settings().vapid_public_key}


def _serialize_notification(n: Notification) -> dict:
    return {
        "_id": str(n.id),
        "type": n.type,
        "payload": n.payload or {},
        "is_read": n.is_read,
        "created_at": iso_z(n.created_at),
    }


@router.get("")
async def list_notifications(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    rows = (
        (
            await db.execute(
                select(Notification)
                .where(Notification.user_id == user.id)
                .order_by(Notification.created_at.desc())
                .limit(50)
            )
        )
        .scalars()
        .all()
    )
    return {"data": [_serialize_notification(n) for n in rows]}


@router.post("/read-all")
async def read_all(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user.id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    await db.commit()
    return {"message": "Marked as read"}


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: dict = Field(default_factory=dict)


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.post("/subscribe")
async def subscribe(
    body: SubscribeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    endpoint = (body.endpoint or "").strip()
    if not endpoint:
        raise HTTPException(status_code=400, detail="Endpoint required")
    existing = (
        await db.execute(select(PushSubscription).where(PushSubscription.endpoint == endpoint))
    ).scalar_one_or_none()
    if existing is not None:
        # Endpoints are globally unique; re-subscribing re-binds to the caller.
        existing.user_id = user.id
        existing.keys = dict(body.keys or {})
    else:
        db.add(PushSubscription(user_id=user.id, endpoint=endpoint, keys=dict(body.keys or {})))
    await db.commit()
    return {"message": "Subscribed"}


@router.delete("/subscribe")
async def unsubscribe(
    body: UnsubscribeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == (body.endpoint or "").strip(),
            PushSubscription.user_id == user.id,
        )
    )
    await db.commit()
    return {"message": "Unsubscribed"}
