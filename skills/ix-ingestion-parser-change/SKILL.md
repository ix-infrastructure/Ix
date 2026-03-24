---
name: ix-ingestion-parser-change
description: Use when changing ingestion or parser behavior so parser routing, extracted entities/relationships, and graph patch generation stay coherent and testable.
---

# Ix Ingestion Parser Change

Use this when touching:
- `memory-layer/src/main/scala/ix/memory/ingestion/IngestionService.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/ParserRouter.scala`
- `memory-layer/src/main/scala/ix/memory/ingestion/parsers/*`
- `memory-layer/src/main/scala/ix/memory/ingestion/GraphPatchBuilder.scala`

## Workflow

1. Confirm impact:
```bash
ix impact IngestionService --format json
ix overview ParserRouter --format json
ix overview GraphPatchBuilder --format json
```

2. Locate parser family and routing points:
```bash
ix search Parser --kind class --format json --limit 30
ix read <absolute/path/to/ParserRouter.scala:1-260> --format json
```

3. Verify parse output contract:
```bash
ix overview ParseResult --format json
ix read <absolute/path/to/ParseResult.scala:1-220> --format json
```

4. Verify graph patch contract:
```bash
ix read <absolute/path/to/GraphPatchBuilder.scala:1-260> --format json
```

5. Validate parser and ingestion tests were considered:
```bash
ix search Spec --kind class --format json --include-tests --limit 60
```

## Change Checklist

- Parser selection logic and file-type routing stay deterministic.
- New extracted entity/relationship kinds are represented consistently.
- IDs/hashes remain stable where expected.
- Import-edge and named-edge resolution still converges on resolvable nodes.
- Graph patch operations still satisfy downstream commit assumptions.

## Guardrails

- Avoid parser-only changes that silently break patch building.
- If parser output shape changes, update parse result consumers in the same task.
- Record intended behavior shifts as an explicit decision via `ix decide`.

