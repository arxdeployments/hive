"""Calls (LiveKit token minting, history, isolation) and media auth."""

import contextlib
import io

import jwt
from httpx import ASGITransport, AsyncClient

from app.core.config import get_settings
from app.db.models import Call, CallParticipant, CallStatus, CallType
from app.db.session import SessionLocal
from app.main import app
from app.services.calls import room_name_for
from app.utils import now_utc
from tests.conftest import CSRF, login


def _png_bytes() -> bytes:
    import struct
    import zlib

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes([16, 185, 129] * 8) for _ in range(8))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


@contextlib.asynccontextmanager
async def _client_for(email):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, email)
        yield c


async def _seed_connected_call(users) -> str:
    """Create a connected 1:1 call between alice and bob directly in the DB."""

    async with SessionLocal() as db:
        call = Call(
            org_id=users["org_a"].id,
            initiated_by=users["alice"].id,
            type=CallType.video,
            status=CallStatus.connected,
            room_name="",
            answered_at=now_utc(),
        )
        db.add(call)
        await db.flush()
        call.room_name = room_name_for(call.id)
        db.add_all(
            [
                CallParticipant(call_id=call.id, user_id=users["alice"].id),
                CallParticipant(call_id=call.id, user_id=users["bob"].id),
            ]
        )
        await db.commit()
        return str(call.id)


async def test_call_token_is_scoped_and_only_for_participants(client, two_orgs_with_users):
    users = two_orgs_with_users
    call_id = await _seed_connected_call(users)

    async with _client_for("alice@a.com") as alice:
        resp = await alice.post(f"/api/calls/{call_id}/token")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["room"] == f"call_{call_id}"
        settings = get_settings()
        claims = jwt.decode(body["token"], settings.livekit_api_secret, algorithms=["HS256"])
        # token grants join to exactly this room
        assert claims["video"]["room"] == f"call_{call_id}"
        assert claims["video"]["roomJoin"] is True
        assert claims["sub"] == str(users["alice"].id)

    # a foreign-org user cannot mint a token for someone else's call
    async with _client_for("carol@b.com") as carol:
        resp = await carol.post(f"/api/calls/{call_id}/token")
        assert resp.status_code == 404


async def test_call_history_only_shows_own_calls(client, two_orgs_with_users):
    users = two_orgs_with_users
    await _seed_connected_call(users)

    async with _client_for("alice@a.com") as alice:
        resp = await alice.get("/api/calls/history")
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    async with _client_for("carol@b.com") as carol:
        resp = await carol.get("/api/calls/history")
        assert resp.json()["total"] == 0


async def test_media_upload_and_authenticated_serving(client, two_orgs_with_users):
    users = two_orgs_with_users
    async with _client_for("alice@a.com") as alice:
        # upload an image
        files = {"file": ("pic.png", io.BytesIO(_png_bytes()), "image/png")}
        resp = await alice.post("/api/upload", files=files)
        assert resp.status_code == 200, resp.text
        up = resp.json()
        assert up["file_type"] == "image" and up["file_url"].startswith("/api/media/up/")

        # create a direct conversation + send the image
        conv = (
            await alice.post("/api/conversations/direct", json={"participant_id": str(users["bob"].id)})
        ).json()["_id"]
        msg = await alice.post(
            f"/api/conversations/{conv}/messages",
            json={"content": "", "type": "image", "media_url": up["file_url"], "temp_id": "m1"},
        )
        assert msg.status_code == 200, msg.text
        media_url = msg.json()["media_url"]
        assert media_url.startswith("/api/media/")

        # owner/participant gets a redirect to a presigned URL (not the bytes inline)
        resp = await alice.get(media_url, follow_redirects=False)
        assert resp.status_code == 307
        assert "X-Amz-Signature" in resp.headers["location"]

    # a foreign-org user cannot fetch the attachment
    async with _client_for("carol@b.com") as carol:
        resp = await carol.get(media_url, follow_redirects=False)
        assert resp.status_code == 404

    # anonymous fetch is rejected
    anon = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    anon.headers.update(CSRF)
    async with anon:
        resp = await anon.get(media_url, follow_redirects=False)
        assert resp.status_code == 401


async def test_upload_rejects_unsupported_type(client, two_orgs_with_users):
    async with _client_for("alice@a.com") as alice:
        files = {"file": ("evil.exe", io.BytesIO(b"MZ..."), "application/octet-stream")}
        resp = await alice.post("/api/upload", files=files)
        assert resp.status_code == 400
