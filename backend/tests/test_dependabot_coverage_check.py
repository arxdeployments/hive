"""Tests for scripts/check_dependabot_coverage.py.

The config it guards exists because ci.yml spent months telling readers
"(Dependabot handles pinned SHAs and rewrites the comment)" while no Dependabot
config existed — every pinned action three major versions behind, with a comment
reassuring anyone who looked.

A coverage check is only worth having if it cannot quietly pass, and this one
already failed that once: keying terraform on "main.tf" detected nothing, because
infra/terraform holds compute.tf and seven others. It passed while blind to the
whole ecosystem. These cover detection per ecosystem rather than the aggregate.
"""

import importlib.util
import pathlib

import pytest

_SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "check_dependabot_coverage.py"


def _load():
    spec = importlib.util.spec_from_file_location("check_dependabot_coverage", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def checker():
    return _load()


def test_the_real_repository_is_covered(checker):
    assert checker.main() == 0


@pytest.mark.parametrize(
    "ecosystem,directory",
    [
        ("pip", "/backend"),
        ("npm", "/frontend"),
        ("docker", "/backend"),
        ("docker", "/frontend"),
        ("terraform", "/infra/terraform"),
        ("github-actions", "/"),
    ],
)
def test_every_ecosystem_is_actually_detected(checker, ecosystem, directory):
    """Named individually, not counted.

    The aggregate assertion is what let the terraform blind spot through: five
    detected looked plausible, and nothing said which five.
    """
    present = checker.present_ecosystems()
    assert (ecosystem, directory) in present, sorted(present)


def test_terraform_is_found_without_a_main_tf(checker):
    """The specific bug. infra/terraform has no main.tf, so a filename match on it
    detected nothing and the check could not have caught a missing entry."""
    source = checker.present_ecosystems()[("terraform", "/infra/terraform")]
    assert source.suffix == ".tf"
    assert source.name != "main.tf"


def test_vendored_manifests_are_ignored(checker):
    """ios/build holds SPM checkouts with their own package manifests and even
    their own dependabot.yml. Treating those as ours would demand entries for
    somebody else's dependencies."""
    for (_, directory), source in checker.present_ecosystems().items():
        parts = set(source.parts)
        assert not (parts & checker.IGNORED_PARTS), f"{directory} came from {source}"


def test_a_missing_entry_fails(checker, tmp_path, monkeypatch):
    config = tmp_path / "dependabot.yml"
    config.write_text("version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /backend\n")
    monkeypatch.setattr(checker, "CONFIG", config)
    assert checker.main() == 1


def test_a_missing_config_fails(checker, tmp_path, monkeypatch):
    monkeypatch.setattr(checker, "CONFIG", tmp_path / "nothing-here.yml")
    assert checker.main() == 1


def test_mismatched_keys_are_rejected(checker, tmp_path, monkeypatch):
    """An entry with an ecosystem and no directory would otherwise pair wrongly
    with the next entry's directory and report coverage that does not exist."""
    config = tmp_path / "dependabot.yml"
    config.write_text(
        "version: 2\nupdates:\n"
        "  - package-ecosystem: pip\n"
        "  - package-ecosystem: npm\n    directory: /frontend\n"
    )
    monkeypatch.setattr(checker, "CONFIG", config)
    with pytest.raises(SystemExit) as exit_info:
        checker.configured_ecosystems()
    assert exit_info.value.code == 1
