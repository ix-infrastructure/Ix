---
name: ix-session-memory
description: Use this for any non-trivial IX-Memory task to keep context synchronized in ix (briefing, impact, planning, decisions, and bugs) and to produce resumable work.
---

# Ix Session Memory

Use this skill at the start of multi-step work and keep using it until the task is done.

## Trigger

Use when the task has at least one of:
- More than one file or subsystem
- A risky change with dependency impact
- Work that should be resumable by another agent later

## Workflow

1. Resume context:
```bash
ix briefing --format json
```

2. Scope impact:
```bash
ix overview <target> --format json
ix impact <target> --format json
```

3. If no active goal/plan exists, create one:
```bash
ix goal create "<outcome statement>" --format json
ix plan create "<plan title>" --goal <goal-id> --format json
ix plan task "<first task>" --plan <plan-id> --format json
```

4. Pull next actionable work:
```bash
ix plan next <plan-id> --with-workflow --format json
```

5. Track major reasoning:
```bash
ix decide "<decision>" --rationale "<why>" --affects <EntityName> --format json
```

6. Track defects explicitly:
```bash
ix bug create "<bug title>" --affects <EntityName> --format json
```

7. Mark completed tasks:
```bash
ix task update <task-id> --status done --format json
```

## Guardrails

- Always use `--format json` for any command that is parsed or chained.
- Prefer `overview` and `impact` before low-level traversal.
- If resolution is ambiguous, rerun with `--kind`.
- Never follow unresolved `rawId`; use `ix text` or `ix read` instead.

## Done Criteria

- The change is represented in at least one plan/task update.
- Any architectural tradeoff is captured as a decision.
- Any discovered defect is captured as a bug or fixed in-task.

