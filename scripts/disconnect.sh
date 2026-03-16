#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Disconnect a Project
#
# Removes Ix from a project:
#   1. Removes .mcp.json (so Claude Code no longer sees IX tools)
#   2. Removes IX rules from CLAUDE.md (preserves other content)
#
# Does NOT stop the backend or delete data from the graph.
#
# Usage:
#   ./scripts/disconnect.sh ~/my-project
# ─────────────────────────────────────────────────────────────────────────────

IX_MARKER_START="<!-- IX-MEMORY START -->"
IX_MARKER_END="<!-- IX-MEMORY END -->"

# ── Parse arguments ──────────────────────────────────────────────────────────

PROJECT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      echo "Usage: ./scripts/disconnect.sh <PROJECT_DIR>"
      echo ""
      echo "Removes Ix config from a project."
      echo ""
      echo "What this does:"
      echo "  1. Removes .mcp.json (MCP server config)"
      echo "  2. Removes IX rules from CLAUDE.md (preserves other content)"
      echo ""
      echo "Does NOT stop the backend or delete graph data."
      echo "The project's data stays in the graph — reconnect anytime."
      exit 0
      ;;
    *)
      if [ -z "$PROJECT_DIR" ] && [ -d "$1" ]; then
        PROJECT_DIR="$1"
      else
        echo "Unknown option or invalid directory: $1"
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  echo "Error: Project directory is required."
  echo ""
  echo "Usage: ./scripts/disconnect.sh <PROJECT_DIR>"
  echo "  e.g. ./scripts/disconnect.sh ~/my-project"
  exit 1
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"

echo ""
echo "Disconnecting Ix from: $PROJECT_DIR"
echo ""

# ── Remove .mcp.json ────────────────────────────────────────────────────────

echo "── MCP Config ─────────────────────────────────────"

MCP_JSON="$PROJECT_DIR/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  rm -f "$MCP_JSON"
  echo "  [ok] Removed .mcp.json"
else
  echo "  [ok] No .mcp.json found"
fi

# ── Remove IX rules from CLAUDE.md ──────────────────────────────────────────

echo ""
echo "── CLAUDE.md ──────────────────────────────────────"

CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  if grep -q "$IX_MARKER_START" "$CLAUDE_MD"; then
    sed -i.bak "/$IX_MARKER_START/,/$IX_MARKER_END/d" "$CLAUDE_MD"
    sed -i.bak -e :a -e '/^\n*$/{$d;N;ba' -e '}' "$CLAUDE_MD"
    rm -f "${CLAUDE_MD}.bak"

    if [ ! -s "$CLAUDE_MD" ] || ! grep -q '[^[:space:]]' "$CLAUDE_MD"; then
      rm -f "$CLAUDE_MD"
      echo "  [ok] Removed CLAUDE.md (was only IX rules)"
    else
      echo "  [ok] Removed IX rules from CLAUDE.md"
    fi
  else
    echo "  [ok] No IX rules found in CLAUDE.md"
  fi
else
  echo "  [ok] No CLAUDE.md found"
fi

echo ""
echo "[ok] Project disconnected."
echo "  Graph data preserved — run './scripts/connect.sh $PROJECT_DIR' to reconnect."
echo ""
