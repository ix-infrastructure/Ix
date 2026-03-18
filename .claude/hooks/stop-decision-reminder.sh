#!/usr/bin/env bash
# After each turn, if code was changed, remind Claude to record design decisions.
# Only fires when there are uncommitted changes — silent otherwise.

if git diff --quiet HEAD 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
  exit 0  # no changes, no reminder needed
fi

echo "Code was modified. If a design decision was made, record it:"
echo "  ix decide \"<title>\" --rationale \"<why>\""
exit 0
