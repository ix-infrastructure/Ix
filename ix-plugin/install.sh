#!/usr/bin/env bash
# ix-plugin/install.sh — Standalone Claude Code plugin installer for Ix Memory
#
# Usage (curl):
#   curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/ix-plugin/install.sh | bash
#
# Usage (local, from the Ix repo):
#   bash ix-plugin/install.sh
#
# What it does:
#   1. Copies/downloads all hook scripts to ~/.local/share/ix/plugin/hooks/
#   2. Wires them into ~/.claude/settings.json
#
# Prerequisites: ix CLI must already be installed and in PATH.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

GITHUB_RAW="https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/ix-plugin/hooks"
INSTALL_DIR="${IX_PLUGIN_DIR:-$HOME/.local/share/ix/plugin/hooks}"
SETTINGS="$HOME/.claude/settings.json"

HOOKS=(
  "ix-briefing.sh"
  "ix-intercept.sh"
  "ix-read.sh"
  "ix-bash.sh"
  "ix-ingest.sh"
  "ix-map.sh"
)

# ── Helpers ───────────────────────────────────────────────────────────────────

info()  { echo "  [ok] $*"; }
warn()  { echo "  [!!] $*" >&2; }
die()   { echo "  [error] $*" >&2; exit 1; }

# ── Dependency check ──────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Ix Memory — Claude Code plugin         ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "── Checking dependencies ──"

for dep in jq curl; do
  command -v "$dep" >/dev/null 2>&1 || die "Required tool not found: $dep"
done
info "curl, jq"

if ! command -v ix >/dev/null 2>&1; then
  warn "'ix' not found in PATH — hooks will be installed but won't activate until ix is installed."
  warn "Install ix first: see https://github.com/ix-infrastructure/IX-Memory"
fi

# ── Download / copy hooks ─────────────────────────────────────────────────────

echo ""
echo "── Installing hooks ──"

mkdir -p "$INSTALL_DIR"

# Detect if we're running from the repo (local install) vs. curl
_repo_hooks=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  if [ -f "$_script_dir/hooks/ix-intercept.sh" ]; then
    _repo_hooks="$_script_dir/hooks"
  fi
fi

for hook in "${HOOKS[@]}"; do
  if [ -n "$_repo_hooks" ]; then
    cp "$_repo_hooks/$hook" "$INSTALL_DIR/$hook"
  else
    curl -fsSL "$GITHUB_RAW/$hook" -o "$INSTALL_DIR/$hook"
  fi
  chmod +x "$INSTALL_DIR/$hook"
  info "$hook → $INSTALL_DIR"
done

# ── Wire Claude Code settings ─────────────────────────────────────────────────

echo ""
echo "── Configuring Claude Code ──"

BRIEFING="$INSTALL_DIR/ix-briefing.sh"
INTERCEPT="$INSTALL_DIR/ix-intercept.sh"
READ_HOOK="$INSTALL_DIR/ix-read.sh"
BASH_HOOK="$INSTALL_DIR/ix-bash.sh"
INGEST="$INSTALL_DIR/ix-ingest.sh"
MAP_HOOK="$INSTALL_DIR/ix-map.sh"

mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || echo "{}" > "$SETTINGS"

# Idempotent: skip if already wired (check for intercept hook as sentinel)
already=$(jq --arg cmd "$INTERCEPT" \
  '[.hooks?.PreToolUse[]?.hooks[]?.command? // empty] | map(select(. == $cmd)) | length' \
  "$SETTINGS" 2>/dev/null || echo "0")

if [ "$already" -gt 0 ]; then
  info "Hooks already registered in ~/.claude/settings.json — skipping"
else
  tmp=$(mktemp)
  jq \
    --arg briefing "$BRIEFING" \
    --arg intercept "$INTERCEPT" \
    --arg read_hook "$READ_HOOK" \
    --arg bash_hook "$BASH_HOOK" \
    --arg ingest "$INGEST" \
    --arg map_hook "$MAP_HOOK" '
    .hooks |= (. // {}) |

    .hooks.UserPromptSubmit |= (. // []) |
    .hooks.UserPromptSubmit += [
      {
        "hooks": [{ "type": "command", "command": $briefing, "timeout": 10 }]
      }
    ] |

    .hooks.PreToolUse |= (. // []) |
    .hooks.PreToolUse += [
      {
        "matcher": "Grep|Glob",
        "hooks": [{ "type": "command", "command": $intercept, "timeout": 10 }]
      },
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": $read_hook, "timeout": 8 }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": $bash_hook, "timeout": 10 }]
      }
    ] |

    .hooks.PostToolUse |= (. // []) |
    .hooks.PostToolUse += [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [{ "type": "command", "command": $ingest, "timeout": 30, "async": true }]
      }
    ] |

    .hooks.Stop |= (. // []) |
    .hooks.Stop += [
      {
        "hooks": [{ "type": "command", "command": $map_hook, "timeout": 60, "async": true }]
      }
    ]
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  info "Registered all hooks → ~/.claude/settings.json"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Ix Claude plugin installed!            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Hooks installed to: $INSTALL_DIR"
echo ""
echo "  Active hooks:"
echo "    UserPromptSubmit            → ix briefing (session context on every prompt)"
echo "    PreToolUse  Grep|Glob       → ix text + ix locate (graph-aware search)"
echo "    PreToolUse  Read            → ix inventory + ix overview (file context)"
echo "    PreToolUse  Bash (grep/rg)  → ix text + ix locate (shell search intercept)"
echo "    PostToolUse Write|Edit|...  → ix ingest (auto-update graph after edits)"
echo "    Stop                        → ix map (full graph refresh after session)"
echo ""
echo "  Restart Claude Code to activate."
echo ""
echo "  To uninstall:"
echo "    bash ix-plugin/uninstall.sh"
echo "    # or:"
echo "    curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/IX-Memory/main/ix-plugin/uninstall.sh | bash"
echo ""
