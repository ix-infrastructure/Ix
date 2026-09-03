# Ix HTTP API Reference

The Ix backend exposes a JSON-over-HTTP API on **`http://localhost:8090`** (the
local Docker memory-layer). The `ix` CLI and the Compass visualizer are its two
primary clients. This reference is generated from the client source
(`ix-cli/src/client/api.ts`), the visualizer server template
(`ix-cli/src/cli/commands/view.js`), and the shared client types
(`ix-cli/src/client/types.ts`).

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Authentication & Scoping](#authentication--scoping)
4. [Base Endpoints](#base-endpoints)
5. [Endpoints by Area](#endpoints-by-area)
   - [Health & Capabilities](#health--capabilities)
   - [Context & Question Answering](#context--question-answering)
   - [Ingestion & Mapping](#ingestion--mapping)
   - [Search & Discovery](#search--discovery)
   - [Entities & Traversal](#entities--traversal)
   - [Planning Artifacts](#planning-artifacts)
   - [Patches & Provenance](#patches--provenance)
   - [Analysis (Diff, Conflicts, Smells, Subsystems)](#analysis)
   - [Stats & Savings](#stats--savings)
   - [Reset](#reset)
6. [Visualizer Proxy Surface](#visualizer-proxy-surface)
7. [Data Models](#data-models)
8. [Error Reference](#error-reference)
9. [Timeouts & Deadlines](#timeouts--deadlines)
10. [Versioning](#versioning)

## Overview

All endpoints are under `/v1` and speak JSON. Requests use `Content-Type:
application/json`; responses are JSON objects. There is no version prefix other
than `/v1`; schema compatibility is signaled by `schema_version` in
`/v1/health`.

The API has two logical surfaces:

- **Backend API (direct, port 8090)** — used by the CLI.
- **Visualizer proxy (port 8080)** — Compass serves the SPA and proxies every
  `/v1/*` request to the backend, stamping workspace/system scoping headers.

## Quick Start

```bash
# Liveness + graph schema version
curl -s http://localhost:8090/v1/health

# Ingest a repository
curl -s -X POST http://localhost:8090/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"path": "/absolute/path/to/repo", "recursive": true}'

# Search for a symbol
curl -s -X POST http://localhost:8090/v1/search \
  -H "Content-Type: application/json" \
  -d '{"term": "IngestionService", "limit": 10, "kind": "class"}'

# Get structured context for a question
curl -s -X POST http://localhost:8090/v1/context \
  -H "Content-Type: application/json" \
  -d '{"query": "how does ingestion flow end to end?"}'
```

## Authentication & Scoping

- **Local backend**: no authentication. The endpoint is bound to localhost.
- **Scoping headers**: the visualizer proxy stamps `x-ix-workspace` (and
  `x-ix-system` when the launch directory is part of a stitched multi-repo
  system) on every proxied `/v1` request. The backend reads these as a
  fallback when no explicit `workspace_id` / `system_id` is on the request.
- **Query/body scoping**: most read endpoints accept optional `workspace_id`
  and `system_id` parameters to bound the result set server-side.
- **Pro features**: `GET /v1/capabilities` reports whether Pro features are
  enabled. Treat an absent field as *unknown*, not *false* (older backends).

## Base Endpoints

| Method | Path | Client | Purpose |
|---|---|---|---|
| GET | `/v1/health` | `health()` | Liveness, status, `schema_version` |
| GET | `/v1/capabilities` | `capabilities()` | Pro feature flags |
| POST | `/v1/context` | `query()` | Structured-context QA |

## Endpoints by Area

### Health & Capabilities

#### GET `/v1/health`

Liveness probe. Returns `{"status": "ok", "schema_version": 3}`. A client whose
expected schema version differs forces a clean re-ingest (e.g. after the
absolute→relative `source_uri` migration).

**Response**

```json
{ "status": "ok", "schema_version": 3 }
```

#### GET `/v1/capabilities`

Feature-detection probe. Returns an object whose presence/absence drives
client behavior.

**Response**

```json
{ "proFeaturesEnabled": true }
```

### Context & Question Answering

#### POST `/v1/context`

Ask a bounded structural question; the backend returns claims, conflicts,
decisions, intents, and the supporting subgraph.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `query` | string | required — the question |
| `asOfRev` | number | optional — read the graph as of this revision |
| `depth` | string | optional — traversal depth hint |

**Response** — `StructuredContext` (see [Data Models](#data-models)).

### Ingestion & Mapping

#### POST `/v1/ingest`

Ingest a path into the graph. Long-running: the client allows **30 minutes**.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `path` | string | required — absolute path to ingest |
| `recursive` | boolean | optional |
| `force` | boolean | optional — re-ingest unchanged files |

**Response** — `IngestResult`:

```json
{
  "filesProcessed": 128,
  "patchesApplied": 142,
  "filesSkipped": 3,
  "entitiesCreated": 640,
  "latestRev": 217,
  "skipReasons": { "unchanged": 1, "emptyFile": 1, "parseError": 1, "tooLarge": 0 }
}
```

> The **CLI's** `ix ingest --format json` emits a different, narrower breakdown
> under the same key: `unchanged` there counts only files skipped as *mtime- or
> hash-unchanged*, `emptyFile` is a real count rather than a hardcoded `0`, and
> there is an extra `unparsed` bucket for files the parse pool returned nothing
> for. That is the client's own summary of its own run and is not this response;
> see the stitch section below for why the narrower `unchanged` is load-bearing
> there.

#### POST `/v1/map`

Return the full code map (systems → subsystems → members). The visualizer and
`ix map` consume this. Reads **snake_case** keys off the raw body.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `full` | boolean | default `false` |
| `workspace_id` | string | optional — scope to a workspace |
| `system_id` | string | optional — scope to a stitched system |

**Response**

```json
{
  "file_count": 409,
  "region_count": 44,
  "levels": 3,
  "map_rev": 217,
  "outcome": "ok",
  "regions": [],
  "edges": [],
  "hierarchy": []
}
```

#### POST `/v1/source-hashes`

Workspace-scoped baseline lookup. Returns one row per `(workspace_id, uri)` so
each file matches against its **own** workspace's hash (avoids collisions when
workspaces share relative paths).

**Request body**

| Field | Type | Notes |
|---|---|---|
| `uris` | string[] | required — workspace-relative paths |
| `workspaceIds` | string[] | optional — bounds the query server-side |

**Response** — array of `{ workspaceId: string | null, uri: string, hash: string }`.

#### GET `/v1/source-hashes/exists`

Returns `{ "exists": boolean }` — whether an ingest baseline exists for the
scoped workspace.

#### POST `/v1/stitch`

Cross-repo stitching (Ix#225 Path 2). Registers this workspace's published
packages (`provides`) and production-dep external imports (`consumes`); the
backend joins them bidirectionally against other workspaces and writes
cross-repo `IMPORTS` edges.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `workspaceId` | string | required |
| `provides` | array | `{ name, entryNodeId, entryUri? }` |
| `consumes` | array | `{ name, consumerNodeId }` |
| `exports` | array | optional — `{ name, nodeId }` |
| `symbolConsumes` | array | optional — `{ symbol, callerNodeId, pkg? }` |

**Response** — `{ stitched: number, systemId: string | null, edges: [{ src, dst, name }] }`.

**Client-side admission control (Ix#568).** The join behind this endpoint runs
server-side for as long as it needs to, and outlives the HTTP call that started
it — a proxy answering 500 at ~60s does not stop the query. The CLI therefore
does not issue this call unconditionally:

| Rule | Behaviour |
|---|---|
| One at a time **per backend endpoint** | A second `ix map` — including one for a *different* workspace — waits up to `IX_STITCH_WAIT_MS` (default 30s) for the in-flight stitch, then skips. `ix map`'s own lock is per workspace and does not bound a cross-workspace join. |
| A cooldown written when a stitch **starts** | It is removed only on proof that nothing is running. Until then, no further stitch is sent to that endpoint for `IX_STITCH_COOLDOWN_MS` (default 15 min). |

The second rule is the one that stops the pile-up, and it is written the
opposite way round from the obvious design. Rather than inspecting the failure
and deciding whether it looked like a timeout, the marker goes down before the
request and comes back up only on **proof** that the backend did not run the
join:

* the stitch succeeded;
* the backend answered **4xx**, which is it refusing the request rather than
  executing it — with **408** excluded, since a proxy reporting that *it* gave
  up waiting says nothing about whether the backend did;
* the backend answered **501**, which is how this codebase already spells "no
  `/v1/stitch` here" (`isStitchUnsupported` accepts 404 or 501);
* the connection was never established, so no bytes reached the backend.
  Decided by the **syscall** Node stamps on the underlying error — `connect` or
  `getaddrinfo` — with a small errno set (`ECONNREFUSED`, `ENOTFOUND`,
  `ENETUNREACH`, `EHOSTUNREACH`, `EAI_AGAIN`) and undici's
  `UND_ERR_CONNECT_TIMEOUT` alongside it, and a walk into `AggregateError.errors`
  because a multi-address host like `localhost` — the default endpoint — reports
  a refusal that way. Deliberately narrower than "a transport error": a socket
  dropped *after* the request went out (`UND_ERR_SOCKET`) is the ambiguous case
  — an upstream that restarted killed its join, a proxy that hung up did not —
  and keeps the marker. A read/write `ETIMEDOUT` is excluded for the same
  reason; a connect-phase one is caught by the syscall.

Everything else — a 5xx, a timeout, an abort, a socket dropped mid-flight, or
the process being killed before it could report anything — leaves the marker in
place. That
last case is why the marker is written up front: a hook whose timeout is shorter
than the stitch takes the CLI down mid-request, and nothing it *would* have done
on the way out can be relied on.

The cost is that a stitch failing for an unclassified reason cools down when it
need not have. That errs toward skipping one stitch rather than stacking joins
on a database that is already the reason.

Both the lock and the cooldown are keyed on a normalised endpoint, so
`http://localhost:8090`, `http://localhost:8090/` and `http://127.0.0.1:8090`
are one backend rather than three. Without that, an `ix mcp` server started with
`IX_ENDPOINT` set to an IP and a shell `ix map` reading the config file would
each hold their own "single-flight" lock and stitch simultaneously.

`IX_STITCH_COOLDOWN_MS` is re-read on every attempt and applied to cooldowns
already on disk, so setting it to `0` releases an active one rather than only
affecting the next.

The cooldown is stamped at the stitch's **start** and re-stamped to its **end**
when the attempt reports back without proving anything stopped. The re-stamp is
what makes short values mean anything: `IxClient` caps a request at two minutes,
so a cooldown measured only from the start would already have expired by the
time a timing-out stitch returned, and the next map would be admitted straight
into a second join. One residue remains — a process that is *killed* never
re-stamps, so a cooldown shorter than the attempt it is protecting is expired
when the next map looks at it. Values below the two-minute request cap are
therefore only reliable on the paths that report back.

A skipped stitch is reported as `stitchSkipped` in `ix ingest --format json`, as
`stitch_skipped` in `ix map --format json` and `--format llm`, and as a
`stitch_skipped` token on `ix map --silent`, so an automated consumer can tell it
apart from a clean run. It is not an error: it does not set a non-zero exit code
and does not count towards `stitchErrors`, and the previous registration stands —
the same position a stitch that *failed* already left the graph in.

The wait happens **inside** `ix map`'s per-workspace lock, which the run holds
until it exits. So while one map is waiting out another repo's stitch — up to
`IX_STITCH_WAIT_MS`, 30s by default — any further `ix map` fired for that same
workspace (an auto-map hook, for instance) finds the lock held, coalesces, and
exits 0. Edits made in that window get no graph refresh and nothing says so.
That is a new source of staleness, bounded by `IX_STITCH_WAIT_MS`; set it to `0`
to shed on contention immediately instead, at the cost of losing that map's
cross-repo registration.

Both the lock and the cooldown are keyed on the **endpoint**, not on the
workspace, because the join they bound is cross-workspace. That is the point of
the guard, and it is also its cost: one transient failure while mapping repo A
refuses the stitch for repos B..E on the same backend for the whole cooldown,
and when it expires none of them re-attempt on their own for the reason below.
In a multi-repo setup that means every repo's cross-repo edges stay as they were
until somebody runs a full re-ingest in each. The alternative -- keying per
workspace -- does not bound the query at all, since the query is not per
workspace.

Note that re-registration is not automatic on the next map, and was not before
this change: the stitch is gated on every file having been parsed this run, so an
incremental map that skips an mtime- or hash-unchanged file neither reaches it nor
has the registration data to send, having only parsed what changed. A run that
re-ingests every file (`ix ingest <root> --force`, a post-reset re-map) is what
picks it back up.

The gate counts files skipped **as unchanged**, plus parses lost to a **crashed
worker**. It used to be the whole `filesSkipped` total, which also counts
zero-byte files, ones that look minified, and ones the parser simply returned
nothing for — none of which have anything to contribute to the registration, so
their absence does not make the collected set partial. That last class matters:
fourteen tree-sitter grammars are optional dependencies, and a file whose grammar
did not build (`tree-sitter-sas` has no win32 prebuild) comes back unparsed on
*every* run, `--force` included, so counting it blocked stitching permanently for
any repo containing one. A crashed parse worker is different — it lost a file we
would have indexed — and `ParsePool.crashedTasks()` is what the gate reads for
it. Counting them meant a single empty `__init__.py` disqualified a repo from
stitching permanently, `--force` included: the run printed nothing, exited 0, and
left the cross-repo edges stale, while the message above advertised `--force` as
the way to fix it. `skipReasons.unchanged` in `--format json` is now that narrower
count rather than every skip, and `skipReasons.emptyFile`, previously hardcoded to
`0`, is the real number.

| Variable | Default | Effect |
|---|---|---|
| `IX_STITCH_COOLDOWN_MS` | `900000` | How long to hold off after a stitch that did not prove it stopped, measured from when the attempt ended. `0` disables the cooldown; single-flight stays. Values under ~2 min are not honoured after a killed process — see above. |
| `IX_STITCH_WAIT_MS` | `30000` | How long to wait for an in-flight stitch before skipping. `0` sheds immediately. |
| `IX_LOCK_DIR` | `~/.ix/locks` | Where the stitch lock and cooldown record live (shared with the map lock). `ix reset` clears the cooldown, so the full re-ingest that follows one is not refused by it. |
| `IX_MAP_LOCK_MAX_MS` | `1200000` | Shared with the map lock: how old a held lock must be before it is presumed abandoned and stolen. Lowering it to a few seconds so a wedged `ix map` self-heals faster also lets a second process steal the stitch lock from an in-flight stitch. The cooldown normally catches that on the next read, so it only matters together with `IX_STITCH_COOLDOWN_MS=0` — which is the one case where "single-flight stays" stops being true. |

This bounds the client. Cancelling the server-side query when the client hangs
up, and making the join indexed rather than a full scan, are backend concerns
and are not addressed here.

#### GET `/v1/stitch/system/{workspaceId}`

Return the `system_id` a workspace currently belongs to (null for a singleton).
Older backends 404 — clients fall back to `{ systemId: null }`.

### Search & Discovery

#### POST `/v1/search`

Search nodes by name/term.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `term` | string | required |
| `limit` | number | optional |
| `kind` | string | optional — filter by entity kind |
| `language` | string | optional |
| `asOfRev` | number | optional |
| `nameOnly` | boolean | optional |
| `workspaceId` / `systemId` | string | optional — scope |

**Response** — array of `GraphNode`.

#### POST `/v1/search/semantic`

Vector-similarity search. The backend embeds the term and returns nodes already
ordered by similarity — **do not re-rank client-side**. The request field is
`term` (not `query`); no `language` filter. Requires the extraction service
(cloud); returns **503** when not configured.

**Response** — array of `GraphNode`.

#### POST `/v1/list`

List entities by kind.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `kind` | string | required |
| `limit` | number | optional |
| `scope` | string | optional |
| `workspaceId` / `systemId` | string | optional |

**Response** — array of `GraphNode`.

### Entities & Traversal

#### GET `/v1/entity/{id}`

Fetch a node with its claims and edges.

**Response** — `{ node: GraphNode, claims: unknown[], edges: unknown[] }`.

#### GET `/v1/resolve-prefix/{prefix}`

Resolve a shortened entity id prefix. Full UUIDs pass through untouched.

**Response**

```json
{ "id": "900031a5-..." }
```

or, on ambiguity, `{ "error": "ambiguous", "matches": ["…"] }`; the client
throws `Ambiguous prefix …` in that case.

#### POST `/v1/expand`

Expand a node's neighborhood.

**Request body**

| Field | Type | Default |
|---|---|---|
| `nodeId` | string | required |
| `direction` | string | `"both"` |
| `predicates` | string[] | — |
| `hops` | number | `1` |

**Response** — `{ nodes: GraphNode[], edges: GraphEdge[] }`.

#### POST `/v1/expand-by-name`

Same as expand, but by entity name.

### Planning Artifacts

Planning artifacts (goals, truth statements, decisions, bugs, tasks) persist
across code-graph resets.

#### GET `/v1/truth`

List planning artifacts. **Response** — array of `GraphNode`.

#### POST `/v1/truth`

Create a goal/truth statement.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `statement` | string | required |
| `parentIntent` | string | optional |

**Response** — `{ status: string, nodeId: string, rev: number }`.

#### POST `/v1/decide`

Record a decision.

**Request body** — `{ title, rationale, intentId? }`.

**Response** — `{ status, nodeId, rev }`.

#### GET `/v1/decisions`

List decisions. **Query**: `limit`, `topic`. **Response** — array of `GraphNode`.

### Patches & Provenance

#### GET `/v1/patches`

List patches. **Query**: `limit`. **Response** — array of `PatchSummary`:

```json
[{ "patch_id": "…", "rev": 217, "intent": "…", "source_uri": "…", "timestamp": "…" }]
```

#### GET `/v1/patches/{id}`

Fetch a single patch.

#### POST `/v1/patch`

Commit one patch. Client timeout **5 minutes**.

**Request body** — `GraphPatchPayload` (see [Data Models](#data-models)).

**Response** — `PatchCommitResult`: `{ status, rev }`.

#### POST `/v1/patches/batch`

Commit an array of patches directly as the body (not wrapped).

#### POST `/v1/patches/bulk`

Commit patches wrapped as `{ "patches": [...] }`. Client timeout **5 minutes**
(prevents hangs when a k8s ingress closes idle connections).

#### POST `/v1/provenance/{entityId}`

Provenance for an entity.

### Analysis

#### POST `/v1/diff`

Diff between graph revisions.

**Request body**

| Field | Type | Notes |
|---|---|---|
| `fromRev` | number | required |
| `toRev` | number | required |
| `entityId` | string | optional |
| `summary` | boolean | optional |
| `limit` | number | optional |

#### GET `/v1/conflicts`

List detected conflicts. **Response** — array of `ConflictReport`.

#### POST `/v1/smells`

Run smell analysis. **Query params**: `orphan-max-connections`, `god-module-chunks`,
`god-module-fan`, `weak-max-neighbors`, `workspace_id`, `system_id`.

#### GET `/v1/smells`

List computed smells. **Query**: `workspace_id`, `system_id`.

#### POST `/v1/subsystems/score`

Score subsystems. **Query**: `workspace_id`, `system_id`.

#### GET `/v1/subsystems`

List subsystems. **Query**: `detailed`, `limit`, `offset`, `regions`,
`edge_cap`, `member_file_cap`, `workspace_id`, `system_id`.

#### GET `/v1/subsystems/map`

Subsystem map for the visualizer. **Query**: `target` (entity id), `pick`
(1-based candidate for ambiguous targets), `workspace_id`, `system_id`.

### Stats & Savings

#### GET `/v1/stats`

Graph statistics. **Query**: `workspace_id`, `system_id`.

**Response** — node/edge totals by kind:

```json
{
  "nodes": { "total": 10144, "byKind": [ { "kind": "function", "count": 1883 } ] },
  "edges": { "total": 26084, "byKind": [ … ] }
}
```

#### GET `/v1/savings`

Token-savings metrics. **Query**: `detail=true` for detail.

#### DELETE `/v1/savings`

Reset savings metrics.

### Reset

> ⚠️ **`ix reset` is GLOBAL.** The reset endpoints below take **no
> workspace_id** and wipe every workspace's graph in the shared backend. The
> only scoped variant is `/v1/reset/workspace`, which the CLI does not expose.

| Method | Path | Behavior |
|---|---|---|
| POST | `/v1/reset` | Wipe **all** nodes and edges (sync; local endpoints) |
| POST | `/v1/reset/async` | Begin an async wipe (remote endpoints) |
| POST | `/v1/reset/code` | Wipe only the code graph, preserving planning artifacts |
| POST | `/v1/reset/code/async` | Async variant of the code wipe |
| GET | `/v1/reset/status/{opId}` | Poll async op — `{ state: "done" \| "failed", error? }` |
| POST | `/v1/reset/workspace` | **Scoped** wipe — `{ workspaceId }`; other workspaces untouched |

**Async reset flow (client-side):** local endpoints use the sync path; remote
endpoints begin via `/async`, then poll `/v1/reset/status/{opId}` every 2s up
to 15 minutes. A 404 on `begin` falls back to the sync path (old backend); a
404 on `status` means the op was lost to a server restart — reset is idempotent,
so re-run to confirm.

## Visualizer Proxy Surface

Compass (`ix view`, default port **8080**) adds three behaviors on top of the
backend:

1. **`/v1/*` proxy** — every backend request is proxied to `localhost:8090`
   with `x-ix-workspace` and `x-ix-system` headers baked in at launch, so the
   browser app never knows about workspaces. `--all` opts out of scoping.
2. **`POST /__ix/remap`** — rebuild the code map for the workspace this
   visualizer is scoped to, by running `ix map <workspace-root> --silent` with
   a 30-minute timeout. Responds `{ "ok": true }` on success, or a `500` with
   `{ "ok": false, "error": ... }` when the map command fails.

   The workspace root is resolved once, by `ix view start`, and baked into the
   generated server — the same resolution that produces the `x-ix-workspace`
   header, so a remap rebuilds exactly what the view is showing. It is *not*
   the server's working directory: under `--all` that need not be a workspace
   at all, so a view started from a home directory would have mapped the whole
   of it. Two `409`s follow from that:

   - `--all` leaves the view unscoped and there is no single workspace to
     rebuild: `{ "ok": false, "error": "remap needs a single workspace; …" }`
   - a remap is already running: `{ "ok": false, "error": "a remap is already
     running" }`. `execFile` is asynchronous, so without this every request
     would start another full ingest over the same workspace.

   It does **not** run `ix reset` — `ix map` reconciles deletions itself, and
   `ix reset` takes no workspace id, so it would wipe every workspace in the
   backend rather than rebuilding this one.

   **Loopback only:** the server binds `127.0.0.1`, and the handler rejects
   requests whose `Host` is not loopback, or whose browser `Origin` is not
   this exact origin — loopback hostname *and* this server's port
   (`403 { "ok": false, "error": "forbidden: loopback only" }`). Matching the
   port matters: any page served on another localhost port can send this POST
   with no preflight, so treating the whole loopback interface as one origin
   would let a local dev server trigger a remap. Requests with no `Origin`
   (e.g. `curl`) are allowed when the `Host` is loopback. The endpoint shells
   out with the user's privileges, which is what all of this is guarding.

   Interrupting a remap is safe: the client going away kills the child, and the
   ingest baseline is only persisted after a clean run, so an interrupted map
   re-ingests next time rather than recording files as done that never landed.
3. **SPA fallback** — any other path serves `index.html`. A `GET` to
   `/__ix/remap` (or any other unknown path) falls through to this handler.

## Data Models

### GraphNode

```ts
interface GraphNode {
  id: string;
  kind: string;            // function | class | file | module | region | …
  name: string;
  attrs: Record<string, unknown>;
  provenance: {
    sourceUri: string;     // workspace-relative path (POSIX separators)
    sourceHash?: string;
    extractor: string;
    sourceType: string;
    observedAt: string;
  };
  createdRev: number;
  deletedRev?: number;
  createdAt: string;
  updatedAt: string;
}
```

### GraphEdge

```ts
interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  predicate: string;       // calls | imports | contains | …
  attrs: Record<string, unknown>;
  createdRev: number;
  deletedRev?: number;
}
```

### StructuredContext

```ts
interface StructuredContext {
  claims: ScoredClaim[];
  compactClaims?: CompactScoredClaim[];
  conflicts: ConflictReport[];
  decisions: DecisionReport[];
  intents: IntentReport[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: { query: string; seedEntities: string[]; hopsExpanded: number; asOfRev: number; depth?: string };
}
```

### IngestResult

```ts
interface IngestResult {
  filesProcessed: number;
  patchesApplied: number;
  filesSkipped?: number;
  entitiesCreated: number;
  latestRev: number;
  skipReasons?: {
    unchanged: number;          // skipped as mtime-/hash-unchanged, not every skip
    emptyFile: number;
    parseError: number;         // parse-stage failures, including non-skips
    tooLarge: number;
    minifiedLikely?: number;
    unparsed?: number;          // the parse pool returned nothing for these
  };
}
```

### GraphPatchPayload

```ts
interface GraphPatchPayload {
  patchId: string;
  actor: string;
  timestamp: string;
  source: {
    uri: string;           // workspace-relative, opaque key for joins/tombstones
    sourceHash?: string;
    extractor: string;
    sourceType: string;
    workspaceId?: string;  // SHA-256 of the workspace root path
  };
  baseRev: number;
  ops: Array<{ type: string; [k: string]: unknown }>;
  replaces: string[];
  intent?: string;
}
```

### PatchCommitResult

```ts
interface PatchCommitResult { status: string; rev: number; }
```

### HealthResponse

```ts
interface HealthResponse { status: string; schema_version?: number; }
```

### CapabilitiesResponse

```ts
interface CapabilitiesResponse { proFeaturesEnabled?: boolean; }
```

## Error Reference

| Code | Meaning |
|---|---|
| `4xx` | Client error — body is plain text (not JSON), surfaced as `"<status>: <text>"` |
| `404` | Unknown endpoint / entity / lost async op / old backend without async endpoints |
| `502` | Cloud proxy timeout on long sync ops — use the async variants |
| `503` | `/v1/search/semantic` without the extraction service configured |

Client error convention: `IxClient` throws `Error("<status>: <text>")` on any
non-`ok` response, so CLI errors carry both the HTTP status and the raw body.

## Timeouts & Deadlines

| Operation | Per-request timeout |
|---|---|
| General `get` / `post` | 2 minutes |
| `POST /v1/patch`, `/v1/patches/bulk` | 5 minutes |
| `POST /v1/ingest`, `/v1/map` | 30 minutes |
| Async reset begin / status poll | 30 seconds each |
| Sync reset (local) | 10 minutes |
| Shared deadline (`ix map`) | hard wall-clock budget; aborts all in-flight requests via `AbortSignal.any` |

## Versioning

- The graph has a schema version (`/v1/health.schema_version`, currently `v3`);
  a mismatch forces a clean re-ingest.
- Endpoints are additive under `/v1`; the `capabilities` probe is the
  recommended way to feature-detect rather than hard-code against versions.
- Older backends may 404 new endpoints (`/v1/stitch/system/*`, async reset) —
  clients implement fallbacks, and so should any new client code.
