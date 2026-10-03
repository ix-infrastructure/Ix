// Copyright 2026 Ix Infrastructure Inc.

import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

type SentPatch = {
  patchId?: string;
  source?: { uri?: string; sourceHash?: string; workspaceId?: string };
  ops?: Array<Record<string, unknown>>;
};

/** A backend that answers the endpoints an ingest touches, and records them. */
export class FakeBackend {
  readonly requests: Array<{ path: string; patches: number; code?: number }> = [];
  /** `source.uri` of every patch sent in a commit request, accepted or not. */
  readonly sourceUris: string[] = [];
  /** `source.workspaceId` beside each of `sourceUris`, in the same order. */
  readonly sourceWorkspaceIds: Array<string | undefined> = [];
  /** The ops of the last patch sent for each `source.uri`. */
  readonly lastOps = new Map<string, Array<Record<string, unknown>>>();
  /** Paths this fake does not implement. Asserted empty after every test. */
  readonly unknownPaths: string[] = [];

  private server: Server | undefined;
  private rev = 0;

  /** Patch-source substrings this backend refuses, whatever else is healthy. */
  poison: string[] = [];
  /** Fail every commit, the Ix#560 shape. */
  refuseEverything = false;
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
  private readonly nodes = new Map<string, { kind: unknown; name: unknown; live: boolean }>();
  private readonly edges = new Map<string, {
    src: unknown; dst: unknown; predicate: unknown; workspaceId: string; uri: string; live: boolean;
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
   * edges as `id src dst predicate`. Two backends hold the same graph exactly
   * when their signatures are equal.
   */
  graphSignature(): { nodes: string[]; edges: string[] } {
    const nodes = [...this.nodes].filter(([, n]) => n.live)
      .map(([id, n]) => `${id} ${String(n.kind)} ${String(n.name)}`).sort();
    const edges = [...this.edges].filter(([, e]) => e.live)
      .map(([id, e]) => `${id} ${String(e.src)} ${String(e.dst)} ${String(e.predicate)}`).sort();
    return { nodes, edges };
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

  private applyPatch(patch: SentPatch, sweep: boolean, bulkGroup: string | null): void {
    const workspaceId = patch.source?.workspaceId ?? "";
    const uri = patch.source?.uri ?? "";
    this.rev++;
    if (sweep) {
      for (const e of this.edges.values()) {
        if (e.live && e.uri === uri && e.workspaceId === workspaceId) e.live = false;
      }
    }
    for (const op of patch.ops ?? []) {
      const id = String(op.id);
      if (op.type === "UpsertNode") this.nodes.set(id, { kind: op.kind, name: op.name, live: true });
      else if (op.type === "UpsertEdge") {
        this.edges.set(id, { src: op.src, dst: op.dst, predicate: op.predicate, workspaceId, uri, live: true });
      } else if (op.type === "DeleteNode") {
        const n = this.nodes.get(id);
        if (n) n.live = false;
      } else if (op.type === "DeleteEdge") {
        const e = this.edges.get(id);
        if (e) e.live = false;
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
      if (patch) this.applyPatch(patch, false, null);
      return send(200, { rev: this.rev, status: "Ok" });
    }
    const ids = patches.map((p) => p.patchId ?? "");
    const group = createHash("sha256").update(ids.join(",")).digest("hex");
    const done = ids.filter((id) => this.alreadyCommitted(id));
    if (done.length === 0) {
      for (const p of patches) this.applyPatch(p, true, group);
      return send(200, { rev: this.rev, applied: patches.length, status: "Ok" });
    }
    if (done.length !== ids.length) {
      return send(409, {
        error: `bulk request is partially committed (${done.length}/${ids.length} patch IDs)`,
        committed_patch_ids: [...done].sort(),
      });
    }
    if (done.some((id) => this.stored.get(id)!.bulkGroup !== group)) {
      return send(409, { error: "bulk patch IDs were previously committed by a different request plan" });
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
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
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

  private route(url: string, body: string, res: ServerResponse): void {
    const path = new URL(url, "http://x").pathname;
    const send = (code: number, payload: unknown): void => {
      // Stamp the answer onto the request that produced it. Whether a bulk was
      // ACCEPTED or refused is the difference between two completely different
      // code paths in `ingestFiles`, and a test that assumes the wrong one is
      // measuring nothing -- which is exactly how the drain test below first
      // went wrong.
      const last = this.requests[this.requests.length - 1];
      if (last !== undefined && last.code === undefined) last.code = code;
      res.writeHead(code, { "Content-Type": "application/json" });
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
      for (const { source, ops } of patches) {
        if (!source?.uri) continue;
        this.sourceUris.push(source.uri);
        this.sourceWorkspaceIds.push(source.workspaceId);
        this.lastOps.set(source.uri, ops ?? []);
      }
      if (this.abortAfterCommits !== undefined && this.commitCount >= this.abortAfterCommits) {
        this.aborter.abort();
      }

      if (path === "/v1/patch" && this.refuseReplays) {
        return send(500, { error: "500: already committed" });
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

    if (path === "/v1/health") return send(200, { status: "ok", version: "1.0.28" });
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
    if (path.startsWith("/v1/stitch/system/")) return send(200, { systemId: null });
    // Read by `reconcileRemovedEntities`, which only an incremental run against
    // a stored graph reaches.
    if (this.semantics !== undefined && path.startsWith("/v1/patches/")) {
      const record = this.stored.get(decodeURIComponent(path.slice("/v1/patches/".length)));
      return record ? send(200, { data: { ops: record.ops } }) : send(404, { error: "404: patch not found" });
    }
    if (this.semantics !== undefined && path.startsWith("/v1/entity/")) {
      const id = decodeURIComponent(path.slice("/v1/entity/".length));
      const node = this.nodes.get(id);
      if (!node?.live) return send(404, { error: "404: entity not found" });
      const edges = [...this.edges]
        .filter(([, e]) => e.live && (e.src === id || e.dst === id))
        .map(([edgeId, e]) => ({ id: edgeId, predicate: e.predicate, provenance: { sourceUri: e.uri } }));
      return send(200, { node: { id, kind: node.kind, name: node.name }, edges });
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
