#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Ix — Uninstaller
#
# Removes everything installed by the Ix installer:
#   1. ix CLI
#   2. Backend Docker containers + volumes (optional)
#
# Usage:
#   curl -fsSL https://ix-infra.com/uninstall.sh | sh
#
# Options (env vars):
#   IX_KEEP_DATA=1    Keep ArangoDB data volume (default: remove everything)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

IX_HOME="${IX_HOME:-$HOME/.ix}"
IX_BIN="$HOME/.local/bin"
COMPOSE_DIR="$IX_HOME/backend"

info() { printf "  \033[32m[ok]\033[0m %s\n" "$*"; }
warn() { printf "  \033[33m[!!]\033[0m %s\n" "$*"; }

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║       Ix — Uninstall              ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Remove ix CLI ────────────────────────────────────────────────────────

echo ""
echo "── Removing ix CLI ──"

# Remove ix from all known locations
for ix_path in "/usr/local/bin/ix" "$HOME/.local/bin/ix"; do
  if [ -f "$ix_path" ]; then
    rm -f "$ix_path" 2>/dev/null || true
    info "Removed $ix_path"
  fi
done

if [ -d "$IX_HOME/cli" ]; then
  rm -rf "$IX_HOME/cli"
  info "Removed $IX_HOME/cli"
fi

# ── 2. Stop and remove backend ──────────────────────────────────────────────

echo ""
echo "── Removing backend ──"

if [ -f "$COMPOSE_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
  if [ "${IX_KEEP_DATA:-}" = "1" ]; then
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" down 2>/dev/null || true
    info "Stopped backend containers (data volume preserved)"
  else
    docker compose -f "$COMPOSE_DIR/docker-compose.yml" down -v 2>/dev/null || true
    info "Stopped backend and removed data volumes"
  fi
  rm -f "$COMPOSE_DIR/docker-compose.yml"
  rmdir "$COMPOSE_DIR" 2>/dev/null || true
else
  echo "  (no backend compose file found — skipping)"
fi

# ── 3. Clean up IX_HOME ─────────────────────────────────────────────────────

echo ""
echo "── Cleaning up ──"

# Remove IX_HOME if empty
if [ -d "$IX_HOME" ]; then
  rmdir "$IX_HOME" 2>/dev/null && info "Removed $IX_HOME" || \
    warn "$IX_HOME is not empty — kept (remove manually if desired)"
fi

echo ""
echo "  Done. Ix has been uninstalled."
echo ""
echo "  Note: The ~/.local/bin PATH entry in your shell rc was left in place."
echo ""
