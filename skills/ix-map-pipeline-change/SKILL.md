---
name: ix-map-pipeline-change
description: Use when changing the architectural analysis pipeline — MapService, SmellService, SubsystemScoringService, or their routes/CLI commands — so the map → smells → subsystems chain stays coherent.
---

# Ix Map Pipeline Change

Use this when touching:
- `memory-layer/src/main/scala/ix/memory/map/MapService.scala`
- `memory-layer/src/main/scala/ix/memory/map/MapGraphBuilderFast.scala`
- `memory-layer/src/main/scala/ix/memory/map/MapPreflight.scala`
- `memory-layer/src/main/scala/ix/memory/map/LouvainClustering.scala`
- `memory-layer/src/main/scala/ix/memory/smell/SmellService.scala`
- `memory-layer/src/main/scala/ix/memory/subsystem/SubsystemScoringService.scala`
- `ix-cli/src/cli/commands/map.ts`
- `ix-cli/src/cli/commands/smells.ts`
- `ix-cli/src/cli/commands/subsystems.ts`

## Pipeline Overview

```
ix map     →  MapService (Louvain clustering → region hierarchy stored as REGION nodes)
ix smells  →  SmellService (AQL graph queries → smell claims on File nodes)
ix subsystems → SubsystemScoringService (join regions + smell claims → health scores)
```

Each stage stores versioned claims. Re-running retires old claims before writing new ones.

## Workflow

1. Understand current pipeline state:
```bash
ix briefing --format json
ix overview MapService --format json
ix impact MapService --format json
```

2. Check smell and subsystem dependencies:
```bash
ix overview SmellService --format json
ix overview SubsystemScoringService --format json
ix callers MapService --format json
```

3. Inspect the map types contract (shared across all three stages):
```bash
ix read memory-layer/src/main/scala/ix/memory/map/MapTypes.scala
```

4. After changes, verify all three stages still chain:
```bash
ix map --format json | head -20
ix smells --format json | head -20
ix subsystems --format json | head -20
```

5. Check region/claim data in graph:
```bash
ix stats --format json
ix smells --list --format json
ix subsystems --list --format json
```

6. Record the decision:
```bash
ix decide "<change title>" --rationale "<why>" --affects MapService --format json
```

## Key Invariants

- `MapService` stores results as `REGION` nodes and `CONTAINS_FILE` / `CONTAINS_REGION` edges. SmellService and SubsystemScoringService query these — don't change the node/edge kinds without updating all three.
- Smell claims use field prefix `has_smell.*` and `inference_version=smell_v1`. Subsystem scores use `field=subsystem_health` and `inference_version=subsystem_v1`.
- Both services call `retireOld*()` before storing new claims — this is idempotent by design.
- `SubsystemScoringService(client: ArangoClient, writeApi: GraphWriteApi)` — uses `writeApi` not `queryApi`.
- `SmellService(client: ArangoClient, writeApi: GraphWriteApi)` — uses `writeApi` not `queryApi`.

## Guardrails

- Run `ix map` before `ix smells` or `ix subsystems` — they depend on region data being current.
- If you change region granularity in MapService, SubsystemScoringService scores will shift — document the expected delta as a decision.
- Do not change claim field names (`has_smell.*`, `subsystem_health`) without updating the CLI commands that parse them.
