#!/usr/bin/env bash
# Copyright 2026 Ix Infrastructure Inc.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Connect a Project
#
# Connects a project to Ix:
#   1. Prepares the project (`ix init`, deprecated -- kept for older installs)
#   2. Ingests the project's source code into the knowledge graph
#
# It does NOT write rules into CLAUDE.md. It used to say so, and `ix init` used
# to do it; the agent-facing instructions ship as the `ix` skill now.
#
# Usage:
#   ./scripts/connect.sh ~/my-project
#   ./scripts/connect.sh ~/my-project --skip-ingest    # Don't ingest yet
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"
IX_CMD="npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_DIR=""
SKIP_INGEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-ingest) SKIP_INGEST=true; shift ;;
    -h|--help)
      echo "Usage: ./scripts/connect.sh <PROJECT_DIR> [OPTIONS]"
      echo ""
      echo "Connects a project to Ix."
      echo ""
      echo "Arguments:"
      echo "  PROJECT_DIR              Path to the project to connect (required)"
      echo ""
      echo "Options:"
      echo "  --skip-ingest            Don't ingest the codebase yet"
      echo "  -h, --help               Show this help"
      echo ""
      echo "What this does:"
      echo "  1. Prepares the project (ix init)"
      echo "  2. Ingests the project's source code into the knowledge graph"
      echo ""
      echo "To disconnect later:"
      echo "  ./scripts/disconnect.sh ~/my-project"
      exit 0
      ;;
    *)
      if [ -z "$PROJECT_DIR" ] && [ -d "$1" ]; then
        PROJECT_DIR="$1"
      else
        echo "Unknown option or invalid directory: $1"
        echo "Run './scripts/connect.sh --help' for usage."
        exit 1
      fi
      shift
      ;;
  esac
done

# ── Validate ─────────────────────────────────────────────────────────────────

if [ -z "$PROJECT_DIR" ]; then
  echo "Error: Project directory is required."
  echo ""
  echo "Usage: ./scripts/connect.sh <PROJECT_DIR>"
  echo "  e.g. ./scripts/connect.sh ~/my-project"
  exit 1
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

# Check CLI is built
if [ ! -d "$CLI_DIR/dist" ] || [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "Error: CLI is not built. Run first:"
  echo "  ./setup.sh"
  exit 1
fi

# Check backend is running
if ! curl -sf http://localhost:8090/v1/health > /dev/null 2>&1; then
  echo "Error: Backend is not running. Run first:"
  echo "  ./setup.sh"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — Connect Project        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Project: $PROJECT_DIR"
echo ""

# ── Step 1: Prepare the project ──────────────────────────────────────────────

echo "── [1] Prepare ──────────────────────────────────────"

cd "$PROJECT_DIR"
$IX_CMD init --force 2>&1 | grep -v "^$" | grep -v "Initializing\|Next:"

echo ""

# ── Step 2: Ingest codebase ─────────────────────────────────────────────────

if [ "$SKIP_INGEST" = true ]; then
  echo "── [2] Ingest (skipped) ───────────────────────────"
else
  echo "── [2] Ingest Codebase ────────────────────────────"
  cd "$PROJECT_DIR"
  "$IX_DIR/scripts/ingest.sh"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Project connected!                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Project: $PROJECT_DIR"
echo ""
echo "  To disconnect:"
echo "    ./scripts/disconnect.sh $PROJECT_DIR"
echo ""
