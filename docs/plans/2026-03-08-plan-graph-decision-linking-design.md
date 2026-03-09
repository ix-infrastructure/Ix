# Plan Graph + Decision Linking Design

**Goal:** Transform Ix from low-level graph primitives into a planning and reasoning layer for LLM agents.

**Scope:** MCP removal, CLI output fix, decision linking, plan graph, doc updates. Verification layer deferred to part 2.

---

## 1. MCP Removal

Delete `ix-cli/src/mcp/` entirely:
- `server.ts`, `session.ts`, tests
- Remove `mcp-start` and `mcp-install` commands from `main.ts`
- Remove `@modelcontextprotocol/sdk` from `package.json`
- Remove MCP references from README, CLAUDE.md, AGENTS.md

After this, `ix CLI --format json` is the only agent interface.

## 2. CLI Output Fix

Create a `stderr()` utility wrapping `console.error()`. All human-readable status messages (`printResolved()`, disambiguation warnings, progress indicators) go through `stderr()`. stdout is reserved exclusively for the command's primary output.

- `--format json` produces clean, pipeable JSON on stdout
- `--format text` (default) keeps human-readable output on stdout
- Diagnostic/status messages always go to stderr regardless of format

## 3. Decision Linking

### New flags on `ix decide`

- `--affects <entity1,entity2,...>` — resolves each entity, creates `DECISION_AFFECTS` edges
- `--supersedes <decision-id>` — creates `DECISION_SUPERSEDES` edge from new to old
- `--parent <decision-id>` — creates `DECISION_CHILD` edge from parent to new

### New edge predicates

- `DECISION_AFFECTS` — Decision → Entity
- `DECISION_SUPERSEDES` — Decision → Decision
- `DECISION_CHILD` — Decision → Decision

### Implementation

Client-side via GraphPatch. CLI resolves entity names, builds patch ops (UpsertNode for decision + UpsertEdge for each link), submits to `POST /v1/patch`. Same pattern as GitHub ingestion.

### Surfacing

`ix overview <entity>` gains a `decisions` field by expanding incoming `DECISION_AFFECTS` edges.

## 4. Plan Graph

### Node kinds

- **Goal** — reuse existing `Intent` node kind. `ix goal create` = alias for `ix truth add`.
- **Plan** — new `NodeKind.Plan`
- **Task** — new `NodeKind.Task`

### Edge predicates

- `GOAL_HAS_PLAN` — Intent → Plan
- `PLAN_HAS_TASK` — Plan → Task
- `DEPENDS_ON` — Task → Task
- `TASK_AFFECTS` — Task → any entity

### Task statuses

Stored as a claim attribute on the Task node: `pending`, `in_progress`, `blocked`, `done`, `abandoned`.

### CLI commands

| Command | Purpose |
|---------|---------|
| `ix goal create <statement>` | Alias for `ix truth add` |
| `ix goal list` | Alias for `ix truth list` |
| `ix plan create <title> --goal <goal-id>` | Create Plan node + GOAL_HAS_PLAN edge |
| `ix plan task <title> --plan <plan-id> [--depends-on <id>] [--affects <entity>]` | Create Task + edges |
| `ix plan status <plan-id>` | Tasks with statuses, critical path, next actionable |
| `ix plan next <plan-id>` | Highest-priority unblocked task |
| `ix task update <task-id> --status <status>` | Update task status |

### Plan status algorithm

1. Expand `PLAN_HAS_TASK` to get all tasks
2. For each task, expand outgoing `DEPENDS_ON` to find blockers
3. Critical path = tasks with most downstream `DEPENDS_ON` chains
4. Next actionable = not-done task with all dependencies satisfied, first by creation order

### Surfacing

`ix overview <entity>` gains a `tasks` field by expanding incoming `TASK_AFFECTS` edges.

## 5. Doc Updates

Preferred agent routing:

| Goal | Command |
|------|---------|
| Understand an entity | `ix overview` |
| Blast radius | `ix impact` |
| Find hotspots | `ix rank` |
| List entities | `ix inventory` |
| Plan work | `ix plan create` / `ix plan next` |
| Track decisions | `ix decide --affects` |
| Resume work | `ix plan next` |

Low-level commands (`callers`, `callees`, `contains`, `imports`, `depends`) described as structural primitives.

Remove all MCP references from docs.

## 6. Deferred (Part 2)

Verification layer: `ix task verify <task>` — check if affected entities changed since task creation. Requires tracking revision at task creation time.

## Implementation approach

All new features are client-side via GraphPatch submissions. No new backend routes needed beyond the existing `POST /v1/patch`. Deterministic IDs via SHA-256 (same pattern as GitHub ingestion).
