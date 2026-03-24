# ix map Performance + Scalability Fix Plan

**Files reviewed:** `MapGraphBuilder.scala`, `MapService.scala`, `LouvainClustering.scala`, `MapTypes.scala`
**Date:** 2026-03-22

---

## Change Tracking

This section is the running handoff record for follow-up review and bug fixing.

### Files changed

- `memory-layer/src/main/scala/ix/memory/map/MapGraphBuilder.scala`
  Rewrote `fetchCouplingByUri()` to build a single `logical_id -> source_uri`
  lookup map inside AQL, pushed source-extension filtering into `fetchFiles()`,
  added directory-size guardrails for path-proximity edges, and changed
  `currentInputRev()` to use a dedicated `source-graph` revision with a scan
  fallback for older data.
- `memory-layer/src/main/scala/ix/memory/map/MapService.scala`
  Replaced O(R²) parent wiring in `buildRegions()` with partition-based lookup,
  removed subset-scan recomputation from `rehydrateRelationships()`, trimmed
  `CrosscutTokens`, replaced the max-degree heuristic with a real percentile
  cutoff, and precomputed signal adjacency so dominant-signal scoring only
  touches region-local incident pairs.
- `memory-layer/src/main/scala/ix/memory/map/LouvainClustering.scala`
  Added seed gating for small graphs and reused the community-weight map inside
  the hot Louvain loop instead of allocating it per node.
- `memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`
  Updated revision writes so bulk ingestion advances both the global revision
  and the dedicated `source-graph` revision.
- `memory-layer/src/main/scala/ix/memory/db/ArangoGraphWriteApi.scala`
  Added source-graph revision tracking for patch commits that touch map inputs,
  while leaving derived writes on the global revision only.
- `docs/plans/map-algorithm-review.md`
  Revised the recommendations so they match the current codebase, added this
  tracking section, and recorded implementation and verification status.

### Implementation notes

- `currentInputRev()` needs a dedicated source-graph revision, not just the
  global revision, because non-map-input writes also advance the main revision
  counter.
- `buildRegions()` can use partition assignments directly, but only after
  accounting for communities filtered out by `minCommunitySize`.
- `CrosscutTokens` cleanup should be paired with a fix to the current
  pseudo-percentile degree threshold.

### Verification notes

- Build: `sbt memoryLayer/compile` passed on 2026-03-22
- Runtime benchmark: not run
- `ix map` end-to-end validation: not run in this pass

---

## TL;DR

Primary bottlenecks:

1. O(E × N) database query in `fetchCouplingByUri()`
2. Full graph scan per run in `currentInputRev()`
3. O(R²) region construction in `buildRegions()`

These issues cause `ix map` to degrade from near-linear toward quadratic behavior, leading to Docker crashes and unusable performance on large codebases.

Fixing these should reduce runtime from minutes to seconds for 500-2,000 file repos.

---

## Summary

The algorithm is architecturally correct: multi-level Louvain plus weighted signals is the right direction.

The problem is **scalability**, not correctness.

**Severity legend:** Critical / High / Medium / Low

---

# 1. Critical Bottlenecks

## `fetchCouplingByUri()` - O(E × N) correlated subqueries

Each edge performs two full scans over `nodes` to resolve `src` and `dst`. Without an index on `logical_id`, this is O(E × N) - for 5,000 edges and 50,000 nodes that's 250M comparisons per `ix map`.

**Fix (preferred):** build the URI map once, then join:

```aql
LET uriMap = (
  FOR n IN nodes
    FILTER n.deleted_rev == null
      AND n.provenance.source_uri != null
      AND n.kind NOT IN @ignoredKinds
    RETURN { id: n.logical_id, uri: n.provenance.source_uri }
)

LET byId = ZIP(uriMap[*].id, uriMap[*].uri)

FOR e IN edges
  FILTER e.predicate IN @predicates
    AND e.deleted_rev == null
  LET su = byId[e.src]
  LET du = byId[e.dst]
  FILTER su != null AND du != null AND su != du
  COLLECT srcUri = su, dstUri = du, pred = e.predicate WITH COUNT INTO cnt
  RETURN { srcUri, dstUri, predicate: pred, count: cnt }
```

**Alternative:** add a persistent index on `nodes.logical_id`. Cuts each subquery from O(N) to O(log N) without rewriting the query.

---

## `currentInputRev()` - full graph scan per run

Runs a MAX aggregation over all nodes and edges on every `ix map` call, even when the graph is unchanged and the cached map will be reused.

**Fix:** maintain a dedicated source-graph revision entry updated only when source-graph inputs change. Do not reuse the global revision counter directly, because map persistence and other derived writes also advance it.

One viable implementation is a separate revisions entry:

```json
{ "_key": "source-graph", "rev": 123 }
```

Then `currentInputRev()` becomes a single key lookup, with a fallback full scan only for older databases that do not yet have the dedicated metadata:

```aql
FOR doc IN revisions
  FILTER doc._key == "source-graph"
  LIMIT 1
  RETURN doc.rev
```

Result: O(1) instead of O(N + E).

---

# 2. High Priority Fixes

## `buildRegions()` - O(R²) parent-child wiring

Currently calls `region.memberFiles.subsetOf(p.memberFiles)` for every `(region, parent)` pair. Replace with a direct lookup from the Louvain partition, but preserve correctness when some communities are filtered out by `minCommunitySize`:

```scala
val fileToParent: Map[NodeId, Int] = coarseLevel.assignment

val parentOpt = memberFiles.headOption
  .flatMap(fileToParent.get)
  .flatMap(coarseRegionByCommunity.get)
```

Where `coarseRegionByCommunity` only contains retained coarse communities, and equal-set coarse regions should still be treated as "no parent" to match the current hierarchy behavior.

---

## `rehydrateRelationships()` - remove recomputation

`parentId` and `childRegionIds` are already persisted on region nodes. Do not rerun the subset scan on cache load. Wire children directly from the loaded data:

```scala
val childrenByParent = regions
  .flatMap(r => r.parentId.map(pid => pid -> r.id))
  .groupBy(_._1)
  .view
  .mapValues(_.map(_._2).toSet)
  .toMap
```

---

## `CrosscutTokens` - too many false positives

Tokens like `"service"`, `"controller"`, `"repository"`, `"model"`, `"entity"`, `"dto"` are standard naming conventions, not cross-cutting concerns. Flagging them applies a penalty to the coupling signals that should cluster those files together.

Also fix the degree-side heuristic: the current code uses `maxDeg * 0.9`, which is not actually "top 10% by degree". If percentile behavior matters, compute it from the observed degree distribution instead of scaling the maximum.

Remove architectural terms. Keep only genuine horizontal concerns:

```scala
private val CrosscutTokens = Set(
  "util", "utils", "helper", "helpers", "common", "shared",
  "logging", "config", "constants", "base"
)
```

---

# 3. Medium Fixes

## `computeDominantSignals()` - O(total edges) per region

Iterates all `graph.predicatePairs` for each region. Build a per-file signal index once before the region loop so each region only touches incident pairs for its own members.

```scala
Map[NodeId, Vector[(NodeId, Map[String, Int])]]
```

---

## Path proximity - O(N²) per directory

Only run the path proximity pass for directories with between 2 and 50 files. Large flat directories (generated code, fixtures) add noise and inflate the graph without contributing architectural signal.

Also push source-extension filtering into the `fetchFiles()` AQL so the JVM does not deserialize non-source file rows it will drop anyway.

---

## Louvain optimizations

**Seed gating** - skip the extra two seeds for small graphs:

```scala
val numSeeds = if (graph.vertices.size < 30) 1 else 3
```

**Avoid map allocation in hot loop** - allocate once and clear per node:

```scala
val wToComm = mutable.HashMap[Int, Double]()
// inside the loop:
wToComm.clear()
```

---

# 4. Graph Guardrails

Hard limits to prevent runaway memory and time on large repos:

**Node limits:**
- V > 5,000: disable path proximity edges; cap soft edges per node at 5
- V > 10,000: switch to coarse mode (directory-level clustering only)

**Density limits:**
- E / V > 50: prune lowest-weight edges before clustering

**Edge budget by type:**
- Structural edges (imports, calls): unlimited
- Path similarity: max 3 per node

---

# 5. Execution Plan

## Phase 1 - Database

- Fix `fetchCouplingByUri()` query
- Replace `currentInputRev()` with dedicated source-graph revision metadata

**Validate:** identical output, runtime measurably reduced.

## Phase 2 - Region construction

- Replace `buildRegions()` subset scan with direct lookup
- Remove recomputation in `rehydrateRelationships()`
- Precompute dominant-signal adjacency once per graph

**Validate:** same region hierarchy, no missing parents.

## Phase 3 - Graph density controls

- Limit path proximity to small/medium directories
- Push source-extension filtering into the DB query

**Validate:** lower edge count on large flat trees with no missing file vertices.

## Phase 4 - Louvain optimization

- Seed gating by graph size
- Reuse `wToComm` map across iterations

**Validate:** clustering stable across runs, runtime improved.

## Phase 5 - Cross-cut cleanup

- Fix `CrosscutTokens`
- Replace the pseudo-percentile threshold with a real percentile cutoff

## Phase 6 - Scaling safeguards

- Implement graph guardrails
- Add coarse mode for V > 10,000

---

# 6. Constraints

- Output of `ix map` should remain materially consistent: same broad region membership and hierarchy unless a heuristic fix explicitly justifies a behavior change
- Do not introduce new edge types
- Do not alter signal weights without justification

---

# 7. Anti-Patterns

- O(N²) similarity computations across the whole repo
- Full collection scans inside per-edge or per-node loops
- Per-node or per-edge database queries
- Rebuilding the full graph on every cache lookup
- Dense adjacency matrices

---

# 8. Success Criteria

| Metric | Target |
|---|---|
| `fetchCouplingByUri` | < 100ms for 10k edges |
| `currentInputRev` | < 5ms |
| 500 files | < 5s end-to-end |
| 2,000 files | < 10s end-to-end |

---

# 9. Priority Order

| Priority | Fix |
|---|---|
| 1 | `fetchCouplingByUri` query rewrite |
| 2 | `currentInputRev` dedicated source-graph revision |
| 3 | Path proximity directory-size guardrail |
| 4 | `CrosscutTokens` cleanup + real percentile threshold |
| 5 | `rehydrateRelationships` recompute removal |
| 6 | `buildRegions` O(R²) replacement |
| 7 | Louvain seed gating + map reuse |

---

## Final Note

Target complexity: **O(V + E)**.

If performance degrades superlinearly, the graph is too dense or queries are unindexed. Diagnose with `IX_DEBUG=1 ix map` and inspect per-phase timing before adding more signal types or hierarchy levels.
