"""Who may talk to whom, and what they may send.

Two independent questions, deliberately kept apart:

  REACHABILITY  — can these two people hold a conversation at all?
                  DENY BY DEFAULT. See ChatAccessRule.
  SEND POLICY   — what kinds of thing may this person send, to anyone?
                  ALLOW BY DEFAULT. See SendPolicy.

Everything here is advisory to the caller and authoritative nowhere else: the
web app, the PWA and the iOS client all consume the same raw endpoints, so a
client-side check is a convenience and never a control. Every call site listed
in the module docstrings below is server-side.

WHY THE CHOKE POINTS ARE WHERE THEY ARE

Three separate code paths manufacture a direct conversation — POST
/conversations/direct, forward-to-contacts, and call initiation — and all three
funnel through services.conversations.get_or_create_direct. Guarding the
endpoint alone would leave two ways to reach someone you may not reach, so the
reachability check lives in that one function.

Send policy is keyed off the UPLOAD, never off the client's declared message
type: messaging.send_message coerces unknown types to "text" and attaches
uploads regardless of type, so `{type: "text", media_url: "...pdf"}` produces a
real PDF attachment on a row the database records as text. The declared type is
not evidence of anything.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AccessPartyType, ChatAccessRule, SendPolicy, User, UserRole
from app.services import storage

Party = tuple[AccessPartyType, uuid.UUID]


def canonical_pair(one: Party, two: Party) -> tuple[Party, Party]:
    """Order the two sides deterministically.

    A rule is symmetric, so (A, B) and (B, A) must be the same row or the unique
    constraint is decorative and a UI can create two rules that disagree with
    each other. Sorting on (type value, uuid string) is arbitrary but stable,
    which is all that is required.
    """
    ka = (one[0].value, str(one[1]))
    kb = (two[0].value, str(two[1]))
    return (one, two) if ka <= kb else (two, one)


def _specificity(a_type: AccessPartyType, b_type: AccessPartyType) -> int:
    if a_type == AccessPartyType.user and b_type == AccessPartyType.user:
        return 3
    if a_type == AccessPartyType.department and b_type == AccessPartyType.department:
        return 1
    return 2


def _resolve(candidates: Iterable[tuple[int, bool]]) -> bool | None:
    """Apply most-specific-wins, with deny winning any tie.

    Returns None when nothing matched, which the caller turns into the
    deny-by-default answer. Distinguishing "no rule" from "a rule that says no"
    matters for the admin UI, which needs to explain WHY a pair is blocked.
    """
    best: int | None = None
    verdict = True
    for level, allow in candidates:
        if best is None or level > best:
            best, verdict = level, allow
        elif level == best and not allow:
            verdict = False  # tie -> deny wins
    return None if best is None else verdict


async def can_converse(db: AsyncSession, a: User, b: User) -> bool:
    """May these two hold a direct conversation?

    Superadmins are exempt rather than denied: they have org_id NULL and no
    department, so no rule can ever match them and deny-by-default would block
    machinery they legitimately drive (cross-org group administration). They
    have no chat surface of their own, so this is not a way in.
    """
    if a.id == b.id:
        return True
    if a.role == UserRole.superadmin or b.role == UserRole.superadmin:
        return True
    # Tenant isolation is enforced independently and more strictly elsewhere;
    # repeating it here keeps a cross-org pair from accidentally matching a rule.
    if a.org_id is None or b.org_id is None or a.org_id != b.org_id:
        return False

    keys: list[tuple[Party, Party]] = [
        canonical_pair((AccessPartyType.user, a.id), (AccessPartyType.user, b.id))
    ]
    if b.dept_id:
        keys.append(canonical_pair((AccessPartyType.user, a.id), (AccessPartyType.department, b.dept_id)))
    if a.dept_id:
        keys.append(canonical_pair((AccessPartyType.user, b.id), (AccessPartyType.department, a.dept_id)))
    if a.dept_id and b.dept_id:
        keys.append(
            canonical_pair(
                (AccessPartyType.department, a.dept_id), (AccessPartyType.department, b.dept_id)
            )
        )

    rows = (
        (
            await db.execute(
                select(ChatAccessRule).where(
                    ChatAccessRule.org_id == a.org_id,
                    or_(
                        *[
                            and_(
                                ChatAccessRule.a_type == one[0],
                                ChatAccessRule.a_id == one[1],
                                ChatAccessRule.b_type == two[0],
                                ChatAccessRule.b_id == two[1],
                            )
                            for one, two in keys
                        ]
                    ),
                )
            )
        )
        .scalars()
        .all()
    )
    verdict = _resolve((_specificity(r.a_type, r.b_type), r.allow) for r in rows)
    return bool(verdict)


async def explain(db: AsyncSession, a: User, b: User) -> dict:
    """Why this pair resolves the way it does.

    Exists for the admin UI. With most-specific-wins and a deny-wins tie-break,
    a rule an administrator just wrote can be correctly ignored by a more
    specific one — and a UI that only shows a verdict makes that look like a
    bug. This returns every rule that matched, its level, and which one decided,
    so the screen can say "allowed by a user rule, overriding a department deny"
    rather than just "allowed".
    """
    matched: list[dict] = []
    verdict = await can_converse(db, a, b)

    if a.org_id and a.org_id == b.org_id and a.id != b.id:
        keys: list[tuple[Party, Party]] = [
            canonical_pair((AccessPartyType.user, a.id), (AccessPartyType.user, b.id))
        ]
        if b.dept_id:
            keys.append(canonical_pair((AccessPartyType.user, a.id), (AccessPartyType.department, b.dept_id)))
        if a.dept_id:
            keys.append(canonical_pair((AccessPartyType.user, b.id), (AccessPartyType.department, a.dept_id)))
        if a.dept_id and b.dept_id:
            keys.append(
                canonical_pair(
                    (AccessPartyType.department, a.dept_id), (AccessPartyType.department, b.dept_id)
                )
            )
        rows = (
            (
                await db.execute(
                    select(ChatAccessRule).where(
                        ChatAccessRule.org_id == a.org_id,
                        or_(
                            *[
                                and_(
                                    ChatAccessRule.a_type == one[0],
                                    ChatAccessRule.a_id == one[1],
                                    ChatAccessRule.b_type == two[0],
                                    ChatAccessRule.b_id == two[1],
                                )
                                for one, two in keys
                            ]
                        ),
                    )
                )
            )
            .scalars()
            .all()
        )
        best = max((_specificity(r.a_type, r.b_type) for r in rows), default=None)
        for r in rows:
            level = _specificity(r.a_type, r.b_type)
            matched.append(
                {
                    "id": str(r.id),
                    "level": level,
                    "allow": r.allow,
                    "a": {"type": r.a_type.value, "id": str(r.a_id)},
                    "b": {"type": r.b_type.value, "id": str(r.b_id)},
                    # More than one rule can be decisive at the same level when
                    # they tie — the UI should show both, not pick one.
                    "decisive": level == best,
                }
            )
    return {
        "allowed": verdict,
        "reason": "no rule matched (deny by default)" if not matched else None,
        "matched": sorted(matched, key=lambda m: -m["level"]),
    }


async def reachable_user_ids(db: AsyncSession, me: User) -> set[uuid.UUID]:
    """Every user in my organization I am allowed to converse with.

    A set rather than a per-candidate can_converse() call because the contact
    list has no pagination and the conversation list is already a multi-join —
    evaluating a pair rule row by row would N+1 the two hottest read paths in
    the app. This issues exactly two queries regardless of org size.
    """
    if me.role == UserRole.superadmin:
        return set()  # superadmins have no org and no chat surface
    if me.org_id is None:
        return set()

    others = (
        await db.execute(
            select(User.id, User.dept_id).where(User.id != me.id, User.org_id == me.org_id)
        )
    ).all()

    mine: list[Party] = [(AccessPartyType.user, me.id)]
    if me.dept_id:
        mine.append((AccessPartyType.department, me.dept_id))

    side_a = [and_(ChatAccessRule.a_type == t, ChatAccessRule.a_id == i) for t, i in mine]
    side_b = [and_(ChatAccessRule.b_type == t, ChatAccessRule.b_id == i) for t, i in mine]
    rules = (
        (
            await db.execute(
                select(ChatAccessRule).where(
                    ChatAccessRule.org_id == me.org_id, or_(*side_a, *side_b)
                )
            )
        )
        .scalars()
        .all()
    )

    # Index the rules by what they say about "the other side", so each candidate
    # is a few dict lookups rather than a scan.
    vs_user: dict[uuid.UUID, bool] = {}  # me(user) <-> them(user)
    vs_their_dept: dict[uuid.UUID, bool] = {}  # me(user) <-> their department
    their_user_vs_my_dept: dict[uuid.UUID, bool] = {}  # them(user) <-> my department
    dept_vs_dept: dict[uuid.UUID, bool] = {}  # my department <-> their department

    # Classify each rule by the TYPES of its two ends, not by "which end is not
    # me". That earlier shape skipped any rule whose BOTH ends were mine, and two
    # such rules are entirely ordinary:
    #
    #   department Ward <-> department Ward   — my own department, which is
    #       exactly what the migration writes via LEAST(D,D)/GREATEST(D,D) for
    #       two colleagues who already share a conversation
    #   user me <-> department Ward           — "this person may reach everyone
    #       in Ward", where I am myself in Ward
    #
    # Dropping those made this function disagree with can_converse for the single
    # most common relationship in the product: a colleague in your own
    # department. Messaging them worked, but they were absent from the contact
    # list and from search.
    #
    # The query above only returns rules with at least one end that is mine, so
    # in the mixed case the "user" end is either me or the candidate, with no
    # ambiguity.
    me_user: Party = (AccessPartyType.user, me.id)

    for rule in rules:
        ends: list[Party] = [(rule.a_type, rule.a_id), (rule.b_type, rule.b_id)]
        a_end, b_end = ends

        if a_end[0] == AccessPartyType.user and b_end[0] == AccessPartyType.user:
            # user <-> user. One end is me; the other names the candidate.
            far = a_end if b_end == me_user else b_end
            vs_user[far[1]] = rule.allow
        elif a_end[0] == AccessPartyType.department and b_end[0] == AccessPartyType.department:
            # department <-> department. My department is one end — and when the
            # rule is self-paired, both — so the candidate's department is the
            # other end, which for a self-pair resolves to my own. That is right:
            # such a rule is precisely "people in Ward may talk to each other".
            far_dept = b_end[1] if a_end[1] == me.dept_id else a_end[1]
            dept_vs_dept[far_dept] = rule.allow
        else:
            user_end = a_end if a_end[0] == AccessPartyType.user else b_end
            dept_end = b_end if a_end[0] == AccessPartyType.user else a_end
            if user_end == me_user:
                # me <-> a department, possibly my own.
                vs_their_dept[dept_end[1]] = rule.allow
            else:
                # a specific user <-> my department.
                their_user_vs_my_dept[user_end[1]] = rule.allow

    allowed: set[uuid.UUID] = set()
    for other_id, other_dept in others:
        candidates: list[tuple[int, bool]] = []
        if other_id in vs_user:
            candidates.append((3, vs_user[other_id]))
        if other_dept is not None and other_dept in vs_their_dept:
            candidates.append((2, vs_their_dept[other_dept]))
        if me.dept_id is not None and other_id in their_user_vs_my_dept:
            candidates.append((2, their_user_vs_my_dept[other_id]))
        if me.dept_id is not None and other_dept is not None and other_dept in dept_vs_dept:
            candidates.append((1, dept_vs_dept[other_dept]))
        if _resolve(candidates):
            allowed.add(other_id)
    return allowed


@dataclass(frozen=True)
class ResolvedSendPolicy:
    """The send rules in force for one person, already collapsed."""

    text: bool = True
    image: bool = True
    video: bool = True
    audio: bool = True
    document: bool = True
    #: None means "every document type the server accepts"; a set narrows it.
    doc_extensions: frozenset[str] | None = None
    #: 'user' | 'department' | 'default' — surfaced so the admin UI can say
    #: whether a restriction is personal or inherited.
    source: str = "default"

    def allows_category(self, category: str | None) -> bool:
        return {
            "text": self.text,
            "image": self.image,
            "video": self.video,
            "audio": self.audio,
            "document": self.document,
        }.get(category or "", False)

    def allows_extension(self, ext: str) -> bool:
        ext = (ext or "").lower()
        category = storage.classify(ext)
        if category is None:
            return False  # not a type the server accepts at all
        if not self.allows_category(category):
            return False
        if category == "document" and self.doc_extensions is not None:
            return ext in self.doc_extensions
        return True

    def allowed_extensions(self) -> set[str]:
        """Everything this person may upload, for driving the client's pickers."""
        out: set[str] = set()
        if self.image:
            out |= storage.IMAGE_EXTS
        if self.video:
            out |= storage.VIDEO_EXTS
        if self.audio:
            out |= storage.AUDIO_EXTS
        if self.document:
            out |= storage.DOC_EXTS if self.doc_extensions is None else set(self.doc_extensions)
        return out

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "image": self.image,
            "video": self.video,
            "audio": self.audio,
            "document": self.document,
            "doc_extensions": sorted(self.doc_extensions) if self.doc_extensions is not None else None,
            "allowed_extensions": sorted(self.allowed_extensions()),
            "source": self.source,
        }


PERMISSIVE = ResolvedSendPolicy()


def _from_row(row: SendPolicy, source: str) -> ResolvedSendPolicy:
    raw = row.doc_extensions
    exts: frozenset[str] | None = None
    if isinstance(raw, list):
        # Intersect with what the server accepts anyway: a whitelist may only
        # ever NARROW. Without this an admin typing ".exe" would appear to
        # enable it, and the upload endpoint would still (correctly) refuse.
        exts = frozenset(e.lower() for e in raw if isinstance(e, str)) & storage.DOC_EXTS
    return ResolvedSendPolicy(
        text=row.allow_text,
        image=row.allow_image,
        video=row.allow_video,
        audio=row.allow_audio,
        document=row.allow_document,
        doc_extensions=exts,
        source=source,
    )


async def resolve_send_policy(db: AsyncSession, user: User) -> ResolvedSendPolicy:
    """The policy in force for this sender. Absent any row, everything is allowed.

    A user-scoped row REPLACES the department's rather than merging with it —
    see SendPolicy's docstring for why field-wise merging is the wrong shape.
    """
    if user.role == UserRole.superadmin:
        return PERMISSIVE

    scopes: list[Party] = [(AccessPartyType.user, user.id)]
    if user.dept_id:
        scopes.append((AccessPartyType.department, user.dept_id))

    rows = (
        (
            await db.execute(
                select(SendPolicy).where(
                    or_(
                        *[
                            and_(SendPolicy.scope_type == t, SendPolicy.scope_id == i)
                            for t, i in scopes
                        ]
                    )
                )
            )
        )
        .scalars()
        .all()
    )
    by_scope = {(r.scope_type, r.scope_id): r for r in rows}

    personal = by_scope.get((AccessPartyType.user, user.id))
    if personal is not None:
        return _from_row(personal, "user")
    if user.dept_id:
        departmental = by_scope.get((AccessPartyType.department, user.dept_id))
        if departmental is not None:
            return _from_row(departmental, "department")
    return PERMISSIVE
