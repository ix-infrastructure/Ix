#!/usr/bin/env bash
# ix-plugin/uninstall.sh — Remove the Ix Memory Claude Code plugin
#
# Usage (curl):
#   curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/uninstall.sh | bash
#
# Usage (local):
#   bash ix-plugin/uninstall.sh

set -euo pipefail

INSTALL_DIR="${IX_PLUGIN_DIR:-$HOME/.local/share/ix/plugin/hooks}"
SETTINGS="$HOME/.claude/settings.json"

info() { echo "  [ok] $*"; }

echo ""
echo "── Removing Ix Claude Code plugin ──"

# Remove hook files
if [ -d "$INSTALL_DIR" ]; then
  rm -f "$INSTALL_DIR/ix-intercept.sh" "$INSTALL_DIR/ix-ingest.sh"
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  info "Removed $INSTALL_DIR"
else
  echo "  (hooks directory not found — nothing to remove)"
fi

# Remove hook entries from ~/.claude/settings.json
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  INTERCEPT="$INSTALL_DIR/ix-intercept.sh"
  INGEST="$INSTALL_DIR/ix-ingest.sh"

  tmp=$(mktemp)
  jq --arg intercept "$INTERCEPT" --arg ingest "$INGEST" '
    if .hooks.PreToolUse then
      .hooks.PreToolUse |= map(select(
        (.hooks // []) | map(.command) | any(. == $intercept) | not
      ))
    else . end |
    if .hooks.PostToolUse then
      .hooks.PostToolUse |= map(select(
        (.hooks // []) | map(.command) | any(. == $ingest) | not
      ))
    else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  info "Removed hooks from ~/.claude/settings.json"
else
  echo "  (settings.json not found — nothing to remove)"
fi

echo ""
echo "  Done. Restart Claude Code to deactivate."
echo ""
