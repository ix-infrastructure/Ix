// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Command } from "commander";

import { registerMapCommand } from "../commands/map.js";
import { ingestFiles } from "../commands/ingest.js";
import {
  clearIngestMtimeCache,
  clearMapBaseline,
  ingestMtimeCachePath,
  mapResultCachePath,
} from "../config.js";
import {
  backendIdentity,
  loadCachedMap,
  resolveMapCacheSlot,
  revisionToken,
  saveCachedMap,
  type MapCacheSlot,
} from "../map-result-cache.js";
import { acquireMapLock, lockPathForTest, requestMapRerun, takeMapRerun } from "../single-flight.js";
import { createHash } from "node:crypto";

/**
 * `ix map` reuses its last `/v1/map` response when a run ingested nothing and
 * the backend's head revision has not moved. These drive the real command
 * against a fake backend and count the map requests, because "no request" is
 * the whole point and "the same output" is the whole constraint.
 *
 * Each way the graph can move is tested so that only ONE guard can catch it:
 * `frozenRevision` stops commits from advancing the revision, which isolates
 * the ingest's `graphUnchanged` from the revision check, and a revision bumped
 * with no ingest isolates the revision check from `graphUnchanged`.
 */

/** A backend that answers the endpoints `ix map` touches, and records them. */
class FakeBackend {
  readonly requests: string[] = [];
  /** Paths this fake does not implement. Asserted empty after every test. */
  readonly unknownPaths: string[] = [];
  rev = 0;
  /** Commits land without advancing the revision, isolating the ingest-side guard. */
  frozenRevision = false;
  /** Answer `/v1/revisions/current` with a record rather than a bare number. */
  revisionRecord = false;
  release = "1.0.30";
  systemId: string | null = null;
  /** Run on the next commit request, then cleared. */
  onCommit: (() => void) | undefined;
  /** Answer every commit with a 500, as a backend that is down would. */
  failCommits = false;
  readonly hashes = new Map<string, { workspaceId: string | null; uri: string; hash: string }>();
  private readonly patches = new Map<string, unknown[]>();
  private server: Server | undefined;

  mapRequests(): number {
    return this.requests.filter(p => p === "/v1/map").length;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.route(req.url ?? "/", Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private route(url: string, body: string, res: ServerResponse): void {
    const path = new URL(url, "http://x").pathname;
    this.requests.push(path);
    const send = (code: number, payload: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/v1/patches/bulk" || path === "/v1/patch") {
      // Fired once, mid-run: what happens in the world while a map commits.
      const hook = this.onCommit;
      this.onCommit = undefined;
      hook?.();
      if (this.failCommits) return send(500, { error: "backend unavailable" });
      type SentPatch = { patchId?: string; source?: { uri?: string; sourceHash?: string; workspaceId?: string }; intent?: string; ops?: unknown[] };
      let patches: SentPatch[] = [];
      try {
        const parsed = JSON.parse(body) as { patches?: SentPatch[] };
        patches = parsed.patches ?? [parsed as SentPatch];
      } catch { /* a body we cannot read is still a request */ }
      if (!this.frozenRevision) this.rev += patches.length || 1;
      for (const { patchId, source, intent, ops } of patches) {
        if (patchId) this.patches.set(patchId, ops ?? []);
        if (!source?.uri) continue;
        const key = `${source.workspaceId ?? ""}\0${source.uri}`;
        if (intent?.startsWith("Deleted ")) this.hashes.delete(key);
        else if (source.sourceHash) {
          this.hashes.set(key, { workspaceId: source.workspaceId ?? null, uri: source.uri, hash: source.sourceHash });
        }
      }
      return send(200, path === "/v1/patches/bulk"
        ? { rev: this.rev, applied: patches.length, status: "Ok" }
        : { rev: this.rev, status: "Ok" });
    }
    if (path === "/v1/health") return send(200, { status: "ok", schema_version: 3, release_version: this.release });
    if (path === "/v1/revisions/current") {
      return send(200, this.revisionRecord
        ? { rev: this.rev, patchId: `p-${this.rev}`, timestamp: "2026-09-28T00:00:00Z", summary: {} }
        : this.rev);
    }
    if (path === "/v1/source-hashes") {
      let uris: string[] = [];
      try { uris = (JSON.parse(body) as { uris?: string[] }).uris ?? []; } catch { /* none */ }
      const wanted = new Set(uris);
      return send(200, [...this.hashes.values()].filter(row => wanted.has(row.uri)));
    }
    // A deletion reconciles against the patch it replaces.
    if (path.startsWith("/v1/patches/")) {
      const ops = this.patches.get(decodeURIComponent(path.slice("/v1/patches/".length)));
      return ops ? send(200, { data: { ops } }) : send(404, { error: "Patch not found" });
    }
    // ...and asks after each node that patch wrote. A node with no edges is
    // simply deleted, which is all this fake needs.
    if (path.startsWith("/v1/entity/")) return send(200, { node: { kind: "function" }, edges: [] });
    if (path.startsWith("/v1/stitch/system/")) return send(200, { systemId: this.systemId });
    if (path === "/v1/stitch") return send(200, { stitched: 0, systemId: null, edges: [] });
    if (path === "/v1/map") {
      // Derived from the graph, so a stale reuse would show in the output.
      const files = this.hashes.size;
      return send(200, {
        file_count: files,
        region_count: 2,
        levels: 2,
        map_rev: this.rev,
        outcome: "full_local_completed",
        regions: [
          region("r-sys", "system", "Fixture", 2, files, null),
          region("r-mod", "module", `Module of ${files}`, 1, files, "r-sys"),
        ],
        edges: [],
        hierarchy: [],
      });
    }
    this.unknownPaths.push(path);
    return send(404, { error: `404: no such endpoint ${path}` });
  }
}

function region(id: string, kind: string, label: string, level: number, files: number, parent: string | null) {
  return {
    id, label, label_kind: kind, level, file_count: files, child_region_count: parent ? 0 : 1,
    parent_id: parent, cohesion: 0.5, external_coupling: 0.1, boundary_ratio: 1, confidence: 0.8,
    crosscut_score: 0, dominant_signals: ["imports"], interface_node_count: 0,
  };
}

describe("ix map reuses an unchanged map", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

  let home = "";
  let repo = "";
  let backend: FakeBackend;
  const saved: Record<string, string | undefined> = {};

  function fixture(count: number): void {
    mkdirSync(join(repo, "src"), { recursive: true });
    for (let i = 0; i < count; i++) {
      writeFileSync(join(repo, "src", `m${i}.ts`), `export function f${i}(): number { return ${i}; }\n`, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
  }

  /** Run `ix map <repo>` in-process; stdout, plus stderr for `--silent`. */
  async function map(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { stdout.push(a.map(String).join(" ")); });
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(`${a.map(String).join(" ")}\n`); });
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const program = new Command();
      registerMapCommand(program);
      await program.parseAsync(["node", "ix", "map", repo, ...args]);
    } finally {
      log.mockRestore();
      error.mockRestore();
      write.mockRestore();
      // The lock is released on process exit, which an in-process run never
      // reaches; without this the next run would coalesce against it.
      rmSync(lockPathForTest(repo), { force: true });
    }
    expect(process.exitCode ?? 0, stderr.join("")).toBe(0);
    return { stdout: stdout.join("\n"), stderr: stderr.join("") };
  }

  /** `ix map <repo> --silent` in-process, without asserting on the exit code. */
  async function runMap(): Promise<void> {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const program = new Command();
      registerMapCommand(program);
      await program.parseAsync(["node", "ix", "map", repo, "--silent"]);
    } finally {
      write.mockRestore();
      error.mockRestore();
      rmSync(lockPathForTest(repo), { force: true });
    }
  }

  beforeEach(async () => {
    backend = new FakeBackend();
    home = realpathSync(mkdtempSync(join(tmpdir(), "ix-mapcache-home-")));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ix-mapcache-repo-")));
    const endpoint = await backend.start();
    for (const k of [
      "HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_AUTO_MAP",
      "IX_MAP_FULL_INGEST", "IX_MAP_DEADLINE_MS", "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS",
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_HOME = join(home, ".ix");
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    fixture(4);
  });

  afterEach(async () => {
    try {
      expect(backend.unknownPaths, "endpoints the fake does not implement").toEqual([]);
    } finally {
      process.exitCode = undefined;
      await backend.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
      home = "";
      repo = "";
    }
  });

  describe("a map that coalesces is not lost", () => {
    const hashOf = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
    const stored = (uri: string) => [...backend.hashes.values()].find(row => row.uri === uri)?.hash;

    it("a coalescing map leaves a rerun request for the holder", async () => {
      const holder = acquireMapLock(repo, "holder")!;
      try {
        await map("--silent");
        expect(takeMapRerun(repo)).toBe(true);
      } finally {
        holder.release();
      }
    });

    it("the holder runs once more for an edit made while it was committing", async () => {
      await map("--silent");
      writeFileSync(join(repo, "src", "m1.ts"), "export const changed = 1;\n", "utf8");
      const late = "export const late = 2;\n";
      // Mid-commit: an edit lands after this run read the tree, and the
      // editor's own `ix map` coalesces.
      backend.onCommit = () => {
        writeFileSync(join(repo, "src", "m2.ts"), late, "utf8");
        requestMapRerun(repo);
      };

      await map("--silent");

      expect(stored("src/m2.ts"), "the late edit reached the backend in this invocation").toBe(hashOf(late));
      expect(takeMapRerun(repo), "the request was consumed").toBe(false);
    });

    it("a map whose ingest failed does not rerun against the same backend", async () => {
      // The rerun ran from a finally block whatever had happened: after a
      // failed ingest it retried a backend just seen to be down, with no
      // deadline, keeping the lock (and the hook waiting on it) for as long
      // as that took.
      backend.failCommits = true;
      const commits = () => backend.requests.filter(p => p === "/v1/patches/bulk" || p === "/v1/patch").length;
      await runMap();
      expect(process.exitCode, "the ingest failed").toBe(1);
      const oneRun = commits();
      process.exitCode = undefined;
      backend.requests.length = 0;

      backend.onCommit = () => requestMapRerun(repo);
      await runMap();
      expect(process.exitCode).toBe(1);
      expect(commits(), "no second ingest after a failed one").toBe(oneRun);
    });

    it("a request left before a map starts is satisfied by that map, not rerun", async () => {
      requestMapRerun(repo);
      await map("--silent");
      const commits = backend.requests.filter(p => p === "/v1/patches/bulk" || p === "/v1/patch").length;
      expect(commits, "one ingest, not two").toBe(1);
    });
  });

  it("makes no map request for an unchanged repo, and prints the same thing", async () => {
    // The first map ingests everything, which the output reports; every run
    // compared below ingests nothing.
    await map("--format", "json");
    for (const format of ["json", "llm", "text"]) {
      // Something to ask about: a fresh map for this format's first run.
      backend.rev += 1;
      const fresh = await map("--format", format);
      const before = backend.mapRequests();
      const reused = await map("--format", format);
      expect(backend.mapRequests(), `${format}: second run must not ask`).toBe(before);
      expect(reused.stdout, `${format}: output`).toBe(fresh.stdout);
      expect(reused.stdout.length).toBeGreaterThan(0);
    }

    backend.rev += 1;
    const fresh = await map("--silent");
    const before = backend.mapRequests();
    const reused = await map("--silent");
    expect(backend.mapRequests()).toBe(before);
    const line = (s: string) => s.split("\n").find(l => l.startsWith("map: "))?.replace(/ · \d+ms/, "");
    expect(line(reused.stderr)).toBe(line(fresh.stderr));
    expect(line(fresh.stderr)).toBe("map: 4 files · 1s/0ss/1m regions");
  });

  it("asks again when a file changed", async () => {
    await map("--format", "json");
    writeFileSync(join(repo, "src", "m9.ts"), "export const nine = 9;\n", "utf8");
    const before = backend.mapRequests();
    const after = await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
    expect(JSON.parse(after.stdout).file_count).toBe(5);
  });

  it("asks again when an ingest wrote to the graph, even if the revision did not move", async () => {
    await map("--format", "json");
    backend.frozenRevision = true;
    writeFileSync(join(repo, "src", "m1.ts"), "export function f1(): number { return 100; }\n", "utf8");
    const before = backend.mapRequests();
    await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
  });

  it("asks again when a file was deleted, even if the revision did not move", async () => {
    await map("--format", "json");
    backend.frozenRevision = true;
    unlinkSync(join(repo, "src", "m3.ts"));
    const before = backend.mapRequests();
    const after = await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
    expect(JSON.parse(after.stdout).file_count).toBe(3);
  });

  it("asks again when another client moved the revision", async () => {
    backend.revisionRecord = true;
    await map("--format", "json");
    backend.rev += 1; // a commit this run's ingest knows nothing about
    const before = backend.mapRequests();
    const after = await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
    expect(JSON.parse(after.stdout).map_rev).toBe(backend.rev);
  });

  it("asks again after the workspace's data was deleted without a commit", async () => {
    await map("--format", "json");
    // A scoped reset: nodes and hashes gone, head revision untouched.
    backend.hashes.clear();
    backend.frozenRevision = true;
    const before = backend.mapRequests();
    await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
  });

  it("asks again after `ix reset` cleared the local baselines", async () => {
    await map("--format", "json");
    // A global reset truncates the revision counter; by the time this runs,
    // other workspaces' commits may have counted it back to the very value the
    // cached map was computed at. Only the local invalidation can tell.
    backend.hashes.clear();
    clearIngestMtimeCache(repo);
    backend.frozenRevision = true;
    const before = backend.mapRequests();
    await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
  });

  it("asks again when the backend release changed", async () => {
    await map("--format", "json");
    backend.release = "1.0.31";
    const before = backend.mapRequests();
    await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 1);
  });

  it("always asks under --full, and for a system-scoped map", async () => {
    await map("--format", "json");
    let before = backend.mapRequests();
    await map("--format", "json", "--full");
    await map("--format", "json", "--full");
    expect(backend.mapRequests()).toBe(before + 2);

    backend.systemId = "sys-1";
    before = backend.mapRequests();
    await map("--format", "json");
    await map("--format", "json");
    expect(backend.mapRequests()).toBe(before + 2);
    expect(existsSync(mapResultCachePath(repo)), "a map that is not kept leaves nothing behind").toBe(false);
  });
});

describe("ingestFiles invalidates the cached map", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

  let home = "";
  let repo = "";
  let backend: FakeBackend;
  const saved: Record<string, string | undefined> = {};
  const slot: MapCacheSlot = { key: "k", revision: "r" };
  const response = { file_count: 1, region_count: 0, levels: 0, map_rev: 1, outcome: "full_local_completed", regions: [] };

  beforeEach(async () => {
    backend = new FakeBackend();
    home = realpathSync(mkdtempSync(join(tmpdir(), "ix-mapcache-home-")));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ix-mapcache-repo-")));
    const endpoint = await backend.start();
    for (const k of ["HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_LOCK_DIR"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_HOME = join(home, ".ix");
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    mkdirSync(join(repo, "src"), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(repo, "src", `m${i}.ts`), `export const v${i} = ${i};\n`, "utf8");
  });

  afterEach(async () => {
    await backend.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const dir of [home, repo]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const ingest = async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      return await ingestFiles(repo, { format: "json", suppressOutput: true, printSummary: false, mapMode: true });
    } finally {
      write.mockRestore();
    }
  };

  it("reports an ingest that wrote nothing as unchanged, and one that wrote as changed", async () => {
    expect((await ingest()).graphUnchanged).toBe(false);
    expect((await ingest()).graphUnchanged).toBe(true);
  });

  it("drops it when the DB-reset guard fires", async () => {
    await ingest();
    saveCachedMap(repo, slot, response);
    backend.hashes.clear();
    const summary = await ingest();
    expect(summary.graphUnchanged).toBe(false);
    expect(existsSync(mapResultCachePath(repo))).toBe(false);
  });

  it("drops it when an extractor change forces a re-ingest", async () => {
    await ingest();
    saveCachedMap(repo, slot, response);
    const baseline = JSON.parse(readFileSync(ingestMtimeCachePath(repo), "utf8"));
    writeFileSync(ingestMtimeCachePath(repo), JSON.stringify({ ...baseline, extractor: "tree-sitter/0.1" }));
    const summary = await ingest();
    expect(summary.graphUnchanged).toBe(false);
    expect(existsSync(mapResultCachePath(repo))).toBe(false);
  });
});

describe("map result cache store", () => {
  let home = "";
  const saved = process.env.IX_HOME;
  const slot: MapCacheSlot = { key: "k1", revision: "[5]" };
  const response = {
    file_count: 2, region_count: 1, levels: 1, map_rev: 5, outcome: "full_local_completed",
    regions: [region("r", "module", "M", 1, 2, null)],
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ix-mapcache-store-"));
    process.env.IX_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IX_HOME;
    else process.env.IX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns what was stored only for the same root, key and revision", () => {
    saveCachedMap("/r", slot, { ...response, hierarchy: [{ big: true }] } as typeof response);
    expect(loadCachedMap("/r", slot)).toEqual(response);
    expect(loadCachedMap("/r", { ...slot, revision: "[6]" })).toBeUndefined();
    expect(loadCachedMap("/r", { ...slot, key: "k2" })).toBeUndefined();
    expect(loadCachedMap("/other", slot)).toBeUndefined();
  });

  it("treats a malformed file as absent", () => {
    writeFileSync(mapResultCachePath("/r"), "{not json");
    expect(loadCachedMap("/r", slot)).toBeUndefined();
    writeFileSync(mapResultCachePath("/r"), JSON.stringify({ root: "/r", key: "k1", revision: "[5]", result: { regions: "x" } }));
    expect(loadCachedMap("/r", slot)).toBeUndefined();
  });

  it("is removed by clearMapBaseline and clearIngestMtimeCache", () => {
    saveCachedMap("/r", slot, response);
    clearMapBaseline("/r");
    expect(existsSync(mapResultCachePath("/r"))).toBe(false);
    saveCachedMap("/r", slot, response);
    clearIngestMtimeCache("/r");
    expect(existsSync(mapResultCachePath("/r"))).toBe(false);
  });
});

describe("map cache slot", () => {
  const client = (head: unknown) => ({ endpoint: "http://127.0.0.1:1", currentRevision: async () => head });
  const identified = async () => ({ release_version: "1.0.30", schema_version: 3 });

  it("reads a bare revision and a revision record, and nothing else", () => {
    expect(revisionToken(7)).toBe("[7]");
    expect(revisionToken({ rev: 7, patchId: "p", timestamp: "t", summary: { a: 1 } })).toBe('[7,"p","t"]');
    expect(revisionToken({ rev: 7 })).toBe("[7,null,null]");
    for (const bad of [null, "7", -1, 1.5, {}, { rev: "7" }]) expect(revisionToken(bad)).toBeUndefined();
  });

  it("names the backend by release and schema, or not at all", () => {
    expect(backendIdentity({ release_version: "1.0.30", schema_version: 3 })).toBe('["1.0.30",3]');
    expect(backendIdentity({ version: "1.0.28" })).toBe('["1.0.28",null]');
    expect(backendIdentity({ status: "ok" })).toBeUndefined();
  });

  it("is only offered for a workspace-scoped, non-full map on a backend it can identify", async () => {
    const ok = client(9);
    const slot = await resolveMapCacheSlot(ok, { workspaceId: "ws" }, identified);
    expect(slot?.revision).toBe("[9]");
    expect(await resolveMapCacheSlot(ok, { workspaceId: "ws", full: true }, identified)).toBeUndefined();
    expect(await resolveMapCacheSlot(ok, { systemId: "sys" }, identified)).toBeUndefined();
    expect(await resolveMapCacheSlot(ok, {}, identified)).toBeUndefined();
    expect(await resolveMapCacheSlot(ok, { workspaceId: "ws" }, async () => ({ status: "ok" }))).toBeUndefined();
    expect(await resolveMapCacheSlot(client("nope"), { workspaceId: "ws" }, identified)).toBeUndefined();
    const failing = { ...ok, currentRevision: async () => { throw new Error("404: not found"); } };
    expect(await resolveMapCacheSlot(failing, { workspaceId: "ws" }, identified)).toBeUndefined();
    const down = async () => { throw new Error("ECONNREFUSED"); };
    expect(await resolveMapCacheSlot(ok, { workspaceId: "ws" }, down)).toBeUndefined();

    const other = await resolveMapCacheSlot(ok, { workspaceId: "ws2" }, identified);
    expect(other?.key).not.toBe(slot?.key);
  });
});
