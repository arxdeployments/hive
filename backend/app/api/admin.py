"""Super-admin portal: stats, organizations, departments, users.

Wire contract preserved from RxHivexx (docs/reference/api-auth-admin.md):
serialize_doc-style responses keep `_id` string keys, lists keep the
{data, total, page, limit} envelope, /organizations/all and
/organizations/{org_id}/users keep their bare-array shapes (the latter with
`id` keys), datetimes are ISO-Z, and roles ride the wire as "admin"/"member".

Deliberate contract-preserving fixes (coordinated with the frontend):
- Deactivation (user PUT, bulk, org cascade, org delete) revokes the target
  users' refresh tokens, closing the refresh-forever hole.
- Org reactivation (PUT is_active=true) restores the ORG only — it no longer
  blanket-reactivates users, so individually-deactivated accounts stay off.
- A suspended org stays suspended: creating a user in one is refused, and
  activating a member (singly or in bulk) is refused/skipped. Nothing on the
  login path reads Organization.is_active, so the suspension is carried by the
  users.is_active cascade alone and these are the routes that could undo it.
- reset-password sets must_change_password and revokes sessions; the
  temporary password is still returned per contract.
- Create/update user validates the department exists in the target org;
  bulk change_dept skips users whose org doesn't match the department.
- Passwords go through the org password policy; emails are unique
  case-insensitively (citext).
- Search input is escaped and parameterized (no regex/LIKE injection).
"""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import wire_role
from app.core.deps import require_superadmin
from app.core.security import PasswordPolicyError, enforce_password_policy, hash_password
from app.db.models import AuditLog, Department, Organization, RefreshToken, User, UserRole
from app.db.session import get_db
from app.realtime.redis_bus import degrade_on_outage, get_redis
from app.services import presence
from app.services.audit import log_audit, serialize_audit
from app.utils import generate_password, iso_z, now_utc, parse_uuid, sanitize_text, slugify

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class CreateOrganization(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    logo_url: str | None = None


class UpdateOrganization(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    logo_url: str | None = None
    is_active: bool | None = None


class CreateDepartment(BaseModel):
    org_id: str
    name: str = Field(min_length=2, max_length=100)
    description: str | None = None


class UpdateDepartment(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = None


class CreateUser(BaseModel):
    org_id: str
    dept_id: str
    email: EmailStr
    display_name: str = Field(min_length=2, max_length=100)
    password: str = Field(min_length=6)
    role: Literal["admin", "member"] = "member"
    # Mobile is opt-in at creation too, so the default here matches the column's.
    mobile_access: bool = False


class UpdateUser(BaseModel):
    display_name: str | None = Field(default=None, min_length=2, max_length=100)
    dept_id: str | None = None
    role: Literal["admin", "member"] | None = None
    is_active: bool | None = None
    # Granting/revoking native-app sign-in for one account. Superadmin-only by
    # virtue of this router's require_superadmin dependency — the org-admin
    # portal's OrgUpdateUser deliberately has no equivalent field, so an org
    # admin can see the state but cannot change it.
    mobile_access: bool | None = None


class BulkAction(BaseModel):
    user_ids: list[str]
    action: str
    dept_id: str | None = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _like_pattern(value: str) -> str:
    """Escape LIKE metacharacters so search input is matched literally."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _uuid_or_400(value: str, message: str) -> uuid.UUID:
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=400, detail=message)
    return parsed


def _db_role(wire: str) -> UserRole:
    return UserRole.org_admin if wire == "admin" else UserRole.member


def _serialize_org(org: Organization) -> dict:
    return {
        "_id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "logo_url": org.logo_url,
        "created_by": None,  # schema does not persist the creating superadmin
        "created_at": iso_z(org.created_at),
        "is_active": org.is_active,
    }


def _serialize_dept(dept: Department) -> dict:
    return {
        "_id": str(dept.id),
        "org_id": str(dept.org_id),
        "name": dept.name,
        "description": dept.description,
        "created_at": iso_z(dept.created_at),
    }


def _user_row(
    user: User,
    org_names: dict[uuid.UUID, str],
    dept_names: dict[uuid.UUID, str],
    statuses: dict[str, str],
) -> dict:
    return {
        "_id": str(user.id),
        "org_id": str(user.org_id) if user.org_id else None,
        "dept_id": str(user.dept_id) if user.dept_id else None,
        "email": user.email,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "role": wire_role(user.role),
        "status": statuses.get(str(user.id), "offline"),
        "last_seen": iso_z(user.last_seen_at),
        "about": user.about,
        "created_by": str(user.created_by) if user.created_by else None,
        "created_at": iso_z(user.created_at),
        "is_active": user.is_active,
        "mobile_access": user.mobile_access,
        "org_name": org_names.get(user.org_id, "Unknown"),
        "dept_name": dept_names.get(user.dept_id, "Unknown"),
    }


async def _name_maps(
    db: AsyncSession, users: list[User]
) -> tuple[dict[uuid.UUID, str], dict[uuid.UUID, str]]:
    """Batch org/dept display names for a page of users (no N+1)."""
    org_ids = {u.org_id for u in users if u.org_id}
    dept_ids = {u.dept_id for u in users if u.dept_id}
    org_names: dict[uuid.UUID, str] = {}
    dept_names: dict[uuid.UUID, str] = {}
    if org_ids:
        rows = await db.execute(
            select(Organization.id, Organization.name).where(Organization.id.in_(org_ids))
        )
        org_names = dict(rows.all())
    if dept_ids:
        rows = await db.execute(select(Department.id, Department.name).where(Department.id.in_(dept_ids)))
        dept_names = dict(rows.all())
    return org_names, dept_names


async def _serialize_user(db: AsyncSession, user: User) -> dict:
    org_names, dept_names = await _name_maps(db, [user])
    statuses = await presence.get_statuses([user.id])
    return _user_row(user, org_names, dept_names, statuses)


async def _org_counts(
    db: AsyncSession, org_ids: list[uuid.UUID], *, active_users_only: bool
) -> tuple[dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    """Batch (dept_count, user_count) per org for a page of orgs."""
    if not org_ids:
        return {}, {}
    rows = await db.execute(
        select(Department.org_id, func.count())
        .where(Department.org_id.in_(org_ids))
        .group_by(Department.org_id)
    )
    dept_counts = dict(rows.all())
    stmt = select(User.org_id, func.count()).where(User.org_id.in_(org_ids))
    if active_users_only:
        stmt = stmt.where(User.is_active.is_(True))
    rows = await db.execute(stmt.group_by(User.org_id))
    return dept_counts, dict(rows.all())


async def _revoke_refresh_tokens(
    db: AsyncSession, user_ids: list[uuid.UUID], *, client: str | None = None
) -> None:
    """Revoke live refresh sessions for these users.

    `client` narrows the revocation to sessions opened by one client. Revoking a
    mobile grant must sign the user out of the phone without signing them out of
    the browser they may be using right now, so that path passes client="mobile";
    deactivation passes nothing and kills everything.
    """
    if not user_ids:
        return
    stmt = update(RefreshToken).where(RefreshToken.user_id.in_(user_ids), RefreshToken.revoked_at.is_(None))
    if client is not None:
        stmt = stmt.where(RefreshToken.client == client)
    await db.execute(stmt.values(revoked_at=now_utc()).execution_options(synchronize_session=False))


async def _deactivate_org_users(db: AsyncSession, org_id: uuid.UUID) -> int:
    """Cascade org suspension: deactivate every user and revoke their sessions."""
    ids = list((await db.execute(select(User.id).where(User.org_id == org_id))).scalars().all())
    if ids:
        await db.execute(
            update(User)
            .where(User.id.in_(ids))
            .values(is_active=False)
            .execution_options(synchronize_session=False)
        )
        await _revoke_refresh_tokens(db, ids)
    return len(ids)


async def _count_online_users() -> int:
    """Currently-online users = live presence keys in Redis.

    Best-effort, like every other presence read in the product: get_statuses and
    is_online both sit inside degrade_on_outage so an outage costs a green dot
    rather than the request. This one did not, so a Redis blip 500'd the whole
    superadmin dashboard — including the four tiles that come from Postgres and
    were never in doubt. The org-admin dashboard, which reads presence through
    get_statuses, stayed up through the same outage.

    The count is assigned only after the scan completes, so a failure part-way
    through reports 0 (the degraded value) rather than a plausible-looking
    partial tally.

    Cost note: SCAN walks the whole keyspace — MATCH filters server-side, it does
    not narrow the iteration — so this is O(total keys), and the keyspace also
    holds ratelimit:, call:, direct: and user: entries. Fine at current scale;
    if it stops being fine, the fix is an index of online users (a sorted set
    scored by last heartbeat), not a bigger COUNT hint.
    """
    count = 0
    async with degrade_on_outage("admin.count_online_users"):
        redis = get_redis()
        scanned = 0
        async for _key in redis.scan_iter(match="presence:*", count=500):
            scanned += 1
        count = scanned
    return count


async def _get_org_or_404(db: AsyncSession, org_id: str) -> Organization:
    oid = _uuid_or_400(org_id, "Invalid organization ID")
    org = await db.get(Organization, oid)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return org


async def _get_dept_or_404(db: AsyncSession, dept_id: str) -> Department:
    did = _uuid_or_400(dept_id, "Invalid department ID")
    dept = await db.get(Department, did)
    if dept is None:
        raise HTTPException(status_code=404, detail="Department not found")
    return dept


async def _get_user_or_404(db: AsyncSession, user_id: str) -> User:
    uid = _uuid_or_400(user_id, "Invalid user ID")
    user = await db.get(User, uid)
    # Superadmins are not managed through /api/admin/users (parity with the
    # Mongo build, where they lived in a separate collection).
    if user is None or user.role == UserRole.superadmin:
        raise HTTPException(status_code=404, detail="User not found")
    return user


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@router.get("/stats")
async def get_stats(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    total_orgs = (await db.execute(select(func.count()).select_from(Organization))).scalar_one()
    total_depts = (await db.execute(select(func.count()).select_from(Department))).scalar_one()
    total_users = (
        await db.execute(select(func.count()).select_from(User).where(User.role != UserRole.superadmin))
    ).scalar_one()
    active_today = await _count_online_users()
    logs = (await db.execute(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(10))).scalars().all()
    return {
        "total_orgs": total_orgs,
        "total_depts": total_depts,
        "total_users": total_users,
        "active_today": active_today,
        "recent_activity": [serialize_audit(log) for log in logs],
    }


# ---------------------------------------------------------------------------
# Organizations
# ---------------------------------------------------------------------------


@router.get("/organizations")
async def list_organizations(
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    search: str = "",
    sort: str = "created_at",
    order: str = "desc",
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    filters = []
    if search:
        filters.append(Organization.name.ilike(_like_pattern(search), escape="\\"))
    sort_col = {
        "name": Organization.name,
        "created_at": Organization.created_at,
        "slug": Organization.slug,
    }.get(sort, Organization.created_at)
    total = (await db.execute(select(func.count()).select_from(Organization).where(*filters))).scalar_one()
    stmt = (
        select(Organization)
        .where(*filters)
        .order_by(sort_col.desc() if order == "desc" else sort_col.asc())
        .offset((page - 1) * limit)
        .limit(limit)
    )
    orgs = (await db.execute(stmt)).scalars().all()
    dept_counts, user_counts = await _org_counts(db, [o.id for o in orgs], active_users_only=False)
    data = [
        {
            **_serialize_org(o),
            "dept_count": dept_counts.get(o.id, 0),
            "user_count": user_counts.get(o.id, 0),
        }
        for o in orgs
    ]
    return {"data": data, "total": total, "page": page, "limit": limit}


@router.post("/organizations")
async def create_organization(
    body: CreateOrganization,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    name = sanitize_text(body.name).strip()
    slug = slugify(name)
    clash = (await db.execute(select(Organization.id).where(Organization.slug == slug))).first()
    if clash:
        raise HTTPException(status_code=400, detail="Organization name already exists")
    org = Organization(name=name, slug=slug, logo_url=body.logo_url, is_active=True, created_at=now_utc())
    db.add(org)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Organization name already exists") from exc
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="create_organization",
        target=str(org.id),
        details={"name": name, "slug": slug},
        org_id=org.id,
    )
    await db.commit()
    return _serialize_org(org)


@router.get("/organizations/all")
async def list_all_organizations(
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    orgs = (
        (
            await db.execute(
                select(Organization).where(Organization.is_active.is_(True)).order_by(Organization.name.asc())
            )
        )
        .scalars()
        .all()
    )
    dept_counts, user_counts = await _org_counts(db, [o.id for o in orgs], active_users_only=True)
    return [
        {
            **_serialize_org(o),
            "user_count": user_counts.get(o.id, 0),
            "dept_count": dept_counts.get(o.id, 0),
        }
        for o in orgs
    ]


@router.get("/organizations/{org_id}")
async def get_organization(
    org_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    org = await _get_org_or_404(db, org_id)
    return _serialize_org(org)


@router.put("/organizations/{org_id}")
async def update_organization(
    org_id: str,
    body: UpdateOrganization,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    org = await _get_org_or_404(db, org_id)
    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "name" in update_data:
        name = sanitize_text(update_data["name"]).strip()
        slug = slugify(name)
        clash = (
            await db.execute(
                select(Organization.id).where(Organization.slug == slug, Organization.id != org.id)
            )
        ).first()
        if clash:
            raise HTTPException(status_code=400, detail="Organization name already exists")
        org.name = name
        org.slug = slug
        update_data["name"] = name
    if "logo_url" in update_data:
        org.logo_url = update_data["logo_url"]
    if "is_active" in update_data:
        org.is_active = update_data["is_active"]
        if update_data["is_active"] is False:
            # Fix: suspending an org also revokes every member session.
            await _deactivate_org_users(db, org.id)
        # Deliberate fix: reactivation restores the org only — users stay as
        # they are, so individually-deactivated accounts are not resurrected.

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="update_organization",
        target=str(org.id),
        details=update_data,
        org_id=org.id,
    )
    await db.commit()
    return _serialize_org(org)


@router.delete("/organizations/{org_id}")
async def delete_organization(
    org_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    org = await _get_org_or_404(db, org_id)
    org.is_active = False
    deactivated = await _deactivate_org_users(db, org.id)
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="delete_organization",
        target=str(org.id),
        details={"name": org.name, "users_deactivated": deactivated},
        org_id=org.id,
    )
    await db.commit()
    return {"message": "Organization deactivated"}


@router.get("/organizations/{org_id}/users")
async def organization_users_by_department(
    org_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(org_id, "Invalid org ID")
    depts = (
        (await db.execute(select(Department).where(Department.org_id == oid).order_by(Department.name.asc())))
        .scalars()
        .all()
    )
    users = (
        (
            await db.execute(
                select(User)
                .where(
                    User.org_id == oid,
                    User.is_active.is_(True),
                    User.role != UserRole.superadmin,
                )
                .order_by(User.display_name.asc())
            )
        )
        .scalars()
        .all()
    )
    by_dept: dict[uuid.UUID, list[dict]] = {}
    for u in users:
        if u.dept_id is None:
            continue
        by_dept.setdefault(u.dept_id, []).append(
            {
                "id": str(u.id),
                "display_name": u.display_name,
                "email": u.email,
                "avatar_url": u.avatar_url,
                "role": wire_role(u.role),
            }
        )
    return [{"id": str(d.id), "name": d.name, "users": by_dept.get(d.id, [])} for d in depts]


# ---------------------------------------------------------------------------
# Departments
# ---------------------------------------------------------------------------


@router.get("/departments")
async def list_departments(
    org_id: str | None = None,
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    search: str = "",
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    filters = []
    if org_id:
        oid = _uuid_or_400(org_id, "Invalid org_id")
        filters.append(Department.org_id == oid)
    if search:
        filters.append(Department.name.ilike(_like_pattern(search), escape="\\"))
    total = (await db.execute(select(func.count()).select_from(Department).where(*filters))).scalar_one()
    depts = (
        (
            await db.execute(
                select(Department)
                .where(*filters)
                .order_by(Department.created_at.desc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    member_counts: dict[uuid.UUID, int] = {}
    dept_ids = [d.id for d in depts]
    if dept_ids:
        rows = await db.execute(
            select(User.dept_id, func.count()).where(User.dept_id.in_(dept_ids)).group_by(User.dept_id)
        )
        member_counts = dict(rows.all())
    data = [{**_serialize_dept(d), "member_count": member_counts.get(d.id, 0)} for d in depts]
    return {"data": data, "total": total, "page": page, "limit": limit}


@router.post("/departments")
async def create_department(
    body: CreateDepartment,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(body.org_id, "Invalid org_id")
    org = await db.get(Organization, oid)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    name = sanitize_text(body.name).strip()
    duplicate = (
        await db.execute(select(Department.id).where(Department.org_id == oid, Department.name == name))
    ).first()
    if duplicate:
        raise HTTPException(status_code=400, detail="Department already exists in this organization")
    dept = Department(
        org_id=oid,
        name=name,
        description=sanitize_text(body.description) if body.description else None,
        created_at=now_utc(),
    )
    db.add(dept)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Department already exists in this organization") from exc
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="create_department",
        target=str(dept.id),
        details={"name": name},
        org_id=oid,
    )
    await db.commit()
    return _serialize_dept(dept)


@router.get("/departments/{dept_id}")
async def get_department(
    dept_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    dept = await _get_dept_or_404(db, dept_id)
    return _serialize_dept(dept)


@router.put("/departments/{dept_id}")
async def update_department(
    dept_id: str,
    body: UpdateDepartment,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    dept = await _get_dept_or_404(db, dept_id)
    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "name" in update_data:
        name = sanitize_text(update_data["name"]).strip()
        duplicate = (
            await db.execute(
                select(Department.id).where(
                    Department.org_id == dept.org_id,
                    Department.name == name,
                    Department.id != dept.id,
                )
            )
        ).first()
        if duplicate:
            raise HTTPException(status_code=400, detail="Department name already exists in this organization")
        dept.name = name
        update_data["name"] = name
    if "description" in update_data:
        description = sanitize_text(update_data["description"])
        dept.description = description
        update_data["description"] = description

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="update_department",
        target=str(dept.id),
        details=update_data,
        org_id=dept.org_id,
    )
    await db.commit()
    return _serialize_dept(dept)


@router.delete("/departments/{dept_id}")
async def delete_department(
    dept_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    dept = await _get_dept_or_404(db, dept_id)
    active_users = (
        await db.execute(
            select(func.count()).select_from(User).where(User.dept_id == dept.id, User.is_active.is_(True))
        )
    ).scalar_one()
    if active_users:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete department: {active_users} active users",
        )
    org_id, name = dept.org_id, dept.name
    await db.delete(dept)
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="delete_department",
        target=str(dept.id),
        details={"name": name},
        org_id=org_id,
    )
    await db.commit()
    return {"message": "Department deleted"}


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


@router.get("/users")
async def list_users(
    org_id: str | None = None,
    dept_id: str | None = None,
    search: str = "",
    status: str = "",
    # "granted" | "denied" — lets the portal answer "who can actually use the app?"
    # without paging through everyone. Empty means no filter.
    mobile: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    sort: str = "created_at",
    order: str = "desc",
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    filters = [User.role != UserRole.superadmin]
    if org_id:
        oid = _uuid_or_400(org_id, "Invalid org_id")
        filters.append(User.org_id == oid)
    if dept_id:
        did = _uuid_or_400(dept_id, "Invalid dept_id")
        filters.append(User.dept_id == did)
    if search:
        pattern = _like_pattern(search)
        filters.append(User.display_name.ilike(pattern, escape="\\") | User.email.ilike(pattern, escape="\\"))
    if status == "active":
        filters.append(User.is_active.is_(True))
    elif status == "inactive":
        filters.append(User.is_active.is_(False))
    if mobile == "granted":
        filters.append(User.mobile_access.is_(True))
    elif mobile == "denied":
        filters.append(User.mobile_access.is_(False))

    sort_col = {
        "display_name": User.display_name,
        "email": User.email,
        "created_at": User.created_at,
        "last_seen": User.last_seen_at,
    }.get(sort, User.created_at)
    total = (await db.execute(select(func.count()).select_from(User).where(*filters))).scalar_one()
    users = (
        (
            await db.execute(
                select(User)
                .where(*filters)
                .order_by(sort_col.desc() if order == "desc" else sort_col.asc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    org_names, dept_names = await _name_maps(db, list(users))
    statuses = await presence.get_statuses([u.id for u in users])
    data = [_user_row(u, org_names, dept_names, statuses) for u in users]
    return {"data": data, "total": total, "page": page, "limit": limit}


@router.post("/users")
async def create_user(
    body: CreateUser,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(body.org_id, "Invalid org_id")
    did = _uuid_or_400(body.dept_id, "Invalid dept_id")
    org = await db.get(Organization, oid)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    # Suspending an org deactivates its members, but nothing on the login path
    # re-reads Organization.is_active — so an account minted here after the
    # suspension would sign in normally against a tenant that is shut off.
    if not org.is_active:
        raise HTTPException(
            status_code=400,
            detail="Cannot create a user in a suspended organization",
        )
    dept = (
        await db.execute(select(Department).where(Department.id == did, Department.org_id == oid))
    ).scalar_one_or_none()
    if dept is None:
        raise HTTPException(status_code=404, detail="Department not found in this organization")
    try:
        enforce_password_policy(body.password)
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # citext equality is case-insensitive; the unique index backstops races.
    existing = (await db.execute(select(User.id).where(User.email == str(body.email)))).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already in use")

    user = User(
        org_id=oid,
        dept_id=did,
        email=str(body.email),
        display_name=sanitize_text(body.display_name).strip(),
        password_hash=await hash_password(body.password),
        role=_db_role(body.role),
        is_active=True,
        mobile_access=body.mobile_access,
        must_change_password=False,
        created_by=actor.id,
        created_at=now_utc(),
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Email already in use") from exc
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="create_user",
        target=str(user.id),
        details={"email": user.email, "role": body.role, "mobile_access": body.mobile_access},
        org_id=oid,
    )
    await db.commit()
    return _user_row(user, {oid: org.name}, {did: dept.name}, {})


@router.post("/users/bulk-action")
async def bulk_user_action(
    body: BulkAction,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    valid_ids = [u for u in (parse_uuid(v) for v in body.user_ids) if u is not None]
    if not valid_ids:
        raise HTTPException(status_code=400, detail="No valid user IDs")

    if body.action in ("deactivate", "activate"):
        stmt = select(User.id).where(User.id.in_(valid_ids), User.role != UserRole.superadmin)
        if body.action == "activate":
            # An org suspension deactivated these accounts deliberately, and the
            # login path never re-checks the org — so a bulk activate is the one
            # call that can quietly bring a whole suspended tenant back online.
            # Members of suspended orgs are skipped rather than failing the batch;
            # `count` in the response already reports what actually changed.
            stmt = stmt.outerjoin(Organization, User.org_id == Organization.id).where(
                or_(User.org_id.is_(None), Organization.is_active.is_(True))
            )
        affected_ids = list((await db.execute(stmt)).scalars().all())
        if affected_ids:
            await db.execute(
                update(User)
                .where(User.id.in_(affected_ids))
                .values(is_active=(body.action == "activate"))
                .execution_options(synchronize_session=False)
            )
            if body.action == "deactivate":
                # Fix: bulk deactivation revokes the targets' sessions too.
                await _revoke_refresh_tokens(db, affected_ids)
        count = len(affected_ids)
        message = f"{count} users {body.action}d"
    elif body.action in ("grant_mobile", "revoke_mobile"):
        # Approving a department's worth of people one modal at a time is the kind
        # of chore that ends in nobody being approved, so the grant is bulk-able.
        granting = body.action == "grant_mobile"
        affected_ids = list(
            (
                await db.execute(
                    select(User.id).where(User.id.in_(valid_ids), User.role != UserRole.superadmin)
                )
            )
            .scalars()
            .all()
        )
        if affected_ids:
            await db.execute(
                update(User)
                .where(User.id.in_(affected_ids))
                .values(mobile_access=granting)
                .execution_options(synchronize_session=False)
            )
            if not granting:
                await _revoke_refresh_tokens(db, affected_ids, client="mobile")
        count = len(affected_ids)
        message = f"Mobile access {'granted for' if granting else 'revoked for'} {count} users"
    elif body.action == "change_dept":
        if not body.dept_id:
            raise HTTPException(status_code=400, detail="dept_id required for change_dept")
        did = parse_uuid(body.dept_id)
        dept = await db.get(Department, did) if did else None
        if dept is None:
            raise HTTPException(status_code=400, detail="Invalid dept_id")
        users = (
            (await db.execute(select(User).where(User.id.in_(valid_ids), User.role != UserRole.superadmin)))
            .scalars()
            .all()
        )
        affected_ids = []
        for u in users:
            # Fix: only move users whose org owns the target department.
            if u.org_id == dept.org_id:
                u.dept_id = dept.id
                affected_ids.append(u.id)
        count = len(affected_ids)
        message = f"{count} users moved"
    else:
        raise HTTPException(status_code=400, detail="Invalid action")

    # Which organisations this batch actually landed in. Every other log_audit
    # call in this module passes org_id; this one never did, because a bulk
    # action is the only one that can span tenants. Leaving it NULL meant the
    # org-admin activity feed — which filters on audit_logs.org_id — showed
    # nothing for the bulk deactivation that had just emptied the org.
    affected_org_ids: list[uuid.UUID] = []
    if affected_ids:
        affected_org_ids = sorted(
            set(
                (
                    await db.execute(
                        select(User.org_id).where(User.id.in_(affected_ids), User.org_id.is_not(None))
                    )
                )
                .scalars()
                .all()
            )
        )

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action=f"bulk_{body.action}",
        target="users",
        # The ids actually affected, not every id asked for. activate skips
        # members of suspended orgs and change_dept skips other tenants, so the
        # requested set overstates what happened — and `count` beside it, which
        # is derived from the same list, then disagreed with it.
        details={
            "count": count,
            "user_ids": [str(i) for i in affected_ids],
            "org_ids": [str(o) for o in affected_org_ids],
        },
        # Attributed whenever the batch stayed inside one organisation, which is
        # what the portal's own org filter produces. A genuinely cross-tenant
        # batch stays NULL and carries the full list in details.
        org_id=affected_org_ids[0] if len(affected_org_ids) == 1 else None,
    )
    await db.commit()
    return {"message": message}


@router.get("/users/{user_id}")
async def get_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    user = await _get_user_or_404(db, user_id)
    return await _serialize_user(db, user)


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    body: UpdateUser,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    user = await _get_user_or_404(db, user_id)
    update_data = {k: v for k, v in body.model_dump().items() if v is not None}
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    if "display_name" in update_data:
        name = sanitize_text(update_data["display_name"]).strip()
        user.display_name = name
        update_data["display_name"] = name
    if "dept_id" in update_data:
        did = _uuid_or_400(update_data["dept_id"], "Invalid dept_id")
        # Fix: the department must exist and belong to the user's org.
        dept = (
            await db.execute(select(Department).where(Department.id == did, Department.org_id == user.org_id))
        ).scalar_one_or_none()
        if dept is None:
            raise HTTPException(status_code=404, detail="Department not found in this organization")
        user.dept_id = did
    if "role" in update_data:
        user.role = _db_role(update_data["role"])
    if "mobile_access" in update_data:
        user.mobile_access = update_data["mobile_access"]
        if update_data["mobile_access"] is False:
            # Revoking the grant ends the phone's session immediately; the web
            # session is untouched (see _revoke_refresh_tokens).
            await _revoke_refresh_tokens(db, [user.id], client="mobile")
    if "is_active" in update_data:
        # The org suspension that deactivated this account is only ever enforced
        # through users.is_active; flipping it back here restores login to a
        # tenant that is supposed to be shut off. Checked before the assignment
        # so the refusal lands before any state changes.
        if update_data["is_active"] is True and user.org_id is not None:
            org = await db.get(Organization, user.org_id)
            if org is not None and not org.is_active:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot activate a user in a suspended organization",
                )
        user.is_active = update_data["is_active"]
        if update_data["is_active"] is False:
            # Fix: deactivation revokes the user's refresh sessions.
            await _revoke_refresh_tokens(db, [user.id])

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="update_user",
        target=str(user.id),
        details={k: str(v) for k, v in update_data.items()},
        org_id=user.org_id,
    )
    await db.commit()
    return await _serialize_user(db, user)


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    user = await _get_user_or_404(db, user_id)
    temporary_password = generate_password(12)
    user.password_hash = await hash_password(temporary_password)
    # Fixes: the account must change it on next login, and old sessions die.
    user.must_change_password = True
    await _revoke_refresh_tokens(db, [user.id])
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="reset_password",
        target=str(user.id),
        details={"email": user.email},
        org_id=user.org_id,
    )
    await db.commit()
    return {"temporary_password": temporary_password}
