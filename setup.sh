#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# IX-Memory — Setup
#
# Starts the IX backend (ArangoDB + Memory Layer) and builds the CLI.
# This runs from the IX-Memory repo — it does NOT touch your projects.
#
# To connect a project, run: ./scripts/connect.sh ~/my-project
#
# Usage:
#   ./setup.sh                  # Start backend + build CLI
#   ./setup.sh --skip-backend   # Just build CLI (backend already running)
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SKIP_BACKEND=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backend) SKIP_BACKEND=true; shift ;;
    -h|--help)
      echo "Usage: ./setup.sh [OPTIONS]"
      echo ""
      echo "Starts the IX-Memory backend and builds the CLI."
      echo ""
      echo "Options:"
      echo "  --skip-backend   Skip backend startup (if already running)"
      echo "  -h, --help       Show this help"
      echo ""
      echo "After setup, connect a project:"
      echo "  ./scripts/connect.sh ~/my-project"
      echo ""
      echo "Individual scripts:"
      echo "  ./scripts/backend.sh        Start/stop Docker containers"
      echo "  ./scripts/build-cli.sh      Build the TypeScript CLI"
      echo "  ./scripts/connect.sh        Connect a project (MCP + CLAUDE.md + ingest)"
      echo "  ./scripts/disconnect.sh     Disconnect a project"
      echo "  ./scripts/ingest.sh         Ingest files into the graph"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      echo "Run './setup.sh --help' for usage."
      exit 1
      ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       IX-Memory — Setup                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Step 1: Backend ──────────────────────────────────────────────────────────

echo "── [1] Backend ────────────────────────────────────"
if [ "$SKIP_BACKEND" = true ]; then
  echo "  (skipped via --skip-backend)"
  if ! "$IX_DIR/scripts/backend.sh" check 2>/dev/null; then
    echo "  Warning: Backend is not responding."
  fi
else
  "$IX_DIR/scripts/backend.sh" up
fi

echo ""

# ── Step 2: Build CLI ────────────────────────────────────────────────────────

echo "── [2] Build CLI ──────────────────────────────────"
"$IX_DIR/scripts/build-cli.sh"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       IX backend is ready!               ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Backend:  http://localhost:8090"
echo "  ArangoDB: http://localhost:8529"
echo ""
echo "  Next: connect a project to IX:"
echo "    ./scripts/connect.sh ~/my-project"
echo ""
echo "  Or with a specific IDE:"
echo "    ./scripts/connect.sh ~/my-project --cursor"
echo ""
