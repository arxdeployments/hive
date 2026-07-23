"""Small shared helpers: wire-format serialization, sanitization, slugs."""

import datetime as dt
import re
import secrets
import string
import uuid

_TAG_RE = re.compile(r"<[^>]+>")


def iso_z(value: dt.datetime | None) -> str | None:
    """ISO-8601 with trailing Z — the wire datetime format the frontend expects."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.UTC)
    return value.astimezone(dt.UTC).isoformat().replace("+00:00", "Z")


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


def sanitize_text(text: str | None) -> str:
    """Strip HTML tags from user text (message content, names)."""
    if not text:
        return ""
    return _TAG_RE.sub("", text)


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def parse_uuid(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError, TypeError):
        return None


def generate_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw):
            return pw


def generate_call_code() -> str:
    groups = ["".join(secrets.choice(string.ascii_lowercase) for _ in range(4)) for _ in range(3)]
    return "-".join(groups)
