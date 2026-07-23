"""Password hashing, JWT minting/verification, refresh-token helpers."""

import datetime as dt
import hashlib
import re
import secrets
import uuid

import bcrypt
import jwt

from app.core.config import get_settings

JWT_ALGORITHM = "HS256"

ACCESS_COOKIE = "rx_access"
REFRESH_COOKIE = "rx_refresh"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


class PasswordPolicyError(ValueError):
    pass


def enforce_password_policy(password: str) -> None:
    """Raise PasswordPolicyError unless the password meets the org policy.

    Called on every path that sets a password: registration, admin create/reset,
    self-service change.
    """
    settings = get_settings()
    if len(password) < settings.password_min_length:
        raise PasswordPolicyError(
            f"Password must be at least {settings.password_min_length} characters"
        )
    if not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        raise PasswordPolicyError("Password must contain both letters and numbers")


def create_access_token(user_id: uuid.UUID, role: str, org_id: uuid.UUID | None) -> str:
    settings = get_settings()
    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": str(user_id),
        "role": role,
        "org_id": str(org_id) if org_id else None,
        "iat": now,
        "exp": now + dt.timedelta(minutes=settings.access_token_minutes),
        "type": "access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "access":
        return None
    return payload


def new_refresh_token() -> tuple[str, str]:
    """Return (raw_token, sha256_hash). Only the hash is stored server-side."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
