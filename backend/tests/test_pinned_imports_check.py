"""Tests for scripts/check_pinned_imports.py — the check that guards the pins.

It exists because two dependencies app/ imports directly were unpinned and nothing
said so: urllib3, whose private `_new_conn` an SSRF guard overrides, and anyio,
which app/ calls with a keyword that did not exist before 4.1 while starlette
allows 3.6.2 upward.

A check like that is only worth having if it cannot quietly pass. Its own review
turned up two ways it could — merging dev pins into a runtime question, and
accepting the module name when a mapping said otherwise — so these cover the
matching rules directly rather than through the CLI.
"""

import importlib.util
import pathlib

import pytest

_SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "check_pinned_imports.py"


def _load():
    """Load the script by path; it is a CI entry point, not an installed module."""
    spec = importlib.util.spec_from_file_location("check_pinned_imports", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker():
    return _load()


def test_the_real_repository_passes_both_modes(checker):
    """The check has to be green on the tree it ships with, or it is noise."""
    assert checker.main() == 0
    assert checker.validate_mappings() == 0


def test_only_runtime_pins_count(checker, tmp_path, monkeypatch):
    """backend/Dockerfile installs requirements.txt and nothing else.

    A package pinned only in requirements-dev.txt is unpinned in the image that
    serves traffic, and the checker used to read both files and call it pinned.
    """
    runtime = tmp_path / "requirements.txt"
    runtime.write_text("fastapi==0.115.12\n")
    monkeypatch.setattr(checker, "RUNTIME_REQUIREMENTS", runtime)
    assert checker.pinned_distributions() == {"fastapi"}

    # The dev file, even sitting right next to it, is not consulted.
    (tmp_path / "requirements-dev.txt").write_text("anyio==4.14.2\n")
    assert "anyio" not in checker.pinned_distributions()


def test_extras_and_case_do_not_hide_a_pin(checker, tmp_path, monkeypatch):
    runtime = tmp_path / "requirements.txt"
    runtime.write_text("redis[hiredis]==5.2.1\nSQLAlchemy[asyncio]==2.0.38\nPyJWT==2.10.1\n")
    monkeypatch.setattr(checker, "RUNTIME_REQUIREMENTS", runtime)
    assert checker.pinned_distributions() == {"redis", "sqlalchemy", "pyjwt"}


def test_comments_and_blank_lines_are_not_pins(checker, tmp_path, monkeypatch):
    runtime = tmp_path / "requirements.txt"
    runtime.write_text("# anyio==4.14.2 is deliberately not pinned here\n\nfastapi==0.115.12\n")
    monkeypatch.setattr(checker, "RUNTIME_REQUIREMENTS", runtime)
    assert checker.pinned_distributions() == {"fastapi"}


def test_a_mapping_is_honoured_exactly(checker):
    """`import jwt` is provided by PyJWT, and `jwt` is a real, different package.

    The matcher used to accept a pin named after the MODULE as well, so a bare
    `jwt==` pin satisfied this import while PyJWT stayed unpinned.
    """
    assert checker.DISTRIBUTION_OF["jwt"] == "pyjwt"


def test_the_mapping_validator_rejects_a_wrong_entry(checker, monkeypatch):
    """The map is hand-maintained, so a bad entry must fail rather than mislead."""
    monkeypatch.setitem(checker.DISTRIBUTION_OF, "jwt", "definitely-not-the-jwt-package")
    assert checker.validate_mappings() == 1


def test_the_mapping_validator_rejects_an_unresolvable_key(checker, monkeypatch):
    """A key no installed package provides cannot be verified, and silently
    trusting it is how a wrong mapping survives. `pil` was exactly this before the
    validator was made case-insensitive — Pillow's import name is `PIL`."""
    monkeypatch.setitem(checker.DISTRIBUTION_OF, "nothing_provides_this", "pillow")
    assert checker.validate_mappings() == 1


def test_a_same_name_mapping_is_accepted(checker, monkeypatch):
    """Redundant but harmless: the import and the distribution agree."""
    monkeypatch.setitem(checker.DISTRIBUTION_OF, "fastapi", "fastapi")
    assert checker.validate_mappings() == 0


def test_case_insensitivity_on_the_import_name(checker, monkeypatch):
    """Pillow is imported as `PIL`. A case-sensitive lookup found nothing and the
    entry could not be validated at all."""
    monkeypatch.setitem(checker.DISTRIBUTION_OF, "PIL", "pillow")
    assert checker.validate_mappings() == 0
