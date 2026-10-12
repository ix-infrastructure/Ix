// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Command } from "commander";

import { registerMapCommand } from "../commands/map.js";
import { mapResultCachePath, mapStalePath } from "../config.js";
import {
  ensureFreshMap,
  mapRefreshDebounceMs,
  markMapStale,
  readMapStale,
} from "../map-freshness.js";
import { acquireMapLock, lockPathForTest, requestMapRerun, takeMapRerun } from "../single-flight.js";
import { hasCompletedMapBaseline } from "../stale.js";
import { registerRemoteRunner } from "../remote.js";

/**
 * `ensureFreshMap` (CL-13): the lazy half of a deferred `ix map`. These drive
 * the real `ix map` against a fake backend to get a deferred map, then count
 * the `/v1/map` requests the refresh makes, because "at most one, and none
 * without a marker" is the whole contract, with "never fails the reader"
 * beside it.
 */

/** A backend that answers what `ix map` and a refresh touch, and records the paths. */
class FakeBackend {
  readonly requests: string[] = [];
  readonly unknownPaths: string[] = [];
  rev = 0;
  /** uri -> the row `/v1/source-hashes` answers with. */
  readonly hashes = new Map<string, { workspaceId: string | null; uri: string; hash: string }>();
  /** The status `/v1/map` answers with; 200 serves a map. */
  mapStatus = 200;
  /** Delay before `/v1/map` answers, in ms. */
  mapDelayMs = 0;
  /** The outcome a 200 from `/v1/map` reports. */
  mapOutcome = "full_local_completed";
  /** Answer `/v1/map` with an empty map: no files, no regions. */
  emptyMap = false;
  /** Run when `/v1/map` is asked, before it answers. */
  onMap: (() => void) | undefined;
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
      if (res.writableEnded) return;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/v1/patches/bulk" || path === "/v1/patch") {
      type SentPatch = { patchId?: string; source?: { uri?: string; sourceHash?: string; workspaceId?: string }; intent?: string; ops?: unknown[] };
      let patches: SentPatch[] = [];
      try {
        const parsed = JSON.parse(body) as { patches?: SentPatch[] };
        patches = parsed.patches ?? [parsed as SentPatch];
      } catch { /* a body we cannot read is still a request */ }
      this.rev += patches.length || 1;
      for (const { patchId, source, intent, ops } of patches) {
        if (patchId) this.patches.set(patchId, ops ?? []);
        if (!source?.uri) continue;
        if (intent?.startsWith("Deleted ")) this.hashes.delete(source.uri);
        else if (source.sourceHash) {
          this.hashes.set(source.uri, { workspaceId: source.workspaceId ?? null, uri: source.uri, hash: source.sourceHash });
        }
      }
      return send(200, path === "/v1/patches/bulk"
        ? { rev: this.rev, applied: patches.length, status: "Ok" }
        : { rev: this.rev, status: "Ok" });
    }
    if (path === "/v1/health") return send(200, { status: "ok", schema_version: 3, release_version: "1.0.30" });
    if (path === "/v1/revisions/current") return send(200, this.rev);
    if (path === "/v1/source-hashes") {
      let uris: string[] = [];
      try { uris = (JSON.parse(body) as { uris?: string[] }).uris ?? []; } catch { /* none */ }
      return send(200, uris.filter(u => this.hashes.has(u)).map(u => this.hashes.get(u)));
    }
    // A changed file reconciles against the patch it replaces.
    if (path.startsWith("/v1/patches/")) {
      const ops = this.patches.get(decodeURIComponent(path.slice("/v1/patches/".length)));
      return ops ? send(200, { data: { ops } }) : send(404, { error: "Patch not found" });
    }
    if (path.startsWith("/v1/entity/")) return send(200, { node: { kind: "function" }, edges: [] });
    if (path.startsWith("/v1/stitch/system/")) return send(200, { systemId: null });
    if (path === "/v1/stitch") return send(200, { stitched: 0, systemId: null, edges: [] });
    if (path === "/v1/map") {
      const hook = this.onMap;
      this.onMap = undefined;
      hook?.();
      const answer = (): void => {
        if (this.mapStatus !== 200) return send(this.mapStatus, { error: "map failed" });
        const files = this.emptyMap ? 0 : this.hashes.size;
        send(200, {
          file_count: files,
          region_count: this.emptyMap ? 0 : 1,
          levels: 1,
          map_rev: this.rev,
          outcome: this.mapOutcome,
          regions: this.emptyMap ? [] : [{
            id: "r-mod", label: `Module of ${files}`, label_kind: "module", level: 1, file_count: files,
            child_region_count: 0, parent_id: null, cohesion: 0.5, external_coupling: 0.1, boundary_ratio: 1,
            confidence: 0.8, crosscut_score: 0, dominant_signals: ["imports"], interface_node_count: 0,
          }],
          edges: [],
          hierarchy: [],
        });
      };
      if (this.mapDelayMs > 0) setTimeout(answer, this.mapDelayMs);
      else answer();
      return;
    }
    this.unknownPaths.push(path);
    return send(404, { error: `404: no such endpoint ${path}` });
  }
}

const hashOf = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("ensureFreshMap", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

  let home = "";
  let repo = "";
  let backend: FakeBackend;
  const saved: Record<string, string | undefined> = {};

  /** Run `ix map <repo> --silent` in-process. */
  async function map(...args: string[]): Promise<void> {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const program = new Command();
      registerMapCommand(program);
      await program.parseAsync(["node", "ix", "map", repo, "--silent", ...args]);
    } finally {
      write.mockRestore();
      error.mockRestore();
      log.mockRestore();
      // Released on process exit, which an in-process run never reaches.
      rmSync(lockPathForTest(repo), { force: true });
    }
    expect(process.exitCode ?? 0).toBe(0);
  }

  /** A mapped repo whose last `ix map` deferred the map after an edit. */
  async function deferred(): Promise<void> {
    await map();
    writeFileSync(join(repo, "src", "m9.ts"), "export const nine = 9;\n", "utf8");
    await map();
    expect(readMapStale(repo), "the edit's map was deferred").not.toBeNull();
    backend.requests.length = 0;
  }

  /** What the last `refresh()` wrote on stderr, and whether it reported the map still stale. */
  let lastStderr = "";
  let lastStale: boolean | undefined;

  /** `ensureFreshMap` for the fixture, with stdout captured (stderr in `lastStderr`). */
  async function refresh(now?: () => number): Promise<string> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    const ewrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
    try {
      lastStale = await ensureFreshMap({ root: repo, now });
    } finally {
      log.mockRestore();
      write.mockRestore();
      ewrite.mockRestore();
      lastStderr = err.join("");
    }
    return out.join("");
  }

  beforeEach(async () => {
    backend = new FakeBackend();
    home = realpathSync(mkdtempSync(join(tmpdir(), "ix-freshness-home-")));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ix-freshness-repo-")));
    const endpoint = await backend.start();
    for (const k of [
      "HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_AUTO_MAP", "IX_MAP_EAGER",
      "IX_MAP_FULL_INGEST", "IX_MAP_DEADLINE_MS", "IX_MAP_REFRESH_DEBOUNCE_MS",
      "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS",
    ]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_HOME = join(home, ".ix");
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    mkdirSync(join(repo, "src"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(repo, "src", `m${i}.ts`), `export function f${i}(): number { return ${i}; }\n`, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
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

  it("makes no request at all without a marker", async () => {
    await map();
    backend.requests.length = 0;
    await refresh();
    expect(backend.requests).toEqual([]);
  });

  it("maps once when the marker is set, records the map and clears the marker", async () => {
    await deferred();
    expect(hasCompletedMapBaseline(repo)).toBe(false);
    rmSync(mapResultCachePath(repo), { force: true });

    expect(await refresh(), "nothing on stdout").toBe("");
    expect(backend.mapRequests()).toBe(1);
    expect(readMapStale(repo)).toBeNull();
    expect(hasCompletedMapBaseline(repo), "the map baseline is saved").toBe(true);
    expect(existsSync(mapResultCachePath(repo)), "the result is stored").toBe(true);
    expect(lastStale).toBe(false);
    expect(lastStderr, "a fresh map says nothing").toBe("");

    await refresh();
    expect(backend.mapRequests(), "a second call is a no-op").toBe(1);

    // And the next unchanged `ix map` reuses it rather than asking.
    await map();
    expect(backend.mapRequests()).toBe(1);
  });

  it("does not retry a failed refresh inside the debounce window", async () => {
    await deferred();
    backend.mapStatus = 500;
    let clock = 1_000_000;
    const now = () => clock;
    await refresh(now);
    expect(backend.mapRequests()).toBe(1);
    expect(readMapStale(repo)?.lastAttemptAt).toBe(1_000_000);

    backend.mapStatus = 200;
    clock += 10_000;
    await refresh(now);
    expect(backend.mapRequests(), "within 30 s of the attempt").toBe(1);
    expect(lastStderr, "a debounced reader still says the map is stale").toContain("architecture map is stale");

    clock += 30_000;
    await refresh(now);
    expect(backend.mapRequests(), "after the window").toBe(2);
    expect(readMapStale(repo)).toBeNull();
  });

  it("does nothing while another map holds the lock, and keeps the marker", async () => {
    await deferred();
    const marker = readMapStale(repo);
    const holder = acquireMapLock(repo, "holder")!;
    try {
      await refresh();
    } finally {
      holder.release();
    }
    expect(backend.requests).toEqual([]);
    expect(readMapStale(repo)).toEqual(marker);
    // The holder may be an incremental `ix map` that defers the map too, so
    // the reader must not pass its regions off as current.
    expect(lastStale).toBe(true);
    expect(lastStderr).toMatch(/^ix: architecture map is stale \(another ix map is running\)/);
    expect(lastStderr.trim().split("\n"), "one line").toHaveLength(1);
  });

  it("reads the marker again under the lock, and maps nothing a refresh just finished", async () => {
    await deferred();
    // A marker an earlier attempt left, outside the debounce window.
    const seen = readMapStale(repo)!;
    writeFileSync(mapStalePath(repo), JSON.stringify({ ...seen, lastAttemptAt: 1 }));
    // Between this reader's first look and its taking the lock, another
    // reader's refresh finishes and removes the marker. The clock is read
    // at that first look, so the race is staged there.
    let calls = 0;
    const now = () => {
      if (calls++ === 0) rmSync(mapStalePath(repo), { force: true });
      return 1_000_000;
    };
    await refresh(now);
    expect(backend.mapRequests(), "no second map for a refreshed map").toBe(0);
    expect(lastStale).toBe(false);
    expect(lastStderr).toBe("");
  });

  for (const [what, setUp] of [
    ["a map whose outcome is not a completed one", (b: FakeBackend) => { b.mapOutcome = "partial"; }],
    ["an empty map", (b: FakeBackend) => { b.emptyMap = true; }],
  ] as const) {
    it(`leaves the stored map, the baseline and the marker as they were after ${what}`, async () => {
      await deferred();
      const marker = readMapStale(repo)!;
      const stored = readFileSync(mapResultCachePath(repo), "utf8");
      setUp(backend);
      process.exitCode = undefined;
      await expect(refresh()).resolves.toBe("");
      expect(backend.mapRequests()).toBe(1);
      expect(process.exitCode).toBeUndefined();
      const kept = readMapStale(repo);
      expect(kept, "the marker stays").not.toBeNull();
      expect(kept?.since).toBe(marker.since);
      expect(kept?.ingestRev).toBe(marker.ingestRev);
      expect(typeof kept?.lastAttemptAt, "the attempt is recorded for the debounce").toBe("number");
      expect(readFileSync(mapResultCachePath(repo), "utf8"), "the last map is still stored").toBe(stored);
      expect(hasCompletedMapBaseline(repo), "no completed map is claimed").toBe(false);
      expect(lastStale).toBe(true);
      expect(lastStderr).toMatch(/architecture map is stale \(its refresh did not complete\)/);
    });
  }

  it("never throws or sets an exit code when the backend fails, and keeps the marker", async () => {
    await deferred();
    const since = readMapStale(repo)!.since;
    backend.mapStatus = 500;
    process.exitCode = undefined;
    await expect(refresh()).resolves.toBe("");
    expect(process.exitCode).toBeUndefined();
    const kept = readMapStale(repo);
    expect(kept?.since).toBe(since);
    expect(typeof kept?.lastAttemptAt).toBe("number");
    expect(lastStale).toBe(true);
    expect(lastStderr).toContain("architecture map is stale");
  });

  it("never throws or sets an exit code when the map times out", async () => {
    await deferred();
    process.env.IX_MAP_DEADLINE_MS = "200";
    backend.mapDelayMs = 2_000;
    process.exitCode = undefined;
    await expect(refresh()).resolves.toBe("");
    expect(process.exitCode).toBeUndefined();
    expect(readMapStale(repo)).not.toBeNull();
  });

  it("keeps a marker that was re-written while it mapped", async () => {
    await deferred();
    backend.onMap = () => markMapStale(repo, { since: Date.now() + 1, ingestRev: 999 });
    await refresh();
    expect(backend.mapRequests()).toBe(1);
    expect(readMapStale(repo)?.ingestRev, "a newer ingest's marker stays").toBe(999);
  });

  it("runs a coalesced map's rerun request and re-marks the map stale", async () => {
    await deferred();
    const late = "export const late = 2;\n";
    // An edit lands mid-refresh and its own `ix map` coalesces into the lock.
    backend.onMap = () => {
      writeFileSync(join(repo, "src", "m2.ts"), late, "utf8");
      requestMapRerun(repo);
    };
    process.exitCode = undefined;
    await refresh();
    expect(backend.mapRequests(), "the refresh asked once").toBe(1);
    expect(backend.hashes.get("src/m2.ts")?.hash, "the late edit reached the backend").toBe(hashOf(late));
    expect(readMapStale(repo), "the edit's map is deferred in turn").not.toBeNull();
    expect(takeMapRerun(repo), "and the request consumed").toBe(false);
    expect(process.exitCode).toBeUndefined();
    expect(lastStale, "the late edit left the map stale again").toBe(true);
  });

  it("makes no request for a workspace fed by a cloud runner", async () => {
    await deferred();
    registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => true });
    try {
      await refresh();
    } finally {
      registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => false });
    }
    expect(backend.requests).toEqual([]);
    expect(readMapStale(repo)).not.toBeNull();
  });

  it("treats a malformed marker as none", async () => {
    await map();
    mkdirSync(join(home, ".ix"), { recursive: true });
    writeFileSync(mapStalePath(repo), "{not json");
    expect(readMapStale(repo)).toBeNull();
    writeFileSync(mapStalePath(repo), JSON.stringify({ since: "yesterday", ingestRev: 1 }));
    expect(readMapStale(repo)).toBeNull();
    backend.requests.length = 0;
    await refresh();
    expect(backend.requests).toEqual([]);
  });
});

describe("mapRefreshDebounceMs", () => {
  it("defaults to 30 s, takes a plain number of ms, and 0 or empty for none", () => {
    expect(mapRefreshDebounceMs(undefined)).toBe(30_000);
    expect(mapRefreshDebounceMs("5000")).toBe(5_000);
    expect(mapRefreshDebounceMs("0")).toBe(0);
    expect(mapRefreshDebounceMs("")).toBe(0);
    expect(mapRefreshDebounceMs("30s"), "not a number of ms keeps the default").toBe(30_000);
  });
});
