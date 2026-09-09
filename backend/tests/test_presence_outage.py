"""Presence during a Redis outage, against the promise the module already makes.

services/presence.py states the rule in get_statuses' own docstring — "an outage
must cost a green dot, not the whole request" — and keeps it in five places:
_index_add, _index_remove, _count, is_online and get_statuses all run their Redis
work inside degrade_on_outage.

Three functions did not, and two of those are reached on every connection:

  * refresh() is the ping branch of the websocket loop (realtime/hub.py). It sits
    OUTSIDE the try/except that wraps _handle_inbound, and the enclosing try
    catches only WebSocketDisconnect — so a RedisError there leaves the endpoint
    entirely. A blip drops every connected socket on its next ping, within the
    60s heartbeat, all at once.
  * mark_offline() runs in that loop's `finally`. Raising from a finally masks
    whatever actually ended the connection and skips the rest of the teardown —
    including handle_user_link_down, which is the grace window that keeps a call
    alive across a reconnect. hub.py's own comment lists that skip as one of the
    consequences it moved the `try` earlier to prevent.
  * mark_online() raises into a guarded region and is torn down correctly, so it
    is left alone; see the note on it below.
"""

import uuid

import pytest

from app.services import presence
from tests.conftest import make_user

_REFUSED = "Error 61 connecting to localhost:6379. Connection refused."


class _DeadPipeline:
    """Buffers like the real one and dies on execute, as a broken client does."""

    def __getattr__(self, _name):
        def _queue(*_args, **_kwargs):
            return self

        return _queue

    async def execute(self, *_args, **_kwargs):
        raise ConnectionError(_REFUSED)


class _DeadRedis:
    def pipeline(self, *_args, **_kwargs):
        return _DeadPipeline()

    def __getattr__(self, _name):
        async def _raise(*_args, **_kwargs):
            raise ConnectionError(_REFUSED)

        return _raise


@pytest.fixture
def dead_presence_redis(monkeypatch):
    """Break Redis for presence only, so each function's own guard is what shows."""
    monkeypatch.setattr(presence, "get_redis", lambda: _DeadRedis())


async def test_refresh_degrades_instead_of_dropping_the_socket(client, dead_presence_redis):
    """The ping path. This raising is a disconnect for every user at once.

    hub.py calls this in the `ping` branch and then `continue`s, outside the
    try/except that guards _handle_inbound — and the enclosing try catches only
    WebSocketDisconnect.
    """
    user = await make_user("pres-refresh@x.com")
    await presence.refresh(user.id, org_id=user.org_id)


async def test_mark_offline_degrades_instead_of_raising_from_finally(client, dead_presence_redis):
    """Raising here masks what actually ended the connection.

    It also skips the teardown after it, which includes the call grace window —
    the exact consequence hub.py's comment says moving the `try` earlier fixed.
    """
    user = await make_user("pres-offline@x.com")
    went_offline = await presence.mark_offline(user.id, "conn-1", org_id=user.org_id)
    assert went_offline is False, (
        "with presence unknown, the offline edge must not fire: broadcasting it "
        "would grey out a user who may still hold a socket on another worker"
    )


async def test_mark_online_degrades_and_claims_no_edge(client, dead_presence_redis):
    """Guarded by the caller, but it must not claim an edge it cannot know about.

    hub.py opens its try before this call precisely so a raise here is torn down
    cleanly, so this is the least urgent of the three. It still must not return
    True on an outage: the caller treats True as "just came online" and publishes
    a presence event from it.
    """
    user = await make_user("pres-online@x.com")
    came_online = await presence.mark_online(user.id, "conn-1", org_id=user.org_id)
    assert came_online is False


async def test_the_read_paths_already_degraded(client, dead_presence_redis):
    """Control. These five were already guarded, and the fix must not change them."""
    user = await make_user("pres-read@x.com")
    assert await presence.is_online(user.id) is False
    assert await presence.get_statuses([user.id]) == {str(user.id): "offline"}
    assert await presence.count_online() == 0
    assert await presence.count_online_in_org(uuid.uuid4()) == 0
