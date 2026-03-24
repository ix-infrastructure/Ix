---
name: ix-arango-query-change
description: Use when modifying Arango-backed query/write behavior so schema, AQL, transaction semantics, and DB-facing tests remain aligned.
---

# Ix Arango Query Change

Use this when touching:
- `memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala`
- DB query/write APIs and AQL construction
- schema or transaction behavior

## Workflow

1. Inspect DB surface:
```bash
ix overview ArangoClient --format json
ix impact ArangoClient --format json
```

2. Read query/transaction hot paths:
```bash
ix read <absolute/path/to/ArangoClient.scala:1-320> --format json
```

3. Locate nearby DB behavior and specs:
```bash
ix search GraphQueryApiSpec --kind class --format json --include-tests --limit 20
ix search GraphWriteApiSpec --kind class --format json --include-tests --limit 20
ix search SearchAqlSpec --kind class --format json --include-tests --limit 20
ix search ArangoClientSpec --kind class --format json --include-tests --limit 20
```

## DB Checklist

- Query semantics match intended node/edge filters.
- Sort/limit/pagination behavior is explicit and stable.
- Transactions remain atomic for multi-step writes.
- Schema bootstrap/ensure behavior is still safe and idempotent.
- Error mapping preserves actionable failure details.

## Guardrails

- Do not change query semantics without corresponding test updates.
- Treat default limits and sort order changes as behavior changes, not refactors.
- Keep API-level callers in sync when return shapes or cardinality change.

