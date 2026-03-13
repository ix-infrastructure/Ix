#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# IX-Memory — Release Script (CI-driven)
#
# Bumps versions, tags, and pushes. CI handles building platform archives,
# creating the GitHub Release, and updating the Homebrew formula.
#
# Usage:
#   ./scripts/release.sh 0.1.0          # Release v0.1.0
#   ./scripts/release.sh 0.2.0 --draft  # Release v0.2.0 (CI creates draft)
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Clean working tree on main branch
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: ./scripts/release.sh <version> [--draft]}"
DRAFT=""

if [[ "${2:-}" == "--draft" ]]; then
  DRAFT="true"
fi

TAG="v${VERSION}"

# ── Preflight checks ────────────────────────────────────────────────────────

if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI is required. Install: https://cli.github.com/"
  exit 1
fi

if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet HEAD 2>/dev/null; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "Warning: you are on branch '$CURRENT_BRANCH', not 'main'."
  read -rp "Continue anyway? [y/N] " confirm
  if [[ "$confirm" != [yY] ]]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── Bump versions ───────────────────────────────────────────────────────────

echo "Bumping version to ${VERSION}..."

# build.sbt
sed -i '' "s|ThisBuild / version := \".*\"|ThisBuild / version := \"${VERSION}\"|" "$IX_DIR/build.sbt"
echo "  [ok] build.sbt"

# ix-cli/package.json
cd "$IX_DIR/ix-cli"
npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
cd "$IX_DIR"
echo "  [ok] ix-cli/package.json"

# ── Commit, tag, push ──────────────────────────────────────────────────────

echo ""
echo "Committing version bump..."
git add build.sbt ix-cli/package.json
git commit -m "release: bump version to ${VERSION}"

echo "Creating annotated tag ${TAG}..."
git tag -a "$TAG" -m "Release ${TAG}"

echo "Pushing commit and tag to origin..."
git push origin main --follow-tags

# ── Done ────────────────────────────────────────────────────────────────────

echo ""
echo "[ok] Version ${VERSION} tagged and pushed."
echo ""
echo "CI will now automatically:"
echo "  1. Build platform-specific archives (macOS aarch64/x86_64, Linux x86_64)"
echo "  2. Create the GitHub Release${DRAFT:+ (as draft)}"
echo "  3. Upload release artifacts"
echo "  4. Update the Homebrew formula with the correct SHA256"
echo ""
if [[ -n "$DRAFT" ]]; then
  echo "Note: --draft was specified. The CI-created release will be a draft."
  echo "You will need to manually publish it when ready."
  echo ""
fi
echo "Monitor the release workflow:"
echo "  gh run list --workflow=release.yml"
