"""sanitize_text runs over every message body and every name the product stores.

It was `<[^>]+>` — the span between any `<` and any later `>`, deleted. That is
not what a tag is, and `<` and `>` are ordinary characters in clinical chat, so
messages lost text nobody asked it to remove. Measured against the old pattern:

    "hold if HR < 50 and SBP > 90"   ->  "hold if HR  90"
    "x <= 5 and y >= 3"              ->  "x = 3"
    "BP <120>80"                     ->  "BP 80"
    "K+ <3.5 replace >4.0"           ->  "K+ 4.0"
    "give <5 units over >30 min"     ->  "give 30 min"

Silent in both directions: the sender is not told and the recipient receives the
mangled text as if it were typed. The second row is the one that matters most —
it does not lose a threshold, it states a different one.

The same pattern was also quadratic. `[^>]` let a failing start rescan to
end-of-input, so every `<` in a run paid O(n): 200k `<` characters in one message
body cost 12.4s. sanitize_text is synchronous and called straight from async
handlers, and `content` has no length cap, so that was the event loop stalled for
12 seconds by any authenticated caller. The same input now takes 0.008s.

Three properties are asserted here, because the fix trades against all three:
text with no tag in it must come back byte-identical, anything a browser would
tokenize as a tag must still be removed, and no output may contain a tag — the
last one because deleting a tag can splice a leftover `<` onto what followed it
and build one that was never in the input ("<<b>b>" leaves "<b>").
"""

import random
import re
import time

import pytest

from app.utils import sanitize_text

# What a browser would tokenize as a tag, written independently of the
# implementation so it cannot agree with a mistake in it.
_TAGLIKE = re.compile(r"<(?:/?[A-Za-z]|[!?])[^>]*>")


@pytest.mark.parametrize(
    "text",
    [
        "hold if HR < 50 and SBP > 90",
        "x <= 5 and y >= 3",
        "BP <120>80",
        "K+ <3.5 replace >4.0",
        "give <5 units over >30 min",
        "sat <90 on 2L, target >94",
        "temp <38.5>37 range",
        "INR <2 target >3",
        "a < b > c",
        "5 < 10",
        "see <3",
        "wean if FiO2 <40 and PEEP >5",
        # A tag name must start with an ASCII letter, so these are text too.
        # Greek letters are ordinary notation in a clinical thread.
        "\u03b1 <\u03b2> \u03b3 blockade",
        "titrate <\u00e9lan> per protocol",
        "\u0434\u043e\u0437\u0430 <\u0432\u044b\u0441\u043e\u043a\u0430\u044f> today",
    ],
)
def test_text_without_a_tag_is_returned_verbatim(text: str):
    """No `<` here opens a tag, so nothing in any of these is markup."""
    assert sanitize_text(text) == text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # Inner text is kept and the tags go — the contract the messaging and
        # cross-org-group tests already rely on.
        ("<script>alert(1)</script>hello", "alert(1)hello"),
        ("Launch <b>Team</b>", "Launch Team"),
        ("<b></b>", ""),
        ("<img src=x onerror=alert(1)>", ""),
        ("<svg/onload=alert(1)>", ""),
        ("<A HREF='x'>y</A>", "y"),
        ("<!-- comment -->", ""),
        ("<?php echo 1; ?>", ""),
        ("<div\nclass='x'>y</div>", "y"),
    ],
)
def test_markup_is_stripped(raw: str, expected: str):
    assert sanitize_text(raw) == expected


@pytest.mark.parametrize("raw", ["<<b>b>", "<<<b>b>b>", "a1</<?>a>b", "?=</<!1 >b>", "a<<b>c>"])
def test_a_removal_cannot_splice_a_new_tag(raw: str):
    """The reason for the fallback branch: these inputs leave a tag behind when
    tags are deleted in one left-to-right pass."""
    assert not _TAGLIKE.search(sanitize_text(raw))


def test_no_output_contains_a_tag():
    """Fuzz over the alphabet that can build one. Fixed seed so a failure is a
    reproducible case rather than a flake."""
    rng = random.Random(13)
    # Quotes, `-` and `=` are in here deliberately: they are what builds a
    # quoted attribute and a comment, the shapes where a `>` appears inside
    # what a browser would still be reading as one tag.
    alphabet = "<>/!?-=ab1 \"'"
    for _ in range(40000):
        raw = "".join(rng.choice(alphabet) for _ in range(rng.randint(1, 20)))
        cleaned = sanitize_text(raw)
        assert not _TAGLIKE.search(cleaned), f"{raw!r} -> {cleaned!r}"


@pytest.mark.parametrize("payload", ["<", "<a", "</", "<!"])
def test_unclosed_angle_brackets_do_not_stall_the_event_loop(payload: str):
    """The DoS half of the finding. Each of these repeated is a start that can
    never complete a tag; under `[^>]` each one rescanned to end-of-input.

    The budget is deliberately loose. Measured on the old pattern: 6.2-12.4s.
    Measured on the current one: under 0.01s. Anything between is a regression
    in the shape of the scan, and a CI runner two orders of magnitude slower
    than this laptop still passes.
    """
    text = payload * (200_000 // len(payload))
    started = time.perf_counter()
    sanitize_text(text)
    elapsed = time.perf_counter() - started
    assert elapsed < 5.0, f"{payload!r} * n took {elapsed:.1f}s — the scan is quadratic again"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('<a title=">">x</a>', '">x'),
        ("<a title='>'>x</a>", "'>x"),
        ('<a title="><script>">x', '">x'),
        ("<!-- a > b -->", " b -->"),
    ],
)
def test_a_quoted_or_comment_contained_gt_ends_the_tag_early(raw: str, expected: str):
    """A known limitation, asserted so it stays known.

    The scan takes the first `>` after a tag opens. A browser would not: inside
    a quoted attribute value, or between `<!--` and `-->`, a `>` is content and
    the tag runs on. So markup of that shape is cut in the wrong place and part
    of it survives as text.

    Deliberately not fixed. It is exactly what `<[^>]+>` did before this change
    — the outputs above are byte-identical to the old pattern's, on every case
    in this table — so the behaviour is unchanged rather than introduced, and
    closing it means hand-rolling quote and comment states, i.e. an HTML
    tokenizer, for text that nothing in the product renders as HTML.

    What has to hold is the property below, and it does: the leftover is inert
    text, never a tag. The fuzz above covers this shape, and the oracle is not
    blind to it — `_TAGLIKE` uses `[^>]*`, so it matches a surviving
    `<a title=">">` readily. The oracle erring toward calling something a tag is
    the safe direction for an oracle.
    """
    assert sanitize_text(raw) == expected
    assert not _TAGLIKE.search(sanitize_text(raw))


@pytest.mark.parametrize("falsy", [None, ""])
def test_falsy_input_becomes_empty_string(falsy):
    assert sanitize_text(falsy) == ""
