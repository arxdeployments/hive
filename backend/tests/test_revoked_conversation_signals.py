"""Deactivating a conversation must stop the signals as well as the content.

`is_active = False` is the only lever a superadmin has to cut a tenant off from a
cross-org group: archiving or deleting one leaves every ConversationParticipant row
in place (cross_org.py delete_group sets deleted_at and is_active and nothing
else), so the flag IS the revocation. Every content path enforces it —
_require_send_access, _member_attachment, the message lists, search, the media
drawer, the contact list.

Three signal paths did not, and they run on membership alone:
  * typing indicators (hub._is_participant),
  * presence fan-out (hub._conversation_partner_ids),
  * read receipts (messaging.mark_read).

So a tenant cut off from a group kept broadcasting into it and kept receiving its
members' online status, indefinitely, while their messages and media 404'd.
"""

import uuid

from httpx import ASGITransport, AsyncClient

from app.db.models import Conversation, ConversationParticipant, ConversationType, User
from app.db.session import SessionLocal
from app.main import app
from app.realtime import hub
from app.services import messaging
from tests.conftest import CSRF, login, make_org, make_user


async def _deactivate_conversation(conv_id: uuid.UUID) -> None:
    """What archiving or deleting a group does: the flag, and nothing else."""
    async with SessionLocal() as db:
        conv = await db.get(Conversation, conv_id)
        conv.is_active = False
        await db.commit()


async def _direct_conversation(email_a: str, other: User) -> uuid.UUID:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        c.headers.update(CSRF)
        await login(c, email_a)
        resp = await c.post("/api/conversations/direct", json={"participant_id": str(other.id)})
        assert resp.status_code == 200, resp.text
        return uuid.UUID(resp.json()["_id"])


def _capture(monkeypatch) -> list:
    sent: list = []

    async def _publish(user_ids, event):
        sent.append(([str(u) for u in user_ids], event))

    monkeypatch.setattr(hub, "publish_to_users", _publish)
    return sent


async def test_typing_is_not_broadcast_into_a_deactivated_conversation(client, monkeypatch):
    org = await make_org("Signals Typing Co")
    a = await make_user("a@sigtype.com", org_id=org.id)
    b = await make_user("b@sigtype.com", org_id=org.id)
    conv_id = await _direct_conversation("a@sigtype.com", b)

    sent = _capture(monkeypatch)
    await hub._handle_inbound(a, {"type": "typing_start", "conversation_id": str(conv_id)})
    assert [e["type"] for _, e in sent] == ["typing"], "control: it broadcasts while active"

    await _deactivate_conversation(conv_id)
    sent.clear()
    await hub._handle_inbound(a, {"type": "typing_start", "conversation_id": str(conv_id)})
    assert sent == [], "a revoked conversation must not carry typing indicators"


async def test_presence_does_not_reach_partners_of_a_deactivated_conversation(client, monkeypatch):
    org = await make_org("Signals Presence Co")
    a = await make_user("a@sigpres.com", org_id=org.id)
    b = await make_user("b@sigpres.com", org_id=org.id)
    conv_id = await _direct_conversation("a@sigpres.com", b)

    sent = _capture(monkeypatch)
    await hub._broadcast_presence(a, "online")
    assert [str(b.id)] in [uids for uids, _ in sent], "control: b hears a while active"

    await _deactivate_conversation(conv_id)
    sent.clear()
    await hub._broadcast_presence(a, "online")
    recipients = [uid for uids, _ in sent for uid in uids]
    assert str(b.id) not in recipients, (
        "online status kept reaching someone whose only shared conversation was revoked"
    )


async def test_read_receipts_are_refused_on_a_deactivated_conversation(client):
    org = await make_org("Signals Read Co")
    a = await make_user("a@sigread.com", org_id=org.id)
    b = await make_user("b@sigread.com", org_id=org.id)
    conv_id = await _direct_conversation("a@sigread.com", b)
    await _deactivate_conversation(conv_id)

    async with SessionLocal() as db:
        reader = await db.get(User, a.id)
        try:
            await messaging.mark_read(db, conversation_id=conv_id, reader=reader)
        except messaging.SendError as exc:
            assert exc.status_code == 404
        else:
            raise AssertionError("a read receipt was accepted on a revoked conversation")


# ---------------------------------------------------------------------------
# The rule itself, once. Three call sites apply it; this is what they apply.
# ---------------------------------------------------------------------------


def _conv(*, kind=ConversationType.group, org_id=None, is_active=True) -> Conversation:
    return Conversation(type=kind, org_id=org_id, is_active=is_active)


def _user(*, org_id=None, is_active=True) -> User:
    return User(email="x@y.com", display_name="X", password_hash="x", org_id=org_id, is_active=is_active)


def test_the_shared_gate_allows_an_ordinary_member():
    org = uuid.uuid4()
    messaging.assert_conversation_access(_conv(org_id=org), _user(org_id=org), is_member=True)


def test_the_shared_gate_refuses_a_deactivated_account_before_anything_else():
    """403 and this wording, because a revoked account is not a missing conversation."""
    org = uuid.uuid4()
    try:
        messaging.assert_conversation_access(
            _conv(org_id=org), _user(org_id=org, is_active=False), is_member=True
        )
    except messaging.SendError as exc:
        assert exc.status_code == 403
        assert "no longer active" in exc.detail
    else:
        raise AssertionError("a deactivated account passed the gate")


def test_the_shared_gate_refuses_a_deactivated_conversation():
    org = uuid.uuid4()
    try:
        messaging.assert_conversation_access(
            _conv(org_id=org, is_active=False), _user(org_id=org), is_member=True
        )
    except messaging.SendError as exc:
        assert exc.status_code == 404, "revocation must be indistinguishable from absence"
    else:
        raise AssertionError("a revoked conversation passed the gate")


def test_the_shared_gate_refuses_a_non_member():
    org = uuid.uuid4()
    try:
        messaging.assert_conversation_access(_conv(org_id=org), _user(org_id=org), is_member=False)
    except messaging.SendError as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("a non-member passed the gate")


def test_the_shared_gate_refuses_a_member_filed_under_another_org():
    """Representable, and only this predicate excludes it.

    A participant row carries no org, so nothing in the schema stops one pointing
    at a conversation in a different tenant. CodeRabbit made the same point about
    users.dept_id in Batch 46: a plain FK with no org-consistency constraint means
    the mismatched row exists as far as the database is concerned.
    """
    try:
        messaging.assert_conversation_access(
            _conv(org_id=uuid.uuid4()), _user(org_id=uuid.uuid4()), is_member=True
        )
    except messaging.SendError as exc:
        assert exc.status_code == 403
        assert exc.detail == "Access denied"
    else:
        raise AssertionError("a cross-tenant member passed the gate")


def test_the_shared_gate_lets_a_cross_org_conversation_span_orgs():
    """The converse of the test above, and the reason the org rule is not simply
    `org_id == user.org_id`: a cross_org group is supposed to span tenants."""
    messaging.assert_conversation_access(
        _conv(kind=ConversationType.cross_org, org_id=uuid.uuid4()),
        _user(org_id=uuid.uuid4()),
        is_member=True,
    )


# ---------------------------------------------------------------------------
# The signal paths, through the gate
# ---------------------------------------------------------------------------


async def test_a_deactivated_account_cannot_broadcast_typing(client, monkeypatch):
    """The other half of the gate, on a conversation that is perfectly live.

    Without reloading the user row this would pass anyway: the User handed to
    _handle_inbound was loaded when the socket opened, so its is_active is as stale
    as the socket.
    """
    org = await make_org("Signals Deact Co")
    a = await make_user("a@sigdeact.com", org_id=org.id)
    b = await make_user("b@sigdeact.com", org_id=org.id)
    conv_id = await _direct_conversation("a@sigdeact.com", b)

    sent = _capture(monkeypatch)
    async with SessionLocal() as db:
        row = await db.get(User, a.id)
        row.is_active = False
        await db.commit()

    # `a` is deliberately the stale object the socket would still be holding.
    await hub._handle_inbound(a, {"type": "typing_start", "conversation_id": str(conv_id)})
    assert sent == [], "a deactivated account broadcast typing on a live conversation"


async def test_presence_still_reaches_partners_of_live_conversations(client, monkeypatch):
    """The filter must be per conversation, not all-or-nothing.

    Without this, dropping presence entirely once any shared conversation was
    revoked would satisfy the revocation test — and would silence a working chat.
    """
    org = await make_org("Signals Mixed Co")
    a = await make_user("a@sigmix.com", org_id=org.id)
    revoked_partner = await make_user("b@sigmix.com", org_id=org.id)
    live_partner = await make_user("c@sigmix.com", org_id=org.id)

    dead_conv = await _direct_conversation("a@sigmix.com", revoked_partner)
    await _direct_conversation("a@sigmix.com", live_partner)
    await _deactivate_conversation(dead_conv)

    sent = _capture(monkeypatch)
    await hub._broadcast_presence(a, "online")
    recipients = [uid for uids, _ in sent for uid in uids]
    assert str(live_partner.id) in recipients, "the live conversation's partner must still hear it"
    assert str(revoked_partner.id) not in recipients


async def test_read_receipts_still_work_on_a_live_conversation(client):
    """Negative control for the mark_read gate."""
    org = await make_org("Signals Read OK Co")
    a = await make_user("a@sigreadok.com", org_id=org.id)
    b = await make_user("b@sigreadok.com", org_id=org.id)
    conv_id = await _direct_conversation("a@sigreadok.com", b)

    async with SessionLocal() as db:
        reader = await db.get(User, a.id)
        await messaging.mark_read(db, conversation_id=conv_id, reader=reader)
        me = await db.get(ConversationParticipant, (conv_id, a.id))
        assert me.last_read_at is not None


# ---------------------------------------------------------------------------
# The audience, not just the actor: a participant row carries no org
# ---------------------------------------------------------------------------


async def _intrude(conv_id: uuid.UUID, user_id: uuid.UUID) -> None:
    """Persist a foreign-org membership row in an ordinary conversation.

    Nothing in the schema forbids it: conversation_participants has no org column
    and no constraint tying it to the conversation's tenant. This is the row the
    recipient predicate exists for, and it is the same shape of representable
    inconsistency CodeRabbit identified for users.dept_id in Batch 46.
    """
    async with SessionLocal() as db:
        db.add(ConversationParticipant(conversation_id=conv_id, user_id=user_id))
        await db.commit()


async def test_no_signal_reaches_a_foreign_org_participant_row(client, monkeypatch):
    """Typing, presence and read receipts must all exclude it.

    Gating who may ACT and not who may be TOLD would leave the tenant boundary
    open in the direction that actually discloses data.
    """
    org_a = await make_org("Tenant A Signals")
    org_b = await make_org("Tenant B Signals")
    a = await make_user("a@tenanta.com", org_id=org_a.id)
    b = await make_user("b@tenanta.com", org_id=org_a.id)
    outsider = await make_user("x@tenantb.com", org_id=org_b.id)

    conv_id = await _direct_conversation("a@tenanta.com", b)
    await _intrude(conv_id, outsider.id)

    sent = _capture(monkeypatch)
    await hub._handle_inbound(a, {"type": "typing_start", "conversation_id": str(conv_id)})
    typing_recipients = [uid for uids, _ in sent for uid in uids]
    assert str(b.id) in typing_recipients, "control: the legitimate member is still told"
    assert str(outsider.id) not in typing_recipients, "typing leaked across tenants"

    sent.clear()
    await hub._broadcast_presence(a, "online")
    presence_recipients = [uid for uids, _ in sent for uid in uids]
    assert str(b.id) in presence_recipients, "control: the legitimate member still hears presence"
    assert str(outsider.id) not in presence_recipients, "presence leaked across tenants"

    read_sent: list = []

    async def _capture_read(user_ids, event):
        read_sent.append(([str(u) for u in user_ids], event))

    monkeypatch.setattr(messaging, "publish_to_users", _capture_read)
    async with SessionLocal() as db:
        reader = await db.get(User, a.id)
        await messaging.mark_read(db, conversation_id=conv_id, reader=reader)
    read_recipients = [uid for uids, _ in read_sent for uid in uids]
    assert str(b.id) in read_recipients, "control: the legitimate member gets the receipt"
    assert str(outsider.id) not in read_recipients, "read receipts leaked across tenants"


async def test_a_foreign_org_participant_row_is_not_sent_the_message_body(client, monkeypatch):
    """The severe case, and the one that was reached by the same unfiltered query.

    `send_message` fanned out to every membership row, so the foreign-org row
    received `new_message` with the serialized body — not merely the fact that
    someone was typing.
    """
    org_a = await make_org("Tenant A Body")
    org_b = await make_org("Tenant B Body")
    a = await make_user("a@bodya.com", org_id=org_a.id)
    b = await make_user("b@bodya.com", org_id=org_a.id)
    outsider = await make_user("x@bodyb.com", org_id=org_b.id)

    conv_id = await _direct_conversation("a@bodya.com", b)
    await _intrude(conv_id, outsider.id)

    sent: list = []

    async def _capture_send(user_ids, event):
        sent.append(([str(u) for u in user_ids], event))

    monkeypatch.setattr(messaging, "publish_to_users", _capture_send)
    async with SessionLocal() as db:
        sender = await db.get(User, a.id)
        await messaging.send_message(db, conversation_id=conv_id, sender=sender, content="tenant A internal")

    delivered = [uid for uids, event in sent if event.get("type") == "new_message" for uid in uids]
    assert str(b.id) in delivered, "control: the legitimate member receives the message"
    assert str(outsider.id) not in delivered, "the message body was delivered across tenants"


async def test_a_cross_org_group_still_reaches_every_tenant(client, monkeypatch):
    """The converse, and the reason the predicate is not a plain org equality.

    A cross_org conversation is supposed to span tenants, so the same rule that
    excludes the row above must let these through — otherwise the fix would
    silently break the feature it is protecting.
    """
    org_a = await make_org("Cross A")
    org_b = await make_org("Cross B")
    a = await make_user("a@crossa.com", org_id=org_a.id)
    partner = await make_user("p@crossb.com", org_id=org_b.id)

    async with SessionLocal() as db:
        conv = Conversation(type=ConversationType.cross_org, org_id=org_a.id, is_active=True)
        db.add(conv)
        await db.flush()
        db.add_all(
            [
                ConversationParticipant(conversation_id=conv.id, user_id=a.id),
                ConversationParticipant(conversation_id=conv.id, user_id=partner.id),
            ]
        )
        await db.commit()
        conv_id = conv.id

    async with SessionLocal() as db:
        recipients = await messaging.conversation_recipients(db, conv_id, exclude=a.id)
    assert [str(u) for u in recipients] == [str(partner.id)], (
        "a cross-org group must still deliver to the other tenant"
    )

    sent = _capture(monkeypatch)
    await hub._handle_inbound(a, {"type": "typing_start", "conversation_id": str(conv_id)})
    assert str(partner.id) in [uid for uids, _ in sent for uid in uids]
