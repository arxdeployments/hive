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

# -x patterns are matched against paths relative to the zip root ("rxhive/...").
cd ..
BASE="$(basename "$REPO_ROOT")"
zip -r -q "$ARCHIVE" "$BASE" \
  -x "$BASE/**/.venv/*" \
  -x "$BASE/**/node_modules/*" \
  -x "$BASE/frontend/dist/*" \
  -x "$BASE/**/__pycache__/*" \
  -x "$BASE/**/.pytest_cache/*" \
  -x "$BASE/**/.ruff_cache/*" \
  -x "$BASE/**/.mypy_cache/*" \
  -x "$BASE/**/.terraform/*" \
  -x "$BASE/**/.terraform.lock.hcl" \
  -x "$BASE/**/*.tfstate*" \
  -x "$BASE/frontend/test-results/*" \
  -x "$BASE/frontend/playwright-report/*" \
  -x "$BASE/**/.DS_Store" \
  -x "$BASE/.env" -x "$BASE/**/.env" -x "$BASE/**/.env.local" \
  -x "$BASE/data/*"

echo "wrote $ARCHIVE"

# Fail loudly rather than silently shipping a secret or a 300MB dependency tree.
LEAKED="$(unzip -Z1 "$ARCHIVE" | grep -E '(^|/)\.env$|/node_modules/|/\.venv/|\.tfstate' || true)"
if [ -n "$LEAKED" ]; then
  echo "ERROR: archive contains files that must not ship:" >&2
  echo "$LEAKED" | sed 's/^/  /' >&2
  exit 1
fi

echo "verified: no .env, node_modules, .venv or tfstate in the archive"
echo "files: $(unzip -Z1 "$ARCHIVE" | wc -l | tr -d ' ')   size: $(du -h "$ARCHIVE" | cut -f1)"
