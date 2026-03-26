#!/usr/bin/env bash
# ix-read.sh — PreToolUse hook for Read
#
# Fires before Claude reads a file. Runs ix inventory (all entities in the file)
# and ix overview (structural summary) in parallel and injects results as
# additionalContext so Claude has graph-aware context before reading raw source.
#
# Exit 0 + JSON stdout → injects additionalContext, native Read still runs
# Exit 0 + no stdout  → no-op, Read runs normally

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Skip binary/non-code files
case "$FILE_PATH" in
  *.png|*.jpg|*.jpeg|*.gif|*.ico|*.pdf|*.zip|*.tar|*.gz|*.bin|*.exe) exit 0 ;;
esac

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

# ── Run ix inventory + ix overview in parallel ───────────────────────────────
_inv_tmp=$(mktemp)
_ov_tmp=$(mktemp)
trap 'rm -f "$_inv_tmp" "$_ov_tmp"' EXIT

ix inventory --path "$FILE_PATH" --format json > "$_inv_tmp" 2>/dev/null &
_inv_pid=$!

# Strip extension for a cleaner symbol match
_name=$(basename "$FILE_PATH")
_name="${_name%.*}"
ix overview "$_name" --format json > "$_ov_tmp" 2>/dev/null &
_ov_pid=$!

wait "$_inv_pid" || true
wait "$_ov_pid" || true

INV_RESULT=$(cat "$_inv_tmp")
OV_RESULT=$(cat "$_ov_tmp")

[ -z "$INV_RESULT" ] && [ -z "$OV_RESULT" ] && exit 0

CONTEXT="[ix] Pre-read context for: ${FILE_PATH}"
[ -n "$INV_RESULT" ] && CONTEXT="${CONTEXT}\n\n--- ix inventory (entities in file) ---\n${INV_RESULT}"
[ -n "$OV_RESULT" ]  && CONTEXT="${CONTEXT}\n\n--- ix overview ---\n${OV_RESULT}"

jq -n --arg ctx "$CONTEXT" '{"additionalContext": $ctx}'
exit 0
