"""An index built on a table that already has rows must not block writes.

Three migrations say this, at length. b7e21c4a9d33 calls it not optional:

    A plain CREATE INDEX takes SHARE for the length of a full heap scan, which
    conflicts with the ROW EXCLUSIVE that INSERT/UPDATE/DELETE take: it blocks
    writes and leaves reads alone.

and a4f81c6b2e07 says what that costs in this deployment specifically:

    Production boots with `alembic upgrade head && python -m app.seed &&
    uvicorn ...` (infra/docker-compose.prod.yml), so blocking here does not
    merely queue writes — the API never finishes starting.

Nothing enforced it. Two migrations built indexes on tables that already
existed, plainly: 4471a6d661d3 on `messages`, a row per message sent, and
c3f1a7b92d04 on `conversation_participants`. The first is fixed — it creates an
index and nothing else, so leaving the transaction costs it no atomicity. The
second is exempt below, with its reason.

An index on a table the same migration creates is a different case and is
allowed: the table is empty and nothing else can be holding a lock on it, and
CONCURRENTLY cannot run in the transaction that created it anyway.
"""

import ast
import pathlib
import re

import pytest

VERSIONS = pathlib.Path(__file__).resolve().parents[1] / "alembic" / "versions"

# Migrations allowed to build on an existing table without CONCURRENTLY, and why.
# Each entry is a decision, not a backlog: adding one means arguing that the lock
# is worth what going concurrent would cost.
EXEMPT = {
    "c3f1a7b92d04": (
        "The index shares a transaction with the add_column it indexes. Splitting "
        "it out would trade a lock for a migration that cannot be retried: the "
        "revision is stamped only when upgrade() returns, so a failure after an "
        "autocommit block leaves the column added, the revision unstamped, and the "
        "retry failing on a column that already exists."
    ),
}

_RAW_CREATE_INDEX = re.compile(
    r"CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"
    r"([\w.\"]+)\s+ON\s+([\w.\"]+)",
    re.IGNORECASE,
)
_RAW_CREATE_TABLE = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.\"]+)", re.IGNORECASE)


def _migrations() -> list[pathlib.Path]:
    """Every revision file, oldest first by name so failures read stably."""
    return sorted(p for p in VERSIONS.glob("*.py") if p.name != "__init__.py")


def _revision_id(path: pathlib.Path) -> str:
    """The revision this file declares, which is what EXEMPT is keyed on."""
    match = re.search(r'^revision(?::\s*str)?\s*=\s*["\']([^"\']+)', path.read_text(), re.M)
    assert match, f"{path.name} declares no revision"
    return match.group(1)


def _string_constants(tree: ast.AST) -> list[str]:
    """Every string literal in the module — where the raw DDL lives."""
    return [n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def _tables_created(tree: ast.AST, sql: str) -> set[str]:
    """Tables this migration creates itself, by either route."""
    created = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create_table"
            and node.args
            and isinstance(node.args[0], ast.Constant)
        ):
            created.add(str(node.args[0].value).strip('"'))
    created.update(m.group(1).strip('"') for m in _RAW_CREATE_TABLE.finditer(sql))
    return created


def _indexes_built(tree: ast.AST, sql: str) -> list[tuple[str, str, bool]]:
    """(index, table, concurrently) for every index this migration creates."""
    built: list[tuple[str, str, bool]] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "create_index"
            and len(node.args) >= 2
            and all(isinstance(a, ast.Constant) for a in node.args[:2])
        ):
            concurrent = any(
                kw.arg == "postgresql_concurrently" and getattr(kw.value, "value", False) is True
                for kw in node.keywords
            )
            built.append((str(node.args[0].value), str(node.args[1].value), concurrent))
    for match in _RAW_CREATE_INDEX.finditer(sql):
        built.append((match.group(2).strip('"'), match.group(3).strip('"'), bool(match.group(1))))
    return built


@pytest.mark.parametrize("path", _migrations(), ids=lambda p: p.name)
def test_an_index_on_an_existing_table_is_built_concurrently(path: pathlib.Path):
    """The rule three migrations state and nothing checked."""
    source = path.read_text()
    tree = ast.parse(source)
    sql = "\n".join(_string_constants(tree))
    created = _tables_created(tree, sql)
    revision = _revision_id(path)

    offenders = [
        (index, table)
        for index, table, concurrent in _indexes_built(tree, sql)
        if table not in created and not concurrent
    ]
    if revision in EXEMPT:
        assert offenders, (
            f"{path.name} is listed in EXEMPT but no longer builds a blocking index. "
            "Remove the entry — an exemption nothing uses reads as though the rule "
            "does not apply here."
        )
        return
    assert not offenders, (
        f"{path.name} builds {', '.join(f'{i} on {t}' for i, t in offenders)} without "
        "CONCURRENTLY, on a table it did not create in this migration. A plain "
        "CREATE INDEX holds SHARE for a full heap scan and blocks every write to "
        "that table while it runs, and production runs migrations before uvicorn "
        "starts. See b7e21c4a9d33 for the pattern, or add an argued entry to EXEMPT."
    )


@pytest.mark.parametrize("path", _migrations(), ids=lambda p: p.name)
def test_concurrent_statements_leave_the_transaction(path: pathlib.Path):
    """CONCURRENTLY outside an autocommit block fails at runtime, not here.

    Alembic wraps a migration in a transaction, and Postgres refuses both CREATE
    and DROP INDEX CONCURRENTLY inside one. Without the block the migration does
    not build a slow index — it raises, on the boot that runs it.
    """
    source = path.read_text()
    if "CONCURRENTLY" not in source.upper():
        pytest.skip("no concurrent DDL")
    assert "autocommit_block()" in source, (
        f"{path.name} uses CONCURRENTLY without op.get_context().autocommit_block(); "
        "Postgres refuses it inside a transaction, so this fails at boot."
    )


@pytest.mark.parametrize("path", _migrations(), ids=lambda p: p.name)
def test_a_concurrent_build_clears_an_invalid_index_first(path: pathlib.Path):
    """A cancelled concurrent build leaves an INVALID index of the same name.

    The revision is stamped only once upgrade() returns, so the retry re-enters
    and has to clear it. CREATE ... IF NOT EXISTS would take the invalid one for
    the finished article; a DROP CONCURRENTLY IF EXISTS first does not.
    """
    source = path.read_text()
    tree = ast.parse(source)
    sql = "\n".join(_string_constants(tree))
    concurrent = [(i, t) for i, t, c in _indexes_built(tree, sql) if c]
    if not concurrent:
        pytest.skip("no concurrent index build")
    dropped = set(re.findall(r"DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+([\w.\"]+)", sql, re.I))
    missing = [index for index, _ in concurrent if index.strip('"') not in {d.strip('"') for d in dropped}]
    assert not missing, (
        f"{path.name} builds {', '.join(missing)} concurrently without dropping it first. "
        "A retry after a cancelled build would find an INVALID index and leave it."
    )


def test_the_guard_sees_the_migrations():
    """Every assertion above passes vacuously on an empty list."""
    paths = _migrations()
    assert len(paths) >= 10, [p.name for p in paths]
    built = sum(
        len(_indexes_built(ast.parse(p.read_text()), "\n".join(_string_constants(ast.parse(p.read_text())))))
        for p in paths
    )
    assert built >= 15, f"only found {built} index builds across {len(paths)} migrations"
