---
name: ix-new-command
description: Use when adding a new ix CLI command end-to-end — Scala route, IxClient method, CLI command file, oss.ts registration, and doc updates must all stay in sync.
---

# Ix New Command

Use this when adding a new `ix <command>` from scratch or extending an existing command with a new subcommand.

## Files that must all change together

| Layer | File |
|-------|------|
| Backend route | `memory-layer/src/main/scala/ix/memory/api/<Name>Routes.scala` |
| Route wiring | `memory-layer/src/main/scala/ix/memory/api/Routes.scala` |
| Server wiring | `memory-layer/src/main/scala/ix/memory/Main.scala` |
| TypeScript client | `ix-cli/src/client/api.ts` |
| CLI command | `ix-cli/src/cli/commands/<name>.ts` |
| OSS registration | `ix-cli/src/cli/register/oss.ts` |
| Docs | `CLAUDE.md`, `AGENTS.md` |

## Workflow

1. Understand current command surface:
```bash
ix overview IxClient --format json
ix search Routes --kind class --format json --limit 30
ix impact Routes --format json
```

2. Read existing route and client as pattern references:
```bash
ix read memory-layer/src/main/scala/ix/memory/api/SmellRoutes.scala
ix read ix-cli/src/cli/commands/smells.ts
```

3. After writing the new route file, read constructor patterns to wire correctly:
```bash
ix search <ServiceName> --kind class --format json --limit 5
ix read memory-layer/src/main/scala/ix/memory/api/Routes.scala
ix read memory-layer/src/main/scala/ix/memory/Main.scala
```

4. After writing the CLI command, verify registration isn't duplicated:
```bash
ix read ix-cli/src/cli/register/oss.ts
```

5. Compile-check the backend:
```bash
sbt "memoryLayer/compile" 2>&1 | grep -E "error|warning|success"
```

6. Build the CLI:
```bash
cd ix-cli && npm run build 2>&1 | grep -E "error TS|error:"
```

7. Smoke-test the command:
```bash
ix <newcommand> --format json
```

8. Update docs and ingest:
```bash
# Edit CLAUDE.md and AGENTS.md to add the command to the appropriate table
ix ingest ./ix-cli/src ./memory-layer/src
```

9. Record the decision:
```bash
ix decide "Add ix <name> command" --rationale "<why this command exists>" --affects IxClient --format json
```

## Common Wiring Errors

- `Routes.scala`: wrong constructor args — always read the `class <Name>Routes(...)` signature before instantiating
- `Routes.scala`: referencing a class from the wrong package — check import path matches where the service lives
- `oss.ts`: registering the same command twice — grep for the register call before adding it
- `api.ts`: method returns `Record<string,string>` but caller expects `Map` — prefer `Map` and use `new Map(Object.entries(result))`
- `api.ts`: method signature accepts no args but CLI passes options — always add `opts?: {...}` if the command has flags

## Done Criteria

- `sbt "memoryLayer/compile"` passes with no errors.
- `cd ix-cli && npm run build` passes with no errors.
- `ix <newcommand> --format json` returns a valid JSON response.
- Command appears in `CLAUDE.md` and `AGENTS.md`.
- No duplicate registration in `oss.ts`.
