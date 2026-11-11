// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

type SentPatch = {
  patchId?: string;
  source?: { uri?: string; sourceHash?: string; workspaceId?: string; extractor?: string };
  ops?: Array<Record<string, unknown>>;
};

/** Ix-memory's ErrorHandler body for BulkPlanMismatchException (Ix-memory#273). */
function planMismatchBody(ids: string[]): Record<string, unknown> {
  const sorted = [...ids].sort();
  return {
    error: "conflict",
    message: `bulk patch IDs were previously committed by a different request plan (${sorted.length} patch IDs)`,
    committed_patch_ids: sorted,
    committed_count: sorted.length,
  };
}

/** One live edge as a `graphSignature` line. */
function edgeLine(id: string, e: { src: unknown; dst: unknown; predicate: unknown; attrs?: unknown }): string {
  const attrs = (e.attrs ?? {}) as { tier?: unknown; confidence?: unknown };
  return `${id} ${String(e.src)} ${String(e.dst)} ${String(e.predicate)} tier=${String(attrs.tier)} confidence=${String(attrs.confidence)}`;
}

/** One node of a `ReadGraph`. `uri` is workspace-relative, as ingest sends it. */
export interface ReadNode {
  id: string;
  kind: string;
  name: string;
  uri: string;
  attrs?: Record<string, unknown>;
}

/** One edge of a `ReadGraph`. */
export interface ReadEdge {
  id: string;
  src: string;
  dst: string;
  predicate: string;
}

/**
 * A fixed graph for the read routes (`FakeBackend.readGraph`), with the source
 * files it was "extracted" from, so a command that reads source finds the
 * lines the graph names.
 */
export interface ReadGraph {
  nodes: ReadNode[];
  edges: ReadEdge[];
  files: Record<string, string>;
}

const GEOMETRY_TS = [
  "export class Canvas {",
  "  width = 0;",
  "}",
  "",
  "export function draw(canvas: Canvas): void {",
  "  canvas.width += 1;",
  "}",
  "",
].join("\n");

const APP_TS = [
  'import { Canvas, draw as drawShape } from "./geometry";',
  "",
  "export function draw(canvas: Canvas): void {",
  "  paint(canvas);",
  "}",
  "",
  "export function paint(canvas: Canvas): void {",
  "  drawShape(canvas);",
  "}",
  "",
].join("\n");

/** A fixed UUID whose first 8 characters (the short id the CLI prints) differ per entity. */
const gid = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

/**
 * The one small graph the read-path snapshots answer from: two files, a class,
 * three functions, and CONTAINS / IMPORTS / CALLS edges between them.
 *
 *   src/geometry.ts  CONTAINS  Canvas (class), draw (function)
 *   src/app.ts       CONTAINS  draw (function), paint (function)
 *   src/app.ts       IMPORTS   src/geometry.ts
 *   app.ts draw      CALLS     paint
 *   paint            CALLS     geometry.ts draw
 *
 * `paint` resolves to one entity, `draw` is ambiguous (one per file), and
 * nothing is named `vanish` -- nor does any source file mention it.
 */
export const SMALL_READ_GRAPH: ReadGraph = {
  nodes: [
    { id: gid(1), kind: "file", name: "geometry.ts", uri: "src/geometry.ts", attrs: { language: "typescript", line_start: 1, line_end: 7 } },
    { id: gid(2), kind: "file", name: "app.ts", uri: "src/app.ts", attrs: { language: "typescript", line_start: 1, line_end: 9 } },
    { id: gid(3), kind: "class", name: "Canvas", uri: "src/geometry.ts", attrs: { language: "typescript", line_start: 1, line_end: 3 } },
    { id: gid(4), kind: "function", name: "draw", uri: "src/geometry.ts", attrs: { language: "typescript", line_start: 5, line_end: 7 } },
    { id: gid(5), kind: "function", name: "draw", uri: "src/app.ts", attrs: { language: "typescript", line_start: 3, line_end: 5 } },
    { id: gid(6), kind: "function", name: "paint", uri: "src/app.ts", attrs: { language: "typescript", line_start: 7, line_end: 9 } },
  ],
  edges: [
    { id: gid(101), src: gid(1), dst: gid(3), predicate: "CONTAINS" },
    { id: gid(102), src: gid(1), dst: gid(4), predicate: "CONTAINS" },
    { id: gid(103), src: gid(2), dst: gid(5), predicate: "CONTAINS" },
    { id: gid(104), src: gid(2), dst: gid(6), predicate: "CONTAINS" },
    { id: gid(105), src: gid(2), dst: gid(1), predicate: "IMPORTS" },
    { id: gid(106), src: gid(5), dst: gid(6), predicate: "CALLS" },
    { id: gid(107), src: gid(6), dst: gid(4), predicate: "CALLS" },
  ],
  files: { "src/geometry.ts": GEOMETRY_TS, "src/app.ts": APP_TS },
};

/** A `ReadNode` as the backend serialises a GraphNode. Fixed times: nothing volatile. */
function graphNode(n: ReadNode): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    attrs: n.attrs ?? {},
    provenance: {
      sourceUri: n.uri,
      sourceHash: "0".repeat(64),
      extractor: "fake",
      sourceType: "code",
      observedAt: "2026-01-01T00:00:00Z",
    },
    createdRev: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function graphEdge(e: ReadEdge): Record<string, unknown> {
  return { id: e.id, src: e.src, dst: e.dst, predicate: e.predicate, attrs: {}, createdRev: 1 };
}

/** A backend that answers the endpoints an ingest touches, and records them. */
export class FakeBackend {
  readonly requests: Array<{ path: string; patches: number; code?: number }> = [];
  /** `source.uri` of every patch sent in a commit request, accepted or not. */
  readonly sourceUris: string[] = [];
  /** `source.workspaceId` beside each of `sourceUris`, in the same order. */
  readonly sourceWorkspaceIds: Array<string | undefined> = [];
  /** The ops of the last patch sent for each `source.uri`. */
  readonly lastOps = new Map<string, Array<Record<string, unknown>>>();
  /** The `patchId` of the last patch sent for each `source.uri`. */
  readonly lastPatchIds = new Map<string, string>();
  /** Paths this fake does not implement. Asserted empty after every test. */
  readonly unknownPaths: string[] = [];
  /**
   * Answer the read routes (`/v1/search`, `/v1/expand`, `/v1/expand-by-name`, `/v1/entity/`,
   * `/v1/degree`, `/v1/list`, `/v1/nodes`, `/v1/stats`, `/v1/provenance/`,
   * `/v1/resolve-prefix/`) from this graph. Unset, those routes behave as
   * before: unknown, or answered from the committed graph under `semantics`.
   */
  readGraph: ReadGraph | undefined;
  /** Read requests `readGraph` answered, in order, with their parsed bodies. */
  readonly reads: Array<{ path: string; body: unknown }> = [];

  private server: Server | undefined;
  private baseUrl: string | undefined;
  private rev = 0;

  /** Patch-source substrings this backend refuses, whatever else is healthy. */
  poison: string[] = [];
  /** Fail every commit, the Ix#560 shape. */
  refuseEverything = false;
  /** Answer a bulk of more than this many ops (over two or more patches) with a 413. */
  maxBulkOps: number | undefined = undefined;
  /** Put `suggestedMaxPatches` in that 413, as the bulk writer's estimate does. */
  suggestMaxPatches = false;
  /**
   * Answer a bulk whose body is over this many bytes (over two or more
   * patches) with a 413, as Ix-memory's body cap (`IX_BULK_MAX_BODY_MB`) does:
   * no patch count, since bytes are not ops.
   */
  maxBulkBytes: number | undefined = undefined;
  /** Body bytes of each `/v1/patches/bulk` request, in order. */
  readonly bulkBodyBytes: number[] = [];
  /** Refuse re-sends of patches a 409 already confirmed. */
  refuseReplays = false;
  /**
   * Answer the CUTOFF DRAIN's bulk with `BaseRevMismatch`, and nothing else.
   *
   * A 200 that wrote nothing: the backend read the latest rev outside the
   * transaction and it moved before the commit ran. Without a knob the harness
   * could only ever serve "Ok", so every `status` branch in the three commit
   * sites was unreachable from any test.
   *
   * Aimed at the drain specifically, by shape rather than by counting
   * requests. The drain is the only bulk that happens AFTER the per-file
   * fan-out, so "a bulk with at least one single behind it" names it exactly,
   * and stays right if the number of requests before it ever changes.
   */
  mismatchOnDrainBulk = false;
  /**
   * Answer this many commits (bulk or single) `BaseRevMismatch` before taking
   * any: what a second `ix map` committing to the same backend does to this
   * one. A 200 that wrote nothing, like `mismatchOnDrainBulk`.
   */
  loseBaseRevRaces = 0;
  /**
   * Refuse the opening bulk and every per-file send, but ACCEPT the drain.
   *
   * The only shape that reaches an accepted cutoff drain, and it took three
   * tries to find because each failed one looked plausible. Poisoning files
   * does not work: the cutoff holds the patches that FAILED as well as the
   * untried ones, so the drain carries the poison and is refused. Refusing by
   * request count does not work either: the cutoff trips on the fifth failure
   * and the drain follows immediately, so any threshold high enough to produce
   * five failures is still in force when the drain arrives. Both were measured
   * at zero accepted bulks in the whole run, via `acceptedBulks()`.
   *
   * Refusing by KIND separates them: the opening bulk (no singles behind it)
   * and every single are refused, which trips the cutoff; the drain is the only
   * bulk with singles behind it, and it is answered 200 -- so the code that
   * reads its status is finally reached.
   */
  refuseUntilDrain = false;
  /** Fired after `abortAfterCommits` commit requests, if set. */
  abortAfterCommits: number | undefined;
  private readonly aborter = new AbortController();

  /** A run deadline that fires at a known POINT IN THE COMMIT SEQUENCE. */
  get deadlineSignal(): AbortSignal {
    return this.aborter.signal;
  }
  /** Answer a bulk with 409 naming every patch as already committed. */
  bulk409AllLanded = false;
  /**
   * Answer a bulk with Ix-memory#273's plan-mismatch 409: every id committed
   * by a different request plan, named in `committed_patch_ids`, and no
   * "partially committed" text.
   */
  bulk409PlanMismatch = false;
  /** Status for POST /v1/stitch. */
  stitchStatus = 200;
  /**
   * Answer `/v1/source-hashes` with the hashes of patches this fake accepted,
   * as the real backend does. Off by default: with it off every lookup is
   * empty, so the DB-reset guard sends each incremental run down the full
   * path, which the tests written before it rely on.
   */
  rememberHashes = false;
  /** Answer `/v1/source-hashes` with a 500, as a backend under load does. */
  failSourceHashes = false;
  /**
   * Answer the next commits (bulk or single) with these statuses, in order,
   * before any other decision: a proxy or a restarting backend saying "not
   * now" (IN-19C). `retryAfter` is sent as the `Retry-After` header.
   */
  transientCommitFailures: Array<{ status: number; retryAfter?: string }> = [];
  /**
   * ArangoDB is down: `/v1/health` answers 503 `degraded` with
   * `database: "unreachable"` (Ix-memory 1.0.33+), every commit answers 500,
   * and `/v1/revisions/current` answers 500.
   */
  databaseDown = false;
  /**
   * The status commits answer while `databaseDown`. 500 is what the backend
   * sends; 503 is a backend (or a proxy in front of it) that reads a lost
   * database as "not now", which the bulk sites would otherwise retry.
   */
  databaseDownCommitStatus = 500;
  /**
   * Whether `/v1/health` reports `database` at all. Off is a backend older
   * than 1.0.33: health answers 200 `ok` whatever the database is doing, and
   * only a read that needs it (`/v1/revisions/current`) can tell.
   */
  healthReportsDatabase = true;
  /**
   * `/v1/health` reports the database unreachable while it is in fact up and
   * commits land: a wrong or stale health answer.
   */
  healthSaysDatabaseDown = false;
  /** `/v1/health` requests, in order. */
  healthRequests = 0;
  /** `/v1/revisions/current` requests, in order. */
  revisionRequests = 0;
  /**
   * Answer `GET /v1/patches/{id}` with a 500, as a backend under load does:
   * every read when true, or the reads the predicate picks (given the id and
   * the stored ops, if any).
   */
  failPatchReads: boolean | ((patchId: string, ops: Array<Record<string, unknown>> | undefined) => boolean) = false;
  /** Answer `GET /v1/patches/{id}` with a 404 for every id, as if nothing were stored. */
  hidePatchReads = false;
  /** `GET /v1/patches/{id}` requests served, whatever their answer. */
  patchReads = 0;
  /** `GET /v1/entity/{id}` requests served, whatever their answer. */
  entityReads = 0;
  /** `POST /v1/nodes` requests served, whatever their answer. */
  nodesReads = 0;
  /** Serve `POST /v1/nodes` (Ix-memory 1.0.33+); false answers 404, as an older backend does. */
  serveNodes = true;
  /**
   * Answer `GET /v1/patches/{id}` for a patch committed in bulk as the real
   * bulk route stores it -- an id manifest (`entityIds`, `nodeIds`,
   * `nodeOpCount`), no ops -- instead of with its ops.
   */
  bulkManifests = false;
  private readonly hashes = new Map<string, { workspaceId: string | null; uri: string; hash: string }>();

  /**
   * Store the graph, with the real backend's commit semantics. Unset, the fake
   * only counts: every commit is "Ok" and nothing is kept, which is what the
   * wiring tests were written against. Set, commits go through `commitToGraph`,
   * modelled on Ix-memory 326d8da (and `scratch/cli-ingest/exp12.mjs`):
   *
   *   - a bulk commit tombstones every live edge whose source is one of its
   *     patches' (workspace, uri) before it writes (BulkWriteApi
   *     `tombstoneExistingEdges`); `/v1/patch` does not;
   *   - Delete ops tombstone by id, on both routes;
   *   - a patch id seen before is not written again: `/v1/patch` answers
   *     `Idempotent`, and a bulk answers `Idempotent` when every id was seen in
   *     the same request plan, 409 otherwise (BulkWriteApi `completedReplay`);
   *   - `/v1/source-hashes` answers the hash of the head patch, the one with
   *     the highest rev, per (workspace, uri).
   *
   * The two modes differ only in what "seen before" means:
   *
   *   - `legacy`: any id ever committed. This is the backend as shipped, and
   *     why a file reverted to earlier bytes is never re-applied (F-01).
   *   - `head`: only the id that is still the head patch for its (workspace,
   *     uri). An older id is written again and becomes the head (BEW-03).
   */
  semantics: "legacy" | "head" | undefined;
  /**
   * The `release_version` /v1/health reports. Unset, `head` reports a release
   * whose bulk route applies deletes (BEW-03 and #237 are in it) and the others
   * report none, as a pre-#157 backend does. `null` reports none in any mode.
   */
  releaseVersion: string | null | undefined = undefined;
  private readonly nodes = new Map<string, { kind: unknown; name: unknown; attrs?: unknown; uri?: string; hash?: string; extractor?: string; live: boolean }>();
  private readonly edges = new Map<string, {
    src: unknown; dst: unknown; predicate: unknown; attrs?: unknown; workspaceId: string; uri: string; live: boolean;
  }>();
  /** Every committed patch by id, with the rev it last landed at. */
  private readonly stored = new Map<string, {
    rev: number; workspaceId: string; uri: string; hash: string | undefined;
    ops: Array<Record<string, unknown>>; bulkGroup: string | null;
  }>();
  /** Head patch id per `${workspaceId}\0${uri}`. */
  private readonly heads = new Map<string, string>();

  constructor(opts: { semantics?: "legacy" | "head" } = {}) {
    this.semantics = opts.semantics;
  }

  /**
   * The live graph as a sorted, comparable list: nodes as `id kind name`,
   * edges as `id src dst predicate tier=<tier> confidence=<confidence>`. The
   * resolution attrs are part of the line because an edge can be upgraded in
   * place (same id, new tier). Two backends hold the same graph exactly when
   * their signatures are equal.
   */
  graphSignature(): { nodes: string[]; edges: string[] } {
    const nodes = [...this.nodes].filter(([, n]) => n.live)
      .map(([id, n]) => `${id} ${String(n.kind)} ${String(n.name)}`).sort();
    const edges = [...this.edges].filter(([, e]) => e.live).map(([id, e]) => edgeLine(id, e)).sort();
    return { nodes, edges };
  }

  /** Live edges whose `tier` attr is `tier`, as `graphSignature` lines. */
  edgesOfTier(tier: string): string[] {
    return [...this.edges].filter(([, e]) => e.live && (e.attrs as { tier?: unknown } | undefined)?.tier === tier)
      .map(([id, e]) => edgeLine(id, e)).sort();
  }

  /** Names of the live nodes, to make a signature diff readable. */
  nodeName(id: string): string {
    const n = this.nodes.get(id);
    return n ? `${String(n.name)}[${String(n.kind)}]${n.live ? "" : "(deleted)"}` : `<missing ${id.slice(0, 8)}>`;
  }

  private alreadyCommitted(patchId: string): boolean {
    const record = this.stored.get(patchId);
    if (record === undefined) return false;
    if (this.semantics === "legacy") return true;
    return this.heads.get(`${record.workspaceId}\0${record.uri}`) === patchId;
  }

  private sweepEdgesOf(patch: SentPatch): void {
    const workspaceId = patch.source?.workspaceId ?? "";
    const uri = patch.source?.uri ?? "";
    for (const e of this.edges.values()) {
      if (e.live && e.uri === uri && e.workspaceId === workspaceId) e.live = false;
    }
  }

  private applyDeletes(patch: SentPatch): void {
    for (const op of patch.ops ?? []) {
      const id = String(op.id);
      if (op.type === "DeleteNode") {
        const n = this.nodes.get(id);
        if (n) n.live = false;
      } else if (op.type === "DeleteEdge") {
        const e = this.edges.get(id);
        if (e) e.live = false;
      }
    }
  }

  /**
   * One patch's writes. A bulk request runs its phases across all of its
   * patches -- every sweep, then every delete, then every upsert -- as
   * BulkWriteApi `commitChunk` does, so a delete in one file's patch never
   * removes what another patch of the same request writes.
   */
  private applyPatch(patch: SentPatch, bulkGroup: string | null, deletesApplied = false): void {
    const workspaceId = patch.source?.workspaceId ?? "";
    const uri = patch.source?.uri ?? "";
    this.rev++;
    if (!deletesApplied) this.applyDeletes(patch);
    for (const op of patch.ops ?? []) {
      const id = String(op.id);
      if (op.type === "UpsertNode") {
        // As the bulk route does, every upsert takes the patch's provenance.
        this.nodes.set(id, { kind: op.kind, name: op.name, attrs: op.attrs, uri, hash: patch.source?.sourceHash, extractor: patch.source?.extractor, live: true });
      }
      else if (op.type === "UpsertEdge") {
        this.edges.set(id, { src: op.src, dst: op.dst, predicate: op.predicate, attrs: op.attrs, workspaceId, uri, live: true });
      }
    }
    if (patch.patchId === undefined) return;
    this.stored.set(patch.patchId, {
      rev: this.rev, workspaceId, uri, hash: patch.source?.sourceHash, ops: patch.ops ?? [], bulkGroup,
    });
    this.heads.set(`${workspaceId}\0${uri}`, patch.patchId);
  }

  private commitToGraph(path: string, patches: SentPatch[], send: (code: number, payload: unknown) => void): void {
    if (path === "/v1/patch") {
      const [patch] = patches;
      if (patch?.patchId !== undefined && this.alreadyCommitted(patch.patchId)) {
        return send(200, { rev: this.stored.get(patch.patchId)!.rev, status: "Idempotent" });
      }
      if (patch) this.applyPatch(patch, null);
      return send(200, { rev: this.rev, status: "Ok" });
    }
    const ids = patches.map((p) => p.patchId ?? "");
    const group = createHash("sha256").update(ids.join(",")).digest("hex");
    const done = ids.filter((id) => this.alreadyCommitted(id));
    if (done.length === 0) {
      for (const p of patches) this.sweepEdgesOf(p);
      for (const p of patches) this.applyDeletes(p);
      for (const p of patches) this.applyPatch(p, group, true);
      return send(200, { rev: this.rev, applied: patches.length, status: "Ok" });
    }
    if (done.length !== ids.length) {
      return send(409, {
        error: `bulk request is partially committed (${done.length}/${ids.length} patch IDs)`,
        committed_patch_ids: [...done].sort(),
      });
    }
    if (done.some((id) => this.stored.get(id)!.bulkGroup !== group)) {
      return send(409, planMismatchBody(ids));
    }
    return send(200, { rev: Math.max(...done.map((id) => this.stored.get(id)!.rev)), applied: 0, status: "Idempotent" });
  }

  private sourceHashesFromGraph(uris: string[], workspaceIds: string[] | undefined): unknown[] {
    const wanted = new Set(uris);
    const rows: unknown[] = [];
    for (const patchId of this.heads.values()) {
      const record = this.stored.get(patchId)!;
      if (!wanted.has(record.uri) || record.hash === undefined) continue;
      if (workspaceIds?.length && !workspaceIds.includes(record.workspaceId)) continue;
      rows.push({ workspaceId: record.workspaceId, uri: record.uri, hash: record.hash });
    }
    return rows;
  }

  /** Forget every request so far, so a second run can be measured on its own. */
  resetRequests(): void {
    this.requests.splice(0, this.requests.length);
  }

  get stitchCount(): number {
    return this.requests.filter((r) => r.path === "/v1/stitch").length;
  }

  /** Patches in commit requests the backend ACCEPTED. */
  acceptedPatches(): number {
    return this.requests
      .filter(r => (r.path === "/v1/patches/bulk" || r.path === "/v1/patch") && r.code === 200)
      .reduce((sum, r) => sum + r.patches, 0);
  }

  /** Bulk commits that the backend ACCEPTED, in order. */
  acceptedBulks(): number {
    return this.requests.filter(r => r.path === "/v1/patches/bulk" && r.code === 200).length;
  }

  get bulkCount(): number {
    return this.requests.filter((r) => r.path === "/v1/patches/bulk").length;
  }

  get singleCount(): number {
    return this.requests.filter((r) => r.path === "/v1/patch").length;
  }

  get commitCount(): number {
    return this.bulkCount + this.singleCount;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      // Collect and concat, rather than `body += chunk`. Appending a Buffer to
      // a string decodes each TCP chunk on its own, so a multi-byte character
      // split across a chunk boundary is corrupted -- and a bulk body for
      // thirty patches is comfortably big enough to be split. Latent while the
      // fixtures are ASCII; the first non-ASCII one would make `JSON.parse`
      // throw and silently route the request down a different branch.
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.route(req.url ?? "/", Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>((resolve, reject) => {
      // Without the `error` listener a failed bind -- EACCES under a
      // restrictive sandbox, EADDRNOTAVAIL where loopback is unusual -- never
      // settles this promise, and surfaces as a beforeEach hook timeout plus an
      // unhandled 'error' event rather than as the bind error it is.
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this.baseUrl;
  }

  /** The URL `start()` returned, while the server is up; undefined before and after. */
  get url(): string | undefined {
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    this.baseUrl = undefined;
    // `closeAllConnections` first, and a deadline behind it. `close()` waits for
    // every open socket, so one keep-alive connection the run did not finish
    // with leaves this pending -- and a hook that never settles takes its
    // timeout, at which point NEITHER `finally` in the teardown runs and both
    // temp trees leak anyway. The teardown can only be made safe if this cannot
    // hang, so the fix belongs here rather than in another `try`.
    // Not optional-chained: `engines.node` is >=22 and this landed in 18.2.
    server.closeAllConnections();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      new Promise<boolean>((resolve) => server.close(() => resolve(true))),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      // Not expected to fire, and it never has. `Promise.race` builds its
      // array eagerly, so `server.close()` runs in the SAME tick as
      // `closeAllConnections()` above -- the listening handle is gone before
      // any later turn of the loop, so nothing can connect afterwards, and
      // every socket that existed has been destroyed. There is no "late
      // socket" story; an earlier revision of this comment invented one.
      //
      // Kept anyway, as a backstop against `close()` simply never calling
      // back -- a socket wedged in destroy, say. Deliberately a message and
      // not a throw: the alternative it exists to prevent is a hook that
      // never settles, which takes the hook timeout and runs NEITHER
      // `finally` below, leaking both trees and leaving the env pointed at a
      // deleted home. A leak that announces itself is the better trade.
      process.stderr.write(
        "FakeBackend.stop: close() did not call back within 2s; the server handle is being abandoned\n",
      );
    }
  }

  /**
   * The read routes, answered from `graph` with the real backend's shapes.
   * Search matches names by case-insensitive substring and orders exact names
   * first, then by name and id, as Ix-memory's weight ordering does for a
   * graph this small. Undefined for a path that is not a read route.
   */
  private answerRead(graph: ReadGraph, path: string, rawBody: string): { code: number; payload: unknown } | undefined {
    let body: Record<string, unknown> = {};
    try { body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}; } catch { /* none */ }
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const record = (): void => { this.reads.push({ path, body }); };
    const ok = (payload: unknown): { code: number; payload: unknown } => ({ code: 200, payload });

    if (path === "/v1/search") {
      record();
      const term = String(body.term ?? "").toLowerCase();
      const kind = typeof body.kind === "string" ? body.kind : undefined;
      const scope = typeof body.scope === "string" ? body.scope.toLowerCase() : undefined;
      const limit = typeof body.limit === "number" ? body.limit : 20;
      const hits = graph.nodes
        .filter((n) => n.name.toLowerCase().includes(term))
        .filter((n) => kind === undefined || n.kind === kind)
        .filter((n) => scope === undefined || n.uri.toLowerCase().includes(scope))
        .sort((a, b) => Number(b.name.toLowerCase() === term) - Number(a.name.toLowerCase() === term)
          || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return ok(hits.slice(0, limit).map(graphNode));
    }
    if (path === "/v1/list") {
      record();
      const limit = typeof body.limit === "number" ? body.limit : 100;
      const scope = typeof body.scope === "string" ? body.scope.toLowerCase() : undefined;
      return ok(graph.nodes
        .filter((n) => n.kind === body.kind && (scope === undefined || n.uri.toLowerCase().includes(scope)))
        .slice(0, limit).map(graphNode));
    }
    const expandFrom = (starts: string[], hops: number): Record<string, unknown> => {
      const direction = String(body.direction ?? "both");
      const predicates = Array.isArray(body.predicates) ? body.predicates as string[] : undefined;
      const seen = new Set<string>(starts);
      let frontier = [...starts];
      const nodes: ReadNode[] = [];
      const edges: ReadEdge[] = [];
      for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
        const next: string[] = [];
        for (const id of frontier) {
          for (const e of graph.edges) {
            if (predicates && !predicates.includes(e.predicate)) continue;
            const other = (direction !== "in" && e.src === id) ? e.dst
              : (direction !== "out" && e.dst === id) ? e.src : undefined;
            if (other === undefined) continue;
            if (!edges.includes(e)) edges.push(e);
            if (seen.has(other)) continue;
            seen.add(other);
            const n = byId.get(other);
            if (n) { nodes.push(n); next.push(other); }
          }
        }
        frontier = next;
      }
      return { nodes: nodes.map(graphNode), edges: edges.map(graphEdge) };
    };
    if (path === "/v1/expand") {
      record();
      return ok(expandFrom([String(body.nodeId)], typeof body.hops === "number" ? body.hops : 1));
    }
    if (path === "/v1/expand-by-name") {
      // One hop from every entity with exactly this name (and kind, if given).
      record();
      const kinds = Array.isArray(body.kinds) ? body.kinds as string[] : undefined;
      const starts = graph.nodes
        .filter((n) => n.name === body.name && (kinds === undefined || kinds.includes(n.kind)))
        .map((n) => n.id);
      return ok(expandFrom(starts, 1));
    }
    if (path === "/v1/degree") {
      record();
      const ids = Array.isArray(body.ids) ? body.ids as string[] : [];
      const direction = String(body.direction ?? "both");
      const predicates = Array.isArray(body.predicates) ? body.predicates as string[] : undefined;
      const counts: Record<string, number> = {};
      for (const id of ids) {
        if (!byId.has(id)) continue;
        const neighbours = new Set<string>();
        let edgeCount = 0;
        for (const e of graph.edges) {
          if (predicates && !predicates.includes(e.predicate)) continue;
          if (direction !== "in" && e.src === id) { neighbours.add(e.dst); edgeCount++; }
          else if (direction !== "out" && e.dst === id) { neighbours.add(e.src); edgeCount++; }
        }
        counts[id] = body.distinct ? neighbours.size : edgeCount;
      }
      return ok({ rev: 1, counts, truncated: false });
    }
    if (path.startsWith("/v1/entity/")) {
      record();
      const n = byId.get(decodeURIComponent(path.slice("/v1/entity/".length)));
      if (!n) return { code: 404, payload: { error: "404: entity not found" } };
      const edges = graph.edges.filter((e) => e.src === n.id || e.dst === n.id).map(graphEdge);
      return ok({ node: graphNode(n), claims: [], edges });
    }
    if (path === "/v1/nodes") {
      record();
      const ids = Array.isArray(body.ids) ? body.ids as string[] : [];
      const nodes = ids.flatMap((id) => { const n = byId.get(id); return n ? [graphNode(n)] : []; });
      const found = new Set(nodes.map((n) => n.id));
      return ok({ rev: 1, nodes, missing: ids.filter((id) => !found.has(id)) });
    }
    if (path === "/v1/stats") {
      // The graph-health probe's input (graph-health.ts assessGraphStats).
      record();
      const tally = (keys: string[], field: string): Array<Record<string, unknown>> =>
        [...new Set(keys)].sort().map((k) => ({ [field]: k, count: keys.filter((x) => x === k).length }));
      return ok({
        nodes: { total: graph.nodes.length, byKind: tally(graph.nodes.map((n) => n.kind), "kind") },
        edges: { total: graph.edges.length, byPredicate: tally(graph.edges.map((e) => e.predicate), "predicate") },
      });
    }
    if (path.startsWith("/v1/provenance/")) {
      record();
      const id = decodeURIComponent(path.slice("/v1/provenance/".length));
      return ok({ entityId: id, chain: [] });
    }
    if (path.startsWith("/v1/resolve-prefix/")) {
      record();
      const prefix = decodeURIComponent(path.slice("/v1/resolve-prefix/".length));
      const matches = graph.nodes.filter((n) => n.id.startsWith(prefix)).map((n) => n.id);
      if (matches.length === 1) return ok({ id: matches[0] });
      if (matches.length > 1) return ok({ error: "ambiguous", matches });
      return ok({ error: "not_found" });
    }
    return undefined;
  }

  private route(url: string, body: string, res: ServerResponse): void {
    const path = new URL(url, "http://x").pathname;
    const send = (code: number, payload: unknown, headers: Record<string, string> = {}): void => {
      // Stamp the answer onto the request that produced it. Whether a bulk was
      // ACCEPTED or refused is the difference between two completely different
      // code paths in `ingestFiles`, and a test that assumes the wrong one is
      // measuring nothing -- which is exactly how the drain test below first
      // went wrong.
      const last = this.requests[this.requests.length - 1];
      if (last !== undefined && last.code === undefined) last.code = code;
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };

    if (path === "/v1/patches/bulk" || path === "/v1/patch") {
      let patches: SentPatch[] = [];
      try {
        const parsed = JSON.parse(body) as { patches?: SentPatch[] };
        patches = parsed.patches ?? [parsed as SentPatch];
      } catch {
        /* a body we cannot read is still a request */
      }
      this.requests.push({ path, patches: patches.length });
      for (const { source, ops, patchId } of patches) {
        if (!source?.uri) continue;
        this.sourceUris.push(source.uri);
        this.sourceWorkspaceIds.push(source.workspaceId);
        this.lastOps.set(source.uri, ops ?? []);
        if (patchId !== undefined) this.lastPatchIds.set(source.uri, patchId);
      }
      if (this.abortAfterCommits !== undefined && this.commitCount >= this.abortAfterCommits) {
        this.aborter.abort();
      }

      const transientFailure = this.transientCommitFailures.shift();
      if (transientFailure !== undefined) {
        return send(
          transientFailure.status,
          { error: `${transientFailure.status}: service unavailable` },
          transientFailure.retryAfter !== undefined ? { "Retry-After": transientFailure.retryAfter } : {},
        );
      }
      if (this.databaseDown) {
        const status = this.databaseDownCommitStatus;
        return send(status, { error: `${status}: Connection refused: arangodb:8529` });
      }

      if (path === "/v1/patches/bulk") this.bulkBodyBytes.push(Buffer.byteLength(body));
      if (path === "/v1/patches/bulk" && this.maxBulkBytes !== undefined && patches.length > 1 &&
          Buffer.byteLength(body) > this.maxBulkBytes) {
        // The OSS backend's strict error policy answers the body cap with this
        // fixed text (ErrorHandler.payloadTooLargeJson without a suggestion).
        return send(413, {
          error: "payload_too_large",
          message: "the write exceeds the maximal transaction size; send fewer patches per request",
          correlation_id: "fake",
        });
      }
      if (path === "/v1/patches/bulk" && this.maxBulkOps !== undefined && patches.length > 1) {
        const ops = patches.reduce((sum, p) => sum + (p.ops?.length ?? 0), 0);
        if (ops > this.maxBulkOps) {
          // The bulk writer's estimate refusal (Ix-memory#232): a 413 before
          // any write, with the patch count that would fit when asked to say.
          const perPatch = ops / patches.length;
          const suggested = Math.max(1, Math.floor(this.maxBulkOps / perPatch));
          return send(413, {
            error: "payload_too_large",
            message: `bulk commit of ${patches.length} patches is over the transaction budget`,
            ...(this.suggestMaxPatches ? { suggestedMaxPatches: suggested } : {}),
          });
        }
      }
      if (path === "/v1/patch" && this.refuseReplays) {
        return send(500, { error: "500: already committed" });
      }
      if (path === "/v1/patches/bulk" && this.bulk409PlanMismatch) {
        return send(409, planMismatchBody(patches.map((p) => p.patchId ?? "")));
      }
      if (path === "/v1/patches/bulk" && this.bulk409AllLanded) {
        const ids = patches.map((p) => p.patchId).filter(Boolean);
        return send(409, { error: "bulk group partially committed", committed_patch_ids: ids });
      }
      // Ahead of the poison check, deliberately. The drain carries the patches
      // the cutoff held back, which for any fixture that trips the cutoff
      // includes the poisoned ones -- so the poison branch answered 500 and the
      // drain never reached the success path at all. A first attempt at this
      // set the status further down and measured nothing, because no bulk in
      // the test ever got there.
      const isDrainBulk = path === "/v1/patches/bulk" && this.singleCount > 0;
      if (this.loseBaseRevRaces > 0) {
        this.loseBaseRevRaces--;
        return send(200, { rev: this.rev, applied: 0, status: "BaseRevMismatch" });
      }
      if (this.mismatchOnDrainBulk && isDrainBulk) {
        // A 200 that wrote NOTHING: the backend read the latest rev outside the
        // transaction and it moved before the commit ran. `applied: 0` and the
        // rev deliberately left where it was, because nothing landed.
        return send(200, { rev: this.rev, applied: 0, status: "BaseRevMismatch" });
      }
      const refused =
        this.refuseEverything ||
        (this.refuseUntilDrain && !isDrainBulk) ||
        this.poison.some((p) => body.includes(p));
      // Answered synchronously. A `commitDelayMs` knob lived here and no test
      // ever set it -- the deadline test fires off request COUNT instead, which
      // is what makes it deterministic. Reviving it needs care rather than a
      // one-liner: `stop()` resolves on `server.close()` without cancelling a
      // pending timer, so a deferred response outlives the test that armed it
      // and fires against a closed server.
      if (refused) return send(500, { error: "500: transaction begin timeout" });
      if (this.semantics !== undefined) return this.commitToGraph(path, patches, send);
      this.rev += patches.length || 1;
      if (this.rememberHashes) {
        for (const { source } of patches) {
          if (source?.uri && source.sourceHash) {
            this.hashes.set(`${source.workspaceId ?? ""}\0${source.uri}`,
              { workspaceId: source.workspaceId ?? null, uri: source.uri, hash: source.sourceHash });
          }
        }
      }
      // `status` included, because `PatchCommitResult` declares it required and
      // the ingest path branches on it. Serving 200s without it left
      // `result.status` undefined everywhere, so this fake could never produce
      // an `Idempotent` or `BaseRevMismatch` answer -- the two branches that
      // decide whether a patch lands in `patchesApplied` or `commitErrors`, and
      // so whether the mtime baseline is written at all. A regression that
      // flipped the applied test from "not BaseRevMismatch" to `=== "Ok"` would
      // have counted zero patches applied against the real backend while every
      // test here stayed green.
      send(
        200,
        path === "/v1/patches/bulk"
          ? { rev: this.rev, applied: patches.length, status: "Ok" }
          : { rev: this.rev, status: "Ok" },
      );
      return;
    }

    if (path === "/v1/health") {
      this.healthRequests++;
      const release = this.releaseVersion !== undefined ? this.releaseVersion : this.semantics === "head" ? "1.0.34" : null;
      const base = { version: "1.0.28", ...(release ? { release_version: release } : {}) };
      if (!this.healthReportsDatabase) return send(200, { status: "ok", ...base });
      if (this.databaseDown || this.healthSaysDatabaseDown) return send(503, { status: "degraded", database: "unreachable", ...base });
      return send(200, { status: "ok", database: "reachable", ...base });
    }
    if (path === "/v1/revisions/current") {
      this.revisionRequests++;
      if (this.databaseDown) return send(500, { error: "500: Connection refused: arangodb:8529" });
      return send(200, { rev: this.rev });
    }
    if (path === "/v1/source-hashes") {
      if (this.failSourceHashes) return send(500, { error: "500: transaction begin timeout" });
      let uris: string[] = [];
      let workspaceIds: string[] | undefined;
      try {
        ({ uris = [], workspaceIds } = JSON.parse(body) as { uris?: string[]; workspaceIds?: string[] });
      } catch { /* none */ }
      if (this.semantics !== undefined) return send(200, this.sourceHashesFromGraph(uris, workspaceIds));
      if (!this.rememberHashes) return send(200, []);
      const wanted = new Set(uris);
      return send(200, [...this.hashes.values()].filter((row) => wanted.has(row.uri)));
    }
    if (this.readGraph !== undefined) {
      const answer = this.answerRead(this.readGraph, path, body);
      if (answer !== undefined) return send(answer.code, answer.payload);
    }
    if (path.startsWith("/v1/stitch/system/")) return send(200, { systemId: null });
    // Read by `reconcileRemovedEntities`, which only an incremental run against
    // a stored graph reaches.
    // Without semantics nothing is stored, so every patch is not found: what a
    // forced or rebuilt file's reconcile sees, and survives.
    if (path.startsWith("/v1/patches/")) {
      const patchId = decodeURIComponent(path.slice("/v1/patches/".length));
      this.patchReads++;
      const record = this.stored.get(patchId);
      const fail = typeof this.failPatchReads === "function"
        ? this.failPatchReads(patchId, record?.ops)
        : this.failPatchReads;
      if (fail) return send(500, { error: "500: transaction begin timeout" });
      if (this.hidePatchReads) return send(404, { error: "404: patch not found" });
      if (!record) return send(404, { error: "404: patch not found" });
      if (this.bulkManifests && record.bulkGroup !== null) {
        // BulkWriteApi.patchDocument: ids in op order, no ops.
        const entityIds: string[] = [];
        const nodeIds: string[] = [];
        let nodeOpCount = 0;
        for (const op of record.ops) {
          const opId = String(op["id"] ?? op["entityId"]);
          if (op["type"] === "UpsertNode" || op["type"] === "DeleteNode") nodeOpCount++;
          if (op["type"] === "UpsertNode" && !nodeIds.includes(opId)) nodeIds.push(opId);
          if (!entityIds.includes(opId)) entityIds.push(opId);
        }
        return send(200, { data: { entityIds, nodeIds, nodeOpCount } });
      }
      return send(200, { data: { ops: record.ops } });
    }
    if (path === "/v1/nodes") {
      this.nodesReads++;
      if (!this.serveNodes) {
        return send(404, { error: `404: no such endpoint ${path}` });
      }
      let ids: string[] = [];
      try {
        ({ ids = [] } = JSON.parse(body) as { ids?: string[] });
      } catch { /* none */ }
      if (ids.length > 1000) return send(413, { error: "payload_too_large" });
      const nodes = ids.flatMap((id) => {
        const n = this.nodes.get(id);
        return n?.live
          ? [{ id, kind: n.kind, name: n.name, attrs: n.attrs ?? {}, provenance: { sourceUri: n.uri ?? "", sourceHash: n.hash, extractor: n.extractor } }]
          : [];
      });
      const found = new Set(nodes.map((n) => n.id));
      return send(200, { rev: this.rev, nodes, missing: ids.filter((id) => !found.has(id)) });
    }
    if (this.semantics !== undefined && path.startsWith("/v1/entity/")) {
      this.entityReads++;
      const id = decodeURIComponent(path.slice("/v1/entity/".length));
      const node = this.nodes.get(id);
      if (!node?.live) return send(404, { error: "404: entity not found" });
      const edges = [...this.edges]
        .filter(([, e]) => e.live && (e.src === id || e.dst === id))
        .map(([edgeId, e]) => ({ id: edgeId, predicate: e.predicate, provenance: { sourceUri: e.uri } }));
      return send(200, { node: { id, kind: node.kind, name: node.name, attrs: node.attrs ?? {} }, edges });
    }
    if (path === "/v1/stitch") {
      this.requests.push({ path, patches: 0 });
      if (this.stitchStatus !== 200)
        return send(this.stitchStatus, { error: "AQL: query timed out" });
      return send(200, { stitched: 0, systemId: null, edges: [] });
    }
    // 404, not `200 {}`. A fake that answers every unrecognised path with a
    // cheerful empty body cannot fail: product code that starts calling a new
    // endpoint -- or mistypes an existing one -- gets a success here where the
    // real backend would 404, and the harness stays green while measuring a
    // request the backend never served. The path is recorded as well as
    // refused, so the afterEach names it rather than leaving a stray 404 to be
    // explained.
    this.unknownPaths.push(path);
    return send(404, { error: `404: no such endpoint ${path}` });
  }
}
