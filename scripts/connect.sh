#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Connect a Project
#
# Connects a project to Ix:
#   1. Adds IX rules to CLAUDE.md (so Claude follows the IX workflow)
#   2. Ingests the project's source code into the knowledge graph
#
# MCP is optional — the plugin (Claude hooks) is the default integration.
# Pass --mcp to also install an MCP server config.
#
# Usage:
#   ./scripts/connect.sh ~/my-project                  # Plugin only (default)
#   ./scripts/connect.sh ~/my-project --mcp            # Plugin + MCP (Claude Code)
#   ./scripts/connect.sh ~/my-project --mcp cursor     # Plugin + MCP (Cursor)
#   ./scripts/connect.sh ~/my-project --mcp claude-desktop
#   ./scripts/connect.sh ~/my-project --skip-ingest    # Don't ingest yet
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"
IX_CMD="npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_DIR=""
MCP=false
MCP_IDE="claude-code"
SKIP_INGEST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mcp)
      MCP=true
      shift
      # Optional IDE argument: claude-code (default), cursor, claude-desktop
      if [[ $# -gt 0 ]] && [[ "$1" != --* ]]; then
        MCP_IDE="$1"
        shift
      fi
      ;;
    --skip-ingest) SKIP_INGEST=true; shift ;;
    -h|--help)
      echo "Usage: ./scripts/connect.sh <PROJECT_DIR> [OPTIONS]"
      echo ""
      echo "Connects a project to Ix so Claude can use the knowledge graph."
      echo ""
      echo "Arguments:"
      echo "  PROJECT_DIR              Path to the project to connect (required)"
      echo ""
      echo "Options:"
      echo "  --mcp [ide]              Also install MCP server config (optional)"
      echo "                           ide: claude-code (default), cursor, claude-desktop"
      echo "  --skip-ingest            Don't ingest the codebase yet"
      echo "  -h, --help               Show this help"
      echo ""
      echo "What this does:"
      echo "  1. Adds IX rules to CLAUDE.md (mandatory LLM workflow)"
      echo "  2. Ingests the project's source code into the knowledge graph"
      echo "  3. (--mcp only) Writes MCP server config for the specified IDE"
      echo ""
      echo "The plugin (Claude hooks) is installed globally via ./setup.sh."
      echo "MCP is an alternative integration — use --mcp only if you prefer it."
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
if [ "$MCP" = true ]; then
  echo "  MCP:     $MCP_IDE"
fi
echo ""

# ── Step 1: Add IX rules to CLAUDE.md ────────────────────────────────────────

echo "── [1] CLAUDE.md ────────────────────────────────────"

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

# ── Step 3: MCP (opt-in) ────────────────────────────────────────────────────

if [ "$MCP" = true ]; then
  echo ""
  echo "── [3] MCP Config ($MCP_IDE) ──────────────────────"
  cd "$PROJECT_DIR"
  case "$MCP_IDE" in
    claude-code)
      $IX_CMD mcp-install --claude-code
      echo "  Config written to: $(pwd)/.claude/settings.json"
      ;;
    claude-desktop)
      $IX_CMD mcp-install
      ;;
    cursor)
      $IX_CMD mcp-install --cursor
      echo "  Config written to: $(pwd)/.cursor/mcp.json"
      ;;
    *)
      echo "  Unknown IDE '$MCP_IDE'. Valid options: claude-code, cursor, claude-desktop"
      exit 1
      ;;
  esac
  echo "  [ok] MCP server configured — restart your IDE to activate"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Project connected!                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Project: $PROJECT_DIR"
echo ""
echo "  Open $PROJECT_DIR in Claude Code — the Ix plugin is active."
echo ""
echo "  To disconnect:"
echo "    ./scripts/disconnect.sh $PROJECT_DIR"
echo ""
