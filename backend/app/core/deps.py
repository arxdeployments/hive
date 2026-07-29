"""FastAPI dependencies: current user, role guards, and the tenant guard.

The tenant guard is the single place multi-tenant isolation is enforced.
Every org-scoped route depends on `TenantContext`; every query made through it
is scoped to the caller's organization. Closing the cross-tenant IDOR class by
construction — not per-endpoint vigilance.
"""

import uuid

from fastapi import Depends, HTTPException, Request, WebSocket, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import ACCESS_COOKIE, decode_access_token
from app.db.models import Conversation, ConversationParticipant, ConversationType, User, UserRole
from app.db.session import get_db

_credentials_error = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")


def _token_from_request(request: Request) -> str | None:
    # httpOnly cookie is the canonical transport; Authorization header is
    # accepted for API tooling and tests.
    token = request.cookies.get(ACCESS_COOKIE)
    if token:
        return token
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.removeprefix("Bearer ")
    return None


def _mobile_grant_revoked(payload: dict, user: User) -> bool:
    """True if this token was minted for mobile but the account may no longer use it.

    Checked on every request, not just refresh, so a superadmin revoking mobile
    access ends that user's mobile session now rather than whenever their access
    token happens to expire. Tokens minted before the claim existed have no
    "client" and are treated as web, which is what they were.
    """
    if payload.get("client") != "mobile":
        return False
    return user.role == UserRole.superadmin or not user.mobile_access


async def _load_user(token: str | None, db: AsyncSession) -> User:
    if not token:
        raise _credentials_error
    payload = decode_access_token(token)
    if not payload:
        raise _credentials_error
    user = await db.get(User, uuid.UUID(payload["sub"]))
    if not user or not user.is_active:
        raise _credentials_error
    if _mobile_grant_revoked(payload, user):
        raise _credentials_error
    return user


async def get_current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    return await _load_user(_token_from_request(request), db)


async def get_current_user_ws(websocket: WebSocket, db: AsyncSession) -> tuple[User, int, str] | None:
    """Cookie-authenticated WebSocket handshake.

    Returns (user, token_exp, client) so the connection can enforce the
    access-token lifetime and force a re-auth on expiry, and so its periodic
    liveness check knows whether to re-verify the mobile grant. The query-param
    token fallback exists only outside production."""
    from app.core.config import get_settings

    token = websocket.cookies.get(ACCESS_COOKIE)
    if token is None and not get_settings().is_production:
        token = websocket.query_params.get("token")
    if not token:
        return None
    payload = decode_access_token(token)
    if not payload:
        return None
    try:
        user = await db.get(User, uuid.UUID(payload["sub"]))
    except (ValueError, KeyError):
        return None
    if not user or not user.is_active:
        return None
    if _mobile_grant_revoked(payload, user):
        return None
    return user, int(payload.get("exp", 0)), str(payload.get("client") or "web")


async def require_superadmin(user: User = Depends(get_current_user)) -> User:
    if user.role != UserRole.superadmin:
        raise HTTPException(status_code=403, detail="Super admin access required")
    return user


async def require_org_admin(user: User = Depends(get_current_user)) -> User:
    if user.role not in (UserRole.superadmin, UserRole.org_admin):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


class TenantContext:
    """The caller's identity + org scope. All org-scoped data access goes
    through helpers that take this context, so org filtering can't be forgotten."""

    def __init__(self, user: User, db: AsyncSession):
        self.user = user
        self.db = db

    @property
    def org_id(self) -> uuid.UUID | None:
        return self.user.org_id

    @property
    def is_superadmin(self) -> bool:
        return self.user.role == UserRole.superadmin

    def check_org(self, org_id: uuid.UUID | None) -> None:
        """Assert an object belongs to the caller's org (superadmin bypasses)."""
        if self.is_superadmin:
            return
        if org_id is None or self.org_id is None or org_id != self.org_id:
            raise HTTPException(status_code=404, detail="Not found")

    async def require_membership(self, conversation_id: uuid.UUID) -> Conversation:
        """Return the conversation iff the caller is a participant. 404 otherwise
        (existence is not revealed across tenants)."""
        conv = await self.db.get(Conversation, conversation_id)
        if conv is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        membership = await self.db.get(ConversationParticipant, (conversation_id, self.user.id))
        if membership is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        # Org check lives here rather than in each route: every participant row the
        # API can create today already matches the conversation's org, so this is
        # defence in depth — but the message read paths checked it and the pin /
        # mute / delete / clear / export routes did not, and only enforcing it in
        # the shared guard keeps a future route from drifting the same way.
        # cross_org conversations belong to no single org and are exempt by design.
        if conv.type != ConversationType.cross_org and conv.org_id != self.user.org_id:
            raise HTTPException(status_code=403, detail="Access denied")
        return conv

    async def org_user(self, user_id: uuid.UUID) -> User:
        """Load a user constrained to the caller's org (superadmin: any user)."""
        target = await self.db.get(User, user_id)
        if target is None:
            raise HTTPException(status_code=404, detail="User not found")
        if not self.is_superadmin and target.org_id != self.org_id:
            raise HTTPException(status_code=404, detail="User not found")
        return target

    async def org_users_query(self):
        stmt = select(User).where(User.is_active.is_(True))
        if not self.is_superadmin:
            stmt = stmt.where(User.org_id == self.org_id)
        return stmt


async def get_tenant(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> TenantContext:
    return TenantContext(user, db)
