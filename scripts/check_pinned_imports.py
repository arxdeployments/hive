#!/usr/bin/env python3
"""Every third-party package app/ imports must be pinned in requirements.txt.

WHY THIS EXISTS

Batch 46 pinned requests and urllib3 after app/services/push.py started
subclassing urllib3's HTTPConnection and overriding the private `_new_conn`. The
subclass stays valid Python across versions, so a urllib3 that stopped calling
that method would have silently disabled an SSRF guard with no error anywhere.

Asking the same question of the rest of the tree found anyio, which was worse than
a hypothetical: app/api/notifications.py and app/services/push.py pass
`abandon_on_cancel=True` to anyio.to_thread.run_sync, a keyword that arrived in
anyio 4.1, while starlette constrains only `anyio>=3.6.2,<5`. Every version from
3.6.2 to 4.0.x satisfied the declared requirements and none of them accepts that
call.

Both were reached transitively. Neither was in requirements.txt. Nothing would have
told us — which is the gap this closes: a direct import is a direct dependency,
whatever installed it.

Run by CI alongside scripts/check_contracts.py.
"""

from __future__ import annotations

import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "backend" / "app"
# RUNTIME pins only. backend/Dockerfile installs requirements.txt and nothing
# else, so a package pinned only in requirements-dev.txt is unpinned in the image
# that actually serves traffic — and merging the two files let a dev-only pin
# satisfy a runtime import. Nothing hits that today; it is a hole that closes for
# free.
RUNTIME_REQUIREMENTS = ROOT / "backend" / "requirements.txt"

# Import name -> distribution name, for the cases where they differ. Kept explicit
# rather than resolved through importlib.metadata so this runs without the
# environment installed, which is the point of a static check.
DISTRIBUTION_OF = {
    "jwt": "pyjwt",
    "dotenv": "python-dotenv",
    "pil": "pillow",
    "pydantic_settings": "pydantic-settings",
    "livekit": "livekit-api",
    "multipart": "python-multipart",
    "email_validator": "email-validator",
}

# Ours, not third party.
FIRST_PARTY = {"app", "tests", "scripts", "alembic"}


def pinned_distributions() -> set[str]:
    """Names pinned with `==`, extras stripped: `redis[hiredis]==5.2.1` -> redis."""
    found: set[str] = set()
    if not RUNTIME_REQUIREMENTS.exists():
        return found
    for raw in RUNTIME_REQUIREMENTS.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "==" not in line:
            continue
        name = line.split("==", 1)[0].strip()
        found.add(name.split("[", 1)[0].strip().lower())
    return found


def imported_top_level() -> dict[str, set[pathlib.Path]]:
    """Top-level module names imported anywhere under app/, with where."""
    where: dict[str, set[pathlib.Path]] = {}
    for path in sorted(APP.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                # Relative imports have no module of ours to check.
                if node.level:
                    continue
                names = [node.module or ""]
            else:
                continue
            for name in names:
                top = name.split(".", 1)[0]
                if top:
                    where.setdefault(top, set()).add(path.relative_to(ROOT))
    return where


def main() -> int:
    stdlib = set(sys.stdlib_module_names)
    pinned = pinned_distributions()
    problems: list[str] = []
    checked = 0

    for module, files in sorted(imported_top_level().items()):
        if module in stdlib or module in FIRST_PARTY:
            continue
        checked += 1
        mapped = DISTRIBUTION_OF.get(module.lower())
        if mapped is not None:
            # A mapping asserts which distribution provides this import, so
            # only that name counts. Accepting the module name as a fallback —
            # which this did — meant a bare `jwt==` pin satisfied an
            # `import jwt` that PyJWT actually provides, leaving the real
            # package unpinned.
            candidates = {mapped.lower()}
        else:
            candidates = {module.lower(), module.lower().replace("_", "-")}
        if not candidates & pinned:
            listed = ", ".join(str(f) for f in sorted(files)[:3])
            wanted = " or ".join(sorted(candidates))
            problems.append(f"  {module} (imported by {listed}) -> not pinned as {wanted}")

    if problems:
        print("third-party packages imported by app/ but not pinned:\n")
        print("\n".join(problems))
        print(
            "\nA direct import is a direct dependency, whatever installed it. Pin it in"
            "\nbackend/requirements.txt (the RUNTIME file, the only one the image"
            "\ninstalls), or add the import->distribution mapping to DISTRIBUTION_OF here."
        )
        return 1

    print(f"checked {checked} third-party imports in app/ — all pinned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
