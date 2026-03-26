#!/usr/bin/env bash
# ix-briefing.sh — UserPromptSubmit hook
#
# Fires at the start of each user prompt. Injects a compact ix session briefing
# once per 10 minutes — simulating "on session open" behaviour. Subsequent
# prompts within the window are no-ops (no tokens consumed).
#
# Exit 0 + JSON stdout → injects additionalContext into the prompt
# Exit 0 + no stdout  → no-op

set -euo pipefail

BRIEFING_TTL=600  # 10 minutes

# Bail silently if ix is not in PATH
command -v ix >/dev/null 2>&1 || exit 0

IX_BRIEFING_CACHE="${TMPDIR:-/tmp}/ix-briefing-cache"
_now=$(date +%s)

# If cache exists and is fresh, stay silent (briefing already injected this session)
if [ -f "$IX_BRIEFING_CACHE" ]; then
  _cached_time=$(head -1 "$IX_BRIEFING_CACHE" 2>/dev/null || echo 0)
  if (( (_now - _cached_time) < BRIEFING_TTL )); then
    exit 0
  fi
fi

# Cache is stale — check backend health before calling ix
ix status >/dev/null 2>&1 || exit 0

BRIEFING=$(ix briefing --format json 2>/dev/null) || exit 0
[ -z "$BRIEFING" ] && exit 0

# Write timestamp + briefing to cache
{ echo "$_now"; echo "$BRIEFING"; } > "$IX_BRIEFING_CACHE"

jq -n --arg b "$BRIEFING" \
  '{"additionalContext": ("[ix] Session briefing:\n" + $b)}'
exit 0
