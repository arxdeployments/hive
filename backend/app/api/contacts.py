"""Contacts roster — GET /api/users/contacts.

Wire contract preserved from RxHivexx (docs/reference/api-uploads-calls-misc.md):
bare array response with the `department_name` key (the /api/search contacts
bucket calls the same concept `department`). Fixes vs the Mongo build: the
search input is escaped + parameterized (was raw $regex — injection/ReDoS),
and departments are batch-joined instead of one lookup per user.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import selectinload

from app.core.deps import TenantContext, get_tenant
from app.db.models import (
    Conversation,
    ConversationParticipant,
    ConversationType,
    Department,
    User,
)
from app.services import access, enrich, presence
from app.utils import iso_z, parse_uuid

router = APIRouter(prefix="/api/users", tags=["contacts"])

# The contact panel renders this list in full — the wire contract has no cursor —
# so the query must cap itself: a user who shares hundreds of groups with a
# colleague would otherwise serialize every one of them on each profile open.
_GROUPS_IN_COMMON_LIMIT = 50


def _like_pattern(value: str) -> str:
    """Escape LIKE wildcards so user input is matched literally."""
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("/me/send-policy")
async def my_send_policy(tenant: TenantContext = Depends(get_tenant)):
    """What the caller may send, resolved.

    A dedicated endpoint rather than a field on /api/auth/me, for two reasons.
    AuthContext caches the /me payload in localStorage, and policy is exactly
    the thing that must not be read from a store the user can edit. And policy
    changes independently of identity — it needs re-fetching on an
    access_changed event without cycling the session.

    Purely a rendering hint. The client uses it to grey out an attach option
    instead of offering a file the server will refuse; `accept` on a file input
    is advisory anyway, and drag-and-drop and paste ignore it entirely. Every
    send is still checked server-side at claim time.
    """
    return (await access.resolve_send_policy(tenant.db, tenant.user)).as_dict()


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

    # Filter the roster to people this user may actually reach. Chosen over
    # showing everyone and failing on click: a directory that lists a colleague
    # you cannot contact invites the support ticket, and the ward's staff list
    # is itself information a restriction is often meant to withhold.
    #
    # One preloaded set rather than a per-row check — this endpoint has no
    # pagination and renders in full, so a per-pair query here would N+1 one of
    # the hottest paths in the app.
    reachable = await access.reachable_user_ids(tenant.db, user)
    rows = [(u, d) for u, d in rows if u.id in reachable]

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


@router.get("/{user_id}/groups-in-common")
async def groups_in_common(user_id: str, tenant: TenantContext = Depends(get_tenant)):
    """Group conversations BOTH the caller and the target user belong to.

    The target is resolved through the tenant guard, so a foreign-org user id
    is a 404 — the caller can't probe another org's roster or memberships.
    """
    target_id = parse_uuid(user_id)
    if target_id is None:
        raise HTTPException(status_code=400, detail="Invalid user ID")
    target = await tenant.org_user(target_id)
    if target.id == tenant.user.id:
        return {"data": []}

    mine = ConversationParticipant.__table__.alias("mine")
    theirs = ConversationParticipant.__table__.alias("theirs")
    stmt = (
        select(Conversation)
        .join(mine, and_(mine.c.conversation_id == Conversation.id, mine.c.user_id == tenant.user.id))
        .join(theirs, and_(theirs.c.conversation_id == Conversation.id, theirs.c.user_id == target.id))
        .options(selectinload(Conversation.participants).selectinload(ConversationParticipant.user))
        .where(
            Conversation.is_active.is_(True),
            Conversation.type.in_((ConversationType.group, ConversationType.cross_org)),
        )
        .order_by(Conversation.last_message_at.desc().nulls_last())
        .limit(_GROUPS_IN_COMMON_LIMIT)
    )
    convs = (await tenant.db.execute(stmt)).scalars().all()

    # Batched like the conversation LIST endpoint: serializing one at a time made
    # this three queries PER group (unread, last message, presence) issued
    # sequentially, so the panel's latency grew linearly with shared groups.
    db = tenant.db
    conv_ids = [c.id for c in convs]
    unread = await enrich.unread_counts(db, conv_ids, tenant.user.id)
    last_msgs = await enrich.last_messages(db, conv_ids, tenant.user.id)
    statuses = await presence.get_statuses(list({p.user_id for c in convs for p in c.participants}))

    data = [
        await enrich.serialize_conversation(
            db, c, tenant.user.id, statuses=statuses, unread=unread, last_msgs=last_msgs
        )
        for c in convs
    ]
    return {"data": data}
