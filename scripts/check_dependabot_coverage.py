#!/usr/bin/env python3
"""Every dependency manifest in the repository must be covered by dependabot.yml.

WHY THIS EXISTS

ci.yml told readers, from the day its action SHAs were pinned, that
"(Dependabot handles pinned SHAs and rewrites the comment)". Dependabot was never
configured, so every `uses:` sat frozen and the comment reassured anyone who
wondered. Measured when this was written, all five pinned actions were three major
versions behind.

A config alone does not stop that recurring. Someone adds an ecosystem — an
`ios/Package.resolved`, a second frontend, a new Dockerfile — and nothing says the
config did not grow with it. This walks the tree, works out which ecosystems are
actually present, and fails when one has no entry.

Deliberately not the reverse check: an entry for a directory that no longer has a
manifest is harmless noise, and Dependabot ignores it.

Stdlib only, so CI can run it before anything is installed.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".github" / "dependabot.yml"

# Manifest -> the package-ecosystem Dependabot calls it. One per ecosystem we
# actually use; extend when a new one appears, which is what the failure asks for.
MANIFESTS: dict[str, str] = {
    "requirements.txt": "pip",
    "package.json": "npm",
    "Dockerfile": "docker",
    "Package.resolved": "swift",
    # Dependabot's own ecosystem key for these is `docker-compose`, distinct from
    # `docker`. Both infra compose files are tracked and pin five images —
    # postgres:16-alpine, redis:7-alpine, caddy:2-alpine, and minio and
    # livekit-server on floating :latest — and none of them was covered, so the
    # production stack's images were unmanaged while this script reported full
    # coverage.
    "docker-compose.yml": "docker-compose",
    "docker-compose.yaml": "docker-compose",
}

# Terraform has no single well-known filename. Matching "main.tf" was the first
# attempt and it detected nothing: infra/terraform holds compute.tf, versions.tf
# and six others, so the check passed while being blind to the whole ecosystem —
# it would not have caught a missing terraform entry, which is the one thing it was
# there to do. Any .tf file marks the directory instead.
MANIFEST_SUFFIXES: dict[str, str] = {".tf": "terraform"}

# TRACKED FILES ONLY, because that is precisely what Dependabot can see.
#
# The first version walked the filesystem and subtracted a hand-written blocklist
# of directory names. That is the wrong question asked twice: it missed
# ios/build/SourcePackages until the list grew, and it would have demanded a
# `swift` entry for ios/RxHive.xcodeproj/.../Package.resolved — a real manifest
# that .gitignore line 46 excludes, so Dependabot cannot read it and the entry
# would be inert.
#
# `git ls-files` answers both at once: vendored checkouts, build output,
# node_modules, .venv and .claude worktrees are all untracked, and anything
# somebody deliberately commits shows up without this script needing to learn
# about it. The blocklist survives only as a fallback for a tree with no git.
IGNORED_PARTS = {
    "node_modules",
    ".venv",
    "dist",
    "build",
    "build-device",
    "SourcePackages",
    ".git",
    "test-results",
    ".claude",
    "__pycache__",
}


def repository_files() -> list[pathlib.Path]:
    """Every tracked file, repository-relative. Falls back to a filesystem walk."""
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "ls-files", "-z"],
            capture_output=True,
            check=True,
            text=True,
        ).stdout
        return [pathlib.Path(name) for name in out.split("\0") if name]
    except (OSError, subprocess.CalledProcessError):
        # No git available: walk instead, and fall back to the blocklist. Less
        # accurate, and it says so rather than silently reporting a clean tree.
        print("warning: git unavailable, falling back to a filesystem walk", file=sys.stderr)
        return [
            path.relative_to(ROOT)
            for path in ROOT.rglob("*")
            if path.is_file() and not (IGNORED_PARTS & set(path.relative_to(ROOT).parts))
        ]


def _display(path: pathlib.Path) -> str:
    """Repository-relative when it can be, absolute otherwise."""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def present_ecosystems() -> dict[tuple[str, str], pathlib.Path]:
    """{(ecosystem, directory): the manifest that put it there}."""
    found: dict[tuple[str, str], pathlib.Path] = {}
    for path in sorted(repository_files()):
        ecosystem = MANIFESTS.get(path.name) or MANIFEST_SUFFIXES.get(path.suffix)
        if ecosystem is None:
            continue
        directory = "/" + str(path.parent) if str(path.parent) != "." else "/"
        found.setdefault((ecosystem, directory), path)
    # github-actions is keyed on the repository root rather than a manifest name,
    # and Dependabot scans three places for it: .github/workflows/*, and a root
    # action.yml or action.yaml. Derived from the TRACKED paths above, not from
    # is_dir() — that checked the filesystem, so it would have counted an
    # untracked .github/workflows and missed a tracked root action.yml.
    for path in sorted(repository_files()):
        parts = path.parts
        is_workflow = len(parts) >= 3 and parts[0] == ".github" and parts[1] == "workflows"
        is_root_action = len(parts) == 1 and path.name in ("action.yml", "action.yaml")
        if is_workflow or is_root_action:
            found.setdefault(("github-actions", "/"), path)
            break
    return found


def configured_ecosystems() -> set[tuple[str, str]]:
    """Parsed with a regex on purpose — no PyYAML, so this runs before pip install.

    The file's shape is fixed by Dependabot's own schema: a flat list of entries
    each carrying package-ecosystem and directory, so pairing them in order is
    sound. A malformed file is caught by GitHub itself, which rejects it and says
    so in the Dependabot tab.
    """
    if not CONFIG.exists():
        return set()
    text = CONFIG.read_text()
    ecosystems = re.findall(r"^\s*-?\s*package-ecosystem:\s*[\"']?([\w-]+)", text, re.M)
    directories = re.findall(r"^\s*directory:\s*[\"']?([^\"'\s]+)", text, re.M)
    if len(ecosystems) != len(directories):
        print(
            f"dependabot.yml: {len(ecosystems)} package-ecosystem keys but "
            f"{len(directories)} directory keys — every entry needs exactly one of each"
        )
        raise SystemExit(1)
    return set(zip(ecosystems, directories, strict=True))


def main() -> int:
    if not CONFIG.exists():
        # Not relative_to(ROOT): that raises for any path outside the repository,
        # so the missing-config branch crashed instead of reporting, and could not
        # be tested at all. The message is for a human either way.
        print(f"{_display(CONFIG)} is missing — nothing updates this repo's dependencies")
        return 1

    present = present_ecosystems()
    configured = configured_ecosystems()
    missing = {key: src for key, src in present.items() if key not in configured}

    if missing:
        print("dependency ecosystems present in the repository but not in dependabot.yml:\n")
        for (ecosystem, directory), source in sorted(missing.items()):
            print(f"  {ecosystem} at {directory}  (found {source})")
        print(
            "\nAdd an entry per ecosystem, or add the manifest to IGNORED_PARTS in this"
            "\nscript if it is vendored rather than ours."
        )
        return 1

    print(f"dependabot.yml covers all {len(present)} dependency ecosystems in the repository")
    return 0


if __name__ == "__main__":
    sys.exit(main())
