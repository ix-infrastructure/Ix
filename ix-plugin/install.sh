#!/usr/bin/env bash
# ix-plugin/install.sh — Standalone Claude Code plugin installer for Ix Memory
#
# Usage (curl):
#   curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/install.sh | bash
#
# Usage (local, from the Ix repo):
#   bash ix-plugin/install.sh
#
# What it does:
#   1. Downloads ix-intercept.sh and ix-ingest.sh to ~/.local/share/ix/plugin/hooks/
#   2. Wires them into ~/.claude/settings.json
#
# Prerequisites: ix CLI must already be installed and in PATH.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────

GITHUB_RAW="https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/hooks"
INSTALL_DIR="${IX_PLUGIN_DIR:-$HOME/.local/share/ix/plugin/hooks}"
SETTINGS="$HOME/.claude/settings.json"

# Auth for private repo access
AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
  AUTH_HEADER="Authorization: token ${GITHUB_TOKEN}"
elif command -v gh >/dev/null 2>&1; then
  GH_TOKEN=$(gh auth token 2>/dev/null || true)
  if [ -n "$GH_TOKEN" ]; then
    AUTH_HEADER="Authorization: token ${GH_TOKEN}"
  fi
fi

gcurl() {
  if [ -n "$AUTH_HEADER" ]; then
    curl -fsSL -H "$AUTH_HEADER" "$@"
  else
    curl -fsSL "$@"
  fi
}

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
  warn "Install ix first: see https://github.com/ix-infrastructure/Ix"
fi

# ── Download hooks ────────────────────────────────────────────────────────────

echo ""
echo "── Downloading hooks ──"

mkdir -p "$INSTALL_DIR"

# Detect if we're running from the repo (local install) vs. curl
_repo_hooks=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
  # Hooks live in hooks/ subdir relative to this script
  if [ -f "$_script_dir/hooks/ix-intercept.sh" ]; then
    _repo_hooks="$_script_dir/hooks"
  fi
fi

if [ -n "$_repo_hooks" ]; then
  # Local install — copy from repo
  cp "$_repo_hooks/ix-intercept.sh" "$INSTALL_DIR/ix-intercept.sh"
  cp "$_repo_hooks/ix-ingest.sh"    "$INSTALL_DIR/ix-ingest.sh"
  info "Copied hooks from local repo → $INSTALL_DIR"
else
  # Remote install — download from GitHub
  gcurl "$GITHUB_RAW/ix-intercept.sh" -o "$INSTALL_DIR/ix-intercept.sh"
  gcurl "$GITHUB_RAW/ix-ingest.sh"    -o "$INSTALL_DIR/ix-ingest.sh"
  info "Downloaded hooks → $INSTALL_DIR"
fi

chmod +x "$INSTALL_DIR/ix-intercept.sh" "$INSTALL_DIR/ix-ingest.sh"
info "Permissions set"

# ── Wire Claude Code settings ─────────────────────────────────────────────────

echo ""
echo "── Configuring Claude Code ──"

INTERCEPT="$INSTALL_DIR/ix-intercept.sh"
INGEST="$INSTALL_DIR/ix-ingest.sh"

mkdir -p "$HOME/.claude"
[ -f "$SETTINGS" ] || echo "{}" > "$SETTINGS"

# Idempotent: skip if already wired
already=$(jq --arg cmd "$INTERCEPT" \
  '[.hooks?.PreToolUse[]?.hooks[]?.command? // empty] | map(select(. == $cmd)) | length' \
  "$SETTINGS" 2>/dev/null || echo "0")

if [ "$already" -gt 0 ]; then
  info "Hooks already registered in ~/.claude/settings.json — skipping"
else
  tmp=$(mktemp)
  jq --arg intercept "$INTERCEPT" --arg ingest "$INGEST" '
    .hooks |= (. // {}) |
    .hooks.PreToolUse |= (. // []) |
    .hooks.PreToolUse += [{
      "matcher": "Grep|Glob",
      "hooks": [{ "type": "command", "command": $intercept, "timeout": 10 }]
    }] |
    .hooks.PostToolUse |= (. // []) |
    .hooks.PostToolUse += [{
      "matcher": "Write|Edit|MultiEdit",
      "hooks": [{ "type": "command", "command": $ingest, "timeout": 30 }]
    }]
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  info "Registered hooks → ~/.claude/settings.json"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║   Ix Claude plugin installed!            ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Hooks installed to: $INSTALL_DIR"
echo ""
echo "  Restart Claude Code to activate."
echo ""
echo "  To uninstall:"
echo "    curl -fsSL https://raw.githubusercontent.com/ix-infrastructure/Ix/main/ix-plugin/uninstall.sh | bash"
echo ""
