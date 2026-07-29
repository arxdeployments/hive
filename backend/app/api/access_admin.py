"""Super-admin authoring for chat reachability and send policy.

Deliberately a separate router from api/admin.py: that module is already the
largest in the codebase, and these routes share a single concern (the two
policy tables plus admin-to-department assignment) rather than the general
tenant CRUD there.

GUARD CHOICE, stated because there are two plausible ones and they disagree:
this uses core.deps.require_superadmin — superadmin ONLY. Writing policy is not
something an org admin may do to themselves; delegated control is exercised
through the org-admin portal, whose scope is derived from admin_departments.
Note that org_admin.py has its own `_require_org_admin` which REJECTS
superadmins by design, while core.deps has an unused `require_org_admin` that
PERMITS them — two near-identical names with opposite semantics. Wiring a policy
route to the wrong one would silently change who can administer access.

Polymorphic ids (a rule side is either a user or a department) have no foreign
key, so every write here validates that the referenced row exists AND belongs to
the named organization. Without that check a super admin could write a rule
pairing two ids from different tenants, which would sit in the table forever
matching nothing.
"""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import require_superadmin
from app.db.models import (
    AccessPartyType,
    AdminDepartment,
    ChatAccessRule,
    Department,
    SendPolicy,
    User,
    UserRole,
)
from app.db.session import get_db
from app.realtime.redis_bus import publish_to_users
from app.services import storage
from app.services.access import canonical_pair, explain, resolve_send_policy
from app.services.audit import log_audit
from app.utils import parse_uuid

router = APIRouter(prefix="/api/admin/access", tags=["admin-access"])


class Party(BaseModel):
    type: str  # "user" | "department"
    id: str


class RuleUpsert(BaseModel):
    org_id: str
    a: Party
    b: Party
    allow: bool


class SendPolicyUpsert(BaseModel):
    org_id: str
    scope: Party
    allow_text: bool = True
    allow_image: bool = True
    allow_video: bool = True
    allow_audio: bool = True
    allow_document: bool = True
    #: null = every document type the server accepts; a list narrows it.
    doc_extensions: list[str] | None = None


class AdminDepartmentsUpdate(BaseModel):
    department_ids: list[str]


async def _notify(db: AsyncSession, parties: list[tuple[AccessPartyType, uuid.UUID]]) -> None:
    """Tell everyone a policy edit affects to re-read their access.

    SOFT degradation, deliberately. The alternative — closing the socket and
    bouncing them to the login screen — would drop a clinician mid-consultation
    because an administrator adjusted a department rule. The client re-fetches
    its roster and its send policy and updates the composer in place; a
    conversation that is no longer permitted goes read-only rather than
    vanishing.

    This is a CONVENIENCE, never the control. Redis pub/sub here is at-most-once
    and redis_bus.degrade_on_outage swallows publish failures during an outage,
    so a dropped event must not mean a lifted restriction. It does not: every
    send re-checks the live rules, and the socket revalidates on a timer. This
    only shortens the window in which the UI is wrong.
    """
    user_ids: set[uuid.UUID] = set()
    dept_ids = [pid for ptype, pid in parties if ptype == AccessPartyType.department]
    user_ids.update(pid for ptype, pid in parties if ptype == AccessPartyType.user)
    if dept_ids:
        rows = (
            await db.execute(select(User.id).where(User.dept_id.in_(dept_ids)))
        ).scalars().all()
        user_ids.update(rows)
    if user_ids:
        await publish_to_users(sorted(user_ids), {"type": "access_changed"})


def _uuid_or_400(value: str, message: str) -> uuid.UUID:
    parsed = parse_uuid(value)
    if parsed is None:
        raise HTTPException(status_code=400, detail=message)
    return parsed


def _party_type(raw: str) -> AccessPartyType:
    try:
        return AccessPartyType(raw)
    except ValueError:
        raise HTTPException(status_code=400, detail="Party type must be 'user' or 'department'") from None


async def _resolve_party(
    db: AsyncSession, party: Party, org_id: uuid.UUID
) -> tuple[AccessPartyType, uuid.UUID, str]:
    """Validate a rule side and return (type, id, display name).

    The tenant check is the point: a_id/b_id are polymorphic and therefore
    unconstrained by the schema, so this is the only thing stopping a rule that
    references another organization's user.
    """
    ptype = _party_type(party.type)
    pid = _uuid_or_400(party.id, "Invalid party id")
    if ptype == AccessPartyType.user:
        row = await db.get(User, pid)
        if row is None or row.org_id != org_id:
            raise HTTPException(status_code=404, detail="User not found in this organization")
        return ptype, pid, row.display_name
    row = await db.get(Department, pid)
    if row is None or row.org_id != org_id:
        raise HTTPException(status_code=404, detail="Department not found in this organization")
    return ptype, pid, row.name


async def _label_map(db: AsyncSession, org_id: uuid.UUID) -> dict[tuple[str, str], str]:
    """(type, id) -> human name, so a rule list is readable without N lookups."""
    users = (await db.execute(select(User.id, User.display_name).where(User.org_id == org_id))).all()
    depts = (
        await db.execute(select(Department.id, Department.name).where(Department.org_id == org_id))
    ).all()
    out: dict[tuple[str, str], str] = {}
    for uid, name in users:
        out[("user", str(uid))] = name
    for did, name in depts:
        out[("department", str(did))] = name
    return out


def _serialize_rule(rule: ChatAccessRule, labels: dict) -> dict:
    return {
        "id": str(rule.id),
        "allow": rule.allow,
        "a": {
            "type": rule.a_type.value,
            "id": str(rule.a_id),
            # A rule can outlive the row it points at (no FK on a polymorphic
            # column). Show that plainly instead of a blank.
            "name": labels.get((rule.a_type.value, str(rule.a_id)), "(deleted)"),
        },
        "b": {
            "type": rule.b_type.value,
            "id": str(rule.b_id),
            "name": labels.get((rule.b_type.value, str(rule.b_id)), "(deleted)"),
        },
        "level": 3
        if rule.a_type == rule.b_type == AccessPartyType.user
        else 1
        if rule.a_type == rule.b_type == AccessPartyType.department
        else 2,
    }


# --------------------------------------------------------------------------
# Reachability rules
# --------------------------------------------------------------------------


@router.get("/rules")
async def list_rules(
    org_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    _actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(org_id, "Invalid org_id")
    rules = (
        (await db.execute(select(ChatAccessRule).where(ChatAccessRule.org_id == oid)))
        .scalars()
        .all()
    )
    labels = await _label_map(db, oid)
    # Broadest first: department rules are the policy, user rules the exceptions,
    # and reading them the other way round makes the exceptions look like the rule.
    return {"data": sorted((_serialize_rule(r, labels) for r in rules), key=lambda r: r["level"])}


@router.put("/rules")
async def upsert_rule(
    body: RuleUpsert,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(body.org_id, "Invalid org_id")
    a_type, a_id, a_name = await _resolve_party(db, body.a, oid)
    b_type, b_id, b_name = await _resolve_party(db, body.b, oid)
    if (a_type, a_id) == (b_type, b_id) and a_type == AccessPartyType.user:
        raise HTTPException(status_code=400, detail="A user cannot be paired with themselves")

    # Canonicalised before touching the table: the rule is symmetric, so
    # (A, B) and (B, A) must land on the same row or the unique constraint is
    # decorative and the UI can create two rules that contradict each other.
    (ca_type, ca_id), (cb_type, cb_id) = canonical_pair((a_type, a_id), (b_type, b_id))

    existing = (
        await db.execute(
            select(ChatAccessRule).where(
                ChatAccessRule.a_type == ca_type,
                ChatAccessRule.a_id == ca_id,
                ChatAccessRule.b_type == cb_type,
                ChatAccessRule.b_id == cb_id,
            )
        )
    ).scalar_one_or_none()

    if existing is not None:
        existing.allow = body.allow
        rule = existing
    else:
        rule = ChatAccessRule(
            org_id=oid,
            a_type=ca_type,
            a_id=ca_id,
            b_type=cb_type,
            b_id=cb_id,
            allow=body.allow,
            created_by=actor.id,
        )
        db.add(rule)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Rule already exists") from exc

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="set_chat_access_rule",
        target=str(rule.id),
        details={"a": a_name, "b": b_name, "allow": body.allow},
        org_id=oid,
    )
    await db.commit()
    await _notify(db, [(ca_type, ca_id), (cb_type, cb_id)])
    labels = await _label_map(db, oid)
    return _serialize_rule(rule, labels)


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    rid = _uuid_or_400(rule_id, "Invalid rule id")
    rule = await db.get(ChatAccessRule, rid)
    if rule is None:
        raise HTTPException(status_code=404, detail="Rule not found")
    org_id = rule.org_id
    # Captured before the delete: after it the row is gone and there is nothing
    # left to say who was affected.
    affected = [(rule.a_type, rule.a_id), (rule.b_type, rule.b_id)]
    await db.delete(rule)
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="delete_chat_access_rule",
        target=str(rid),
        org_id=org_id,
    )
    await db.commit()
    await _notify(db, affected)
    # Deleting an ALLOW re-blocks the pair, since the default is deny. Said in
    # the response so the UI can warn rather than presenting it as a tidy-up.
    return {"message": "Rule removed", "note": "the pair now falls back to deny-by-default"}


@router.get("/explain")
async def explain_pair(
    user_a: str = Query(...),
    user_b: str = Query(...),
    db: AsyncSession = Depends(get_db),
    _actor: User = Depends(require_superadmin),
):
    """Which rules matched a pair and which one decided. See services.access.explain."""
    a = await db.get(User, _uuid_or_400(user_a, "Invalid user_a"))
    b = await db.get(User, _uuid_or_400(user_b, "Invalid user_b"))
    if a is None or b is None:
        raise HTTPException(status_code=404, detail="User not found")
    result = await explain(db, a, b)
    labels = await _label_map(db, a.org_id) if a.org_id else {}
    for entry in result["matched"]:
        entry["a"]["name"] = labels.get((entry["a"]["type"], entry["a"]["id"]), "(deleted)")
        entry["b"]["name"] = labels.get((entry["b"]["type"], entry["b"]["id"]), "(deleted)")
    return result


# --------------------------------------------------------------------------
# Send policy
# --------------------------------------------------------------------------


@router.get("/send-policies")
async def list_send_policies(
    org_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    _actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(org_id, "Invalid org_id")
    rows = (
        (await db.execute(select(SendPolicy).where(SendPolicy.org_id == oid))).scalars().all()
    )
    labels = await _label_map(db, oid)
    return {
        "data": [
            {
                "id": str(p.id),
                "scope": {
                    "type": p.scope_type.value,
                    "id": str(p.scope_id),
                    "name": labels.get((p.scope_type.value, str(p.scope_id)), "(deleted)"),
                },
                "allow_text": p.allow_text,
                "allow_image": p.allow_image,
                "allow_video": p.allow_video,
                "allow_audio": p.allow_audio,
                "allow_document": p.allow_document,
                "doc_extensions": p.doc_extensions,
            }
            for p in rows
        ],
        # The client needs these to offer a checklist rather than a free-text box
        # it will then have to validate against a list it cannot see.
        "document_extensions": sorted(storage.DOC_EXTS),
    }


@router.put("/send-policies")
async def upsert_send_policy(
    body: SendPolicyUpsert,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(body.org_id, "Invalid org_id")
    scope_type, scope_id, scope_name = await _resolve_party(db, body.scope, oid)

    exts: list[str] | None = None
    if body.doc_extensions is not None:
        # Normalised and intersected with what the server actually accepts. A
        # whitelist may only NARROW: without this an admin typing ".exe" would
        # see it saved and assume it works, while every upload kept being
        # refused by storage.classify. An EMPTY list is preserved as empty —
        # that is "no documents at all", a real and different setting from null.
        cleaned = {e.strip().lower() for e in body.doc_extensions if e and e.strip()}
        cleaned = {e if e.startswith(".") else f".{e}" for e in cleaned}
        exts = sorted(cleaned & storage.DOC_EXTS)

    existing = (
        await db.execute(
            select(SendPolicy).where(
                SendPolicy.scope_type == scope_type, SendPolicy.scope_id == scope_id
            )
        )
    ).scalar_one_or_none()

    if existing is None:
        existing = SendPolicy(org_id=oid, scope_type=scope_type, scope_id=scope_id)
        db.add(existing)
    existing.allow_text = body.allow_text
    existing.allow_image = body.allow_image
    existing.allow_video = body.allow_video
    existing.allow_audio = body.allow_audio
    existing.allow_document = body.allow_document
    existing.doc_extensions = exts
    existing.updated_by = actor.id
    await db.flush()

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="set_send_policy",
        target=str(existing.id),
        details={"scope": scope_name, "doc_extensions": exts},
        org_id=oid,
    )
    await db.commit()
    await _notify(db, [(scope_type, scope_id)])
    return {"id": str(existing.id), "doc_extensions": exts}


@router.delete("/send-policies/{policy_id}")
async def delete_send_policy(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    pid = _uuid_or_400(policy_id, "Invalid policy id")
    row = await db.get(SendPolicy, pid)
    if row is None:
        raise HTTPException(status_code=404, detail="Policy not found")
    org_id = row.org_id
    affected = [(row.scope_type, row.scope_id)]
    await db.delete(row)
    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="delete_send_policy",
        target=str(pid),
        org_id=org_id,
    )
    await db.commit()
    await _notify(db, affected)
    # Send policy is allow-by-default, so removing the row lifts the restriction.
    return {"message": "Policy removed", "note": "this scope may now send every type again"}


@router.get("/effective-policy/{user_id}")
async def effective_policy(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _actor: User = Depends(require_superadmin),
):
    """What is actually in force for one person, and where it came from.

    A user-scoped row replaces their department's outright, so an administrator
    looking at a department policy cannot tell from it alone what any given
    member may send. `source` names the level that won.
    """
    user = await db.get(User, _uuid_or_400(user_id, "Invalid user id"))
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return (await resolve_send_policy(db, user)).as_dict()


# --------------------------------------------------------------------------
# Admin -> department delegation
# --------------------------------------------------------------------------


@router.get("/admin-departments")
async def list_admin_departments(
    org_id: str = Query(...),
    db: AsyncSession = Depends(get_db),
    _actor: User = Depends(require_superadmin),
):
    oid = _uuid_or_400(org_id, "Invalid org_id")
    admins = (
        (
            await db.execute(
                select(User).where(User.org_id == oid, User.role == UserRole.org_admin)
            )
        )
        .scalars()
        .all()
    )
    assignments = (
        await db.execute(
            select(AdminDepartment.user_id, AdminDepartment.dept_id, Department.name)
            .join(Department, Department.id == AdminDepartment.dept_id)
            .where(Department.org_id == oid)
        )
    ).all()
    by_user: dict[uuid.UUID, list[dict]] = {}
    for uid, did, name in assignments:
        by_user.setdefault(uid, []).append({"id": str(did), "name": name})
    return {
        "data": [
            {
                "user_id": str(a.id),
                "display_name": a.display_name,
                "email": a.email,
                "departments": by_user.get(a.id, []),
                # No rows means org-wide. Surfaced explicitly because an empty
                # list would otherwise read as "manages nothing", which is the
                # opposite of what it means.
                "org_wide": a.id not in by_user,
            }
            for a in admins
        ]
    }


@router.put("/admin-departments/{user_id}")
async def set_admin_departments(
    user_id: str,
    body: AdminDepartmentsUpdate,
    db: AsyncSession = Depends(get_db),
    actor: User = Depends(require_superadmin),
):
    """Replace an admin's department assignment.

    An EMPTY list restores org-wide reach rather than removing all access — see
    AdminDepartment. That is deliberate but easy to misread, so the response
    says which of the two just happened.
    """
    uid = _uuid_or_400(user_id, "Invalid user id")
    target = await db.get(User, uid)
    if target is None or target.role != UserRole.org_admin:
        raise HTTPException(status_code=404, detail="Organization admin not found")

    dept_ids: list[uuid.UUID] = []
    for raw in body.department_ids:
        did = _uuid_or_400(raw, "Invalid department id")
        dept = await db.get(Department, did)
        if dept is None or dept.org_id != target.org_id:
            raise HTTPException(status_code=404, detail="Department not found in this organization")
        dept_ids.append(did)

    await db.execute(sa_delete(AdminDepartment).where(AdminDepartment.user_id == uid))
    for did in dept_ids:
        db.add(AdminDepartment(user_id=uid, dept_id=did))

    await log_audit(
        db,
        actor_id=actor.id,
        actor_type="superadmin",
        action="set_admin_departments",
        target=str(uid),
        details={"department_ids": [str(d) for d in dept_ids]},
        org_id=target.org_id,
    )
    await db.commit()
    return {
        "user_id": str(uid),
        "department_ids": [str(d) for d in dept_ids],
        "org_wide": not dept_ids,
    }
