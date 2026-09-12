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
import shlex

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


# `&&`, `;` and friends separate commands; `(` and `)` group them. shlex hands
# these back as their own tokens only with punctuation_chars set.
_SEPARATORS = frozenset({"&&", "||", ";", "|", "&", "(", ")"})

# `python`, `python3`, `python3.12`, `/usr/bin/python` — an interpreter whose
# first argument is the script it runs.
_PYTHON = re.compile(r"^(?:\S*/)?python[\d.]*$")


def _unquote(token: str) -> str:
    """Drop one layer of surrounding quotes, which non-posix shlex keeps."""
    if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'":
        return token[1:-1]
    return token


def _is_invocation(words: list[str], script: str) -> bool:
    """Whether one command — already split from its neighbours — runs the script."""
    if not words:
        return False
    target = f"scripts/{script}"
    if words[0] in (target, f"./{target}"):
        return True
    return len(words) > 1 and bool(_PYTHON.match(words[0])) and words[1] == target


def _invokes(command: str, script: str) -> bool:
    """Whether a shell command actually runs `scripts/<script>`.

    Naming the path is not running it, and the ways to name it are not obvious.
    Splitting the raw text on `&&` and `;` reads a separator inside a quoted
    string as a real one, so `echo 'note; python scripts/check_x.py'` looks like
    an invocation; dropping only lines that *start* with `#` misses an inline
    comment, so `true # && python scripts/check_x.py` does too.

    Lexing with shlex fixes both, but its own comment handling is not the
    shell's: it cuts at a `#` anywhere, so `scripts/check_x.py#note` lexes to
    `scripts/check_x.py` and reads as an invocation, where a POSIX shell treats
    the whole thing as one word naming a path that does not exist. So commenters
    are switched off and `#` is honoured only where a word begins, which is the
    rule the shell applies.

    Non-posix, which keeps quotes on the token: that is what distinguishes a
    word genuinely starting `#` from a quoted `'#'`, and quotes are stripped for
    comparison afterwards.

    A line that cannot be lexed is treated as not an invocation — the
    conservative direction, since it reports a wired guard as unwired rather
    than the reverse.
    """
    for line in command.splitlines():
        lexer = shlex.shlex(line, punctuation_chars=True, posix=False)
        lexer.whitespace_split = True
        lexer.commenters = ""
        try:
            tokens = list(lexer)
        except ValueError:
            continue
        words: list[str] = []
        for token in [*tokens, ";"]:
            comment = token.startswith("#")
            if comment or token in _SEPARATORS:
                if _is_invocation(words, script):
                    return True
                words = []
                if comment:
                    break
            else:
                words.append(_unquote(token))
    return False


@pytest.mark.parametrize(
    ("command", "runs"),
    [
        ("python scripts/check_contracts.py --check-mappings", True),
        ("python3 scripts/check_contracts.py", True),
        ("./scripts/check_contracts.py", True),
        ("cd backend && python scripts/check_contracts.py", True),
        ("  python scripts/check_contracts.py  ", True),
        # Mentions, not invocations — each of these would have satisfied a plain
        # substring match, which is what this guard was first written with.
        ("echo scripts/check_contracts.py", False),
        ("# python scripts/check_contracts.py", False),
        ("echo 'see scripts/check_contracts.py for why'", False),
        ("python scripts/check_contracts.py.bak", False),
        ("python other/scripts/check_contracts.py", False),
        # Running a different guard is not running this one.
        ("python scripts/check_dependency_groups.py", False),
        ("python scripts/check_pinned_imports.py --check-mappings", False),
        # A separator inside a quoted string is not a separator.
        ("echo 'note; python scripts/check_contracts.py --check-mappings'", False),
        ('echo "a && python scripts/check_contracts.py"', False),
        # An inline comment ends the line, wherever it starts.
        ("true # && python scripts/check_contracts.py", False),
        ("true  #; python scripts/check_contracts.py", False),
        # ...but the same separators, unquoted, do separate.
        ("true && python scripts/check_contracts.py", True),
        ("python scripts/check_contracts.py; true", True),
        ("false || python scripts/check_contracts.py", True),
        ("python scripts/check_contracts.py | tee log", True),
        ("bare scripts/check_contracts.py", False),
        ("scripts/check_contracts.py", True),
        # shlex cuts at `#` anywhere; a shell only does so where a word begins.
        ("python scripts/check_contracts.py#note", False),
        ("python scripts/check_contracts.py #note", True),
        ("python scripts/check_contracts.py --flag#x", True),
        # ...and a quoted `#` opens nothing.
        ("echo '#' && python scripts/check_contracts.py", True),
        ('python "scripts/check_contracts.py"', True),
    ],
)
def test_only_a_real_invocation_counts(command: str, runs: bool):
    """The matcher itself, since the guard is only as good as it."""
    assert _invokes(command, "check_contracts.py") is runs


@pytest.mark.parametrize("script", _guard_scripts(), ids=lambda p: p.name)
def test_every_guard_script_is_run_by_ci(script: pathlib.Path):
    """A guard that CI never invokes cannot fail, so it protects nothing."""
    assert any(_invokes(cmd, script.name) for cmd in _ci_commands()), (
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
