"""Small shared helpers: wire-format serialization, sanitization, slugs."""

import datetime as dt
import re
import secrets
import string
import uuid


def _opens_tag(text: str, lt: int) -> bool:
    """Whether the `<` at `lt` opens an HTML tag.

    A browser's tokenizer treats `<` as markup only before an ASCII letter, `/`
    and an ASCII letter, or `!`/`?`. Everything else — `< 50`, `<=`, `<3`,
    `<120` — is text, which is the whole point: `<` and `>` are ordinary
    characters in clinical chat and must not be read as markup.
    """
    nxt = text[lt + 1 : lt + 2]
    if nxt in ("!", "?"):
        return True
    if nxt == "/":
        nxt = text[lt + 2 : lt + 3]
    return nxt.isascii() and nxt.isalpha()


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
    """Strip HTML tags from user text (message content, names).

    Defence in depth, not an HTML sanitizer: nothing in the product renders this
    text as HTML — the web client has no `dangerouslySetInnerHTML` and iOS draws
    native labels — so the job is to keep markup out of stored text without
    damaging text that merely contains `<` or `>`.

    This was `re.sub(r"<[^>]+>", "", text)`, which is neither. It deleted the
    span between any `<` and any later `>`, so "hold if HR < 50 and SBP > 90"
    was stored as "hold if HR  90" and "x <= 5 and y >= 3" as "x = 3" — the
    second states a different threshold rather than losing one, and the sender
    was never told. It was also quadratic: `[^>]` let every `<` in a run rescan
    to end-of-input, and 200k of them in one body cost 12.4s of CPU. This
    function is synchronous inside async handlers and `content` has no length
    cap, so that was the event loop, stalled by any authenticated caller.

    Hand-rolled rather than a regex because no regex is all three of linear,
    precise, and non-destructive here. `[^>]*` for the tag body is the accurate
    match — a quoted attribute and a `<!...>` bogus comment may both contain
    `<` — but trying it at every `<` is what makes it quadratic. Narrowing the
    body to `[^<>]*` is linear and silently stops matching those tags. Scanning
    once, and only looking for `>` after a `<` that actually opens a tag, is
    linear without giving anything up: 200k `<` now costs 0.008s.
    """
    if not text:
        return ""
    out: list[str] = []
    kept = 0  # start of the run not yet copied to `out`
    scan = 0
    length = len(text)
    while scan < length:
        lt = text.find("<", scan)
        if lt < 0:
            break
        if not _opens_tag(text, lt):
            # Text, not markup. Costs O(1), which is what keeps this linear:
            # the old pattern read to end-of-input before reaching the same
            # conclusion, from every `<` in the string.
            scan = lt + 1
            continue
        gt = text.find(">", lt + 1)
        if gt < 0:
            break
        # Deleting [lt, gt] would leave any `<` immediately before it touching
        # the text after, which can spell a tag the input never held: "<<b>b>"
        # would leave "<b>". Take that run with the tag. The `/` of a "</" goes
        # with it only when a `<` precedes it, so "a/<b>" keeps its slash.
        cut = lt
        probe = cut - 1
        if probe >= kept and text[probe] == "/":
            probe -= 1
        if probe >= kept and text[probe] == "<":
            cut = probe
            while cut > kept and text[cut - 1] == "<":
                cut -= 1
        out.append(text[kept:cut])
        kept = scan = gt + 1
    out.append(text[kept:])
    return "".join(out)


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
