---
name: ix-impact
description: Change risk analysis — blast radius, affected systems, and what to test. Depth scales with risk level; low-risk targets stop early.
argument-hint: <symbol or file path to assess change risk for> [--save [path]]
---

{{preamble}}
{{#if cli}}
Check `command -v ix` first. If unavailable, use Grep to find all usages and estimate impact manually.
{{/if}}
{{#if mcp}}
If the Ix tools are unavailable, use Grep to find all usages and estimate impact manually.
{{/if}}

## Argument parsing

Strip `--save` and any following path token from `$ARGUMENTS` before resolving the target.
- If `--save <path>` is present, set `SAVE_PATH` to that path.
- If `--save` is present without a path, auto-generate `ix-impact-<target-slug>.md` in cwd (target slug = the target with spaces and slashes replaced by `-`).
- If `--save` is absent, `SAVE_PATH` is empty — do not write a file.

{{#if cli}}
## Pro check (optional)

Do not run `ix briefing` — you have already been told. The plugin's
UserPromptSubmit hook injects an `[ix] Session briefing` once per TTL whenever
Pro is reachable. Seen one this session? Pro is available; read `openBugs` from it.
Not seen one? Skip every **[Pro]** step. Asking costs a whole turn to learn
something already in your context.

{{/if}}
## Goal

Answer: *what breaks if this changes, and is it safe to proceed?* Stop as early as the risk level allows.

## Phase 1 — Risk score (always)

Run in parallel:
{{calls}}
ix impact target=$ARGUMENTS
ix explain symbol=$ARGUMENTS
{{/calls}}

**God-module check:** If the `edges` record of the {{ix explain}} result has `callees` > 20 AND `callers` < 2:
> ⚠ This symbol calls many others but has few callers. Standard blast-radius metrics may understate risk. Check callers of its key dependencies, not just direct dependents.

This caveat applies regardless of the {{ix impact}} risk classification.

**Immediately classify** using `risk=` on the `impact` record and the dependent count on the `counts` record (`dependents=` for a file or class, `callers=` for a function or method):

| Risk level | Action |
|---|---|
| `low` + < 3 dependents | **STOP** — safe to proceed. Report and suggest verification targets. |
| `medium` OR 3–10 dependents | Go to Phase 2 |
| `high` or `critical` OR > 10 dependents | Go to Phase 2 + 3 |
| `unknown` (the graph is missing its edges) | Not safe to call low. Go to Phase 2 + 3 and say the count is incomplete. |

## Phase 2 — Callers and dependents (medium/high/critical)

Run in parallel:
{{calls}}
ix callers symbol=$ARGUMENTS limit=15
ix depends symbol=$ARGUMENTS depth=2
{{/calls}}

Extract: direct callers by name and subsystem, transitive count (`nodes=` on the `depends` record).

**Stop here if risk is `medium`:** report callers, suggest verification, done.

## Phase 3 — Import chain and subsystem spread (high/critical only)

{{calls}}
ix imported-by symbol=$ARGUMENTS
{{/calls}}

Cross-reference callers + dependents + importers to identify:
- Which subsystems are in the blast radius
- Whether the change crosses an architectural boundary
- Any tests that cover the affected paths

## Output

```
## Impact: [target]

**Risk level:** <critical | high | medium | low | unknown>
**Verdict:** <SAFE TO PROCEED | REVIEW CALLERS FIRST | NEEDS CHANGE PLAN>

**Blast radius:**
- Direct dependents: N
- Transitive (depth 2): M
- Subsystems affected: [list — only if phase 3 ran]

**Key callers:** [top 5, with subsystem label]

**At-risk behaviors:** [from the `behavior text=` records of the {{ix impact}} result]

**Recommended action:**
- low: proceed, verify [specific callers]
- medium: test [caller list] after change
- high/critical: run `/ix-plan $ARGUMENTS` before editing
{{#if cli}}

**Known bugs in blast radius:** [Pro only — list open bugs touching callers/dependents, or omit section if none/Pro unavailable]
{{/if}}
```
{{#if cli}}

## Phase 4 — Known bugs in blast radius **[Pro]**

If Pro is available and `openBugs` from the briefing is non-empty, check for bugs affecting this target:
```bash
ix bug list --format text
```
Cross-reference open bugs against the direct callers and dependents identified in Phase 2. Any open bug touching the blast radius escalates the risk verdict — flag it explicitly in the output.
{{/if}}

Never read source code in this skill. Risk analysis is purely graph-based.

**Save step (only if `SAVE_PATH` is non-empty):**
- Write the full output above to `SAVE_PATH`{{#if host=claude}} using the Write tool{{/if}}.
- Confirm to the user: `Saved to <SAVE_PATH>`.
- Do not write the file if `--save` was not passed.
