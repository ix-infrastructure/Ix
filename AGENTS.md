# Ix CLI — Agent Usage Guide

This file tells automated agents (Codex, Claude, etc.) how to use the `ix` CLI effectively.

## Interface

Use the `ix` CLI exclusively. All commands support `--format json` for machine-readable output.

## JSON Mode

Always use `--format json` when chaining commands or parsing results programmatically.

JSON output is strict — no text preamble or postamble. The output is a single JSON object.

### Standard JSON fields

| Field | Description |
|-------|-------------|
| `resolvedTarget` | The entity that was resolved (`{id, kind, name}`) |
| `resolutionMode` | How the entity was resolved: `exact`, `preferred-kind`, `ambiguous`, `heuristic` |
| `resultSource` | Where results came from: `graph`, `text`, `graph+text`, `heuristic` |
| `results` | Array of result entities |
| `summary` | Counts and aggregates |
| `diagnostics` | Array of `{code, message}` explaining empty or weak results |
| `warning` | Human-readable warning string |

### Diagnostic codes

| Code | Meaning |
|------|---------|
| `no_edges` | Entity resolved but no graph edges of the requested type exist |
| `unresolved_call_target` | A callee/caller could not be resolved to a named entity |
| `dangling_reference_filtered` | Some results had unresolvable IDs |
| `ambiguous_resolution` | Multiple entities matched; specify `--kind` or use entity ID |
| `text_fallback_used` | Graph had no results; text search was used instead |
| `parser_gap_suspected` | Results suggest the parser did not fully index this area |
| `unfiltered_search` | No `--kind` filter used; results may be broad |

## Result entities

Each result entity in `results` includes:

- `name` — human-readable name (present when `resolved: true`)
- `kind` — entity kind (function, method, class, etc.)
- `id` — resolvable entity ID (present when `resolved: true`)
- `resolved` — boolean indicating whether this entity can be followed up
- `path` — source file path (when available)
- `suggestedCommand` — a follow-up `ix` command to get more details
- `rawId` — raw graph ID (only present when `resolved: false`)

**Rule:** Only use `id` fields from entities where `resolved: true`. Do not attempt `ix entity <rawId>` on unresolved references.

## Command routing

### Recommended loop

1. `ix briefing --format json`           — resume session context
2. `ix overview <target> --format json`  — understand a component
3. `ix impact <target> --format json`    — check blast radius
4. `ix rank / ix inventory`              — find hotspots or list entities
5. `ix plan next <id> --with-workflow`   — get next task
6. `ix tasks --status pending`           — see all pending tasks across plans

### Start here — high-level workflow commands

These are the preferred entry points. Use them first; drop to low-level commands only when you need fine-grained control.

```
ix impact <target> --format json          # Blast radius / dependency consequences
ix rank --by <metric> --kind <kind> --top N --format json   # Hotspot discovery
ix overview <target> --format json        # One-shot structural summary of a component
ix inventory --kind <kind> --format json  # Scoped entity listing
ix goal create <statement> --format json      # Create a project goal
ix plan create <title> --goal <id> --format json  # Create a plan
ix plan next <plan-id> --format json          # Next actionable task
ix decide <title> --rationale <text> --affects <entities> --format json  # Record linked decision
ix briefing --format json                     # Session-scoped resume summary
ix bug create "title" --affects Entity        # Track a bug
ix bugs --format json                         # List bugs
ix bug show <id> --format json                # Bug details
```

**When to use which:**
- "What breaks if I change X?" → `ix impact X`
- "What are the most important classes?" → `ix rank --by dependents --kind class --top 10`
- "Tell me about UserService" → `ix overview UserService`
- "List all functions in auth.py" → `ix inventory --kind function --path auth.py`
- "List all classes" → `ix inventory --kind class`
- "What are the most critical methods?" → `ix rank --by callers --kind method --top 10`
- "What changed between rev 5 and 10?" → `ix diff 5 10 --summary`
- "Show me all changes" → `ix diff 5 10 --full --format json`
- "Are there architectural problems?" → `ix smells --format json`
- "Which subsystems are unhealthy?" → `ix subsystems --format json`

### Low-level structural primitives

Useful for debugging, fine-grained inspection, or when high-level commands don't cover your case.

#### Finding code
```
# Always use --kind with search to get bounded results
ix search <term> --kind <kind> --format json --limit 10
ix text <term> --format json --language python
ix locate <symbol> --format json
ix read <file:lines>
```

#### Understanding entities
```
ix explain <symbol> --format json
ix entity <id> --format json
```

#### Navigating relationships
```
ix callers <symbol> --format json
ix callees <symbol> --format json
ix contains <symbol> --format json
ix imports <symbol> --format json
ix imported-by <symbol> --format json
ix depends <symbol> --format json
```

### Architecture analysis
```
ix smells --format json                              # Detect orphan files, god modules, weak components
ix smells --list --format json                       # List previously stored smell claims
ix smells --god-module-chunks 15 --god-module-fan 10 # Custom thresholds
ix subsystems --format json                          # Score subsystems by health (0–1)
ix subsystems --list --format json                   # List stored scores
ix subsystems --level 2 --format json                # Filter to subsystem level
```

**When to use which:**
- "Are there any architectural problems?" → `ix smells`
- "Which subsystems are unhealthy?" → `ix subsystems --format json`
- "Show me god modules" → `ix smells --format json | jq '.candidates[] | select(.smell == "has_smell.god_module")'`

### Updating the graph
```
ix map --format json
ix ingest --github owner/repo --format json --limit 50
ix ingest --github owner/repo --since 2026-01-01 --format json
```

### History and decisions
```
ix decisions --format json
ix history <id> --format json
ix diff <from> <to> --summary --format json   # Fast revision summary
ix diff <from> <to> --format json              # Full diff (default limit 100)
ix diff <from> <to> --full --format json       # All changes, no limit
```

### Planning & decisions (Pro)
```
# Goals
ix goal create "GitHub ingestion pipeline" --format json
ix goal show <id-or-name> --format json
ix goal list --status active --format json
ix goals --format json                               # shorthand list

# Plans
ix plan create "GitHub Ingestion" --goal <goal-id> --responds-to <bugId> --format json
ix plan status <plan-id> --format json               # task list + critical path + open bug count
ix plan next <plan-id> --with-workflow --format json # next actionable task + workflow
ix plan next <plan-id> --run-workflow --stage discover --format json  # execute one stage
ix plans --format json                               # shorthand list

# Tasks
ix plan task "API fetch layer" --plan <plan-id> --depends-on <task-id> --format json
ix plan task "title" --plan <id> --workflow-staged '{"discover":["ix overview X"],"implement":["ix map"],"validate":["ix smells"]}' --format json
ix plan task "title" --plan <id> --resolves <bugId> --format json
ix tasks --format json                               # list all tasks across plans
ix tasks --status pending --plan <plan-id> --format json
ix task show <task-id> --with-workflow --format json
ix task update <task-id> --status done --format json
ix task update <task-id> --run-workflow implement --format json  # run a workflow stage

# Decisions
ix decide "Use client-side patch" --rationale "..." --affects IngestionService --format json
ix decide "Use JWT" --rationale "..." --responds-to <bugId> --format json

# Bugs
ix bug create "title" --severity high --affects Entity --format json
ix bug update <id> --status resolved --format json
ix bug show <id> --format json
ix bugs --status open --format json

# Misc
ix patches --limit 20 --format json                 # recent graph patches
ix truth add "Support 100k file repos"
ix truth list --format json
```

### Workflows (Pro)
Staged command sequences attached to tasks, plans, or decisions. Stages: `discover → implement → validate`. All commands must start with `ix ` — no arbitrary shell.
```
ix workflow attach task <id> --file workflow.json    # attach from JSON file
ix workflow show task <id> --format json             # view attached workflow
ix workflow validate task <id> --format json         # check structure
ix workflow run task <id> --stage implement --format json  # execute one stage
```

**Workflow JSON format:**
```json
{
  "discover":   ["ix overview AuthService", "ix impact AuthService"],
  "implement":  ["ix map"],
  "validate":   ["ix smells --format json"]
}
```

**When to use which:**
- "What work is planned?" → `ix plans --format json` then `ix plan status <id>`
- "What should I do next?" → `ix plan next <id> --with-workflow`
- "Execute the next task's discovery phase" → `ix plan next <id> --run-workflow --stage discover`
- "Mark a task done" → `ix task update <id> --status done`
- "Link a decision to a bug" → `ix decide "title" --rationale "..." --responds-to <bugId>`

## Semantic boundaries

- **decision** — a choice between alternatives, with rationale. Use `ix decide`.
- **bug** — something broken, missing, or incorrect. Use `ix bug create`.
- **task/plan** — intended work and sequencing. Use `ix plan` / `ix plan task`.

## Chaining pattern

1. Start broad: `ix overview MyClass --format json` or `ix impact MyClass --format json`
2. If you need more detail, drill in: `ix explain MyClass --format json` or `ix entity <id> --format json`
3. Navigate edges: `ix callers MyClass --format json`

## Handling unresolved references

When a result has `resolved: false`:
- Do NOT follow the `rawId` with `ix entity`
- Instead, use `ix text "<name>"` or `ix read <file>` to locate it
- Check `suggestedCommand` if present

## Handling empty results

Check `diagnostics` in the JSON response:
- `no_edges` — entity exists but has no edges of this type. Try `ix text` instead.
- `text_fallback_used` — graph traversal was empty; text matches shown instead.
- `ambiguous_resolution` — re-run with `--kind <kind>` to disambiguate.
