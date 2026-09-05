#!/usr/bin/env bash
#
# Install the Ix skill for every agent harness found on this machine.
#
# skills/ix is a single, harness-agnostic skill (SKILL.md + references/ +
# scripts/). Each agent harness loads skills from its own directory, so this
# script probes for installed harnesses and deploys the same tree to each one
# that is present.
#
# The harness table is NOT maintained here: it lives as an explicit, small
# registry in ix-cli/scripts/skill-harnesses.mjs (claude, agents, codex,
# cursor), where each entry's skill directory has been verified against the
# harness's actual convention — Cursor reads ~/.cursor/skills-cursor, and
# gemini/opencode/openclaw/vscode have no skills convention, so they are not
# install targets. Adding a harness is a deliberate one-line edit there.
#
# Presence is decided by the helper (`--probe`): a harness is present when its
# CLI is found or its config directory exists, so a GUI-only install is still
# found. When TOOLSCAN_PATH is set (opt-in — this script never executes a
# bare `toolscan` name from PATH), its discovery output scans the common
# install roots beyond PATH; otherwise the embedded PATH probe decides —
# toolscan is optional and purely additive, so a clean machine behaves
# exactly the same. Re-run after editing skills/ix to update every installed
# copy.
#
# Usage:
#   bash scripts/install-skill.sh            # install to every harness found
#   bash scripts/install-skill.sh --dry-run  # show the targets, write nothing
#   bash scripts/install-skill.sh --force    # overwrite a same-name foreign skill
#   bash scripts/install-skill.sh claude codex  # explicit harness ids only
#   bash scripts/install-skill.sh --dry-run --json  # machine-readable report (see below)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/skills/ix"
[ -f "$SRC/SKILL.md" ] || { echo "error: $SRC/SKILL.md not found" >&2; exit 1; }

FORCE=0
DRY_RUN=0
JSON=0
EXPLICIT=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --json) JSON=1 ;;
    -*) echo "error: unknown option $arg" >&2; exit 1 ;;
    *) EXPLICIT+=("$arg") ;;
  esac
done

# A machine-readable report replaces the human output: one object per harness
# with the action this run takes (would-install | would-refuse | installed |
# refused | skip) and `detectedVia` — the probe that decided presence
# (toolscan | path | config-dir | none), mirroring `ix mcp install`'s report.
# CI asserts the JSON fields instead of grepping the human lines.

# --- Read the harness registry (hosts.ts via the helper, no built CLI) ------
HELPER="$ROOT/ix-cli/scripts/skill-harnesses.mjs"
if [ ! -f "$HELPER" ]; then
  echo "error: $HELPER not found (the harness registry helper)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to read the harness registry (ix-cli/src/mcp/hosts.ts)" >&2
  exit 1
fi

HELPER_OUT="$(node "$HELPER" --probe)" || {
  echo "error: harness registry helper failed — see its stderr above" >&2
  exit 1
}
IDS=() LABELS=() BINS=() CFGS=() DESTS=() PRESENT=() VIAS=()
while IFS= read -r row; do
  IFS='|' read -r id label bin cfg skill present via <<<"$row"
  [ -z "$cfg" ] && { echo "error: harness '$id' has no config-dir convention" >&2; exit 1; }
  cfg="${cfg//\~/$HOME}"
  skill="${skill//\~/$HOME}"
  IDS+=("$id"); LABELS+=("$label"); BINS+=("$bin"); CFGS+=("$cfg"); DESTS+=("$skill/ix"); PRESENT+=("$present"); VIAS+=("$via")
done <<<"$HELPER_OUT"

if [ "${#IDS[@]}" = "0" ]; then
  echo "error: harness registry produced no entries" >&2
  exit 1
fi

# --- Explicit harness id selection (unknown ids are an error, not a no-op) ---
if [ "${#EXPLICIT[@]}" -gt 0 ]; then
  all="${IDS[*]}"
  for id in "${EXPLICIT[@]}"; do
    case " $all " in
      *" $id "*) ;;
      *) echo "error: unknown harness id '$id'" >&2
         echo "       valid ids:${all}" >&2
         exit 1 ;;
    esac
  done
  want=" ${EXPLICIT[*]} "
  o_ids=("${IDS[@]}"); o_labels=("${LABELS[@]}"); o_bins=("${BINS[@]}")
  o_cfgs=("${CFGS[@]}"); o_dests=("${DESTS[@]}"); o_present=("${PRESENT[@]}"); o_vias=("${VIAS[@]}")
  IDS=(); LABELS=(); BINS=(); CFGS=(); DESTS=(); PRESENT=(); VIAS=()
  for ((i = 0; i < ${#o_ids[@]}; i++)); do
    case "$want" in
      *" ${o_ids[$i]} "*)
        IDS+=("${o_ids[$i]}"); LABELS+=("${o_labels[$i]}"); BINS+=("${o_bins[$i]}")
        CFGS+=("${o_cfgs[$i]}"); DESTS+=("${o_dests[$i]}"); PRESENT+=("${o_present[$i]}"); VIAS+=("${o_vias[$i]}") ;;
    esac
  done
fi

# --- Install to every selected harness that is present -----------------------
# DECISIONS accumulates one `id<TAB>action<TAB>dest<TAB>via` record per host so
# the --json report can be emitted without re-deriving anything. Human lines
# go through `say`, which is silent in --json mode so stdout stays parseable.
say() {
  [ "$JSON" = "1" ] || echo "$@"
}
installed=0
conflicts=0
DECISIONS=()
for ((i = 0; i < ${#IDS[@]}; i++)); do
  id="${IDS[$i]}"; bin="${BINS[$i]}"; cfg="${CFGS[$i]}"; dest="${DESTS[$i]}"; via="${VIAS[$i]}"
  if [ "${PRESENT[$i]}" != "1" ]; then
    if [ -n "$bin" ]; then
      say "skip: $id — no $bin CLI or config at $cfg"
    else
      say "skip: $id — no config at $cfg"
    fi
    DECISIONS+=("$id"$'\t'"skip"$'\t'""$'\t'"$via")
    continue
  fi
  if [ -e "$dest" ] && [ "$FORCE" != "1" ] && ! grep -qs '^name: ix$' "$dest/SKILL.md"; then
    # Refuse to delete something that is not a previous install of this skill.
    # `ix` is a short name, and the unconditional `rm -rf` this replaces would
    # silently destroy a hand-written skill that happened to share it — with no
    # prompt, no backup, and nothing in the output to say it had happened. The
    # check runs in dry-run too, so the preview and the real run agree.
    if [ "$DRY_RUN" = "1" ]; then
      say "would refuse: $dest — exists and is not an Ix skill install (use --force)"
      DECISIONS+=("$id"$'\t'"would-refuse"$'\t'"$dest"$'\t'"$via")
    else
      echo "error: $dest exists and is not an Ix skill install." >&2
      echo "       Move it aside, or re-run with --force to overwrite it." >&2
      DECISIONS+=("$id"$'\t'"refused"$'\t'"$dest"$'\t'"$via")
    fi
    conflicts=$((conflicts + 1))
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    say "would install: $dest"
    DECISIONS+=("$id"$'\t'"would-install"$'\t'"$dest"$'\t'"$via")
    installed=$((installed + 1))
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ]; then
    rm -rf "$dest"
  fi
  cp -R "$SRC" "$dest"
  say "Installed: $dest"
  DECISIONS+=("$id"$'\t'"installed"$'\t'"$dest"$'\t'"$via")
  installed=$((installed + 1))
done

if [ "$JSON" = "1" ]; then
  printf '%s\n' "${DECISIONS[@]:-}" | IX_DRY_RUN="$DRY_RUN" node -e '
    const lines = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
    const hosts = lines.map((line) => {
      const [id, action, dest, via] = line.split("\t");
      return { id, action, dest: dest || null, detectedVia: via };
    });
    process.stdout.write(JSON.stringify({
      dryRun: process.env.IX_DRY_RUN === "1",
      hosts,
    }, null, 2) + "\n");
  '
  # Same agreement as the human dry-run: a would-refuse predicts the real
  # run's exit 1.
  [ "$conflicts" = "0" ] || exit 1
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
    echo
    echo "Dry run: $installed harness(es) would receive the skill."
    # The preview and the real run must agree: a conflict in the real run
    # exits 1, so a preview that predicts a refusal exits 1 too.
    [ "$conflicts" = "0" ] || exit 1
    exit 0
  fi

if [ "$installed" = "0" ] && [ "$conflicts" = "0" ]; then
  echo
  echo "No agent harness found. Install one of: ${IDS[*]} — or pass ids:"
  echo "  bash scripts/install-skill.sh ${IDS[0]}"
  exit 0
fi

echo
if [ "$conflicts" = "0" ]; then
  echo "Ix skill installed for $installed harness(es)."
else
  echo "Ix skill installed for $installed harness(es); $conflicts destination(s) refused."
fi
echo "Start a new session so the agent picks it up, then ask it to use Ix:"
echo "  \"Set up Ix and map this repo\""

[ "$conflicts" = "0" ] || exit 1