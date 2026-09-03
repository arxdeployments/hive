#!/usr/bin/env python3
"""Pins that constrain each other must move as one Dependabot group.

WHY THIS EXISTS

Batch 48 configured Dependabot and grouped pip updates by update *type*: minor and
patch together, majors on their own for individual review. That reasoning was about
review effort and it ignored the dependency graph, so Dependabot started proposing
manifests that pip cannot resolve. Measured on 2026-09-03, two of the twenty-one
open PRs were already stuck this way and neither was a broken dependency:

  #71  starlette 0.46.2 -> 1.6.0, while fastapi 0.115.12 requires starlette<0.47.0
  #67  pywebpush -> 2.5.0, which requires cryptography>=47.0.0, while the
       cryptography pin stays at 44.0.0 because majors are excluded from the group

Both are the same mistake: requirements.txt pins a package AND pins something that
package constrains, and the two sides were allowed to move independently. The
resulting PR fails at `pip install`, so nothing downstream of it runs, and the
queue behind it stops moving.

WHAT IT CHECKS

Read the pins, ask the installed metadata which of them constrain each other, and
treat each connected component of that graph as a unit that has to travel together.
Then model how Dependabot actually assigns a dependency to a group — first group
whose patterns match and whose update-types allow the bump, otherwise its own PR —
and fail when the members of a component do not all land in the same group.

Doing it per update type is the point rather than a detail. A cluster group that
restricts itself to [minor, patch] lets a major bump of one member fall through to
its own PR, which is exactly how #71 happened.

WHY IT INSISTS EVERY PIN IS INSTALLED

The couplings come from importlib.metadata, so a pin whose distribution is missing
contributes no edges and the cluster it belonged to quietly stops being checked.
That is a check that passes because it looked at nothing. It fails instead.
"""

from __future__ import annotations

import argparse
import fnmatch
import pathlib
import sys
from importlib.metadata import PackageNotFoundError, requires, version

import yaml
from packaging.requirements import InvalidRequirement, Requirement
from packaging.utils import canonicalize_name
from packaging.version import InvalidVersion, Version

ROOT = pathlib.Path(__file__).resolve().parent.parent
CONFIG = ROOT / ".github" / "dependabot.yml"
# Both, because Dependabot's pip entry is `directory: /backend` and it updates
# every manifest it finds there. requirements-dev.txt starts with `-r
# requirements.txt`, so the coupling graph genuinely spans the two files: uvicorn
# [standard] needs pyyaml and websockets, which are pinned in the dev file, and the
# pytest <-> pytest-asyncio pair lives entirely inside it.
DEFAULT_MANIFESTS = (
    ROOT / "backend" / "requirements.txt",
    ROOT / "backend" / "requirements-dev.txt",
)
ECOSYSTEM = "pip"
UPDATE_TYPES = ("major", "minor", "patch")


def canonical(name: str) -> str:
    """PEP 503 normalization: lowercase, and runs of -, _ and . collapse to one -.

    Hand-rolling this as two str.replace calls turned Foo__bar into foo--bar rather
    than foo-bar, and because couplings() tests dependency names against the pins by
    exact membership, an equivalent spelling would simply not match and the edge
    would vanish. Deferring to packaging removes the chance of getting it wrong.

    Also applied to the dependabot.yml patterns, which are globs. Collapsing runs of
    separators leaves *, pydantic* and *alchemy* untouched.
    """
    return str(canonicalize_name(name))


def read_pins(manifests: list[pathlib.Path]) -> dict[str, tuple[str, frozenset[str]]]:
    """Pinned name -> (version, requested extras).

    The extras are not decoration. requirements.txt pins uvicorn[standard],
    SQLAlchemy[asyncio] and redis[hiredis], and an extra's requirements are gated
    behind `; extra == "..."` markers that evaluate False when no extra is in the
    environment — silently, without raising. Dropping the extras therefore dropped
    every coupling those three contribute, which is the check quietly narrowing
    itself rather than failing.
    """
    pins: dict[str, tuple[str, frozenset[str]]] = {}
    for manifest in manifests:
        for raw in manifest.read_text().splitlines():
            line = raw.split("#", 1)[0].strip()
            if not line or "==" not in line:
                continue
            try:
                req = Requirement(line)
            except InvalidRequirement:
                continue
            pinned = [s.version for s in req.specifier if s.operator in ("==", "===")]
            if not pinned:
                continue
            # A root marker that is false on this platform means pip skipped the
            # install, and demanding installed metadata for it would fail the guard
            # for a reason that has nothing to do with grouping. Root requirements
            # cannot reference `extra`, so there is no extra context to supply.
            if req.marker is not None and not req.marker.evaluate():
                continue
            pins[canonical(req.name)] = (pinned[0], frozenset(req.extras))
    return pins


def _in_force(req: Requirement, extras: frozenset[str]) -> bool:
    """Is this requirement active for the base install plus the requested extras?

    A marker with no extra context evaluates `extra == "standard"` to False rather
    than raising, so an extra's requirements have to be evaluated once per extra
    that the pin actually asks for. Both the manifest spelling and the canonical
    one are tried, because metadata normalizes extra names and older wheels do not.
    """
    if req.marker is None:
        return True
    if req.marker.evaluate():
        return True
    for extra in extras:
        for spelling in {extra, canonical(extra)}:
            if req.marker.evaluate({"extra": spelling}):
                return True
    return False


def couplings(
    pins: dict[str, tuple[str, frozenset[str]]],
) -> tuple[list[tuple[str, str, str]], list[str], list[str]]:
    """Edges (dependent, dependency, specifier) where both ends are pinned.

    Also reports pins with no installed metadata, and pins whose installed version
    is not the pinned one. Both make the graph untrustworthy: requires() answers for
    whatever version is actually installed, so a stale environment would have this
    validate the wrong graph and bless a configuration that cannot install.
    """
    edges: list[tuple[str, str, str]] = []
    missing: list[str] = []
    mismatched: list[str] = []
    for name in sorted(pins):
        pinned_version, extras = pins[name]
        try:
            installed = version(name)
            declared = requires(name) or []
        except PackageNotFoundError:
            missing.append(name)
            continue
        try:
            same = Version(installed) == Version(pinned_version)
        except InvalidVersion:
            same = installed == pinned_version
        if not same:
            mismatched.append(f"{name}: pinned {pinned_version}, installed {installed}")
            continue
        for raw in declared:
            try:
                req = Requirement(raw)
            except InvalidRequirement:
                continue
            if not _in_force(req, extras):
                continue
            dep = canonical(req.name)
            if dep in pins and str(req.specifier):
                edges.append((name, dep, str(req.specifier)))
    return edges, missing, mismatched


def components(
    pins: dict[str, tuple[str, frozenset[str]]], edges: list[tuple[str, str, str]]
) -> list[list[str]]:
    parent = {name: name for name in pins}

    def find(node: str) -> str:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    for dependent, dependency, _ in edges:
        a, b = find(dependent), find(dependency)
        if a != b:
            parent[a] = b

    clusters: dict[str, list[str]] = {}
    for name in pins:
        clusters.setdefault(find(name), []).append(name)
    return sorted((sorted(c) for c in clusters.values() if len(c) > 1), key=lambda c: c[0])


def configured_groups() -> list[tuple[str, dict]]:
    config = yaml.safe_load(CONFIG.read_text())
    for entry in config.get("updates") or []:
        if entry.get("package-ecosystem") == ECOSYSTEM:
            groups = entry.get("groups") or {}
            return list(groups.items())
    raise SystemExit(f"{CONFIG.name} has no {ECOSYSTEM} entry to check")


def resolve_group(name: str, update_type: str, groups: list[tuple[str, dict]]) -> str | None:
    """The group Dependabot puts this bump in: first match wins, else its own PR."""
    for group_name, spec in groups:
        patterns = spec.get("patterns") or ["*"]
        excluded = spec.get("exclude-patterns") or []
        if not any(fnmatch.fnmatch(name, canonical(p)) for p in patterns):
            continue
        if any(fnmatch.fnmatch(name, canonical(p)) for p in excluded):
            continue
        allowed = spec.get("update-types")
        if allowed is not None and update_type not in allowed:
            continue
        return group_name
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifests", nargs="*", type=pathlib.Path, default=list(DEFAULT_MANIFESTS))
    args = parser.parse_args(argv)
    manifests = args.manifests or list(DEFAULT_MANIFESTS)

    pins = read_pins(manifests)
    if not pins:
        print(f"no pins found in {', '.join(str(m) for m in manifests)}", file=sys.stderr)
        return 1

    edges, missing, mismatched = couplings(pins)
    if missing or mismatched:
        print(
            "cannot check dependency groups: the installed environment does not match the manifest.\n",
            file=sys.stderr,
        )
        if missing:
            print(f"  no installed metadata for: {', '.join(missing)}", file=sys.stderr)
        if mismatched:
            for line in mismatched:
                print(f"  wrong version installed for {line}", file=sys.stderr)
        print(
            "\nThe couplings are read from installed distributions, so a package that "
            "is absent contributes no edges and one at the wrong version contributes "
            "another version's edges. Either way a cluster stops being checked, or is "
            "checked against a graph that is not the one being shipped.\n"
            f"Run `pip install -r {manifests[-1]}` and try again.",
            file=sys.stderr,
        )
        return 1

    groups = configured_groups()
    constrains = {(d, dep): spec for d, dep, spec in edges}
    failures: list[str] = []

    for cluster in components(pins, edges):
        for update_type in UPDATE_TYPES:
            landed: dict[str, list[str]] = {}
            for name in cluster:
                group = resolve_group(name, update_type, groups) or f"(its own PR: {name})"
                landed.setdefault(group, []).append(name)
            if len(landed) > 1:
                detail = "; ".join(
                    f"{group} <- {', '.join(names)}" for group, names in sorted(landed.items())
                )
                failures.append(
                    f"{update_type} bumps split the coupled cluster {{{', '.join(cluster)}}}: {detail}"
                )

    if failures:
        print(
            "These pins constrain each other, so a bump that moves one without the "
            "others produces a manifest pip cannot resolve:\n",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        print("\nThe couplings, from installed metadata:", file=sys.stderr)
        for (dependent, dependency), spec in sorted(constrains.items()):
            print(
                f"  {dependent}=={pins[dependent][0]} requires {dependency}{spec} "
                f"(pinned at {pins[dependency][0]})",
                file=sys.stderr,
            )
        print(
            f"\nFix: in {CONFIG.name}, put each cluster in one {ECOSYSTEM} group listed "
            "before the catch-all, and do not restrict that group's update-types — a "
            "major bump has to be able to carry the cluster with it.",
            file=sys.stderr,
        )
        return 1

    clusters = components(pins, edges)
    print(
        f"dependency groups OK: {len(pins)} pins, {len(edges)} couplings, "
        f"{len(clusters)} coupled cluster(s) each grouped for all of {', '.join(UPDATE_TYPES)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
