"""Structure that is computed and then discarded is not observability.

core/observability builds a request id, method, path template, status and latency
for every request and passes them through logging's `extra=`. `extra` only
reaches the output if the FORMATTER emits it, and the app installed none — so
under basicConfig's default "%(levelname)s:%(name)s:%(message)s" every access log
line in production read exactly

    INFO:rxhive.access:access

and the error branch logged a traceback with no request id and no path to
attribute it to. These tests pin the formatter, the wiring that installs it, and
the one field in that payload a caller controls.
"""

import json
import logging

from app.core.observability import JsonLogFormatter, _request_id


class _Req:
    def __init__(self, headers: dict):
        self.headers = headers


def _emit(record_factory) -> dict:
    """Format one record through the real formatter and parse it back."""
    return json.loads(JsonLogFormatter().format(record_factory()))


def _record(**extra) -> logging.LogRecord:
    record = logging.LogRecord(
        name="rxhive.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg="access",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return record


def test_the_access_fields_actually_reach_the_output():
    """The finding. Every one of these was being dropped."""
    payload = _emit(
        lambda: _record(request_id="abc123def456", method="POST", path="/api/auth/login", status=429, ms=12.3)
    )
    assert payload["request_id"] == "abc123def456"
    assert payload["method"] == "POST"
    assert payload["path"] == "/api/auth/login"
    assert payload["status"] == 429
    assert payload["ms"] == 12.3
    # And the standard fields an aggregator needs to sort and filter on.
    assert payload["level"] == "INFO"
    assert payload["logger"] == "rxhive.access"
    assert payload["msg"] == "access"
    assert payload["ts"]


def test_logging_internals_do_not_masquerade_as_application_fields():
    """`extra` is the signal; LogRecord's own attributes are not.

    Emitting record.__dict__ wholesale would put pathname, lineno, threadName and
    the rest in every line, which is how a JSON log stops being readable. The
    reserved set is derived from a real record so a new stdlib attribute cannot
    quietly start appearing as if the application had passed it.
    """
    payload = _emit(lambda: _record(request_id="r1"))
    for leaked in ("pathname", "lineno", "args", "levelno", "threadName", "processName", "msecs"):
        assert leaked not in payload, f"{leaked} leaked into the log payload"
    assert set(payload) == {"ts", "level", "logger", "msg", "request_id"}


def test_a_traceback_travels_in_the_same_object_as_its_request_id():
    """Line-based collection must not be able to separate the two.

    This is the branch that mattered most and said least: the middleware's
    `except` logged "request failed" with the request id and path in `extra`, and
    the operator got a bare traceback with neither.
    """
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        exc_info = sys.exc_info()

    def factory():
        record = _record(request_id="abc123def456", path="/api/messages")
        record.levelname, record.levelno = "ERROR", logging.ERROR
        record.msg = "request failed"
        record.exc_info = exc_info
        return record

    payload = _emit(factory)
    assert payload["request_id"] == "abc123def456"
    assert payload["path"] == "/api/messages"
    assert "ValueError: boom" in payload["exc"]
    assert "Traceback" in payload["exc"]


def test_an_unserializable_extra_does_not_take_the_log_line_down():
    """A log line must never be the thing that raises. `extra` carries whatever a
    caller passed, so the dump falls back to str rather than propagating."""
    payload = _emit(lambda: _record(request_id="r1", weird=object(), when=logging))
    assert isinstance(payload["weird"], str)
    assert payload["request_id"] == "r1"


def test_the_formatter_is_actually_installed_on_the_root_logger():
    """The wiring, not just the class.

    Worth its own test because the bug being fixed was exactly this shape: the
    structure existed and nothing was configured to emit it. A JsonLogFormatter
    that no handler uses would reproduce the finding with more code.
    """
    import app.main  # noqa: F401 - imported for its logging side effect

    formatters = [h.formatter for h in logging.getLogger().handlers]
    assert any(isinstance(f, JsonLogFormatter) for f in formatters), (
        f"root handlers carry {[type(f).__name__ for f in formatters]}"
    )


def test_a_sane_inbound_request_id_is_honoured():
    """A proxy or client gets to correlate across the hop."""
    assert _request_id(_Req({"x-request-id": "req-0a1b2c3d"})) == "req-0a1b2c3d"
    assert _request_id(_Req({"x-request-id": "A.b_1:2-3"})) == "A.b_1:2-3"


def test_a_hostile_or_oversized_request_id_is_replaced():
    """The field is caller-controlled and now genuinely reaches the logs.

    Before the formatter was fixed this was dormant — the value was computed and
    dropped. Making the logs work is what turns an unbounded, arbitrary,
    caller-chosen string into ~16 KB of chosen text written to the log on every
    request, so the bound lands in the same change.
    """
    for hostile in (
        "x" * 65,
        "x" * 16_000,
        "",
        "has spaces",
        'quote"and\\backslash',
        '{"json": "injection"}',
        "semi;colon",
        "sl/ash",
    ):
        generated = _request_id(_Req({"x-request-id": hostile}))
        assert generated != hostile, f"accepted {hostile[:32]!r}"
        assert len(generated) == 12 and generated.isalnum()

    # No header at all still yields one.
    assert len(_request_id(_Req({}))) == 12


async def test_the_response_carries_a_request_id_end_to_end(client):
    """It is the value the client can use to find its own request in the logs."""
    resp = await client.get("/api/health")
    assert resp.headers.get("X-Request-ID")

    echoed = await client.get("/api/health", headers={"x-request-id": "req-trace-01"})
    assert echoed.headers["X-Request-ID"] == "req-trace-01"

    rejected = await client.get("/api/health", headers={"x-request-id": "y" * 500})
    assert rejected.headers["X-Request-ID"] != "y" * 500
    assert len(rejected.headers["X-Request-ID"]) == 12
