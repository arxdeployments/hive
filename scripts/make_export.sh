#!/usr/bin/env bash
# Build the distributable archive of this repo.
#
# Excludes build output, dependency trees and — critically — any real .env, so
# no live secret ever leaves the machine. Keeps .git: the AWS bootstrap clones
# the app from a git remote, so the recipient needs history to push somewhere.
#
#   ./scripts/make_export.sh ["Hive Export"] [dest-dir]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME="${1:-Hive Export}"
DEST="${2:-$(dirname "$REPO_ROOT")}"
ARCHIVE="$DEST/$NAME.zip"

cd "$REPO_ROOT"

# Refuse to package a dirty tree: an export that doesn't match a commit is not
# reproducible, and the deploy pulls from git rather than from this zip.
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: working tree has uncommitted changes — the archive will not match any commit:" >&2
  git status --porcelain | sed 's/^/  /' >&2
fi

rm -f "$ARCHIVE"

# -x patterns are matched against paths relative to the zip root ("rxhive/").
#
# Each directory is listed TWICE, as `$BASE/<dir>/*` and `$BASE/**/<dir>/*`.
# zip's `**` needs at least one intervening path segment, so a pattern written
# only as `$BASE/**/.ruff_cache/*` silently misses a `.ruff_cache` sitting at the
# repo root — which is exactly where this repo's is, and it shipped.
cd ..
BASE="$(basename "$REPO_ROOT")"

# Directories that must never ship, matched at the root and at any depth.
JUNK_DIRS=(
  .venv node_modules __pycache__ .pytest_cache .ruff_cache .mypy_cache
  .terraform
  # Xcode output. These are the reason an export weighed 1.1 GB across 37,394
  # files instead of ~2 MB across ~3,000: ios/build and ios/build-device alone
  # were 34,352 of them. Both are gitignored — .gitignore calls build-device
  # "884 MB of artefacts that must never be committed" — but this script never
  # excluded them, so the header's promise to exclude build output was false for
  # iOS, and the size check below did not exist to catch it.
  build build-device DerivedData
  # Test and build output.
  dist test-results playwright-report
)

EXCLUDES=()
for d in "${JUNK_DIRS[@]}"; do
  EXCLUDES+=(-x "$BASE/$d/*" -x "$BASE/**/$d/*")
done

# Individual files: secrets, lockfiles that are environment-specific, OS cruft.
EXCLUDES+=(
  # Agent worktrees — full copies of the tree, one per session. Excluded by
  # exact path rather than by excluding all of .claude/, which would also drop
  # the tracked launch.json the repo legitimately ships.
  -x "$BASE/.claude/worktrees/*"
  -x "$BASE/*.tfstate*" -x "$BASE/**/*.tfstate*"
  -x "$BASE/*.tfvars" -x "$BASE/**/*.tfvars"
  -x "$BASE/*.tfvars.json" -x "$BASE/**/*.tfvars.json"
  -x "$BASE/.DS_Store" -x "$BASE/**/.DS_Store"
  # EVERY .env variant, not an enumerated list of the ones anyone thought of.
  # This was `.env` and `.env.local` only, so infra/.env.bak.* — written by the
  # livekit node-ip helper and holding RXHIVE_SECRET_KEY, the Postgres, MinIO,
  # LiveKit and superadmin passwords — shipped in the archive. The leak check
  # below tested for a file named exactly `.env`, so it certified that archive
  # clean. `.env.example` is added back after the sweep; it is a template and is
  # the whole reason a recipient can configure anything.
  -x "$BASE/.env*" -x "$BASE/**/.env*"
  -x "$BASE/data/*"
)

zip -r -q "$ARCHIVE" "$BASE" "${EXCLUDES[@]}"

# Put the templates back. Deliberately after the blanket .env* exclusion above,
# because zip has no "exclude X except Y" and an enumerated exclusion list is
# precisely what let .env.bak through.
zip -r -q "$ARCHIVE" "$BASE" -i "$BASE/.env.example" "$BASE/**/.env.example" \
  -x "$BASE/.claude/worktrees/*"

# The deploy guide and the audit are what a recipient needs first, and nobody
# finds them three directories down. Copy them to the archive root as well —
# `zip -j` stores them with no path. The originals stay in rxhive/docs/ so the
# repo itself is unchanged and nothing goes stale in only one place.
zip -j -q "$ARCHIVE" \
  "$REPO_ROOT/docs/AWS_DEPLOY.md" \
  "$REPO_ROOT/docs/AUDIT_FINDINGS.md"

echo "wrote $ARCHIVE"

# Fail loudly rather than silently shipping a secret or a 300MB dependency tree.
#
# `.tfvars` joined this list: it was in neither the exclusions above nor this
# check, and it is the conventional place to put values that variables.tf marks
# sensitive. Today's file holds only a region, a domain and instance sizes, so
# nothing has shipped — but the .example alongside it is the template operators
# copy and fill in, and the failure mode is silent. The `.example` suffix keeps
# the template itself, which is the whole point of shipping one.
#
# The .env test is now "any .env or .env.<anything> that is not .example",
# rather than "a file named exactly .env" — the latter passed .env.bak.* through
# and reported success.
LEAKED="$(unzip -Z1 "$ARCHIVE" \
  | grep -E '(^|/)\.env(\.|$)|/node_modules/|/\.venv/|\.tfstate|\.tfvars(\.json)?$|/(build|build-device|DerivedData)/|/\.claude/worktrees/' \
  | grep -v '\.example$' || true)"
if [ -n "$LEAKED" ]; then
  echo "ERROR: archive contains files that must not ship:" >&2
  printf '  %s\n' "$LEAKED" >&2
  exit 1
fi

# A file-count ceiling, because the pattern list can only exclude what someone
# thought of. This archive is ~3,000 files; it was 37,394 when two Xcode output
# directories went unlisted, and nothing complained because every check here was
# a name match. A count is the one check that catches the category nobody
# anticipated. Raise the ceiling deliberately if the repo really grows.
FILE_COUNT="$(unzip -Z1 "$ARCHIVE" | wc -l | tr -d ' ')"
MAX_FILES=8000
if [ "$FILE_COUNT" -gt "$MAX_FILES" ]; then
  echo "ERROR: archive has $FILE_COUNT files (ceiling $MAX_FILES) — something large is not excluded." >&2
  echo "Largest directories:" >&2
  unzip -Z1 "$ARCHIVE" | awk -F/ 'NF>2 {print $2"/"$3}' | sort | uniq -c | sort -rn | head -5 >&2
  exit 1
fi

echo "verified: no .env, node_modules, .venv or tfstate in the archive"
echo "files: $(unzip -Z1 "$ARCHIVE" | wc -l | tr -d ' ')   size: $(du -h "$ARCHIVE" | cut -f1)"
