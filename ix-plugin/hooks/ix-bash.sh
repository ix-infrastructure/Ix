#!/usr/bin/env bash
# ix-bash.sh — PreToolUse hook for Bash
#
# Fires before Claude runs a Bash command. Detects grep/rg search patterns and
# front-runs them with ix text + ix locate for graph-aware, token-efficient
# results before the raw shell command executes.
#
# Exit 0 + JSON stdout → injects additionalContext, Bash still runs
# Exit 0 + no stdout  → no-op, Bash runs normally

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$COMMAND" ] && exit 0

# Only intercept grep/rg invocations
echo "$COMMAND" | grep -qE '^\s*(grep|rg)\s' || exit 0

# Bail silently if ix is not in PATH
command -v ix >/dev/null 2>&1 || exit 0

# ── Health check with 30s TTL cache ─────────────────────────────────────────
IX_HEALTH_CACHE="${TMPDIR:-/tmp}/ix-healthy"
_now=$(date +%s)
_cache_ok=0
if [ -f "$IX_HEALTH_CACHE" ]; then
  _cached=$(cat "$IX_HEALTH_CACHE" 2>/dev/null || echo 0)
  (( (_now - _cached) < 30 )) && _cache_ok=1
fi
if [ "$_cache_ok" -eq 0 ]; then
  ix status >/dev/null 2>&1 || exit 0
  echo "$_now" > "$IX_HEALTH_CACHE"
fi

# ── Extract search pattern ────────────────────────────────────────────────────
# Try double-quoted pattern first, then single-quoted, then unquoted
PATTERN=""
PATTERN=$(echo "$COMMAND" | sed -E 's/.*\s"([^"]+)".*/\1/' 2>/dev/null) || PATTERN=""
if [ -z "$PATTERN" ] || [ "$PATTERN" = "$COMMAND" ]; then
  PATTERN=$(echo "$COMMAND" | sed -E "s/.*\s'([^']+)'.*/\1/" 2>/dev/null) || PATTERN=""
fi
if [ -z "$PATTERN" ] || [ "$PATTERN" = "$COMMAND" ]; then
  # Unquoted: grab first non-flag token after command name
  PATTERN=$(echo "$COMMAND" | sed -E 's/^\s*(grep|rg)\s+(-[a-zA-Z0-9]+\s+|--[a-zA-Z-]+=\S+\s+)*([^-][^ ]*).*/\3/' 2>/dev/null) || PATTERN=""
fi

[ -z "$PATTERN" ] && exit 0
[ ${#PATTERN} -lt 2 ] && exit 0

# ── Run ix text + ix locate in parallel ─────────────────────────────────────
_text_tmp=$(mktemp)
_locate_tmp=$(mktemp)
trap 'rm -f "$_text_tmp" "$_locate_tmp"' EXIT

ix text "$PATTERN" --limit 20 --format json > "$_text_tmp" 2>/dev/null &
_text_pid=$!
ix locate "$PATTERN" --limit 10 --format json > "$_locate_tmp" 2>/dev/null &
_locate_pid=$!

wait "$_text_pid" || true
wait "$_locate_pid" || true

TEXT_RESULT=$(cat "$_text_tmp")
LOCATE_RESULT=$(cat "$_locate_tmp")

[ -z "$TEXT_RESULT" ] && [ -z "$LOCATE_RESULT" ] && exit 0

CONTEXT="[ix] Pre-bash search results for pattern: '${PATTERN}'"
[ -n "$TEXT_RESULT" ]   && CONTEXT="${CONTEXT}\n\n--- ix text ---\n${TEXT_RESULT}"
[ -n "$LOCATE_RESULT" ] && CONTEXT="${CONTEXT}\n\n--- ix locate ---\n${LOCATE_RESULT}"

jq -n --arg ctx "$CONTEXT" '{"additionalContext": $ctx}'
exit 0
