#!/usr/bin/env bash
# ix-plugin/uninstall.sh — Remove the Ix Memory Claude Code plugin

set -euo pipefail

INSTALL_DIR="${IX_PLUGIN_DIR:-$HOME/.local/share/ix/plugin/hooks}"
SETTINGS="$HOME/.claude/settings.json"

info() { echo "  [ok] $*"; }

echo ""
echo "── Removing Ix Claude Code plugin ──"

# Remove hook files
if [ -d "$INSTALL_DIR" ]; then
  rm -f \
    "$INSTALL_DIR/ix-briefing.sh" \
    "$INSTALL_DIR/ix-intercept.sh" \
    "$INSTALL_DIR/ix-read.sh" \
    "$INSTALL_DIR/ix-bash.sh" \
    "$INSTALL_DIR/ix-ingest.sh" \
    "$INSTALL_DIR/ix-map.sh"
  rmdir "$INSTALL_DIR" 2>/dev/null || true
  info "Removed $INSTALL_DIR"
else
  echo "  (hooks directory not found — nothing to remove)"
fi

# Remove hook entries from ~/.claude/settings.json
if [ -f "$SETTINGS" ] && command -v jq >/dev/null 2>&1; then
  BRIEFING="$INSTALL_DIR/ix-briefing.sh"
  INTERCEPT="$INSTALL_DIR/ix-intercept.sh"
  READ_HOOK="$INSTALL_DIR/ix-read.sh"
  BASH_HOOK="$INSTALL_DIR/ix-bash.sh"
  INGEST="$INSTALL_DIR/ix-ingest.sh"
  MAP_HOOK="$INSTALL_DIR/ix-map.sh"

  _ix_cmds=$(jq -n \
    --arg a "$BRIEFING" --arg b "$INTERCEPT" \
    --arg c "$READ_HOOK" --arg d "$BASH_HOOK" \
    --arg e "$INGEST" --arg f "$MAP_HOOK" \
    '[$a,$b,$c,$d,$e,$f]')

  tmp=$(mktemp)
  jq --argjson ix_cmds "$_ix_cmds" '
    def is_ix_hook: (.hooks // []) | map(.command) | any(. as $c | $ix_cmds | any(. == $c));

    if .hooks.UserPromptSubmit then .hooks.UserPromptSubmit |= map(select(is_ix_hook | not)) else . end |
    if .hooks.PreToolUse       then .hooks.PreToolUse       |= map(select(is_ix_hook | not)) else . end |
    if .hooks.PostToolUse      then .hooks.PostToolUse      |= map(select(is_ix_hook | not)) else . end |
    if .hooks.Stop             then .hooks.Stop             |= map(select(is_ix_hook | not)) else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  info "Removed hooks from ~/.claude/settings.json"
else
  echo "  (settings.json not found or jq unavailable — nothing to remove)"
fi

echo ""
echo "  Done. Restart Claude Code to deactivate."
echo ""
