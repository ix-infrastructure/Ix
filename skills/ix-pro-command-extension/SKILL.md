---
name: ix-pro-command-extension
description: Use when adding or modifying pro CLI commands to keep registration, dynamic loading, patch-building semantics, and command safety coherent across ix-cli and Ix-pro.
---

# Ix Pro Command Extension

Use this when changing pro command implementation or wiring.

## Scope

- `Ix-pro/src/cli/register.ts`
- `Ix-pro/src/cli/commands/*`
- `IX-Memory/ix-cli/src/cli/register/pro-loader.ts`
- Any shared client patch payload behavior (`GraphPatchPayload`, `PatchOp`)

## Workflow

1. Confirm command wiring:
```bash
ix read /home/ianhock/ix/Ix-pro/src/cli/register.ts:1-260 --format json
ix read /home/ianhock/ix/IX-Memory/ix-cli/src/cli/register/pro-loader.ts:1-260 --format json
```

2. Inspect changed command module:
```bash
ix read /home/ianhock/ix/Ix-pro/src/cli/commands/<command>.ts:1-320 --format json
ix overview IxClient --format json
```

3. Validate patch intent and edge semantics:
```bash
ix search build<Command>Patch --kind function --format json --limit 20
ix impact IxClient --format json
```

4. Verify discoverability and operator UX:
```bash
ix search registerProCommands --kind function --format json --limit 10
ix search tryLoadProCommands --kind function --format json --limit 10
```

## Checklist

- New command is registered in `registerProCommands`.
- Loader compatibility with `@ix/pro/register` is preserved.
- `--format json` output remains stable for automation.
- Patch ops (`UpsertNode`, `UpsertEdge`, `AssertClaim`) reflect intended graph semantics.
- Validation blocks unsafe command input where applicable (example: workflow command safety checks).

## Guardrails

- Treat command output schemas as APIs.
- Do not add command behavior that bypasses entity resolution safeguards.
- Keep edge predicates explicit and consistent with existing pro model.

