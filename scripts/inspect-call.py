#!/usr/bin/env python3
"""Who is actually in the SFU room right now, and is anyone in it twice?

Run this DURING a call. It is the only way to tell the two causes of "echo" apart,
and they need opposite fixes:

  * **A user appears twice.** Two clients of one person are publishing two
    microphones and subscribing two speakers. The other side hears them once per
    leg, each on its own jitter path — which is heard as the same voice repeating
    with a delay, not as a duplicate participant. Fixed server-side by
    `services/calls.evict_other_devices`; if it still happens, that eviction is
    failing and this will say so outright.

  * **Everyone appears once.** Then it is acoustics, not code: two devices in the
    same physical room with speakers on, or two clients on one machine sharing a
    microphone. Each device's echo canceller only knows about its own output, never
    the other's, so nothing in software can remove it. Use headphones on one side.

Usage:
    cd backend && source /tmp/rxhive_lan_env.sh && ../scripts/inspect-call.py
    LIVEKIT_HTTP=http://localhost:7880 ../scripts/inspect-call.py
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from livekit import api as lk  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.services.calls import user_id_from_identity  # noqa: E402

TRACK_KIND = {0: "audio", 1: "video", 2: "data"}


async def main() -> int:
    settings = get_settings()
    url = os.environ.get("LIVEKIT_HTTP") or settings.livekit_probe_url
    if not url:
        print("No server-reachable LiveKit URL. Set LIVEKIT_HTTP or RXHIVE_LIVEKIT_HEALTH_URL.")
        return 2

    client = lk.LiveKitAPI(url, settings.livekit_api_key, settings.livekit_api_secret)
    problems = 0
    try:
        rooms = (await client.room.list_rooms(lk.ListRoomsRequest())).rooms
        if not rooms:
            print(f"No active rooms on {url}. Start a call and run this again.")
            return 0

        for room in rooms:
            print(f"\nroom {room.name}  ({room.num_participants} participants)")
            parts = (
                await client.room.list_participants(lk.ListParticipantsRequest(room=room.name))
            ).participants

            by_user: dict[str, list[str]] = {}
            for p in parts:
                user = user_id_from_identity(p.identity)
                by_user.setdefault(user, []).append(p.identity)
                tracks = ", ".join(
                    f"{TRACK_KIND.get(t.type, t.type)}{' [muted]' if t.muted else ''}"
                    for t in p.tracks
                ) or "no tracks published"
                print(f"  {p.identity}")
                print(f"      name={p.name or '-'}  user={user}")
                print(f"      tracks: {tracks}")

            for user, identities in by_user.items():
                if len(identities) > 1:
                    problems += 1
                    print(
                        f"\n  *** {user} IS IN THIS ROOM {len(identities)} TIMES: {identities}\n"
                        f"      Everyone else hears them {len(identities)}x, offset by the\n"
                        f"      difference between the legs. evict_other_devices should have\n"
                        f"      prevented this — check the API log for call.evicting_stale_leg."
                    )

            speakers = [p.identity for p in parts if any(t.type == 0 and not t.muted for t in p.tracks)]
            if not problems and len(speakers) > 1:
                print(
                    "\n  Every user appears once, so this is not duplicated legs.\n"
                    "  If you can hear echo, the two devices are hearing each other\n"
                    "  acoustically — same room with speakers on, or two clients sharing\n"
                    "  one machine's microphone. Put headphones on one side."
                )
    finally:
        await client.aclose()
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
