#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Install MCP Server
#
# Registers the IX MCP server with your IDE so the LLM gets access to
# the 13 IX tools and 2 resources.
#
# Usage:
#   ./scripts/install-mcp.sh                           # Claude Code (default)
#   ./scripts/install-mcp.sh --claude-desktop           # Claude Desktop
#   ./scripts/install-mcp.sh --cursor                   # Cursor
#   ./scripts/install-mcp.sh --claude-code ~/my-project # Claude Code in specific dir
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_DIR="$IX_DIR/ix-cli"
IX_CMD="npx --prefix $CLI_DIR tsx $CLI_DIR/src/cli/main.ts"

# ── Parse arguments ──────────────────────────────────────────────────────────

IDE="claude-code"
PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-desktop) IDE="claude-desktop"; shift ;;
    --cursor)         IDE="cursor"; shift ;;
    --claude-code)    IDE="claude-code"; shift ;;
    -h|--help)
      echo "Usage: ./scripts/install-mcp.sh [IDE] [PROJECT_DIR]"
      echo ""
      echo "IDE Options:"
      echo "  --claude-code       Install for Claude Code (default)"
      echo "  --claude-desktop    Install for Claude Desktop"
      echo "  --cursor            Install for Cursor"
      echo ""
      echo "Arguments:"
      echo "  PROJECT_DIR    Target project directory (default: current directory)"
      echo "                 Only relevant for --claude-code and --cursor"
      echo ""
      echo "What this does:"
      echo "  Writes MCP server config so the IDE auto-launches the IX MCP server."
      echo "  The LLM then gets access to 13 tools (ix_search, ix_decide, etc.)"
      echo "  and 2 resources (ix://session/context, ix://project/intent)."
      echo ""
      echo "Config file locations:"
      echo "  Claude Code:    .claude/settings.json (in project dir)"
      echo "  Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json"
      echo "  Cursor:         .cursor/mcp.json (in project dir)"
      exit 0
      ;;
    *)
      if [ -d "$1" ]; then
        PROJECT_DIR="$1"
      else
        echo "Unknown option or invalid directory: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -d "$CLI_DIR/dist" ] || [ ! -d "$CLI_DIR/node_modules" ]; then
  echo "Error: CLI is not built. Run first:"
  echo "  ./scripts/build-cli.sh"
  exit 1
fi

# ── Install ──────────────────────────────────────────────────────────────────

if [ -n "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR"
fi

echo "Installing IX MCP server for: $IDE"
echo ""

case "$IDE" in
  claude-code)
    $IX_CMD mcp-install --claude-code
    echo ""
    echo "Config written to: $(pwd)/.claude/settings.json"
    echo "Restart Claude Code to activate."
    ;;
  claude-desktop)
    $IX_CMD mcp-install
    echo ""
    echo "Restart Claude Desktop to activate."
    ;;
  cursor)
    $IX_CMD mcp-install --cursor
    echo ""
    echo "Config written to: $(pwd)/.cursor/mcp.json"
    echo "Restart Cursor to activate."
    ;;
esac

echo ""
echo "[ok] MCP server installed"
echo ""
echo "The LLM will now have access to:"
echo "  Tools:     ix_search, ix_ingest, ix_decide, ix_entity, ix_expand,"
echo "             ix_expand, ix_history, ix_truth, ix_diff, ix_conflicts,"
echo "             ix_resolve, ix_assert, ix_patches"
echo "  Resources: ix://session/context, ix://project/intent"
