# ix map Algorithm: Speed & Accuracy Overhaul

**Plan ID:** `46ecf20c-8bb2-9e54-121b-f5388adc8156`
**Goal ID:** `ec6a17f4-3d75-4a18-a614-c23e3fd709ae`

---

## Overview

`ix map` runs a multi-level Louvain community detection algorithm over a weighted file-coupling graph built from the knowledge graph. This document tracks planned improvements to make it both faster and more accurate.

Pipeline stages:

```
ArangoDB → WeightedFileGraph → (crosscut penalty) → Louvain → Regions → Labels → Confidence → Persist
```

---

## Implementation Status

Status: implemented in code.

What shipped:

- `MapGraphBuilder.fetchCouplingByUri` no longer builds a giant `MERGE` map. It now resolves edge endpoints with direct `nodes` lookups keyed by `logical_id` and aggregates with `COLLECT ... WITH COUNT`.
- `MapGraphBuilder.liveFileCount` now uses `COLLECT WITH COUNT` instead of loading all file rows.
- `MapGraphBuilder.computeGraph` now precomputes directory segments once, short-circuits same-directory path proximity to `1.0`, and caps synthetic structural edge growth with `MaxEdges`.
- `WeightedFileGraph` now carries `predicatePairs`, which restores dominant signal computation downstream.
- `LouvainClustering.cluster` now runs three deterministic seeds, applies adaptive resolution by repository size, stops on modularity-gain convergence instead of a fixed 30-pass cap, and uses in-place Fisher-Yates shuffle.
- `MapService` now uses the tuned signal weights:
  - `CALLS = 1.0`
  - `IMPORTS = 0.5`
  - `EXTENDS/IMPLEMENTS = 1.2`
  - `PATH = 0.2`
- The CLI text renderer now defaults to the hierarchy graph view, with the ranked list preserved behind `ix map --list`.
- Cross-cut token detection was expanded with layer/framework tokens including `service`, `controller`, `repository`, `handler`, `middleware`, `model`, `entity`, `dto`, `interface`, `types`, and `errors`.
- Confidence scoring now uses:

```scala
val brScore = tanh(boundaryRatio / 2.5)
val cohScore = cohesion.min(1.0)
val sizeBonus = tanh(size / 8.0)
val crossPenalty = crosscutScore * 0.4
```

- Labeling now prefers filtered suffixes first, then discriminative directory scoring, then filename-token fallback. Weak suffix tokens like `api`, `service`, and `common` no longer win by default.
- `dominant_signals` is now populated from real intra-region predicate counts instead of being emitted empty.

Validation summary:

- `sbt memoryLayer/compile` passed after the changes.
- A fresh backend using the new build returned `empty_dominant_signals = 0`.
- Sequential timing checks on this repo remained within the target range for a repo of this size, though end-to-end `ix map` time here is heavily influenced by ingest/persist overhead rather than the clustering math alone.

---

## Current Known Issues

### Speed

| Location | Issue | Severity |
|---|---|---|
| `MapGraphBuilder.fetchCouplingByUri` | AQL `MERGE` over all live nodes to build `uri_map` — full collection scan on every call | High |
| `MapGraphBuilder.fetchFiles` | Full table scan, no index on `kind` | Medium |
| `MapGraphBuilder.currentInputRev` | Two separate full table scans (nodes + edges) | Medium |
| `MapGraphBuilder.liveFileCount` | Calls `fetchFiles()` just to count — fetches all data unnecessarily | Low |
| `MapGraphBuilder.computeGraph` (path-proximity pass) | O(n²) within each directory — 100-file directory = 4,950 pairs; `pathProximity` called per pair with string splits | High |
| `MapGraphBuilder.pathProximity` | Splits path strings on every call, no precomputation | Medium |
| `LouvainClustering.louvainPass` | `rng.shuffle(nodes)` on every pass — allocates new list up to 30× | Low |
| `MapService.applyPenalty` | Copies full adjacency map — could be done in-place since graph is not reused | Low |
| `MapService.loadCachedMap` → `liveFileCount` | Separate DB round trip just to populate `fileCount` | Low |

### Accuracy

| Location | Issue | Severity |
|---|---|---|
| `MapService.buildOneRegion` | `dominantSignals` always `[]` — per-predicate counts lost after graph construction | Medium |
| Signal weights (α=1.0 β=0.7 γ=0.9 ε=0.3) | Arbitrary, not empirically validated | Medium |
| `crosscutTokens` set | Missing common framework terms: "service", "controller", "repository", "handler", "middleware" | Medium |
| `computeConfidence` weights (0.4/0.3/0.3) | Ad-hoc formula, not validated against real-world repo quality | Low |
| `inferLabel` | Strategy 1 (longest common dir suffix) fires before the better strategy 2 (discriminative segment scoring) — can produce misleading labels for deeply nested monorepos | Medium |
| Louvain resolution fixed at 1.0 | Higher resolution → smaller communities; lower → larger. Should adapt to repo size or be tunable | Medium |
| Louvain seed fixed at 42 | Single deterministic run may hit local optima — multiple seeds with best-modularity selection improves stability | Low |
| `minCommunitySize` hardcoded | 3 for 3-level repos, 2 otherwise — should scale with repo size | Low |

---

## Tasks

### Task 1 — Optimize AQL queries in MapGraphBuilder
**ID:** `adb844f1-62a3-98f2-a27e-33cc50364ae0`

The two costliest DB operations:

**`fetchCouplingByUri` MERGE approach:**
```aql
LET uri_map = MERGE(
  FOR n IN nodes FILTER ... RETURN {[n.logical_id]: n.provenance.source_uri}
)
```
`MERGE` over thousands of nodes is slow and memory-heavy. Replace with a direct join:
```aql
FOR e IN edges
  FILTER e.predicate IN @predicates AND e.deleted_rev == null
  LET sn = FIRST(FOR n IN nodes FILTER n.logical_id == e.src ... RETURN n.provenance.source_uri)
  LET dn = FIRST(FOR n IN nodes FILTER n.logical_id == e.dst ... RETURN n.provenance.source_uri)
  FILTER sn != null AND dn != null AND sn != dn
  COLLECT srcUri = sn, dstUri = dn, pred = e.predicate WITH COUNT INTO cnt
  RETURN {srcUri, dstUri, predicate: pred, count: cnt}
```
Or with `AQL FOR` subqueries if the ArangoDB index on `logical_id` is usable (it should be, as it's the document key).

**`liveFileCount`:** Replace with a `COLLECT WITH COUNT` query instead of fetching all file data.

**`currentInputRev`:** Benchmark whether combining into one AQL pass is faster.

---

### Task 2 — Fix O(n²) path-proximity pass
**ID:** `9544f83f-e0bb-8973-aa1c-a4d642a63ef0`

**Problem:** The same-directory edge pass is:
```scala
for (i <- dirFiles.indices; j <- (i + 1) until dirFiles.size) {
  pathProximity(sv.path, dv.path)  // splits strings every call
}
```
For a directory with D files, this is O(D²) calls. Monorepos can have 50+ files in src/.

**Fix:**
1. Precompute `dirSegments: Map[NodeId, Array[String]]` for all files once.
2. Replace `pathProximity(a, b)` with an index lookup using precomputed segments.
3. For same-directory files the result is always `1.0 / (1.0 + 0)` = 1.0 — can hardcode for the same-dir case.
4. Add an `adjMut.size > MaxEdges` safety cap to prevent quadratic blowup in dense directories.

---

### Task 3 — Improve Louvain convergence and stability
**ID:** `ca2b0225-c97d-77bf-021f-32b6e1b51884`

**Multi-seed best-of selection:**
```scala
val runs = (1 to 3).map(seed => louvainPass(graph, resolution, new Random(seed)))
val best = runs.maxBy(a => modularity(graph, a))
```
3 runs with different seeds, pick the one with highest modularity. Cost: 3× but more stable results.

**Adaptive resolution:**
- Small repos (< 50 files): resolution 1.2 (prefers smaller, tighter communities)
- Medium repos (50–500 files): resolution 1.0 (default)
- Large repos (> 500 files): resolution 0.8 (allows larger communities, avoids over-fragmentation)

**Convergence check:** The 30-pass hard cap is arbitrary. Add a modularity delta check — stop when ΔQ < 1e-6 rather than forcing 30 passes.

**`rng.shuffle` allocation:** Use Fisher-Yates in-place shuffle on an `Array[NodeId]` instead of `rng.shuffle(nodes)` which allocates a new `Vector` each pass.

---

### Task 4 — Tune signal weights, crosscut detection, and confidence formula
**ID:** `fc9c3ec1-5b6e-3889-8974-ecc9d6dc8995`

**Signal weights — proposed tuned values:**

| Signal | Current | Proposed | Rationale |
|---|---|---|---|
| α (CALLS) | 1.0 | 1.0 | Keep as anchor |
| β (IMPORTS) | 0.7 | 0.5 | Imports are noisier than calls in TypeScript/Python; over-weighted |
| γ (EXTENDS/IMPLEMENTS) | 0.9 | 1.2 | Type hierarchy is a very strong cohesion signal, especially in Scala/Java |
| ε (path proximity) | 0.3 | 0.2 | Structural prior should be weak; files in same dir ≠ same subsystem |

**Crosscut token expansion:**
```scala
CrosscutTokens = Set(
  // existing
  "util", "utils", "helper", "helpers", "common", "shared", "base",
  "logging", "log", "logger", "config", "conf", "constants", "constant",
  "extensions", "ext", "mixin", "mixins", "core", "framework",
  // add: framework layer names
  "service", "services", "controller", "controllers",
  "repository", "repositories", "repo", "handler", "handlers",
  "middleware", "interceptor", "filter", "filters",
  "model", "models", "entity", "entities", "dto", "dtos",
  "interface", "interfaces", "types", "errors", "exceptions"
)
```
These are all cross-cutting by nature in layered architectures.

**`computeConfidence` — boundary ratio saturation:**

Current `brScore = tanh(br / 3.0)` saturates at br ≈ 9. Real repos often have br in 0.5–5 range, so the curve is well-placed. But the size bonus `tanh(size / 10)` gives half-credit to 7-file regions. Proposed:
```scala
val brScore    = math.tanh(boundaryRatio / 2.5)   // slightly tighter saturation
val cohScore   = cohesion.min(1.0)
val sizeBonus  = math.tanh(size / 8.0)            // penalize tiny regions more
val crossPenalty = crosscutScore * 0.4             // stronger crosscut penalty
```

---

### Task 5 — Restore dominant_signals and improve label inference
**ID:** `8c897b67-c639-5705-c0d3-4278b4fa54f3`

**Dominant signals:**
The `dominantSignals` field was cleared in the bug-fix review because `signalCounts` was never populated. The right fix is to thread per-predicate counts through from `MapGraphBuilder` into `buildOneRegion`.

Option A: Add `predicateCounts: Map[(NodeId,NodeId), Map[String,Int]]` to `WeightedFileGraph` (keeps graph builder responsible).

Option B: In `buildOneRegion`, iterate the adjacency and compute a signal breakdown from the raw weights by inverting the weight formula (approximate).

Option A is cleaner. Add to `WeightedFileGraph`:
```scala
final case class WeightedFileGraph(
  vertices:        Vector[FileVertex],
  adjMatrix:       Map[NodeId, Map[NodeId, Double]],
  degrees:         Map[NodeId, Double],
  totalWeight:     Double,
  predicatePairs:  Map[(NodeId, NodeId), Map[String, Int]]  // NEW
)
```

**Label inference — fix strategy order:**

Strategy 1 (longest common suffix) fires even when the common segment is a noise token like "api" or "db". Proposed:

1. Try longest common suffix after filtering noise tokens (current).
2. If result length < 3 chars, fall through to strategy 2.
3. Strategy 2 (discriminative depth-weighted segments) should be weighted by _intra-cluster_ frequency vs. _corpus_ frequency — a segment appearing in 80% of this cluster but only 10% of all files is highly discriminative.
4. Fallback: most frequent camelCase token from filenames.

---

## Performance Benchmarks Needed

Before tuning, establish baselines on this repo:

```bash
time ix map --format json > /dev/null          # end-to-end
time ix map --format json > /dev/null          # second run (should hit cache)
```

Target metrics:
- Cold map (no cache): < 5s for this repo (~150 files)
- Cache hit: < 500ms
- Large repo (2000+ files): < 30s cold, < 1s cached

---

## Files Affected

| File | Changes |
|---|---|
| `memory-layer/src/main/scala/ix/memory/map/MapGraphBuilder.scala` | Tasks 1, 2 |
| `memory-layer/src/main/scala/ix/memory/map/LouvainClustering.scala` | Task 3 |
| `memory-layer/src/main/scala/ix/memory/map/MapService.scala` | Task 4, 5 |
| `memory-layer/src/main/scala/ix/memory/map/MapTypes.scala` | Task 5 (add `predicatePairs` to `WeightedFileGraph`) |
