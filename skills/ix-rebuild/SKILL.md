---
name: ix-rebuild
description: Use when running or recovering from a full ix rebuild — sbt assembly + CLI build. Covers how to interpret compile errors and common failure patterns in this codebase.
---

# Ix Rebuild

Use this when running `./rebuild.sh` or fixing compile errors after merging changes.

## Build Order

```
sbt assembly (Scala backend)  →  npm run build (TypeScript CLI)  →  Docker restart
```

`./rebuild.sh` runs all three. For faster iteration use the individual steps below.

## Fast Iteration Commands

```bash
# Scala only (fastest feedback on backend changes)
sbt "memoryLayer/compile" 2>&1 | grep -E "error|warning|success"

# Full Scala assembly (needed before Docker restart)
sbt assembly 2>&1 | grep -E "error|warning|success|Built"

# TypeScript CLI only
cd ix-cli && npm run build 2>&1 | grep -E "error TS|error:"

# Both + Docker restart
./rebuild.sh
```

## Common Scala Errors and Fixes

### Wrong constructor args
```
not enough arguments for constructor Foo: (a: A, b: B)
```
→ Read the class signature: `ix search Foo --kind class --format json --limit 5`
→ Then: `ix read <path-to-file>` to see the actual constructor.

### Type not found
```
not found: type BulkPatchCommitRoutes
```
→ The class doesn't exist. Search for it: `ix locate BulkPatchCommitRoutes --limit 5`
→ Check if it was renamed or removed from the route aggregator.

### Type mismatch on service
```
found: ix.memory.smell.SubsystemService
required: ix.memory.subsystem.SubsystemScoringService
```
→ The stash/upstream used different packages. Check which class actually exists on disk:
  `find memory-layer/src -name "Subsystem*.scala"`
→ Update the import and usage to match what exists.

### Wrong queryApi vs writeApi
```
found: ArangoGraphQueryApi
required: GraphWriteApi
```
→ Check the service constructor: `grep "^class <Name>" memory-layer/src/main/scala/**/*.scala`
→ Services that store claims need `writeApi`; read-only services need `queryApi`.

## Common TypeScript Errors and Fixes

### Missing method on IxClient
```
Property 'commitPatchBulk' does not exist on type 'IxClient'
```
→ Add the method to `ix-cli/src/client/api.ts`.
→ Check what endpoint it should call by reading the corresponding Scala route.

### Missing export from module
```
Module '"../errors.js"' has no exported member 'parseBackendError'
```
→ Read `ix-cli/src/cli/errors.ts` to see what's actually exported.
→ Remove the import and inline the logic, or add the export if it belongs there.

### Wrong argument count
```
Expected 0 arguments, but got 1
```
→ The CLI passes options the api.ts method doesn't accept yet.
→ Add `opts?: { ... }` to the method signature in `api.ts`.

### Duplicate command registration
```
Error: cannot add command 'smells' as already have command 'smells'
```
→ Open `ix-cli/src/cli/register/oss.ts` and remove the duplicate `register<Name>Command(program)` call.

## Smoke Test After Rebuild

```bash
ix status                          # backend alive
ix stats --format json             # graph accessible
ix map --format json | head -5     # map pipeline works
ix smells --format json | head -5  # smell pipeline works
ix subsystems --format json | head -5  # subsystem pipeline works
```

## Done Criteria

- `sbt "memoryLayer/compile"` exits with `[success]`.
- `cd ix-cli && npm run build` exits cleanly (no `error TS` lines).
- `./rebuild.sh` prints `IX backend is ready!`.
- `ix status` reports `ok`.
