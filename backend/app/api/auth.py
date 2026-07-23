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

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user
from app.core.rate_limit import login_limiter, refresh_limiter
from app.core.security import (
    ACCESS_COOKIE,
    REFRESH_COOKIE,
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


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


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
        "secure": settings.cookie_secure,
        "samesite": "lax",
        "domain": settings.cookie_domain,
        "path": "/",
    }
    response.set_cookie(
        ACCESS_COOKIE, access, max_age=settings.access_token_minutes * 60, **common
    )
    response.set_cookie(
        REFRESH_COOKIE, refresh, max_age=settings.refresh_token_days * 86400, **common
    )


def clear_auth_cookies(response: Response) -> None:
    settings = get_settings()
    for name in (ACCESS_COOKIE, REFRESH_COOKIE):
        response.delete_cookie(name, domain=settings.cookie_domain, path="/")


async def _issue_session(
    db: AsyncSession, user: User, response: Response, request: Request
) -> None:
    settings = get_settings()
    access = create_access_token(user.id, wire_role(user.role), user.org_id)
    raw_refresh, token_hash = new_refresh_token()
    db.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            user_agent=(request.headers.get("user-agent") or "")[:300],
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
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=401, detail="Account is deactivated")

    user.last_seen_at = now_utc()
    await _issue_session(db, user, response, request)
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
        await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
        )
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

    token.revoked_at = now_utc()  # rotation: old token is single-use
    await _issue_session(db, user, response, request)
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
            await db.execute(
                select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
            )
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
            select(RefreshToken).where(
                RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
            )
        )
    ).scalars()
    for t in tokens:
        t.revoked_at = now_utc()
    await db.commit()
    return {"message": "Password changed"}


_ = uuid  # placate linters for uuid used in typing of deps
