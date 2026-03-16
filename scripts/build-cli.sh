#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Build CLI
#
# Installs dependencies and compiles the TypeScript CLI + MCP server.
#
# Usage:
#   ./scripts/build-cli.sh             # Install deps + build
#   ./scripts/build-cli.sh --clean     # Remove node_modules + dist, then rebuild
#   ./scripts/build-cli.sh --check     # Just verify CLI is built and working
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"

# ── Preflight ────────────────────────────────────────────────────────────────

check_prerequisites() {
  if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed."
    echo "  Install: https://nodejs.org/ (v18+ required)"
    exit 1
  fi

  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -lt 18 ]; then
    echo "Error: Node.js 18+ required (found $(node -v))"
    exit 1
  fi

  if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed."
    exit 1
  fi
}

# ── Commands ─────────────────────────────────────────────────────────────────

case "${1:---build}" in
  --clean)
    check_prerequisites
    echo "Cleaning CLI build artifacts..."
    rm -rf "$CLI_DIR/node_modules" "$CLI_DIR/dist"
    echo "[ok] Cleaned"

    echo "Installing dependencies..."
    cd "$CLI_DIR"
    npm install --silent
    echo "[ok] Dependencies installed"

    echo "Building CLI..."
    npm run build
    echo "[ok] CLI built: $CLI_DIR/dist/"
    ;;

  --check)
    if [ ! -d "$CLI_DIR/dist" ]; then
      echo "[!!] CLI is not built. Run: ./scripts/build-cli.sh"
      exit 1
    fi
    if [ ! -d "$CLI_DIR/node_modules" ]; then
      echo "[!!] Dependencies not installed. Run: ./scripts/build-cli.sh"
      exit 1
    fi
    echo "[ok] CLI is built at $CLI_DIR/dist/"
    ;;

  --build|*)
    # Skip if already built and node_modules exist
    if [ -d "$CLI_DIR/dist" ] && [ -d "$CLI_DIR/node_modules" ]; then
      echo "[ok] CLI is already built (use --clean to force rebuild)"
      exit 0
    fi

    check_prerequisites

    if [ ! -d "$CLI_DIR/node_modules" ]; then
      echo "Installing dependencies..."
      cd "$CLI_DIR"
      npm install --silent
      echo "[ok] Dependencies installed"
    else
      echo "[ok] Dependencies already installed"
      cd "$CLI_DIR"
    fi

    echo "Building CLI..."
    npm run build
    echo "[ok] CLI built: $CLI_DIR/dist/"

    echo ""
    echo "Run the CLI with:"
    echo "  npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts status"
    ;;
esac
