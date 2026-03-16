#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Ix — Shutdown
#
# Stops the IX backend (Docker containers + MCP server processes).
# Optionally disconnects projects too.
#
# Usage:
#   ./shutdown.sh                                  # Stop backend only
#   ./shutdown.sh --clean                          # Stop + remove data volumes
#   ./shutdown.sh --disconnect ~/my-project        # Stop + disconnect a project
#   ./shutdown.sh --disconnect ~/app1 ~/app2       # Stop + disconnect multiple
#   ./shutdown.sh --clean --disconnect ~/my-project # Full teardown
# ─────────────────────────────────────────────────────────────────────────────

IX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$IX_DIR"

CLEAN=false
DISCONNECT_PROJECTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=true; shift ;;
    --disconnect)
      shift
      # Collect all following paths until we hit another flag or end
      while [[ $# -gt 0 ]] && [[ "$1" != --* ]]; do
        DISCONNECT_PROJECTS+=("$1")
        shift
      done
      if [ ${#DISCONNECT_PROJECTS[@]} -eq 0 ]; then
        echo "Error: --disconnect requires at least one project path."
        echo "  e.g. ./shutdown.sh --disconnect ~/my-project"
        exit 1
      fi
      ;;
    -h|--help)
      echo "Usage: ./shutdown.sh [OPTIONS]"
      echo ""
      echo "Stops the Ix backend."
      echo ""
      echo "Options:"
      echo "  --clean                      Stop + remove data volumes (fresh start)"
      echo "  --disconnect <path> [paths]  Disconnect projects before stopping"
      echo "  -h, --help                   Show this help"
      echo ""
      echo "Examples:"
      echo "  ./shutdown.sh                                Stop backend only"
      echo "  ./shutdown.sh --disconnect ~/my-app          Stop + disconnect project"
      echo "  ./shutdown.sh --disconnect ~/app1 ~/app2     Stop + disconnect multiple"
      echo "  ./shutdown.sh --clean --disconnect ~/my-app  Full teardown"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — Shutdown               ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Disconnect projects ──────────────────────────────────────────────────────

if [ ${#DISCONNECT_PROJECTS[@]} -gt 0 ]; then
  echo "── Disconnect Projects ────────────────────────────"
  for project in "${DISCONNECT_PROJECTS[@]}"; do
    if [ -d "$project" ]; then
      "$IX_DIR/scripts/disconnect.sh" "$project" 2>&1 | sed 's/^/  /'
    else
      echo "  [!!] Directory not found: $project"
    fi
  done
  echo ""
fi

# ── Stop MCP server processes ────────────────────────────────────────────────

echo "── MCP Server ─────────────────────────────────────"

MCP_PIDS=$(pgrep -f "ix-cli/src/mcp/server.ts" 2>/dev/null || true)
if [ -n "$MCP_PIDS" ]; then
  echo "  Stopping MCP server processes: $MCP_PIDS"
  echo "$MCP_PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  REMAINING=$(pgrep -f "ix-cli/src/mcp/server.ts" 2>/dev/null || true)
  if [ -n "$REMAINING" ]; then
    echo "  Force killing remaining: $REMAINING"
    echo "$REMAINING" | xargs kill -9 2>/dev/null || true
  fi
  echo "  [ok] MCP server stopped"
else
  echo "  [ok] MCP server not running"
fi

# ── Stop Docker containers ───────────────────────────────────────────────────

echo ""
echo "── Docker Containers ──────────────────────────────"

if ! command -v docker &> /dev/null; then
  echo "  [ok] Docker not installed, nothing to stop"
elif ! docker info &> /dev/null 2>&1; then
  echo "  [ok] Docker not running, nothing to stop"
else
  if [ "$CLEAN" = true ]; then
    docker compose down -v 2>&1 | sed 's/^/  /'
    echo "  [ok] Containers stopped and data volumes removed"
  else
    docker compose down 2>&1 | sed 's/^/  /'
    echo "  [ok] Containers stopped (data preserved)"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "IX backend stopped."
if [ "$CLEAN" = true ]; then
  echo "  Data volumes removed. Next './setup.sh' will start fresh."
else
  echo "  Data preserved. Run './setup.sh' to start again."
fi
echo ""
