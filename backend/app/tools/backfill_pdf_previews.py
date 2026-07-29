"""Generate previews for PDFs uploaded before the feature existed.

    python -m app.tools.backfill_pdf_previews [--dry-run] [--limit N]

PDFs sent before page-1 previews shipped have thumbnail_key and page_count NULL,
so their bubbles show the plain icon and the reader has no pages to fetch. This
walks those rows, renders page 1, stores the thumbnail alongside the original and
records the page count.

Strictly speaking this is optional: /media/{id}/thumb renders lazily on first
view, so a PDF nobody opens costs nothing and one that is opened heals itself.
The batch job exists because the lazy path cannot populate `page_count` in a
payload the client has ALREADY fetched — without it the bubble subtitle omits
"N pages" and the reader opens empty until the conversation is reloaded.

Idempotent: rows that already have a page_count are skipped, so re-running is
free. An un-renderable PDF (encrypted, corrupt) is marked page_count=0, which is
the "tried and failed" marker that stops it being re-parsed forever.

Reads and writes one row at a time rather than loading every PDF into memory,
and rendering is serialised by storage's PDFium limiter regardless.
"""

import argparse
import asyncio

from sqlalchemy import select

from app.db.models import MessageAttachment, Upload
from app.db.session import SessionLocal, engine
from app.services import storage

PDF_MIME = "application/pdf"


async def _backfill_attachments(dry_run: bool, limit: int | None) -> tuple[int, int, int]:
    done = failed = skipped = 0
    async with SessionLocal() as db:
        stmt = (
            select(MessageAttachment)
            .where(
                MessageAttachment.mime_type == PDF_MIME,
                MessageAttachment.page_count.is_(None),
            )
            .order_by(MessageAttachment.created_at)
        )
        if limit:
            stmt = stmt.limit(limit)
        rows = (await db.execute(stmt)).scalars().all()
        print(f"message_attachments: {len(rows)} PDF(s) without a preview")

        for a in rows:
            label = f"  {a.filename[:52]:52}"
            if dry_run:
                print(f"{label} would render")
                skipped += 1
                continue
            try:
                data = await storage.get_object(a.storage_key)
            except Exception as exc:  # object missing from storage
                print(f"{label} SKIP — cannot read object ({type(exc).__name__})")
                skipped += 1
                continue

            thumb, pages = await storage.make_pdf_preview(data)
            if thumb is None:
                # Mark as tried so neither this job nor the lazy path retries it.
                a.page_count = 0
                await db.commit()
                print(f"{label} UNRENDERABLE — marked, will keep the icon")
                failed += 1
                continue

            key = f"{a.storage_key}_thumb.jpg"
            await storage.put_object(key, thumb, "image/jpeg")
            a.thumbnail_key = key
            a.page_count = pages
            await db.commit()
            print(f"{label} ok — {pages} page(s), {len(thumb)} byte thumbnail")
            done += 1
    return done, failed, skipped


async def _backfill_uploads(dry_run: bool) -> int:
    """Staging rows. Only matters for uploads not yet claimed by a message —
    a claimed one already copied its (then NULL) page_count onto the attachment,
    which the pass above fixes directly."""
    done = 0
    async with SessionLocal() as db:
        rows = (
            await db.execute(
                select(Upload).where(
                    Upload.mime_type == PDF_MIME,
                    Upload.page_count.is_(None),
                    Upload.claimed.is_(False),
                )
            )
        ).scalars().all()
        print(f"uploads (unclaimed): {len(rows)} PDF(s) without a page count")
        for u in rows:
            if dry_run:
                continue
            try:
                data = await storage.get_object(u.storage_key)
            except Exception:
                continue
            thumb, pages = await storage.make_pdf_preview(data)
            if thumb is None:
                u.page_count = 0
                await db.commit()
                continue
            key = f"{u.storage_key}_thumb.jpg"
            await storage.put_object(key, thumb, "image/jpeg")
            u.thumbnail_key = key
            u.page_count = pages
            await db.commit()
            done += 1
    return done


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="list what would change, touch nothing")
    ap.add_argument("--limit", type=int, default=None, help="cap how many attachments to process")
    args = ap.parse_args()

    if args.dry_run:
        print("DRY RUN — nothing will be written\n")

    done, failed, skipped = await _backfill_attachments(args.dry_run, args.limit)
    up = await _backfill_uploads(args.dry_run)

    print(
        f"\ndone: {done} rendered, {failed} unrenderable, {skipped} skipped"
        f", {up} unclaimed upload(s) updated"
    )
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
