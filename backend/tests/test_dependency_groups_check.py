"""Tests for scripts/check_dependency_groups.py.

The check exists because grouping pip updates by update type alone ignored which
pins constrain each other, and Dependabot then proposed manifests pip refuses to
resolve — #71 (starlette past fastapi's <0.47.0) and #67 (pywebpush needing
cryptography>=47.0.0 against a pinned 44.0.0). Both failed at `pip install`, so
nothing behind them ran.

A guard against that is only worth having if it cannot quietly pass, and the ways
this one could are specific: a catch-all listed above a cluster group swallows the
cluster, an update-types restriction on a cluster lets a major escape into its own
PR, a member left out of the patterns splits off, and a pin whose metadata is not
installed contributes no edges at all. Each of those is asserted to fail here,
against the real config where that is what is being claimed.
"""

import importlib.util
import pathlib
import textwrap

import pytest

_ROOT = pathlib.Path(__file__).resolve().parents[2]
_SCRIPT = _ROOT / "scripts" / "check_dependency_groups.py"
_REQUIREMENTS = _ROOT / "backend" / "requirements.txt"


def _load():
    spec = importlib.util.spec_from_file_location("check_dependency_groups", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker():
    return _load()


def _write_config(tmp_path: pathlib.Path, groups_yaml: str) -> pathlib.Path:
    config = tmp_path / "dependabot.yml"
    config.write_text(
        "version: 2\n"
        "updates:\n"
        "  - package-ecosystem: pip\n"
        "    directory: /backend\n"
        "    groups:\n" + textwrap.indent(textwrap.dedent(groups_yaml).strip() + "\n", "      ")
    )
    return config


REAL_CLUSTERS = """
python-asgi-stack:
  patterns: [fastapi, starlette, "pydantic*", anyio]
python-http-stack:
  patterns: [requests, urllib3, pywebpush, cryptography]
python-database:
  patterns: [alembic, sqlalchemy, asyncpg]
python-livekit:
  patterns: ["livekit*", pyjwt]
python-minor-and-patch:
  patterns: ["*"]
  update-types: [minor, patch]
"""


def test_the_committed_config_passes(checker, capsys):
    """The real file, unmodified. Every assertion below is relative to this."""
    assert checker.main([str(_REQUIREMENTS)]) == 0
    assert "coupled cluster" in capsys.readouterr().out


def test_the_couplings_are_actually_found(checker):
    """If this graph were empty the check would pass on any config at all."""
    pins = checker.read_pins([_REQUIREMENTS])
    edges, missing = checker.couplings(pins)
    assert not missing
    pairs = {(dependent, dependency) for dependent, dependency, _ in edges}
    # The two that produced real red PRs, plus one upper bound and one lower bound.
    assert ("fastapi", "starlette") in pairs
    assert ("pywebpush", "cryptography") in pairs
    assert ("requests", "urllib3") in pairs
    assert ("starlette", "anyio") in pairs
    clusters = checker.components(pins, edges)
    assert sorted(len(c) for c in clusters) == [2, 2, 4, 5]


def test_catch_all_first_is_still_whole_because_the_types_are_disjoint(checker, tmp_path, monkeypatch):
    """Ordering against the catch-all is a preference here, and the check says so.

    The catch-all takes only [minor, patch] and the cluster groups are unrestricted,
    so the two partitions never compete for the same bump: majors resolve to the
    cluster either way. This asserts the honest outcome rather than the tidier claim
    that the catch-all must come last — the earlier version of this test asserted the
    tidier claim and failed.
    """
    clusters, _, catch_all = REAL_CLUSTERS.partition("python-minor-and-patch")
    reordered = f"python-minor-and-patch{catch_all}\n{clusters.strip()}"
    monkeypatch.setattr(checker, "CONFIG", _write_config(tmp_path, reordered))
    assert checker.main([str(_REQUIREMENTS)]) == 0


def test_an_earlier_overlapping_group_splits_a_cluster(checker, tmp_path, monkeypatch, capsys):
    """Where ordering IS load-bearing: two cluster groups whose patterns overlap.

    A group matching sqlalchemy alone, listed above python-database, takes it out of
    the cluster and leaves alembic behind — alembic requires sqlalchemy, so that is a
    pair pip can be handed inconsistently.
    """
    overlapping = 'python-orm-only:\n  patterns: ["*alchemy*"]\n' + REAL_CLUSTERS
    monkeypatch.setattr(checker, "CONFIG", _write_config(tmp_path, overlapping))
    assert checker.main([str(_REQUIREMENTS)]) == 1
    err = capsys.readouterr().err
    assert "python-orm-only" in err
    assert "python-database" in err


def test_update_types_on_a_cluster_lets_a_major_escape(checker, tmp_path, monkeypatch, capsys):
    """Exactly how #71 happened: the cluster grouped, the major bump not."""
    restricted = REAL_CLUSTERS.replace(
        'python-asgi-stack:\n  patterns: [fastapi, starlette, "pydantic*", anyio]',
        'python-asgi-stack:\n  patterns: [fastapi, starlette, "pydantic*", anyio]'
        "\n  update-types: [minor, patch]",
    )
    monkeypatch.setattr(checker, "CONFIG", _write_config(tmp_path, restricted))
    assert checker.main([str(_REQUIREMENTS)]) == 1
    err = capsys.readouterr().err
    assert "major bumps split" in err
    assert "its own PR" in err


def test_a_member_dropped_from_the_patterns_splits_the_cluster(checker, tmp_path, monkeypatch, capsys):
    """The #67 shape: cryptography left behind while pywebpush moves."""
    without_crypto = REAL_CLUSTERS.replace(
        "patterns: [requests, urllib3, pywebpush, cryptography]",
        "patterns: [requests, urllib3, pywebpush]",
    )
    monkeypatch.setattr(checker, "CONFIG", _write_config(tmp_path, without_crypto))
    assert checker.main([str(_REQUIREMENTS)]) == 1
    err = capsys.readouterr().err
    assert "cryptography" in err
    assert "pywebpush" in err


def test_exclude_patterns_are_honoured(checker, tmp_path, monkeypatch, capsys):
    """A cluster member excluded by name is still a split, not still a member."""
    excluded = REAL_CLUSTERS.replace(
        "patterns: [requests, urllib3, pywebpush, cryptography]",
        "patterns: [requests, urllib3, pywebpush, cryptography]\n  exclude-patterns: [cryptography]",
    )
    monkeypatch.setattr(checker, "CONFIG", _write_config(tmp_path, excluded))
    assert checker.main([str(_REQUIREMENTS)]) == 1
    assert "cryptography" in capsys.readouterr().err


def test_an_uninstalled_pin_fails_rather_than_being_skipped(checker, tmp_path, capsys):
    """A missing distribution removes edges. Passing on that is passing on nothing."""
    manifest = tmp_path / "requirements.txt"
    manifest.write_text(_REQUIREMENTS.read_text() + "\nrxhive-not-a-real-package==1.0.0\n")
    assert checker.main([str(manifest)]) == 1
    err = capsys.readouterr().err
    assert "rxhive-not-a-real-package" in err
    assert "silently stops checking" in err


def test_pin_names_are_canonicalised(checker, tmp_path):
    """PyPI folds case and -, _, . — a pin spelled PyJWT is the pyjwt pattern."""
    manifest = tmp_path / "requirements.txt"
    manifest.write_text("PyJWT==2.10.1\nlivekit_api==0.8.2\n")
    assert set(checker.read_pins([manifest])) == {"pyjwt", "livekit-api"}


def test_unpinned_and_commented_lines_are_ignored(checker, tmp_path):
    manifest = tmp_path / "requirements.txt"
    manifest.write_text("# fastapi==0.1.0\nrequests>=2.0\nfastapi==0.115.12  # trailing\n\n")
    assert checker.read_pins([manifest]) == {"fastapi": "0.115.12"}
