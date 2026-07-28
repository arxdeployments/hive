"""Object storage (MinIO / any S3) — uploads, thumbnails, presigned reads.

Files never live on the app disk and are never served unauthenticated:
reads go through /api/media/* which checks membership then redirects to a
short-lived presigned URL.
"""

import datetime as dt
import io
import uuid
from functools import lru_cache
from urllib.parse import urlsplit

import anyio
import pypdfium2 as pdfium
from minio import Minio
from minio.credentials import IamAwsProvider
from PIL import Image

from app.core.config import get_settings

# Decompression-bomb guard: cap decoded pixels well below a memory-exhaustion
# threshold. A crafted small file can otherwise claim huge dimensions.
Image.MAX_IMAGE_PIXELS = 40_000_000  # ~40 MP

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".m4v"}
# .weba is the audio-only WebM extension. It exists here because ".webm" is
# deliberately VIDEO above, and MediaRecorder's Chrome default is
# audio/webm;codecs=opus — uploaded as .webm a voice note would be classified as
# a VIDEO and render in the video bubble. The recorder names its Opus fallback
# .weba so the two can never collide.
AUDIO_EXTS = {".mp3", ".m4a", ".wav", ".ogg", ".aac", ".opus", ".weba"}
DOC_EXTS = {
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".txt",
    ".csv",
    ".zip",
    ".md",
    ".json",
    ".rtf",
}

MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_MEDIA_BYTES = 200 * 1024 * 1024
MAX_DOC_BYTES = 100 * 1024 * 1024

MIME_BY_EXT = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".aac": "audio/aac",
    ".opus": "audio/opus",
    ".weba": "audio/webm",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".md": "text/markdown",
    ".json": "application/json",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf": "application/rtf",
}


def classify(ext: str) -> str | None:
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in DOC_EXTS:
        return "document"
    return None


def size_limit_for(file_type: str) -> int:
    return {
        "image": MAX_IMAGE_BYTES,
        "video": MAX_MEDIA_BYTES,
        "audio": MAX_MEDIA_BYTES,
        "document": MAX_DOC_BYTES,
    }[file_type]


def _endpoint_parts(url: str) -> tuple[str, bool]:
    parts = urlsplit(url)
    secure = parts.scheme == "https"
    return parts.netloc or parts.path, secure


@lru_cache
def _client() -> Minio:
    """S3 client. With no static keys configured, fall back to the AWS instance
    role (EC2/ECS metadata) — that is the deployed path, so no long-lived
    credentials ever sit on the box. MinIO locally still uses explicit keys."""
    settings = get_settings()
    host, secure = _endpoint_parts(settings.s3_endpoint)
    if settings.s3_access_key and settings.s3_secret_key:
        return Minio(
            host,
            access_key=settings.s3_access_key,
            secret_key=settings.s3_secret_key,
            secure=secure,
            region=settings.s3_region,
        )
    return Minio(
        host,
        credentials=IamAwsProvider(region=settings.s3_region),
        secure=secure,
        region=settings.s3_region,
    )


def ensure_bucket() -> None:
    settings = get_settings()
    client = _client()
    if not client.bucket_exists(settings.s3_bucket):
        client.make_bucket(settings.s3_bucket)


async def put_object(key: str, data: bytes, content_type: str) -> None:
    settings = get_settings()

    def _put() -> None:
        _client().put_object(settings.s3_bucket, key, io.BytesIO(data), len(data), content_type=content_type)

    await anyio.to_thread.run_sync(_put)


async def make_thumbnail(data: bytes) -> bytes | None:
    """200px JPEG thumbnail, transparent pixels flattened onto the app bg."""

    def _thumb() -> bytes | None:
        try:
            img = Image.open(io.BytesIO(data))
            # Reject decompression bombs by declared dimensions before decoding.
            if img.size[0] * img.size[1] > Image.MAX_IMAGE_PIXELS:
                return None
            img.thumbnail((200, 200))
            if img.mode in ("RGBA", "P", "LA"):
                background = Image.new("RGB", img.size, (26, 26, 26))
                img = img.convert("RGBA")
                background.paste(img, mask=img.split()[-1])
                img = background
            elif img.mode != "RGB":
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=80)
            return buf.getvalue()
        except Exception:
            return None

    return await anyio.to_thread.run_sync(_thumb)


# --- PDF rasterisation -------------------------------------------------------
#
# Renders PDF pages to JPEG server-side, which is what lets a document bubble
# show page 1 and the viewer show the whole file. Rendering on the CLIENT was
# rejected: a virtualised scrollback of ten 20MB PDFs would download 200MB just
# to draw ten thumbnails.

PDF_THUMB_PX = 400    # page-1 preview inside the bubble
PDF_PAGE_PX = 1600    # long edge for full-viewer pages
# Hard clamp. The page count comes out of a parser fed untrusted input, so a
# hostile file reporting a huge count would otherwise turn the count itself into
# an attack on both the DOM and the per-page endpoint.
PDF_MAX_PAGES = 2000
PDF_WINDOW = 10       # pages rendered per on-demand pass

# PDFium is NOT thread-safe and pypdfium2 ships no lock of its own. anyio's
# default thread limiter allows 40, so without this two renders could overlap.
# Same idiom as services/push.py's send limiter.
_PDF_LIMITER = anyio.CapacityLimiter(1)


def _render_pdf_page(page, long_px: int) -> bytes:
    w_pt, h_pt = page.get_size()
    # Scale is derived from the page box, so the OUTPUT raster is bounded by
    # construction however large the page claims to be. This is the
    # enormous-page guard — Pillow's MAX_IMAGE_PIXELS does not apply here,
    # because nothing is being decoded from an image file.
    scale = min(long_px / max(w_pt, 1.0), long_px / max(h_pt, 1.0))
    # draw_annots=False is deliberate for a clinical product: comments, stamps
    # and redaction overlays stay out of the rendered page.
    bitmap = page.render(scale=scale, draw_annots=False, may_draw_forms=False)
    img = bitmap.to_pil().convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


async def make_pdf_preview(data: bytes) -> tuple[bytes | None, int | None]:
    """(JPEG of page 1, page count). (None, None) on any parse failure —
    encrypted, truncated and plain-garbage files all land there."""

    def _go() -> tuple[bytes | None, int | None]:
        pdf = page = None
        try:
            pdf = pdfium.PdfDocument(data)
            n = min(len(pdf), PDF_MAX_PAGES)
            page = pdf[0]
            return _render_pdf_page(page, PDF_THUMB_PX), n
        except Exception:
            return None, None
        finally:
            if page is not None:
                page.close()
            if pdf is not None:
                pdf.close()

    return await anyio.to_thread.run_sync(_go, limiter=_PDF_LIMITER)


async def render_pdf_window(data: bytes, start: int) -> dict[int, bytes]:
    """1-indexed pages start..start+PDF_WINDOW-1 as JPEGs; {} on failure.

    A window rather than one page at a time: opening the document dominates the
    cost, so rendering ten pages per open is far cheaper than ten opens.
    """

    def _go() -> dict[int, bytes]:
        out: dict[int, bytes] = {}
        pdf = None
        try:
            pdf = pdfium.PdfDocument(data)
            n = min(len(pdf), PDF_MAX_PAGES)
            for i in range(start, min(start + PDF_WINDOW, n + 1)):
                page = pdf[i - 1]
                try:
                    out[i] = _render_pdf_page(page, PDF_PAGE_PX)
                finally:
                    page.close()
            return out
        except Exception:
            # Return whatever rendered before the failure rather than nothing.
            return out
        finally:
            if pdf is not None:
                pdf.close()

    return await anyio.to_thread.run_sync(_go, limiter=_PDF_LIMITER)


async def get_object(key: str) -> bytes:
    """Fetch an object's bytes. Used to re-read a PDF for page rendering."""

    def _get() -> bytes:
        resp = _client().get_object(get_settings().s3_bucket, key)
        try:
            return resp.read()
        finally:
            resp.close()
            resp.release_conn()

    return await anyio.to_thread.run_sync(_get)


async def object_exists(key: str) -> bool:
    def _stat() -> bool:
        try:
            _client().stat_object(get_settings().s3_bucket, key)
            return True
        except Exception:
            return False

    return await anyio.to_thread.run_sync(_stat)


async def presign_get(key: str, *, filename: str | None = None, inline: bool = True) -> str:
    """Short-lived presigned GET URL, rewritten to the public endpoint the
    browser can reach (the bundled Caddy /s3 route, or a real S3/CDN origin)."""
    settings = get_settings()

    def _presign() -> str:
        headers = {}
        disposition = "inline" if inline else "attachment"
        if filename:
            safe = filename.replace('"', "").replace("\r", "").replace("\n", "")
            headers["response-content-disposition"] = f'{disposition}; filename="{safe}"'
        return _client().presigned_get_object(
            settings.s3_bucket,
            key,
            expires=dt.timedelta(seconds=settings.presign_expiry_seconds),
            response_headers=headers or None,
        )

    url = await anyio.to_thread.run_sync(_presign)
    return rewrite_to_public(url, settings.s3_public_endpoint)


def rewrite_to_public(url: str, public_endpoint: str) -> str:
    """Point a presigned URL at the endpoint the browser can actually reach.

    Rewrites by PARSING the URL rather than string-replacing the configured
    endpoint: against real AWS, minio signs virtual-host style
    (https://<bucket>.s3.<region>.amazonaws.com/<key>), which never contains the
    configured "https://s3.<region>.amazonaws.com" prefix — a prefix replace
    silently no-ops and leaks a cross-origin URL to the browser.

    A path-style public endpoint ("/s3") keeps media same-origin, which matters:
    CSP is enforced against redirect targets, so a cross-origin redirect out of
    /api/media is blocked by `img-src 'self'`. The signature stays valid because
    only the host is swapped — the proxy must forward the original Host.
    """
    public = (public_endpoint or "").rstrip("/")
    if not public:
        return url
    parts = urlsplit(url)
    query = f"?{parts.query}" if parts.query else ""
    if public.startswith(("http://", "https://")):
        pub = urlsplit(public)
        if (pub.scheme, pub.netloc) == (parts.scheme, parts.netloc):
            return url
        return f"{pub.scheme}://{pub.netloc}{pub.path.rstrip('/')}{parts.path}{query}"
    # Same-origin path prefix (e.g. "/s3"), resolved by the browser.
    return f"{public}{parts.path}{query}"


def new_storage_key(org_id, ext: str) -> str:
    scope = str(org_id) if org_id else "platform"
    return f"{scope}/{uuid.uuid4()}{ext.lower()}"
