"""Uploads + authenticated media serving.

Replaces the Mongo build's unauthenticated /api/uploads/{filename} disk serving:
every file lives in object storage under a DB-tracked Upload/MessageAttachment
row, and every read is auth-checked (uploader or conversation membership) before
redirecting to a short-lived presigned URL.
"""

import os
import re
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import RedirectResponse
from sqlalchemy import and_, func, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import TenantContext, get_current_user, get_tenant
from app.core.rate_limit import upload_limiter
from app.db.models import (
    ConversationParticipant,
    Message,
    MessageAttachment,
    MessageDeletion,
    MessageType,
    Upload,
    User,
)
from app.db.session import get_db
from app.services import storage
from app.services.enrich import media_url_for, thumb_url_for
from app.utils import iso_z, parse_uuid, sanitize_text

router = APIRouter(prefix="/api", tags=["media"])

_CHUNK_SIZE = 1024 * 1024

_TOO_LARGE_MESSAGES = {
    "image": "Image too large (max 16MB)",
    "video": "File too large (max 200MB)",
    "audio": "File too large (max 200MB)",
    "document": "File too large (max 100MB)",
}

_MEDIA_LIST_TYPES = {"image", "video", "audio", "file"}

_LINK_TYPE = "link"
_URL_RE = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_URL_TRAILING = ".,;:!?)]}>'\""
# Links come out of message text, so the scan is bounded to the newest N
# link-bearing messages rather than the whole (unbounded) history.
_LINK_SCAN_LIMIT = 500
# Inlined as a SQL literal, not a bind parameter, so it matches the predicate of
# the ix_messages_links partial index verbatim (Postgres cannot prove a
# parameterised ILIKE implies the index predicate when it caches a generic plan,
# and silently falls back to scanning the conversation's whole history).
# Safe to inline: a fixed constant, never user input.
_LINK_PATTERN = literal_column("'%http%'")

_INLINE_MIME_PREFIXES = ("image/", "video/", "audio/")


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="File not found")


def _safe_filename(name: str | None) -> str:
    """Strip HTML and any path components from a client-supplied filename."""
    cleaned = sanitize_text(name or "").replace("\\", "/").split("/")[-1].strip()
    return (cleaned or "file")[:300]


def _is_inline(mime_type: str) -> bool:
    return mime_type.startswith(_INLINE_MIME_PREFIXES)


def _extract_links(content: str) -> list[tuple[str, str]]:
    """(url, domain) pairs found in message text, de-duplicated, order preserved.

    The URLs are NEVER fetched: no titles, no favicons, no metadata requests.
    Fetching user-supplied URLs server-side would hand every user an SSRF probe
    into the deployment's private network.
    """
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for raw in _URL_RE.findall(content or ""):
        url = raw.rstrip(_URL_TRAILING)
        if not url or url in seen:
            continue
        domain = (urlparse(url).hostname or "").lower()
        if not domain:
            continue
        seen.add(url)
        out.append((url, domain))
    return out


@router.post("/upload")
async def upload_file(
    file: UploadFile | None = File(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    _rl: None = Depends(upload_limiter),
):
    if file is None or not (file.filename or "").strip():
        raise HTTPException(status_code=400, detail="No file provided")

    ext = os.path.splitext(file.filename or "")[1].lower()
    file_type = storage.classify(ext)
    if file_type is None:
        raise HTTPException(status_code=400, detail="File type not supported")

    limit = storage.size_limit_for(file_type)
    data = bytearray()
    while True:
        chunk = await file.read(_CHUNK_SIZE)
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(status_code=400, detail=_TOO_LARGE_MESSAGES[file_type])
    payload = bytes(data)

    # Content type from the extension map — the client's Content-Type is never trusted.
    content_type = storage.MIME_BY_EXT.get(ext, "application/octet-stream")

    key = storage.new_storage_key(user.org_id, ext)
    await storage.put_object(key, payload, content_type)

    thumbnail_key = None
    if file_type == "image":
        thumb = await storage.make_thumbnail(payload)
        if thumb is not None:
            thumbnail_key = f"{key}_thumb.jpg"
            await storage.put_object(thumbnail_key, thumb, "image/jpeg")

    upload = Upload(
        uploader_id=user.id,
        org_id=user.org_id,
        storage_key=key,
        thumbnail_key=thumbnail_key,
        filename=_safe_filename(file.filename),
        mime_type=content_type,
        file_type=file_type,
        file_size=len(payload),
    )
    db.add(upload)
    await db.commit()

    file_url = f"/api/media/up/{upload.id}"
    response = {
        "file_id": str(upload.id),
        "filename": upload.filename,
        "file_url": file_url,
        "file_type": upload.file_type,
        "file_size": upload.file_size,
        "mime_type": upload.mime_type,
    }
    if file_type == "image":
        # Contract: thumbnail_url falls back to the file itself if thumbnailing failed.
        response["thumbnail_url"] = f"{file_url}/thumb" if thumbnail_key else file_url
    return response


async def _own_upload(db: AsyncSession, upload_id: str, user: User) -> Upload:
    """Load an upload iff the caller is its uploader (404 otherwise)."""
    uid = parse_uuid(upload_id)
    if uid is None:
        raise _not_found()
    upload = await db.get(Upload, uid)
    if upload is None or upload.uploader_id != user.id:
        raise _not_found()
    return upload


@router.get("/media/up/{upload_id}")
async def serve_upload(
    upload_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    upload = await _own_upload(db, upload_id, user)
    url = await storage.presign_get(upload.storage_key, filename=upload.filename, inline=True)
    return RedirectResponse(url, status_code=307)


@router.get("/media/up/{upload_id}/thumb")
async def serve_upload_thumb(
    upload_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    upload = await _own_upload(db, upload_id, user)
    if not upload.thumbnail_key:
        raise _not_found()
    url = await storage.presign_get(upload.thumbnail_key, inline=True)
    return RedirectResponse(url, status_code=307)


async def _member_attachment(db: AsyncSession, attachment_id: str, user: User) -> MessageAttachment:
    """Load an attachment iff the caller participates in its conversation and
    the message is not tombstoned (404 otherwise — existence is not revealed)."""
    att_id = parse_uuid(attachment_id)
    if att_id is None:
        raise _not_found()
    attachment = await db.get(MessageAttachment, att_id)
    if attachment is None:
        raise _not_found()
    msg = await db.get(Message, attachment.message_id)
    if msg is None or msg.deleted_at is not None:
        raise _not_found()
    membership = await db.get(ConversationParticipant, (msg.conversation_id, user.id))
    if membership is None:
        raise _not_found()
    return attachment


@router.get("/media/{attachment_id}")
async def serve_attachment(
    attachment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attachment = await _member_attachment(db, attachment_id, user)
    url = await storage.presign_get(
        attachment.storage_key,
        filename=attachment.filename,
        inline=_is_inline(attachment.mime_type),
    )
    return RedirectResponse(url, status_code=307)


@router.get("/media/{attachment_id}/thumb")
async def serve_attachment_thumb(
    attachment_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    attachment = await _member_attachment(db, attachment_id, user)
    if not attachment.thumbnail_key:
        raise _not_found()
    url = await storage.presign_get(attachment.thumbnail_key, inline=True)
    return RedirectResponse(url, status_code=307)


def _deletion_join(user_id):
    return and_(MessageDeletion.message_id == Message.id, MessageDeletion.user_id == user_id)


async def _sender_names(db: AsyncSession, messages) -> dict:
    sender_ids = {m.sender_id for m in messages if m.sender_id}
    if not sender_ids:
        return {}
    rows = (await db.execute(select(User.id, User.display_name).where(User.id.in_(sender_ids)))).all()
    return {row.id: row.display_name for row in rows}


async def _conversation_links(db: AsyncSession, conv_id, user_id, page: int, limit: int) -> dict:
    """Links shared in a conversation, extracted from message text server-side."""
    deletion_join = _deletion_join(user_id)
    messages = (
        (
            await db.execute(
                select(Message)
                .outerjoin(MessageDeletion, deletion_join)
                .where(
                    Message.conversation_id == conv_id,
                    Message.type != MessageType.system,
                    Message.deleted_at.is_(None),
                    MessageDeletion.message_id.is_(None),  # exclude the caller's delete-for-me
                    # A leading-wildcard match can use no ordinary index, so the
                    # limit below bounded the rows RETURNED while the scan still
                    # read every message in the conversation. The partial index
                    # ix_messages_links carries exactly this predicate, moving
                    # that work to write time; keep the two in lockstep.
                    Message.content.ilike(_LINK_PATTERN),
                )
                .order_by(Message.created_at.desc())
                .limit(_LINK_SCAN_LIMIT)
            )
        )
        .scalars()
        .all()
    )
    sender_names = await _sender_names(db, messages)

    items: list[dict] = []
    for msg in messages:
        content = (msg.content or "").strip()
        for url, domain in _extract_links(content):
            items.append(
                {
                    "message_id": str(msg.id),
                    "url": url,
                    # No fetching means no remote <title>: the surrounding message
                    # text is the only local context, with the domain as fallback.
                    "title": content[:200] or domain,
                    "domain": domain,
                    "sender_name": sender_names.get(msg.sender_id, "Unknown"),
                    "created_at": iso_z(msg.created_at),
                }
            )

    total = len(items)
    offset = (page - 1) * limit
    return {"data": items[offset : offset + limit], "total": total, "has_more": offset + limit < total}


@router.get("/conversations/{conv_id}/media")
async def conversation_media(
    conv_id: str,
    media_type: str = Query("image", alias="type"),
    page: int = Query(1, ge=1),
    limit: int = Query(30, ge=1, le=100),
    tenant: TenantContext = Depends(get_tenant),
):
    conv_uuid = parse_uuid(conv_id)
    if conv_uuid is None:
        raise HTTPException(status_code=400, detail="Invalid conversation ID")
    if media_type not in _MEDIA_LIST_TYPES and media_type != _LINK_TYPE:
        # Deliberate fix vs the Mongo build, which accepted any type string
        # (type=text returned text messages reshaped as media items).
        raise HTTPException(status_code=400, detail="Invalid media type")
    conv = await tenant.require_membership(conv_uuid)
    db = tenant.db

    if media_type == _LINK_TYPE:
        return await _conversation_links(db, conv.id, tenant.user.id, page, limit)

    deletion_join = _deletion_join(tenant.user.id)
    filters = [
        Message.conversation_id == conv.id,
        Message.type == MessageType(media_type),
        Message.deleted_at.is_(None),
        MessageDeletion.message_id.is_(None),  # exclude the caller's delete-for-me
    ]

    total = (
        await db.execute(
            select(func.count(Message.id)).outerjoin(MessageDeletion, deletion_join).where(*filters)
        )
    ).scalar_one()

    messages = (
        (
            await db.execute(
                select(Message)
                .options(selectinload(Message.attachments))
                .outerjoin(MessageDeletion, deletion_join)
                .where(*filters)
                .order_by(Message.created_at.desc())
                .offset((page - 1) * limit)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    sender_names = await _sender_names(db, messages)

    data = []
    for msg in messages:
        first = msg.attachments[0] if msg.attachments else None
        data.append(
            {
                "message_id": str(msg.id),
                "media_url": media_url_for(first.id) if first else None,
                "thumbnail_url": thumb_url_for(first.id) if first and first.thumbnail_key else None,
                "filename": first.filename if first else "",
                "file_size": first.file_size if first else 0,
                "sender_name": sender_names.get(msg.sender_id, "Unknown"),
                "created_at": iso_z(msg.created_at),
            }
        )

    return {"data": data, "total": total, "has_more": page * limit < total}
