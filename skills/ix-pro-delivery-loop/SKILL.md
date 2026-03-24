---
name: ix-pro-delivery-loop
description: Use when executing work with pro CLI objects (goals, plans, tasks, bugs, decisions, workflows) to keep delivery state explicit and machine-queryable.
---

# Ix Pro Delivery Loop

Use this when a task should be tracked through pro objects, not ad-hoc notes.

## Trigger

Use when at least one applies:
- New work should be sequenced into tasks.
- A bug should be linked to affected entities and a responding plan.
- A repeatable staged workflow should be attached and run.

## Core Loop

1. Resume and inspect:
```bash
ix briefing --format json
ix tasks --status pending --format json
ix bugs --format json
```

2. Create or select plan context:
```bash
ix goal create "<goal>" --format json
ix plan create "<plan>" --goal <goal-id> --format json
ix plan next <plan-id> --with-workflow --format json
```

3. Add executable tasks:
```bash
ix plan task "<title>" --plan <plan-id> --workflow-staged '{"discover":["ix overview <x> --format json"],"implement":["ix impact <x> --format json"],"validate":["ix tasks --plan <plan-id> --format json"]}' --format json
```

4. Track defects and linkage:
```bash
ix bug create "<title>" --severity high --affects <EntityName> --format json
ix plan create "<plan>" --goal <goal-id> --responds-to <bug-id> --format json
ix plan task "<title>" --plan <plan-id> --resolves <bug-id> --format json
```

5. Attach and run workflows:
```bash
ix workflow attach task <task-id> --file <workflow.json> --format json
ix workflow validate task <task-id> --format json
ix workflow run task <task-id> --stage discover --format json
```

6. Close loop:
```bash
ix task update <task-id> --status done --format json
ix bug update <bug-id> --status resolved --format json
```

## Guardrails

- Workflows must contain `ix` commands only; no shell operators.
- Keep dependency edges explicit with `--depends-on`.
- Prefer linking bugs/plans/tasks (`RESPONDS_TO`, `TASK_RESOLVES_BUG`) in the same session.

