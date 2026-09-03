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
REQUIREMENTS = [
    ROOT / "backend" / "requirements.txt",
    ROOT / "backend" / "requirements-dev.txt",
]

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
    for path in REQUIREMENTS:
        if not path.exists():
            continue
        for raw in path.read_text().splitlines():
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
        distribution = DISTRIBUTION_OF.get(module.lower(), module.lower()).replace(
            "_", "-"
        )
        if distribution not in pinned and module.lower() not in pinned:
            listed = ", ".join(str(f) for f in sorted(files)[:3])
            problems.append(
                f"  {module} (imported by {listed}) -> not pinned as {distribution!r}"
            )

    if problems:
        print("third-party packages imported by app/ but not pinned:\n")
        print("\n".join(problems))
        print(
            "\nA direct import is a direct dependency, whatever installed it. Pin it in"
            "\nbackend/requirements.txt, or add the import->distribution mapping to"
            "\nDISTRIBUTION_OF in this script if the names differ."
        )
        return 1

    print(f"checked {checked} third-party imports in app/ — all pinned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
