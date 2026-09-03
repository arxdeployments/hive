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

SCOPE, STATED PLAINLY

This reads STATIC imports only — ast.Import and ast.ImportFrom, at any nesting
depth, including inside functions and try blocks. It does not see
importlib.import_module, __import__, plugin discovery or entry points. app/ has
none of those today (checked), but a dynamic import of an unpinned package would
pass this check silently, so anyone adding one needs to pin it by hand.

TWO MODES

Default is the static check above and needs nothing installed. `--check-mappings`
validates DISTRIBUTION_OF against importlib.metadata and therefore needs the
environment; CI runs it after pip install. The split is deliberate: a
hand-maintained map that nothing verifies is a way for this check to pass while a
package is unpinned, and the map's own first run found `pil` pointing at nothing
because Pillow's import name is `PIL`.

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


def validate_mappings() -> int:
    """Check every DISTRIBUTION_OF entry against what is actually installed.

    The map is hand-maintained, and a wrong entry does not fail loudly — it makes
    the static check look for the wrong distribution name and pass. So the map is
    verified separately, against importlib.metadata, where the answer is a fact
    rather than an assumption.

    Case matters and cost me one already: packages_distributions() keys are real
    import names, so Pillow appears as `PIL`. Matching is case-insensitive on the
    import name for that reason.
    """
    from importlib.metadata import packages_distributions

    provided = packages_distributions()
    by_lower: dict[str, list[str]] = {}
    for import_name, distributions in provided.items():
        by_lower.setdefault(import_name.lower(), []).extend(distributions)

    problems: list[str] = []
    for import_name, claimed in sorted(DISTRIBUTION_OF.items()):
        actual = by_lower.get(import_name.lower())
        if not actual:
            problems.append(
                f"  {import_name!r} -> {claimed!r}: nothing installed provides that import, "
                "so the mapping cannot be verified (wrong key, or the package is absent)"
            )
            continue
        normalised = {a.lower().replace("_", "-") for a in actual}
        if claimed.lower().replace("_", "-") not in normalised:
            problems.append(f"  {import_name!r} -> {claimed!r}: actually provided by {sorted(actual)}")

    if problems:
        print("DISTRIBUTION_OF entries that do not match the installed environment:\n")
        print("\n".join(problems))
        print(
            "\nA wrong mapping makes the static check look for the wrong distribution"
            "\nname and pass while the real package is unpinned. Fix the entry."
        )
        return 1

    print(f"validated {len(DISTRIBUTION_OF)} import->distribution mappings against the environment")
    return 0


def main() -> int:
    if "--check-mappings" in sys.argv[1:]:
        return validate_mappings()
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
