#!/usr/bin/env bash
#
# Install the Ix skill so Claude Code and Freebuff can use it.
#
# Deploys skills/ix to:
#   ~/.claude/skills/ix   — Claude Code (global)
#   ~/.agents/skills/ix   — Freebuff / Codebuff (global)
#
# Freebuff's skill loader searches ~/.claude/skills, ~/.agents/skills, and the
# project's .claude/skills and .agents/skills, so a global install makes the
# skill available in every project. Re-run after editing skills/ix.
#
# Usage: bash scripts/install-skill.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills/ix"
[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found" >&2; exit 1; }

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

installed=0
for dest in "$HOME/.claude/skills/ix" "$HOME/.agents/skills/ix"; do
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ]; then
    # Refuse to delete something that is not a previous install of this skill.
    # `ix` is a short name, and the unconditional `rm -rf` this replaces would
    # silently destroy a hand-written skill that happened to share it — with no
    # prompt, no backup, and nothing in the output to say it had happened.
    if [ "$FORCE" != "1" ] && ! grep -qs '^name: ix$' "$dest/SKILL.md"; then
      echo "error: $dest exists and is not an Ix skill install." >&2
      echo "       Move it aside, or re-run with --force to overwrite it." >&2
      exit 1
    fi
    rm -rf "$dest"
  fi
  cp -R "$SRC" "$dest"
  echo "Installed: $dest"
  installed=1
done

if [ "$installed" = "1" ]; then
  echo
  echo "Ix skill installed for Claude Code and Freebuff."
  echo "Start a new session so the agent picks it up, then ask it to use Ix:"
  echo "  \"Set up Ix and map this repo\""
fi
