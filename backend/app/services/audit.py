import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AuditLog
from app.utils import iso_z


async def log_audit(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID,
    actor_type: str,
    action: str,
    target: str = "",
    details: dict | None = None,
    org_id: uuid.UUID | None = None,
) -> None:
    details = dict(details or {})
    if org_id is not None:
        details.setdefault("org_id", str(org_id))
    db.add(
        AuditLog(
            org_id=org_id,
            actor_id=actor_id,
            actor_type=actor_type,
            action=action,
            target=target,
            details=details,
        )
    )


def serialize_audit(log: AuditLog) -> dict:
    return {
        "_id": str(log.id),
        "actor_id": str(log.actor_id) if log.actor_id else None,
        "actor_type": log.actor_type,
        "action": log.action,
        "target": log.target or "",
        "details": log.details or {},
        "ip_address": "",
        "timestamp": iso_z(log.created_at),
    }
