"""A guard nothing runs is not a guard.

scripts/check_dependency_groups.py was written in batch 48 against a measured
failure — four of the twenty-one Dependabot PRs open on 2026-09-03 could not be
resolved by pip, because pins that constrain each other were split across
separate update groups. The script reads the real dependabot.yml and
requirements.txt and fails when a coupled cluster is split again.

ci.yml never invoked it. Its only two mentions anywhere under .github were
prose, in comments inside dependabot.yml.

The reason that survived review is the interesting part. The script has a test,
tests/test_dependency_groups_check.py, and that test is thorough — it builds
synthetic manifests and asserts the script rejects each way a group can go
wrong. So the suite was green, the guard was covered, and the invariant it
exists for was still unchecked against this repository. Coverage of the checker
is not coverage of the thing checked.

This asserts the wiring itself, so the next guard cannot be born dead.
"""

import pathlib
import re

import pytest
import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
WORKFLOWS = ROOT / ".github" / "workflows"


def _guard_scripts() -> list[pathlib.Path]:
    """The scripts that assert an invariant about this repository.

    Named by convention: `check_*.py` is a guard and must run in CI. Anything
    else under scripts/ is a tool a human reaches for — scripts/inspect-call.py
    is one — and carries no such claim.
    """
    return sorted(SCRIPTS.glob("check_*.py"))


def _ci_commands() -> list[str]:
    """Every shell command CI actually runs, across all workflows.

    Taken from the parsed YAML rather than the file text, so a script named only
    in a comment does not read as wired — which is exactly how this was missed:
    dependabot.yml discussed check_dependency_groups.py twice while nothing ran
    it.
    """
    commands: list[str] = []
    for path in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        workflow = yaml.safe_load(path.read_text()) or {}
        for job in (workflow.get("jobs") or {}).values():
            for step in (job or {}).get("steps") or []:
                run = (step or {}).get("run")
                if run:
                    commands.append(run)
    return commands


def test_there_are_guard_scripts_to_check():
    """The parametrized test below passes vacuously on an empty list."""
    assert len(_guard_scripts()) >= 4, [p.name for p in _guard_scripts()]


@pytest.mark.parametrize("script", _guard_scripts(), ids=lambda p: p.name)
def test_every_guard_script_is_run_by_ci(script: pathlib.Path):
    """A guard that CI never invokes cannot fail, so it protects nothing."""
    pattern = re.compile(rf"(?<![\w./-])scripts/{re.escape(script.name)}(?![\w.-])")
    assert any(pattern.search(cmd) for cmd in _ci_commands()), (
        f"scripts/{script.name} is never run by any workflow. It can only pass, whatever "
        "the repository does. Add a step for it, or drop the check_ prefix if it is a tool "
        "rather than a guard."
    )


def test_the_coupling_guard_runs_after_its_dependencies_are_installed():
    """check_dependency_groups.py is the one guard that cannot run stdlib-only.

    The other two that run before `pip install` do so deliberately: they are
    stdlib-only, and running them first means a manifest that lets the resolver
    choose an unpinned package is rejected before that package's build backend
    executes on the runner. This one reads couplings from importlib.metadata and
    parses YAML, so it has to come after the install — and placing it with the
    early pair would fail on the import rather than on the invariant.
    """
    steps = yaml.safe_load((WORKFLOWS / "ci.yml").read_text())["jobs"]["contracts"]["steps"]
    runs = [(step or {}).get("run", "") for step in steps]
    install = next(i for i, r in enumerate(runs) if r.startswith("pip install"))
    guard = next(i for i, r in enumerate(runs) if "check_dependency_groups.py" in r)
    assert guard > install, (
        "check_dependency_groups.py runs before the pip install it depends on; it would "
        "fail on `import yaml` rather than on a split dependency group."
    )
    assert "requirements-dev" in runs[install], (
        f"the contracts job installs {runs[install]!r}, which does not carry PyYAML — "
        "check_dependency_groups.py imports yaml."
    )
