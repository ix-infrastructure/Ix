#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# IX-Memory — Initialize Project
#
# Initializes IX in a target project directory:
#   - Verifies backend is running
#   - Creates ~/.ix/config.yaml
#   - Creates CLAUDE.md with mandatory LLM rules
#
# Usage:
#   ./scripts/init-project.sh                    # Initialize current directory
#   ./scripts/init-project.sh ~/my-project       # Initialize specific project
#   ./scripts/init-project.sh ~/my-project --force  # Overwrite existing CLAUDE.md
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"
IX_CMD="npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_DIR=""
FORCE=""

for arg in "$@"; do
  case "$arg" in
    --force) FORCE="--force" ;;
    -h|--help)
      echo "Usage: ./scripts/init-project.sh [PROJECT_DIR] [--force]"
      echo ""
      echo "Arguments:"
      echo "  PROJECT_DIR    Target project directory (default: current directory)"
      echo ""
      echo "Options:"
      echo "  --force        Overwrite existing CLAUDE.md"
      echo "  -h, --help     Show this help"
      echo ""
      echo "What this does:"
      echo "  1. Checks that the IX backend is running"
      echo "  2. Creates ~/.ix/config.yaml with endpoint settings"
      echo "  3. Creates CLAUDE.md in the project with mandatory LLM rules"
      exit 0
      ;;
    *) PROJECT_DIR="$arg" ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

# Verify CLI is built
if [ ! -d "$CLI_DIR/dist" ] || [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "Error: CLI is not built. Run first:"
  echo "  ./scripts/build-cli.sh"
  exit 1
fi

# Verify backend is running
if ! curl -sf http://localhost:8090/v1/health > /dev/null 2>&1; then
  echo "Error: Backend is not running. Start it first:"
  echo "  ./scripts/backend.sh up"
  exit 1
fi

# ── Initialize ───────────────────────────────────────────────────────────────

if [ -n "$PROJECT_DIR" ]; then
  if [ ! -d "$PROJECT_DIR" ]; then
    echo "Error: Directory does not exist: $PROJECT_DIR"
    exit 1
  fi
  cd "$PROJECT_DIR"
fi

PROJECT_PATH="$(pwd)"
echo "Initializing IX in: $PROJECT_PATH"
echo ""

$IX_CMD init $FORCE

echo ""
echo "[ok] Project initialized"
echo "  Config:    ~/.ix/config.yaml"
echo "  Rules:     $PROJECT_PATH/CLAUDE.md"
