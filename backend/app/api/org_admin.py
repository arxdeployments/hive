"""Org-admin console: stats, activity, user + department management, org settings.

Wire contract mirrors RxHivexx (docs/reference/api-auth-admin.md): serialized
docs use `_id` string keys, ISO-Z datetimes, and the org-admin action-naming
convention (user_created, dept_updated, ...). Deliberate fixes vs the old
build: DB-backed guard (deactivated/demoted admins lose access immediately),
session revocation on deactivate/reset-password, password policy on create,
per-org department name uniqueness on rename, and global slug uniqueness on
org rename. Every query is org-scoped — objects outside the caller's tenant
404 without revealing existence.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import wire_role
from app.core.deps import get_current_user
from app.core.rate_limit import password_limiter
from app.core.security import PasswordPolicyError, enforce_password_policy, hash_password
from app.db.models import (
    AdminDepartment,
    AuditLog,
    Conversation,
    Department,
    Organization,
    RefreshToken,
    User,
    UserRole,
)
from app.db.session import get_db
from app.services import presence
from app.services.audit import log_audit, serialize_audit
from app.utils import generate_password, iso_z, now_utc, parse_uuid, sanitize_text, slugify

router = APIRouter(prefix="/api/org-admin", tags=["org-admin"])

_ROLE_MAP = {"admin": UserRole.org_admin, "member": UserRole.member}


async def _require_org_admin(user: User = Depends(get_current_user)) -> User:
    """Org admins ONLY — superadmins are rejected, preserving reference behavior.

    Unlike the old JWT-claim-only check, get_current_user re-reads the DB row
    (and its is_active flag), so demoted or deactivated admins lose access now.
    """
    if user.role != UserRole.org_admin or user.org_id is None:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _like_pattern(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _serialize_user(user: User, dept_name: str, status: str) -> dict:
    return {
        "_id": str(user.id),
        "org_id": str(user.org_id) if user.org_id else None,
        "dept_id": str(user.dept_id) if user.dept_id else None,
        "email": user.email,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "role": wire_role(user.role),
        "status": status,
        "last_seen": iso_z(user.last_seen_at),
        "about": user.about,
        "created_by": str(user.created_by) if user.created_by else None,
        "created_at": iso_z(user.created_at),
        "is_active": user.is_active,
        # Read-only here. Only a superadmin grants mobile access (OrgUpdateUser has
        # no such field), but an org admin fielding "the app won't let me in" needs
        # to be able to see whether the account was ever approved.
        "mobile_access": user.mobile_access,
        "dept_name": dept_name,
    }


def _serialize_department(dept: Department) -> dict:
    return {
        "_id": str(dept.id),
        "org_id": str(dept.org_id),
        "name": dept.name,
        "description": dept.description,
        "created_at": iso_z(dept.created_at),
    }


def _serialize_org(org: Organization) -> dict:
    return {
        "_id": str(org.id),
        "name": org.name,
        "slug": org.slug,
        "logo_url": org.logo_url,
        "created_by": None,  # not modelled in the Postgres schema; key kept for wire compat
        "created_at": iso_z(org.created_at),
        "is_active": org.is_active,
    }


async def managed_dept_ids(db: AsyncSession, admin: User) -> set[uuid.UUID] | None:
    """Departments this admin administers, or None for organization-wide.

    None and the empty set mean opposite things, so both callers below have to
    branch rather than treating "no departments" as "no reach". An admin with no
    AdminDepartment rows is org-wide — that is what every existing org_admin was
    migrated to, since the migration cannot guess which departments each of them
    should own and silently stripping them would be worse.
    """
    rows = (
        (await db.execute(select(AdminDepartment.dept_id).where(AdminDepartment.user_id == admin.id)))
        .scalars()
        .all()
    )
    return set(rows) or None


async def _writable_department(db: AsyncSession, admin: User, dept_id_raw: str) -> Department:
    """Resolve a department this admin is allowed to place a person INTO.

    Both create-user and change-department route through here, because they are
    the same grant reached two ways. Scoping only the create would leave the
    two-step: create in a department I manage, then move the account to one I do
    not. The second step is the one that actually plants a user outside the
    admin's reach, and it is also the point of no return — once moved, the target
    fails _load_org_user, so the admin cannot undo their own edit.

    Out of scope reads as not-found rather than forbidden, matching how the rest
    of this module treats another tenant's objects: an admin should not be able
    to enumerate departments they do not manage by watching which ids answer 403.
    """
    dept_uuid = parse_uuid(dept_id_raw)
    if dept_uuid is None:
        raise HTTPException(status_code=400, detail="Invalid department ID")
    dept = await _org_department(db, admin.org_id, dept_uuid)
    scope = await managed_dept_ids(db, admin)
    if dept is None or (scope is not None and dept.id not in scope):
        raise HTTPException(status_code=404, detail="Department not found in your organization")
    return dept


async def _load_org_user(db: AsyncSession, admin: User, user_id_raw: str) -> User:
    uid = parse_uuid(user_id_raw)
    if uid is None:
        raise HTTPException(status_code=400, detail="Invalid user ID")
    target = (
        await db.execute(select(User).where(User.id == uid, User.org_id == admin.org_id))
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="User not found")
    # Department scoping, applied at the LOAD helper rather than at each route:
    # every single-user mutation in this module (activate, deactivate, reset
    # password, change department, change role) resolves its target through
    # here, so enforcing once covers them all and a new route inherits it.
    #
    # 404 rather than 403, matching how this module already treats a user from
    # another organization — an admin should not be able to probe for the
    # existence of people outside their scope.
    scope = await managed_dept_ids(db, admin)
    if scope is not None and target.dept_id not in scope:
        raise HTTPException(status_code=404, detail="User not found")
    return target


async def _org_department(db: AsyncSession, org_id: uuid.UUID, dept_id: uuid.UUID) -> Department | None:
    return (
        await db.execute(select(Department).where(Department.id == dept_id, Department.org_id == org_id))
    ).scalar_one_or_none()


async def _dept_name_map(db: AsyncSession, org_id: uuid.UUID) -> dict[uuid.UUID, str]:
    rows = (await db.execute(select(Department.id, Department.name).where(Department.org_id == org_id))).all()
    return {dept_id: name for dept_id, name in rows}


async def _single_dept_name(db: AsyncSession, org_id: uuid.UUID, dept_id: uuid.UUID | None) -> str:
    if dept_id is None:
        return "Unknown"
    name = (
        await db.execute(select(Department.name).where(Department.id == dept_id, Department.org_id == org_id))
    ).scalar_one_or_none()
    return name or "Unknown"


async def _revoke_refresh_tokens(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user_id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=now_utc())
    )


# ---------------------------------------------------------------------------
# Stats + activity
# ---------------------------------------------------------------------------


@router.get("/stats")
async def org_stats(
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    org_id = admin.org_id
    # Scoped to the same departments the Users and Departments pages now list.
    # Without this the dashboard would report "8 departments" beside a listing
    # showing two, which reads as a bug in the listing rather than as scope.
    scope = await managed_dept_ids(db, admin)
    in_scope = [User.dept_id.in_(scope)] if scope is not None else []

    total_users = (
        await db.execute(select(func.count()).select_from(User).where(User.org_id == org_id, *in_scope))
    ).scalar_one()
    active_ids = (
        (
            await db.execute(
                select(User.id).where(User.org_id == org_id, User.is_active.is_(True), *in_scope)
            )
        )
        .scalars()
        .all()
    )
    statuses = await presence.get_statuses(list(active_ids))
    active_today = sum(1 for s in statuses.values() if s == "online")
    dept_count = select(func.count()).select_from(Department).where(Department.org_id == org_id)
    if scope is not None:
        dept_count = dept_count.where(Department.id.in_(scope))
    total_departments = (await db.execute(dept_count)).scalar_one()
    # Left organization-wide on purpose: a conversation has participants, not a
    # department, so there is no honest per-department number to show. A count of
    # threads touching my departments would double-count cross-department ones.
    total_conversations = (
        await db.execute(
            select(func.count())
            .select_from(Conversation)
            .where(Conversation.org_id == org_id, Conversation.is_active.is_(True))
        )
    ).scalar_one()
    return {
        "total_users": total_users,
        "active_today": active_today,
        "total_departments": total_departments,
        "total_conversations": total_conversations,
    }


@router.get("/activity")
async def org_activity(
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(AuditLog).where(AuditLog.org_id == admin.org_id)
    # An audit row's `target` is the affected person's EMAIL, so an unfiltered
    # feed hands a department-scoped admin the addresses of people their own user
    # list is hiding from them. Filtering on the ACTOR is the filter available —
    # audit_logs records who acted but not which user was acted upon as an id, so
    # a target-based filter would mean matching on a display string.
    #
    # Own rows are always included: an admin must be able to see what they
    # themselves did, including edits to a user who has since moved out of scope.
    scope = await managed_dept_ids(db, admin)
    if scope is not None:
        visible_actors = select(User.id).where(User.org_id == admin.org_id, User.dept_id.in_(scope))
        stmt = stmt.where(or_(AuditLog.actor_id == admin.id, AuditLog.actor_id.in_(visible_actors)))
    logs = (
        (await db.execute(stmt.order_by(AuditLog.created_at.desc()).limit(10))).scalars().all()
    )
    return [serialize_audit(log) for log in logs]


# ---------------------------------------------------------------------------
# Users
# ---------------------------------------------------------------------------


@router.get("/users")
async def list_users(
    dept_id: str = "",
    search: str = "",
    status: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(10, ge=1, le=100),
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(User).where(User.org_id == admin.org_id)
    # A department-scoped admin sees only their own departments' people. Applied
    # before the caller's own dept filter, so narrowing further is allowed but
    # widening is not.
    scope = await managed_dept_ids(db, admin)
    if scope is not None:
        stmt = stmt.where(User.dept_id.in_(scope))
    dept_uuid = parse_uuid(dept_id)
    if dept_uuid is not None:  # malformed dept_id is silently ignored (reference behavior)
        stmt = stmt.where(User.dept_id == dept_uuid)
    if search:
        pattern = _like_pattern(search)
        stmt = stmt.where(
            or_(
                User.display_name.ilike(pattern, escape="\\"),
                User.email.ilike(pattern, escape="\\"),
            )
        )
    if status == "active":
        stmt = stmt.where(User.is_active.is_(True))
    elif status == "inactive":
        stmt = stmt.where(User.is_active.is_(False))

    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    rows = (
        (await db.execute(stmt.order_by(User.created_at.desc()).offset((page - 1) * limit).limit(limit)))
        .scalars()
        .all()
    )
    dept_names = await _dept_name_map(db, admin.org_id)
    statuses = await presence.get_statuses([u.id for u in rows])
    data = [
        _serialize_user(u, dept_names.get(u.dept_id, "Unknown"), statuses.get(str(u.id), "offline"))
        for u in rows
    ]
    return {"data": data, "total": total, "page": page, "limit": limit}


class OrgCreateUser(BaseModel):
    dept_id: str
    email: EmailStr
    display_name: str = Field(min_length=2, max_length=100)
    password: str
    role: str = "member"


@router.post("/users")
async def create_user(
    body: OrgCreateUser,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    dept = await _writable_department(db, admin, body.dept_id)

    email = body.email.strip().lower()
    taken = (
        await db.execute(select(User.id).where(func.lower(User.email) == email).limit(1))
    ).scalar_one_or_none()
    if taken is not None:
        raise HTTPException(status_code=400, detail="Email already in use")

    # An admin creates members, never other admins.
    #
    # Not merely a policy preference: an admin who can mint admins can mint one
    # with no admin_departments rows, which _require_org_admin and
    # managed_dept_ids both read as ORGANIZATION-WIDE. A single-department admin
    # could therefore create an account with reach over the entire org and log in
    # as it, since they choose its password. Department scoping would be
    # decorative. Granting the admin role stays a superadmin action (admin.py),
    # where the actor is already org-wide by definition.
    if body.role != "member":
        raise HTTPException(
            status_code=403,
            detail="Admins can create members only. Ask a superadmin to grant admin access.",
        )
    try:
        enforce_password_policy(body.password)
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user = User(
        org_id=admin.org_id,
        dept_id=dept.id,
        email=email,
        display_name=sanitize_text(body.display_name).strip(),
        password_hash=hash_password(body.password),
        role=UserRole.member,
        is_active=True,
        created_by=admin.id,
        created_at=now_utc(),
    )
    db.add(user)
    await db.flush()
    await log_audit(
        db,
        actor_id=admin.id,
        actor_type="org_admin",
        action="user_created",
        target=email,
        details={"user_id": str(user.id), "role": "member"},
        org_id=admin.org_id,
    )
    await db.commit()
    return _serialize_user(user, dept.name, "offline")


@router.get("/users/{user_id}")
async def get_user(
    user_id: str,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    target = await _load_org_user(db, admin, user_id)
    dept_name = await _single_dept_name(db, admin.org_id, target.dept_id)
    statuses = await presence.get_statuses([target.id])
    return _serialize_user(target, dept_name, statuses.get(str(target.id), "offline"))


class OrgUpdateUser(BaseModel):
    display_name: str | None = None
    dept_id: str | None = None
    role: str | None = None
    is_active: bool | None = None


@router.put("/users/{user_id}")
async def update_user(
    user_id: str,
    body: OrgUpdateUser,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    target = await _load_org_user(db, admin, user_id)

    changes: dict = {}
    if body.display_name is not None:
        cleaned = sanitize_text(body.display_name).strip()
        if cleaned:
            target.display_name = cleaned
            changes["display_name"] = cleaned
    if body.dept_id is not None:
        dept = await _writable_department(db, admin, body.dept_id)
        target.dept_id = dept.id
        changes["dept_id"] = str(dept.id)
    if body.role is not None and body.role in _ROLE_MAP:
        # Unknown role values are silently ignored (reference behavior).
        new_role = _ROLE_MAP[body.role]
        # Promotion is creation by another name — the same privilege grant POST
        # /users refuses, routed through a member who already exists. Blocking
        # only the create would have been a one-line detour.
        #
        # Demotion is deliberately still allowed: taking reach away is not
        # escalation, and an admin who has lost their post needs to be
        # demotable by whoever is on shift. Re-granting the role afterwards
        # requires a superadmin, which is the intended asymmetry.
        if new_role is UserRole.org_admin and target.role is not UserRole.org_admin:
            raise HTTPException(
                status_code=403,
                detail="Admins cannot grant admin access. Ask a superadmin to promote this user.",
            )
        target.role = new_role
        changes["role"] = body.role
    if body.is_active is not None:
        target.is_active = body.is_active
        changes["is_active"] = body.is_active
        if not body.is_active:
            await _revoke_refresh_tokens(db, target.id)

    if changes:
        await log_audit(
            db,
            actor_id=admin.id,
            actor_type="org_admin",
            action="user_updated",
            target=target.email,
            details={"user_id": str(target.id), **changes},
            org_id=admin.org_id,
        )
    await db.commit()
    dept_name = await _single_dept_name(db, admin.org_id, target.dept_id)
    statuses = await presence.get_statuses([target.id])
    return _serialize_user(target, dept_name, statuses.get(str(target.id), "offline"))


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    user_id: str,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(password_limiter),
):
    target = await _load_org_user(db, admin, user_id)
    temp = generate_password()
    target.password_hash = hash_password(temp)
    target.must_change_password = True
    await _revoke_refresh_tokens(db, target.id)
    await log_audit(
        db,
        actor_id=admin.id,
        actor_type="org_admin",
        action="password_reset",
        target=target.email,
        details={"email": target.email, "user_id": str(target.id)},
        org_id=admin.org_id,
    )
    await db.commit()
    return {"temporary_password": temp}


# ---------------------------------------------------------------------------
# Departments
# ---------------------------------------------------------------------------


@router.get("/departments")
async def list_departments(
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    stmt = (
        select(Department, func.count(User.id))
        .outerjoin(User, and_(User.dept_id == Department.id, User.is_active.is_(True)))
        .where(Department.org_id == admin.org_id)
        .group_by(Department.id)
        .order_by(Department.name.asc())
    )
    # This response IS the department picker in the create-user and edit-user
    # forms, so scoping it is what makes the restriction visible rather than a
    # 404 the admin runs into after filling the form in.
    scope = await managed_dept_ids(db, admin)
    if scope is not None:
        stmt = stmt.where(Department.id.in_(scope))
    rows = (await db.execute(stmt)).all()
    return [{**_serialize_department(dept), "member_count": count} for dept, count in rows]


class OrgCreateDept(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    description: str | None = None


@router.post("/departments")
async def create_department(
    body: OrgCreateDept,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    # A department-scoped admin cannot add departments. Not a security boundary
    # so much as a coherence one: the new department would fall outside their
    # scope the instant it existed, so it would vanish from their own listing and
    # they could neither staff it nor rename it. Auto-granting themselves the new
    # department would be worse — self-service scope expansion. Org-wide admins,
    # which is every admin today, are unaffected.
    if await managed_dept_ids(db, admin) is not None:
        raise HTTPException(
            status_code=403,
            detail="You manage specific departments and cannot create new ones. Ask a superadmin.",
        )

    name = sanitize_text(body.name).strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Department name must be at least 2 characters")
    dup = (
        await db.execute(
            select(Department.id).where(Department.org_id == admin.org_id, Department.name == name).limit(1)
        )
    ).scalar_one_or_none()
    if dup is not None:
        raise HTTPException(status_code=400, detail="Department already exists")

    description = sanitize_text(body.description) if body.description is not None else None
    dept = Department(org_id=admin.org_id, name=name, description=description, created_at=now_utc())
    db.add(dept)
    await db.flush()
    await log_audit(
        db,
        actor_id=admin.id,
        actor_type="org_admin",
        action="dept_created",
        target=name,
        details={"dept_id": str(dept.id)},
        org_id=admin.org_id,
    )
    await db.commit()
    return _serialize_department(dept)


class OrgUpdateDept(BaseModel):
    name: str | None = None
    description: str | None = None


@router.put("/departments/{dept_id}")
async def update_department(
    dept_id: str,
    body: OrgUpdateDept,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    dept = await _writable_department(db, admin, dept_id)

    changes: dict = {}
    if body.name is not None:
        cleaned = sanitize_text(body.name).strip()
        if cleaned and cleaned != dept.name:
            dup = (
                await db.execute(
                    select(Department.id)
                    .where(
                        Department.org_id == admin.org_id,
                        Department.name == cleaned,
                        Department.id != dept.id,
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if dup is not None:
                raise HTTPException(status_code=400, detail="Department already exists")
            dept.name = cleaned
            changes["name"] = cleaned
    if body.description is not None:
        dept.description = sanitize_text(body.description)
        changes["description"] = dept.description

    if changes:
        await log_audit(
            db,
            actor_id=admin.id,
            actor_type="org_admin",
            action="dept_updated",
            target=dept.name,
            details={"dept_id": str(dept.id), **changes},
            org_id=admin.org_id,
        )
    await db.commit()
    return _serialize_department(dept)


@router.delete("/departments/{dept_id}")
async def delete_department(
    dept_id: str,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    dept = await _writable_department(db, admin, dept_id)

    active_users = (
        await db.execute(
            select(func.count()).select_from(User).where(User.dept_id == dept.id, User.is_active.is_(True))
        )
    ).scalar_one()
    if active_users:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete: {active_users} active users in this department",
        )

    await db.delete(dept)
    await log_audit(
        db,
        actor_id=admin.id,
        actor_type="org_admin",
        action="dept_deleted",
        target=dept.name,
        details={"dept_id": str(dept.id)},
        org_id=admin.org_id,
    )
    await db.commit()
    return {"message": "Department deleted"}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


@router.get("/settings")
async def get_org_settings(
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    org = await db.get(Organization, admin.org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return _serialize_org(org)


class OrgSettingsUpdate(BaseModel):
    name: str | None = None
    logo_url: str | None = None


@router.put("/settings")
async def update_org_settings(
    body: OrgSettingsUpdate,
    admin: User = Depends(_require_org_admin),
    db: AsyncSession = Depends(get_db),
):
    org = await db.get(Organization, admin.org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    changes: dict = {}
    if body.name is not None:
        cleaned = sanitize_text(body.name).strip()
        new_slug = slugify(cleaned)
        if cleaned and new_slug:  # names that slugify to nothing are ignored, not applied
            if new_slug != org.slug:
                dup = (
                    await db.execute(
                        select(Organization.id)
                        .where(Organization.slug == new_slug, Organization.id != org.id)
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if dup is not None:
                    raise HTTPException(status_code=400, detail="Organization name already exists")
            org.name = cleaned
            org.slug = new_slug
            changes["name"] = cleaned
    if body.logo_url is not None:
        org.logo_url = body.logo_url
        changes["logo_url"] = body.logo_url

    if changes:
        await log_audit(
            db,
            actor_id=admin.id,
            actor_type="org_admin",
            action="org_settings_updated",
            target=org.name,
            details=changes,
            org_id=org.id,
        )
    await db.commit()
    return _serialize_org(org)
