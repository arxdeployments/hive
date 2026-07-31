"""Auth: httpOnly-cookie sessions with a persisted, revocable refresh table.

Changes vs the Mongo build (all deliberate, coordinated with the frontend):
- Tokens ride in httpOnly cookies, never in response bodies or localStorage.
- Refresh tokens are opaque, hashed at rest, rotated on every refresh, and
  revoked on logout/deactivation. is_active is re-checked on refresh.
- Superadmin sessions refresh like everyone else (fixes the 15-min logout bug).
- The rate limiter is a dependency wired here — not dead code in main.py.

Rotation is now delivery-safe as well as single-use. Revoking the presented token
commits before its replacement can reach the client, so a lost response used to
leave a healthy client holding a token the server had already spent, and its next
refresh signed the user out of a session that was fine. A rotated token may now be
replayed once, within a short grace window, while the successor it never received
is still unused. Every other reuse is treated as a stolen cookie and burns that
client's whole session family — stricter than failing the one token, which is what
the previous build did.
"""

import datetime as dt
import logging
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user
from app.core.rate_limit import login_limiter, refresh_limiter
from app.core.security import (
    ACCESS_COOKIE,
    MOBILE_CLIENT,
    REFRESH_COOKIE,
    WEB_CLIENT,
    create_access_token,
    hash_refresh_token,
    new_refresh_token,
    verify_password,
)
from app.db.models import AdminDepartment, Department, Organization, RefreshToken, User, UserRole
from app.db.session import get_db
from app.services import presence
from app.utils import iso_z, now_utc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# A fixed bcrypt hash used to burn constant time on unknown-email logins.
_DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO0000000000000000000000000000000000"


# Distinct from the generic 401 on purpose. A member whose account is fine but
# who has not been granted mobile access must not be told "invalid password" —
# they would retype it forever. These are 403s: authentication succeeded, the
# client is what is refused.
SUPERADMIN_MOBILE_DENIED = "Super admin accounts can only sign in on the web app"
MOBILE_NOT_APPROVED = (
    "Mobile access has not been enabled for this account. "
    "Ask your super admin to approve mobile sign-in."
)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    # Which client is signing in. Absent means web, so the existing frontend and
    # every API consumer keep working untouched.
    client: Literal["web", "mobile"] = WEB_CLIENT


def _assert_mobile_allowed(user: User) -> None:
    """Gate a mobile sign-in. Raises 403 unless this account may use mobile.

    Called on login AND on refresh, so a revoked grant ends the session at the
    next refresh instead of lasting as long as the refresh token would. The
    superadmin exclusion is unconditional and not overridable by the flag: the
    admin portal has no mobile UI, and a phone is the wrong place to hold the
    keys to every tenant.
    """
    if user.role == UserRole.superadmin:
        raise HTTPException(status_code=403, detail=SUPERADMIN_MOBILE_DENIED)
    if not user.mobile_access:
        raise HTTPException(status_code=403, detail=MOBILE_NOT_APPROVED)


def wire_role(role: UserRole) -> str:
    # The frontend contract uses "admin" for org admins.
    return "admin" if role == UserRole.org_admin else role.value


def _user_payload(user: User) -> dict:
    payload = {
        "id": str(user.id),
        "email": user.email,
        "name": user.display_name,
        "role": wire_role(user.role),
    }
    if user.role != UserRole.superadmin:
        payload["org_id"] = str(user.org_id) if user.org_id else None
        payload["dept_id"] = str(user.dept_id) if user.dept_id else None
    return payload


async def _attach_managed_departments(db: AsyncSession, user: User, payload: dict) -> None:
    """Add `managed_departments` for org admins, so the console can hide what
    the API would refuse rather than let an admin fill in a form and collect a
    404 on submit.

    An EMPTY list means organization-wide, matching org_admin.managed_dept_ids —
    every admin in production is in that state today, since the delegation
    migration could not guess who should own what. The key is absent entirely for
    members and superadmins, which is what stops a client reading "no
    departments" as "manages nothing" for someone the concept does not apply to.

    Attached on login as well as /me. AuthContext calls /me on boot but sets the
    user straight from the login response, so a scoped admin who signed in and
    went to the console would otherwise be shown org-wide controls until their
    next page load.
    """
    if user.role != UserRole.org_admin:
        return
    rows = (
        await db.execute(
            select(AdminDepartment.dept_id, Department.name)
            .join(Department, Department.id == AdminDepartment.dept_id)
            .where(AdminDepartment.user_id == user.id)
            .order_by(Department.name)
        )
    ).all()
    payload["managed_departments"] = [{"_id": str(d), "name": n} for d, n in rows]


def set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    settings = get_settings()
    common = {
        "httponly": True,
        "secure": settings.cookies_secure,
        "samesite": "lax",
        "domain": settings.cookie_domain,
        "path": "/",
    }
    response.set_cookie(ACCESS_COOKIE, access, max_age=settings.access_token_minutes * 60, **common)
    response.set_cookie(REFRESH_COOKIE, refresh, max_age=settings.refresh_token_days * 86400, **common)


def clear_auth_cookies(response: Response) -> None:
    settings = get_settings()
    for name in (ACCESS_COOKIE, REFRESH_COOKIE):
        response.delete_cookie(name, domain=settings.cookie_domain, path="/")


async def _issue_session(
    db: AsyncSession,
    user: User,
    response: Response,
    request: Request,
    client: str = WEB_CLIENT,
    replaces: RefreshToken | None = None,
) -> None:
    settings = get_settings()
    access = create_access_token(user.id, wire_role(user.role), user.org_id, client=client)
    raw_refresh, token_hash = new_refresh_token()
    issued = RefreshToken(
        user_id=user.id,
        token_hash=token_hash,
        user_agent=(request.headers.get("user-agent") or "")[:300],
        client=client,
        expires_at=now_utc() + dt.timedelta(days=settings.refresh_token_days),
    )
    db.add(issued)
    if replaces is not None:
        # Flushed first so the rotated row can point at a real id in the same
        # transaction: that link is the only way a later replay of the rotated
        # token can be recognised as a response this client never received.
        await db.flush()
        replaces.replaced_by_id = issued.id
    await db.commit()
    set_auth_cookies(response, access, raw_refresh)


@router.post("/login")
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(login_limiter),
):
    stmt = select(User).where(func.lower(User.email) == body.email.lower())
    user = (await db.execute(stmt)).scalar_one_or_none()
    if user is None:
        # Equalize timing so a missing account can't be distinguished from a
        # wrong password by response latency (user-enumeration defense).
        verify_password(body.password, _DUMMY_HASH)
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=401, detail="Account is deactivated")
    # Ordered after the password check so the mobile-approval state of an account
    # is never disclosed to someone who cannot authenticate as it.
    if body.client == MOBILE_CLIENT:
        _assert_mobile_allowed(user)

    user.last_seen_at = now_utc()
    await _issue_session(db, user, response, request, client=body.client)
    payload = _user_payload(user)
    await _attach_managed_departments(db, user, payload)
    return {"user": payload}


def _as_utc(value: dt.datetime) -> dt.datetime:
    # Rows written before the timezone-aware columns landed can still read naive.
    return value if value.tzinfo else value.replace(tzinfo=dt.UTC)


async def _revoke_session_family(db: AsyncSession, token: RefreshToken) -> None:
    """Burn every live session the reused token could belong to, and commit.

    Scoped to the user AND the client that opened the reused session. Walking the
    replaced_by chain would only reach rotations descended from this one row, while
    whoever holds a stolen cookie plausibly holds others taken with it, so the
    family is read as that user's live sessions for that client. Wider than the
    chain on purpose — and still narrow enough that a stolen phone token cannot
    sign the same person out of the browser they are working in, which is the
    property refresh_tokens.client exists to protect.
    """
    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == token.user_id,
            RefreshToken.client == (token.client or WEB_CLIENT),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=now_utc())
        .execution_options(synchronize_session=False)
    )
    await db.commit()


async def _undelivered_successor(db: AsyncSession, token: RefreshToken) -> RefreshToken:
    """Resolve a replay of an already-rotated token, or raise 401 as theft.

    Rotation commits the revocation of the presented token before its replacement
    can possibly reach the client, so any response lost in flight — the iOS
    client's 30s budget expiring, a proxy 502 after the commit, the app being
    suspended, a reset connection — leaves a perfectly healthy client holding a
    token the server considers spent. Refusing that is what ended sessions that
    were fine, so within a bounded window the replay is honoured by rotating from
    the successor the client never saw. It buys exactly one rotation: that
    successor is spent by the rotation below, so a second replay lands in the
    theft branch.

    Every other reuse is a token someone has already spent being presented again,
    which is what a captured cookie looks like, so the family is burned rather than
    just this row.
    """
    grace = dt.timedelta(seconds=get_settings().refresh_reuse_grace_seconds)
    successor = await db.get(RefreshToken, token.replaced_by_id) if token.replaced_by_id else None
    undelivered = (
        successor is not None
        and successor.revoked_at is None
        and _as_utc(successor.expires_at) > now_utc()
        and now_utc() - _as_utc(token.revoked_at) <= grace
    )
    if not undelivered:
        logger.warning(
            "Refresh token reuse for user %s (%s session): revoking that client's session family",
            token.user_id,
            token.client or WEB_CLIENT,
        )
        await _revoke_session_family(db, token)
        # Same detail as an unknown token: which of the two it was is not the
        # caller's business, and saying so would help a thief probe the window.
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    logger.info(
        "Rotation response never reached user %s; replaying onto the undelivered successor",
        token.user_id,
    )
    return successor


@router.post("/refresh")
async def refresh(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(refresh_limiter),
):
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(status_code=401, detail="Refresh token required")
    token = (
        await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw)))
    ).scalar_one_or_none()
    if token is None:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    if token.revoked_at is not None:
        # Substituting the successor rather than returning early keeps every check
        # below — expiry, is_active, the mobile grant — applied in the same order,
        # to the row that is actually the live session.
        token = await _undelivered_successor(db, token)
    expires = _as_utc(token.expires_at)
    if expires < now_utc():
        raise HTTPException(status_code=401, detail="Refresh token expired")

    user = await db.get(User, token.user_id)
    if user is None or not user.is_active:
        # Deactivated users are revoked HERE — the gap the old build shipped.
        token.revoked_at = now_utc()
        await db.commit()
        raise HTTPException(status_code=401, detail="Account is deactivated")

    # A mobile session outlives the grant that created it unless the grant is
    # re-checked here — same reasoning as is_active directly above. The session is
    # burned before raising so a revoked user cannot keep retrying this token.
    session_client = token.client or WEB_CLIENT
    if session_client == MOBILE_CLIENT and (
        user.role == UserRole.superadmin or not user.mobile_access
    ):
        token.revoked_at = now_utc()
        await db.commit()
        raise HTTPException(status_code=403, detail=MOBILE_NOT_APPROVED)

    token.revoked_at = now_utc()  # rotation: old token is single-use
    await _issue_session(db, user, response, request, client=session_client, replaces=token)
    return {"user": _user_payload(user)}


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    raw = request.cookies.get(REFRESH_COOKIE)
    if raw:
        token = (
            await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw)))
        ).scalar_one_or_none()
        if token and token.user_id == user.id:
            token.revoked_at = now_utc()
    user.last_seen_at = now_utc()
    await db.commit()
    clear_auth_cookies(response)
    return {"message": "Logged out successfully"}


@router.get("/me")
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    payload = _user_payload(user)
    if user.role != UserRole.superadmin:
        statuses = await presence.get_statuses([user.id])
        payload["avatar_url"] = user.avatar_url
        payload["about"] = user.about
        payload["status"] = statuses.get(str(user.id), "offline")
        payload["last_seen"] = iso_z(user.last_seen_at)
        payload["mobile_access"] = user.mobile_access
        # Resolved NAMES, not just the ids _user_payload already carries. The
        # profile drawer renders org_name and dept_name, which this endpoint
        # never returned — so those two rows read "N/A" for every user, always,
        # regardless of their actual organization and department.
        payload["org_name"] = (
            (await db.get(Organization, user.org_id)).name if user.org_id else None
        )
        payload["dept_name"] = (
            (await db.get(Department, user.dept_id)).name if user.dept_id else None
        )
    # Queried only for org admins: /me runs on every app load, and members and
    # superadmins have no use for it.
    await _attach_managed_departments(db, user, payload)
    return payload


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.core.security import PasswordPolicyError, enforce_password_policy, hash_password

    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    try:
        enforce_password_policy(body.new_password)
    except PasswordPolicyError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    # Revoke every other session on password change.
    tokens = (
        await db.execute(
            select(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        )
    ).scalars()
    for t in tokens:
        t.revoked_at = now_utc()
    await db.commit()
    return {"message": "Password changed"}


_ = uuid  # placate linters for uuid used in typing of deps
