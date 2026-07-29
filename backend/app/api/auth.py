"""Auth: httpOnly-cookie sessions with a persisted, revocable refresh table.

Changes vs the Mongo build (all deliberate, coordinated with the frontend):
- Tokens ride in httpOnly cookies, never in response bodies or localStorage.
- Refresh tokens are opaque, hashed at rest, rotated on every refresh, and
  revoked on logout/deactivation. is_active is re-checked on refresh.
- Superadmin sessions refresh like everyone else (fixes the 15-min logout bug).
- The rate limiter is a dependency wired here — not dead code in main.py.
"""

import datetime as dt
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
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
from app.db.models import RefreshToken, User, UserRole
from app.db.session import get_db
from app.services import presence
from app.utils import iso_z, now_utc

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
) -> None:
    settings = get_settings()
    access = create_access_token(user.id, wire_role(user.role), user.org_id, client=client)
    raw_refresh, token_hash = new_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            user_agent=(request.headers.get("user-agent") or "")[:300],
            client=client,
            expires_at=now_utc() + dt.timedelta(days=settings.refresh_token_days),
        )
    )
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
    return {"user": _user_payload(user)}


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
    if token is None or token.revoked_at is not None:
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    expires = token.expires_at if token.expires_at.tzinfo else token.expires_at.replace(tzinfo=dt.UTC)
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
    await _issue_session(db, user, response, request, client=session_client)
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
