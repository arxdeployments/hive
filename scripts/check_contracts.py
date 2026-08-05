"""Guard against client/backend contract drift.

The class of bug this catches: a client calls an endpoint the API doesn't
expose (renamed, wrong verb, wrong path). It compiles, lints, and builds fine —
it only fails at runtime, often silently behind a fallback.
Run in CI so drift fails the build instead of shipping.

Covers the web client AND the iOS client. iOS was unchecked until now, which
mattered more there than on the web, not less: CI never builds the iOS target at
all, so a renamed route reached a device with nothing in between having noticed.
This check needs no macOS runner — it is a text scan plus the FastAPI route
table — so it runs in the same Linux job as the web half.
"""

import pathlib
import re
import sys

sys.path.insert(0, "backend")
from app.main import app  # noqa: E402
from fastapi.routing import APIRoute, APIWebSocketRoute  # noqa: E402

VERBS = "get|post|put|patch|delete"


def norm(p: str) -> str:
    r"""Reduce a URL to a comparable shape: no query, no trailing slash, and
    every dynamic segment collapsed to {x} — `${jsExpr}`, `{fastapiParam}` and
    Swift's `\(interpolation)` alike."""
    p = re.sub(r"\\\([^)]*\)", "{x}", p)  # Swift: "/api/x/\(id)/y"
    p = re.sub(r"\$\{[^}]+\}", "{x}", p)  # JS template literal
    p = re.sub(r"\{[^}]+\}", "{x}", p)  # FastAPI path param
    return p.split("?")[0].rstrip("/")


routes = set()
for r in app.routes:
    if isinstance(r, (APIRoute, APIWebSocketRoute)):
        for m in getattr(r, "methods", {"WS"}):
            if m not in ("HEAD", "OPTIONS"):
                routes.add((m, norm(r.path)))


def scan(root: str, glob: str, pattern: re.Pattern) -> tuple[int, list[str]]:
    """Return (calls checked, failures) for one client tree."""
    calls, missing = 0, []
    for f in sorted(pathlib.Path(root).rglob(glob)):
        src = f.read_text()
        for match in pattern.finditer(src):
            verb, url = match.group(1).upper(), match.group(2)
            if "/api" not in url:
                continue
            calls += 1
            if (verb, norm(url)) not in routes:
                line = src[: match.start()].count("\n") + 1
                missing.append(f"{verb:6} {norm(url):50} <- {f}:{line}")
    return calls, missing


# Web: `client.get('/api/...')` on the shared axios instance.
WEB = re.compile(rf"client\.({VERBS})\(\s*[`'\"]([^`'\"]+)")
# iOS: `api.send(.get, "/api/...")`, `sendIgnoringResponse(.delete, "...")` and
# the upload helpers all put the verb and the path adjacent in that order.
IOS = re.compile(rf'\.({VERBS})\s*,\s*"([^"]+)"', re.IGNORECASE)

total, failures = 0, []
for label, root, glob, pattern in (
    ("web", "frontend/src", "*.js*", WEB),
    ("iOS", "ios/RxHive", "*.swift", IOS),
):
    calls, missing = scan(root, glob, pattern)
    print(f"checked {calls} {label} API calls against {len(routes)} backend routes")
    total += calls
    failures += missing

if not total:
    # A regex that silently stops matching would otherwise turn this whole guard
    # into a no-op that passes forever.
    print("\nFAIL — matched no API calls at all; the scan patterns have gone stale")
    sys.exit(1)

if failures:
    print("\nFAIL — client calls with no matching backend route:")
    for m in sorted(set(failures)):
        print("  ", m)
    sys.exit(1)

print("OK — no contract drift")
