#!/usr/bin/env bash
# ix-ingest.sh — PostToolUse hook for Write, Edit, MultiEdit, NotebookEdit
#
# Fires after Claude modifies a file. Automatically ingests the changed file
# into the Ix graph so the next query reflects the current code state.
#
# Runs async (does not block Claude's response).

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE_PATH" ] && exit 0

# Bail silently if ix is not in PATH
command -v ix >/dev/null 2>&1 || exit 0

# Bail silently if ix backend is not reachable
ix status >/dev/null 2>&1 || exit 0

# Ingest the modified file
ix ingest "$FILE_PATH" >/dev/null 2>&1 || exit 0

# Inject a short confirmation into Claude's context so it knows the graph is current
jq -n --arg fp "$FILE_PATH" \
  '{"additionalContext": ("[ix] Graph updated — ingested: " + $fp)}'

exit 0
