"""Contacts roster — GET /api/users/contacts.

Wire contract preserved from RxHivexx (docs/reference/api-uploads-calls-misc.md):
bare array response with the `department_name` key (the /api/search contacts
bucket calls the same concept `department`). Fixes vs the Mongo build: the
search input is escaped + parameterized (was raw $regex — injection/ReDoS),
and departments are batch-joined instead of one lookup per user.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import or_, select

from app.core.deps import TenantContext, get_tenant
from app.db.models import Department, User
from app.services import presence
from app.utils import iso_z

router = APIRouter(prefix="/api/users", tags=["contacts"])


def _like_pattern(value: str) -> str:
    """Escape LIKE wildcards so user input is matched literally."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("/contacts")
async def list_contacts(
    search: str = "",
    tenant: TenantContext = Depends(get_tenant),
) -> list[dict]:
    """All active users in the caller's org except self, display_name asc.

    Callers without an org (superadmins) have no roster: returns [].
    """
    user = tenant.user
    if user.org_id is None:
        return []

    stmt = (
        select(User, Department.name)
        .outerjoin(Department, Department.id == User.dept_id)
        .where(
            User.org_id == user.org_id,
            User.is_active.is_(True),
            User.id != user.id,
        )
        .order_by(User.display_name.asc())
    )
    if search:
        pattern = _like_pattern(search)
        stmt = stmt.where(
            or_(
                User.display_name.ilike(pattern, escape="\\"),
                User.email.ilike(pattern, escape="\\"),
            )
        )

    rows = (await tenant.db.execute(stmt)).all()
    statuses = await presence.get_statuses([u.id for u, _ in rows])

    return [
        {
            "id": str(u.id),
            "display_name": u.display_name,
            "email": u.email,
            "avatar_url": u.avatar_url,
            "department_name": dept_name or "Unknown",
            "status": statuses.get(str(u.id), "offline"),
            "last_seen": iso_z(u.last_seen_at),
        }
        for u, dept_name in rows
    ]
