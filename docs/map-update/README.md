# Map Update — Feature Overview

This document describes the `ix map` overhaul and the two new analysis commands (`ix smells`, `ix subsystems`) added in the `feature/map-update` branch.

## What Changed

### `ix map` — Progress Bar + Timing

The map command now shows a live progress bar while computing the architectural map and prints ingest/map timing on completion.

```
  Computing map...  ████████████░░░░░░░░░░░░░   51%
  ingest 1240ms · map 3820ms
```

Key changes in `ix-cli/src/cli/commands/map.ts`:
- Exponential-decay progress bar using `setInterval`
- Ingest and map durations printed to stderr (text mode only)
- `--full` flag preserved for bypassing incremental map cache

### `ix smells` — Architecture Smell Detection

Runs graph-query-based smell detection and stores results as versioned claims on `File` nodes.

```bash
ix smells                        # run detection with default thresholds
ix smells --format json          # machine-readable output
ix smells --list                 # show previously stored claims
ix smells --god-module-chunks 15 # tune threshold
```

**Detected smells:**

| Smell | Field | Description |
|-------|-------|-------------|
| Orphan file | `has_smell.orphan_file` | File with no import/call connections |
| God module | `has_smell.god_module` | File with high chunk count or fan-in/out |
| Weak component member | `has_smell.weak_component_member` | File connected to very few others |

Claims are stored with `inference_version=smell_v1` and are versioned — re-running retires old claims before writing new ones.

**Backend:** `SmellService.scala` + `SmellRoutes.scala`

### `ix subsystems` — Subsystem Health Scoring

Scores each architectural region produced by `ix map` on a 0–1 health scale.

```bash
ix subsystems                    # compute and store scores
ix subsystems --list             # show stored scores
ix subsystems --level 2          # filter to subsystem level
ix subsystems --format json      # machine-readable
```

**Health score formula:**

```
health = 0.4 × (1 − smell_rate)
       + 0.3 × tanh(chunk_density / 5)
       + 0.3 × confidence
```

| Signal | Meaning |
|--------|---------|
| `smell_rate` | Fraction of files in the region with smell claims (lower = healthier) |
| `chunk_density` | Avg `CONTAINS_CHUNK` edges per file (higher = richer structure) |
| `confidence` | MapService cohesion/boundary ratio score |

Claims stored with `inference_version=subsystem_v1`.

**Backend:** `SubsystemService.scala` + `SubsystemRoutes.scala`

## New Files

| File | Purpose |
|------|---------|
| `ix-cli/src/cli/commands/smells.ts` | CLI command for smell detection |
| `ix-cli/src/cli/commands/subsystems.ts` | CLI command for subsystem scoring |
| `memory-layer/.../smell/SmellService.scala` | Smell detection logic (AQL queries + claim storage) |
| `memory-layer/.../smell/SubsystemService.scala` | Subsystem scoring logic |
| `memory-layer/.../api/SmellRoutes.scala` | HTTP routes for smell endpoints |
| `memory-layer/.../api/SubsystemRoutes.scala` | HTTP routes for subsystem endpoints |

## Recommended Workflow

After running `ix map`, use the new commands to get a quality picture:

```bash
ix map                           # build architectural map
ix smells --format json          # find problem files
ix subsystems --format json      # score each region
```

Pipe results into `ix decide` to record findings:

```bash
ix decide "Refactor auth module" \
  --rationale "god_module smell + health score 0.31" \
  --affects AuthModule
```
