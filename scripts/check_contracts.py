"""Guard against frontend/backend contract drift.

The class of bug this catches: the frontend calls an endpoint the API doesn't
expose (renamed, wrong verb, wrong path). It compiles, lints, and builds fine —
it only fails at runtime, in a browser, often silently behind a fallback.
Run in CI so drift fails the build instead of shipping.
"""
import pathlib, re, sys

sys.path.insert(0, "backend")
from app.main import app  # noqa: E402
from fastapi.routing import APIRoute, APIWebSocketRoute  # noqa: E402


def norm(p: str) -> str:
    p = re.sub(r"\$\{[^}]+\}", "{x}", p)
    p = re.sub(r"\{[^}]+\}", "{x}", p)
    return p.split("?")[0].rstrip("/")


routes = set()
for r in app.routes:
    if isinstance(r, (APIRoute, APIWebSocketRoute)):
        for m in getattr(r, "methods", {"WS"}):
            if m not in ("HEAD", "OPTIONS"):
                routes.add((m, norm(r.path)))

pat = re.compile(r"client\.(get|post|put|patch|delete)\(\s*[`'\"]([^`'\"]+)")
missing = []
calls = 0
for f in pathlib.Path("frontend/src").rglob("*.js*"):
    for meth, url in pat.findall(f.read_text()):
        if not url.startswith("/api"):
            continue
        calls += 1
        if (meth.upper(), norm(url)) not in routes:
            missing.append(f"{meth.upper():6} {norm(url):50} <- {f}")

print(f"checked {calls} frontend API calls against {len(routes)} backend routes")
if missing:
    print("\nFAIL — frontend calls with no matching backend route:")
    for m in sorted(set(missing)):
        print("  ", m)
    sys.exit(1)
print("OK — no contract drift")
