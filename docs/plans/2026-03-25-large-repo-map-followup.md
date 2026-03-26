# Large Repo `ix map` Follow-up

Date: 2026-03-25

## Current user workflow

Use `ix map` only.

Do not assume `ix ingest` is part of the normal workflow anymore. Any large-repo performance work needs to be evaluated through `ix map`, since `ix map` triggers ingest first and that is what the user experiences.

## Main problem

Large repos improved for map computation, but ingest/save regressed badly.

Observed user report for Kubernetes:

- `ix map` total ingest time on current branch: about `466s`
- `ix map` total map time on current branch: about `53s`
- Earlier target / expected behavior from dev: ingest closer to `90s`
- Previous map-only improvement target: Kubernetes map around `20s`

Observed debug sample from user:

- `files=16010`
- `resolveEdgesMs=29581`
- `buildPatchMs=10156`
- `commitMs=386443`
- `totalSaveMs=426834`

Conclusion: the dominant regression is still in the save/commit path, not parse, resolve, or map clustering.

## Confirmed issues

### 1. Save path is the bottleneck on large repos

Client debug logs showed repeated slow commit chunks during saving, for example:

- `commit 3401-3600 ... (15s)`
- `commit 5601-5800 ... (17s)`
- `commit 7801-8000 ... (25s)`

This points at backend bulk commit behavior, especially chunk sizing and/or Arango bulk insert characteristics on large batches.

### 2. `ix map` output had duplicate top-level regions

The map output showed repeated roots like:

- `MODULE Edges`
- `SUBSYSTEM Edges`
- `SYSTEM Edges`

and similarly for `Builder`.

Cause found:

- the same file set could survive across multiple hierarchy levels
- those duplicate regions shared the same deterministic region ID
- they were all rendered as roots/orphans

Status:

- fixed in code by collapsing duplicate hierarchy levels to the coarsest retained region
- regression test added
- verified on a fresh backend

Remaining note:

- `Edges` and `Builder` may still appear once each as top-level systems because they are still weakly connected / isolated in the graph
- that is a separate modeling issue from the duplicate-root bug

## Changes already made

### Map hierarchy fix

Updated:

- `memory-layer/src/main/scala/ix/memory/map/MapService.scala`
- `memory-layer/src/test/scala/ix/memory/map/MapServiceScopeSpec.scala`

What changed:

- collapse duplicate same-member-set regions across module/subsystem/system levels
- keep only the coarsest retained region
- preserve children pointing at that surviving region

### Ingest/save tuning already tried

Updated:

- `ix-cli/src/cli/commands/ingest.ts`
- `memory-layer/src/main/scala/ix/memory/db/BulkWriteApi.scala`

What changed:

- reduced client bulk HTTP batch size from `1000` files to `200`
- reduced backend revision chunk size from `500` files to `100`
- reduced backend payload cap from `16MB` to `4MB`
- capped patch document insert batches instead of inserting arbitrarily large patch arrays

## Measured result after tuning

On a fresh isolated backend, full ingest of this repo improved from an earlier sample with:

- `commitMs ~10899`

to:

- `commitMs 4021`
- total ingest `5.48s` for `221` changed files

This confirms the chunk-size rollback helped on the repo-sized benchmark.

## What is still unresolved

The large-repo `ix map` path for Kubernetes is still much too slow.

Even after chunk-size reductions, the real user-facing test case remains:

- `ix map <kubernetes repo>`

and the unresolved part is:

- save/commit time at large scale

## What to collect next

Since the user uses `ix map`, collect logs from `ix map`, not a standalone `ix ingest` run.

Needed evidence next time:

1. Client-side `ix map` debug output including:
   - slow saving lines
   - final `[ingest-save]` line
   - final `ingest Xms · map Yms`
2. Backend `memory-layer` logs at the same time, especially `ix.bulk-write` timings
3. Identify which backend stage dominates:
   - `insertNodes`
   - `insertEdges`
   - `insertClaims`
   - `insertPatches`
   - tombstoning / retiring old claims
   - revision update

## Likely next investigation targets

1. Arango bulk insert performance for edges and patches on very large repos
2. Whether generated files (`zz_generated`, `.pb.go`, deepcopy/defaults, etc.) should be skipped or downgraded during `ix map`
3. Whether `ix map` should use a cheaper ingest mode than full graph ingest for very large repos
4. Whether chunk sizing should adapt dynamically based on actual commit latency rather than fixed file counts
5. Whether large repo map should avoid persisting some low-value entities/claims during the map-triggered ingest path

## Operational note

If a fix appears to work in code but not in normal `ix map` output, confirm the running backend has actually been restarted. During this session, the old `8090` backend continued serving stale behavior until a fresh backend process was started separately.
