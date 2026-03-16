#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Release Script
#
# Creates a GitHub release with a tarball suitable for Homebrew installation.
#
# Usage:
#   ./scripts/release.sh 0.1.0          # Create release v0.1.0
#   ./scripts/release.sh 0.2.0 --draft  # Create draft release
#
# Prerequisites:
#   - gh CLI installed and authenticated
#   - Clean working tree on main branch
#   - CLI builds successfully
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:?Usage: ./scripts/release.sh <version> [--draft]}"
DRAFT_FLAG=""

if [[ "${2:-}" == "--draft" ]]; then
  DRAFT_FLAG="--draft"
fi

TAG="v${VERSION}"

# ── Preflight ────────────────────────────────────────────────────────────────

if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI is required. Install: https://cli.github.com/"
  exit 1
fi

# Verify CLI builds
echo "Verifying CLI build..."
cd "$IX_DIR/ix-cli"
npm install --silent
npm run build
echo "[ok] CLI builds successfully"

# Update version in package.json
cd "$IX_DIR/ix-cli"
npm version "$VERSION" --no-git-tag-version --allow-same-version 2>/dev/null || true
cd "$IX_DIR"

# ── Create release ───────────────────────────────────────────────────────────

echo ""
echo "Creating release $TAG..."

# Create and push tag
git tag -a "$TAG" -m "Release $TAG"
git push origin "$TAG"

# Create GitHub release
gh release create "$TAG" \
  --title "Ix $TAG" \
  --notes "## Ix $TAG

### Install via Homebrew
\`\`\`bash
brew tap ix-infrastructure/ix https://github.com/ix-infrastructure/Ix
brew install ix
\`\`\`

### Install manually
\`\`\`bash
git clone https://github.com/ix-infrastructure/Ix
cd Ix && ./scripts/build-cli.sh
\`\`\`
" $DRAFT_FLAG

# ── Update Homebrew formula ─────────────────────────────────────────────────

echo ""
echo "Fetching release tarball SHA..."
TARBALL_URL="https://github.com/ix-infrastructure/Ix/archive/refs/tags/${TAG}.tar.gz"
SHA256=$(curl -sL "$TARBALL_URL" | shasum -a 256 | cut -d' ' -f1)

echo "Updating Homebrew formula..."
sed -i '' "s|url \".*\"|url \"${TARBALL_URL}\"|" "$IX_DIR/homebrew/ix.rb"
sed -i '' "s|# sha256 .*|sha256 \"${SHA256}\"|" "$IX_DIR/homebrew/ix.rb"

echo ""
echo "[ok] Release $TAG created"
echo "     Tarball: $TARBALL_URL"
echo "     SHA256:  $SHA256"
echo ""
echo "Formula updated at: homebrew/ix.rb"
echo ""
echo "To publish the tap, push the updated formula:"
echo "  git add homebrew/ix.rb"
echo "  git commit -m \"brew: update formula for $TAG\""
echo "  git push origin main"
