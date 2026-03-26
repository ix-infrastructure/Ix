# Large Repo Ingest Performance

Date: 2026-03-25
Branch: `feature/claude-plugin`

---

## Baseline

Kubernetes repo (`files=16010`) before this work:

| Phase | Time |
|---|---|
| `ix map` ingest | ~466s |
| `ix map` map computation | ~53s |
| **Total `ix map`** | **~519s** |

Debug profile at baseline:
```
resolveEdgesMs=29581  buildPatchMs=10156  commitMs=386443  totalSaveMs=426834
```

The commit path dominated — 386s out of 427s total save time.

---

## What We Did (already merged)

### 1. Compound DB indexes (`memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala`)

Added compound indexes on `nodes(logical_id, deleted_rev)` and `claims(entity_id, deleted_rev)`. Tombstone + retire AQL queries filter both fields; without this, Arango returned all historical node versions then post-filtered. Now it does direct point lookups.

### 2. Upfront batch tombstone + retire (`memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`)

In `commitBatchChunked`, when multiple DB chunks exist and `baseRev > 0`, now collects all entity IDs upfront and runs tombstone + retire **once in parallel** before any inserts (`skipTombstone = true` passed to each per-chunk call). Previously ran 320 AQL UPDATE passes for Kubernetes; now runs 2.

Also parallelized tombstone + retire within `commitBatch` for the single-chunk case using `IO.both`.

### 3. Generated file filtering (`ix-cli/src/cli/commands/ingest.ts`)

Skip known generated files by filename before parsing: `*.pb.go`, `zz_generated*`, `*_deepcopy.go`, `*_mock.go`, `mock_*`, `*.pb.ts`, `*.pb.js`, `_pb.ts`, `_pb.js`. Applied in both `walkFiles` and `tryGitLsFiles`.

### 4. Parallel HTTP save requests (`ix-cli/src/cli/commands/ingest.ts`)

Replaced sequential `for` loop in `commitPreparedPatches` with a 4-worker pool (`COMMIT_CONCURRENCY = 4` at line ~416). Fixed progress bar to use `Math.max` so it doesn't jump backward when an out-of-order chunk completes.

---

## Current State (2026-03-25, pre-session baseline)

| Phase | Before | After | Delta |
|---|---|---|---|
| Ingest | ~466s | ~200s | **-57%** |
| Map computation | ~53s | ~87s | +64% (regression) |
| **Total `ix map`** | **~519s** | **~287s** | **-45%** |

Graph after full Kubernetes ingest:
```
nodes:  312,140  (113k chunk, 76k module, 43k function, 42k method, 16k class, 15k file)
edges:  840,843  (319k CALLS, 107k CONTAINS_CHUNK, 105k CONTAINS, 95k NEXT, 76k IMPORTS)
```

---

## Current State (2026-03-26, post-session)

| Phase | Before | After | Delta |
|---|---|---|---|
| Ingest | ~200s | ~227s | +13% (conflict fix overhead) |
| Map computation | ~87s | ~82s | -6% |
| **Total `ix map`** | **~287s** | **~309s** | +8% |

Ingest debug breakdown (15035 files, full fresh ingest):
```
resolveEdgesMs=26252  buildPatchMs=8731  commitMs=607952  totalSaveMs=188862
```

Ingest is currently slightly slower than the pre-session baseline. The chunk-skipping benefit (~30% fewer DB inserts) is real but offset by the COMMIT_CONCURRENCY revert to 4 (was already 4 at baseline, no gain there) and normal run variance. Ingest is clean — zero write-write conflict errors.

Map regression (82s vs 53s pre-"What We Did") is **unresolved** — this is Task 3.

---

## Targets

| Phase | Current | Target |
|---|---|---|
| Ingest | ~227s | ~90s |
| Map computation | ~82s | ~20s |
| **Total** | **~309s** | **~110s** |

---

## Task List

Tasks are independent unless noted. Each is scoped to be completable by a single Claude instance with no context from the others.

---

### Task 1 — Bump `COMMIT_CONCURRENCY` 4 → 6 ⚠️ BLOCKED

**Priority:** High — blocked by write-write conflict bug (see Task 1b below).

Bumping to 6 caused systemic write-write conflicts in ArangoDB. Root cause was identified and fixed (see Task 1b), but after that fix concurrency was left at 4. Re-attempting the bump to 6 should now be safe — the `updateRevision` conflict is eliminated, and `retryOnConflict` handles any residual tombstone conflicts.

**Acceptance:** Run `IX_DEBUG=1 ix map <kubernetes-repo>` with no `[commit error]` lines and confirm `commitMs` drops vs the 607952ms baseline.

---

### Task 1b — Fix `updateRevision` write-write conflict ✅ DONE

**Root cause:** `updateRevision` used an AQL `UPSERT { _key: "current" }` on the `revisions` collection. Every HTTP commit request ends with this call. With multiple concurrent workers, all requests raced to update the same document → ArangoDB write-write conflict error 1200.

**Fix (`memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`):**
Replaced the AQL UPSERT with two Document API inserts via the existing `bulkInsert(..., overwriteMode="replace")`. The Document API replace is atomic at the document level — concurrent replaces on the same `_key` don't conflict; last writer wins (acceptable since all concurrent requests write the same rev value).

Also added `retryOnConflict` in the client (`ix-cli/src/cli/commands/ingest.ts`) with 10ms base jitter backoff as a safety net for any residual tombstone-phase conflicts.

---

### Task 2 — Skip chunk nodes/edges during map-triggered ingest ✅ DONE

**Priority:** High — estimated ~30% fewer DB inserts.

**Files:**
- `ix-cli/src/cli/commands/ingest.ts` — add `skipChunks` flag, filter nodes/edges before patch submission
- `ix-cli/src/client/api.ts` — pass flag through to request if needed
- `ix-cli/src/client/types.ts` — add type if needed

**Background:**
Current insert volume per 200-file HTTP batch (estimated):
- ~4,154 nodes, of which ~36% are `chunk` kind nodes
- ~11,186 edges, of which ~24% are `CONTAINS_CHUNK` + `NEXT` edges

Chunk nodes and their edges are LLM context artifacts (for `ix read`). The Louvain clustering in `MapService.computeAndPersistMap` runs on `IMPORTS` and `CALLS` edges between file nodes — it never touches chunks. Skipping them during `ix map` doesn't affect map quality.

**What to do:**

1. In `ingest.ts`, find where `PreparedPatch` objects are built (the `buildPatch` / `resolveEdges` path). Add a `mapMode: boolean` parameter that, when true, strips:
   - Any node with `kind === "chunk"`
   - Any edge with `kind === "CONTAINS_CHUNK"` or `kind === "NEXT"`

2. The `ix map` code path in `ingest.ts` (around line ~544 and ~598, the `commitPreparedPatches` calls) should pass `mapMode: true`.

3. The `ix ingest` code path (full ingest, used for `ix read`) must continue writing chunks — pass `mapMode: false` or omit the flag.

4. Do not change the server side. The filtering should be purely client-side before the HTTP payload is built.

**Acceptance:**
- `IX_DEBUG=1 ix map <kubernetes-repo>` shows fewer nodes/edges inserted per batch (verify via backend `insertNodes`/`insertEdges` log lines)
- `ix read <any-file>` after a full `ix ingest` still returns chunk content (chunks must still be written on full ingest)
- No change to `ix map` output quality (regions/subsystems unchanged or better)

---

### Task 3 — Profile and fix map computation regression (82s → target 20s)

**Priority:** High — map computation is the bottleneck for incremental `ix map` runs. Every file save triggers a re-map; keeping this fast matters more than ingest speed.

**Note on terminology:** `ix ingest` is deprecated. `ix map` is the primary command. It has two phases: ingest phase (parse + commit files) and map computation phase (Louvain clustering + persist). Task 3 is about the map computation phase only.

**Files:**
- `memory-layer/src/main/scala/ix/memory/map/MapService.scala` — primary target
- `memory-layer/src/main/scala/ix/memory/map/MapGraphBuilder.scala` — if `build()` is the bottleneck

**Current timing:** map computation = ~82s on Kubernetes (15035 files, 828 regions). Pre-regression baseline was ~53s. Target: ≤20s (30s acceptable).

**Background:**
`computeAndPersistMap` has four steps:
1. `builder.build()` — loads file graph from DB (IMPORTS/CALLS edges between file nodes)
2. `detectCrosscut(rawGraph)` — pure CPU
3. `LouvainClustering.cluster(...)` — pure CPU, `maxLevels=3`
4. `persistMap(fresh, cached)` — writes region nodes to DB, compares old vs new regions

The regression likely lives in `builder.build()` (more nodes/edges to load since ingest changes) or `persistMap` (`sameRegions` comparison may be slow at 828 regions).

**What to do:**

1. Read `MapService.scala` first to find `computeAndPersistMap` and understand the current structure before adding instrumentation.

2. Add coarse `System.currentTimeMillis()` timing around each of the four steps and log at INFO level:
   ```scala
   val t0 = System.currentTimeMillis()
   rawGraph <- builder.build()
   val t1 = System.currentTimeMillis()
   // ... etc
   logger.info(s"map build=${t1-t0}ms crosscut=${t2-t1}ms cluster=${t3-t2}ms persist=${t4-t3}ms")
   ```

3. After adding instrumentation, rebuild and restart the backend:
   ```bash
   # from repo root (/home/ianhock/ix/IX-Memory)
   ./rebuild.sh
   ```

4. Run to collect the timing breakdown:
   ```bash
   IX_DEBUG=1 ix map /home/ianhock/kubernetes 2>&1 | tee /tmp/ix-map-debug.log
   grep "map build=" /tmp/ix-map-debug.log
   ```

5. Fix the dominant step:
   - If `builder.build()` is slow: check `MapGraphBuilder` — it queries all IMPORTS/CALLS edges between file nodes. Look for missing indexes or N+1 queries. Check `ArangoSchema.scala` for relevant indexes.
   - If `persistMap` is slow: check `sameRegions` — it sorts and compares full `Region` objects. At 828 regions this is O(n log n) with potentially high constant. Also check `submitMapPatch` / `loadOldRegionIds`.
   - If `LouvainClustering.cluster` is slow: the graph got larger. Check how many file nodes are passed to the clusterer vs pre-regression.

**Acceptance:**
- Map computation ≤ 30s on Kubernetes (20s target, 30s acceptable for this task)
- Timing log line visible in backend output during `IX_DEBUG=1 ix map`
- No regression in `ix map` output (828 regions expected, same or similar structure)
- Rebuild via `./rebuild.sh` from repo root before testing

---

### Task 4 — Vacuum old tombstoned node versions

**Priority:** Medium — reduces DB size and disk I/O over time; not urgent for this sprint.

**Files:**
- `memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala` — add vacuum method
- `memory-layer/src/main/scala/ix/memory/api/` — add a `/vacuum` or `/admin/vacuum` HTTP endpoint
- `ix-cli/src/client/api.ts` and `ix-cli/src/cli/commands/` — add `ix vacuum` CLI command

**Background:**
Every ingest revision leaves behind tombstoned docs in the `nodes` collection (`deleted_rev IS NOT NULL`). After N ingests of Kubernetes (312k live nodes), the collection has ~N × 312k docs. These bloat ArangoDB's working set, spill indexes to disk, and account for the 12.4GB disk write profile.

**What to do:**

1. In `ArangoClient.scala`, add a method:
   ```scala
   def vacuumTombstoned(keepRevisions: Int): IO[Long]
   ```
   That runs:
   ```aql
   FOR n IN nodes
     FILTER n.deleted_rev != null
       AND n.deleted_rev < @cutoffRev
     LIMIT 50000
     REMOVE n IN nodes
     RETURN 1
   ```
   Where `cutoffRev = latestRev - keepRevisions`. Use `LIMIT 50000` per pass and loop until 0 rows removed to avoid ArangoDB memory pressure on large deletes. Apply the same pattern to the `edges` and `claims` collections.

2. Expose it via a backend endpoint (e.g. `POST /admin/vacuum?keepRevisions=5`).

3. Add `ix vacuum [--keep-revisions N]` CLI command (default `--keep-revisions 5`).

**Acceptance:**
- After `ix vacuum` on Kubernetes graph, `nodes` collection count drops by at least 50% (or confirms there are minimal tombstoned docs if this is a fresh graph)
- Subsequent `ix map` run shows reduced disk I/O in `IX_DEBUG=1` output
- `ix vacuum` completes without OOM or ArangoDB timeout (batched deletes required)

---

### Task 5 — Dynamic concurrency auto-tuning (stretch goal)

**Priority:** Low — only needed if fixed concurrency of 6 still leaves headroom.

**File:** `ix-cli/src/cli/commands/ingest.ts`

**What to do:**
Replace the fixed `COMMIT_CONCURRENCY` constant with a simple AIMD (additive increase / multiplicative decrease) controller:
- Track rolling P90 latency of the last 10 batch commits
- If P90 < 8s, increment concurrency (up to max 12)
- If P90 > 15s or a batch times out, decrement concurrency (min 2)
- Log current concurrency level in the `[ingest-save]` debug line

**Acceptance:**
- On Kubernetes, concurrency auto-settles to a stable value within the first 10 batches
- Total ingest time is ≤ fixed-concurrency-6 time (must not be slower)
- No batch timeout errors introduced

---

## Profiling Instructions

To collect the data needed for Task 3:

```bash
IX_DEBUG=1 ix map <kubernetes-repo-path> 2>&1 | tee /tmp/ix-map-debug.log
```

Look for:
- Client: `[ingest-save]` lines — per-batch phase breakdown
- Client: `[slow saving]` lines — which batch numbers are slow
- Backend: `ix.bulk-write` log lines — `insertNodes`, `insertEdges`, `insertClaims`, `insertPatches` per-stage breakdown
- Backend: `pre-tombstone` line — tombstone+retire time
- Backend (after Task 3 instrumentation): `map build=Xms crosscut=Yms cluster=Zms persist=Wms`
