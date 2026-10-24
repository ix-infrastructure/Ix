// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Command } from "commander";

import { registerMapCommand } from "../commands/map.js";
import { canonicalWorkspacePath, mapResultCachePath, mapStalePath } from "../config.js";
import {
  ensureFreshMap,
  MAP_REFRESH_ARG,
  mapBackgroundRefreshEnabled,
  mapBackgroundTimeoutMs,
  mapRefreshDebounceMs,
  mapRefreshInvocation,
  markMapStale,
  readMapRefreshOutcome,
  readMapStale,
  runBackgroundMapRefresh,
  type MapRefreshOutcome,
} from "../map-freshness.js";
import { acquireMapLock, lockPathForTest, mapLockHeld, requestMapRerun, takeMapRerun } from "../single-flight.js";
import { hasCompletedMapBaseline } from "../stale.js";
import { registerRemoteRunner } from "../remote.js";

/**
 * The lazy half of a deferred `ix map` (CL-13). These drive the real `ix map`
 * against a fake backend to get a deferred map, then check the two halves:
 *
 * - `ensureFreshMap`, run by every region view: never maps inline, answers
 *   at once, and starts at most one background refresh (the spawner is
 *   injected; no test starts a real process);
 * - `runBackgroundMapRefresh`, what that detached process runs: at most one
 *   `/v1/map` under the map lock, the outcome recorded, and never the
 *   caller's exit code.
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

describe("map refresh", () => {
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

  /**
   * A mapped repo whose last `ix map` deferred the map after an edit: an
   * automatic one (IX_AUTO_MAP=1, as the hooks run it), since only those defer.
   */
  async function deferred(): Promise<void> {
    await map();
    writeFileSync(join(repo, "src", "m9.ts"), "export const nine = 9;\n", "utf8");
    process.env.IX_AUTO_MAP = "1";
    try { await map(); } finally { delete process.env.IX_AUTO_MAP; }
    expect(readMapStale(repo), "the edit's map was deferred").not.toBeNull();
    backend.requests.length = 0;
  }

  /** Captures stdout and stderr around `fn`. */
  async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { out.push(String(chunk)); return true; });
    const ewrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { err.push(String(chunk)); return true; });
    try {
      const value = await fn();
      return { value, out: out.join(""), err: err.join("") };
    } finally {
      log.mockRestore();
      write.mockRestore();
      ewrite.mockRestore();
    }
  }

  /** Roots the injected spawner was asked to refresh. */
  let spawned: string[] = [];
  /** What the injected spawner does besides recording; nothing by default. */
  let onSpawn: (root: string) => void = () => {};

  /** A region view's `ensureFreshMap` for the fixture. */
  async function read(now?: () => number) {
    const r = await captured(() => ensureFreshMap({
      root: repo,
      now,
      spawn: (root) => { spawned.push(root); onSpawn(root); },
    }));
    return { stale: r.value, out: r.out, err: r.err };
  }

  /** The detached child's work, run in-process. */
  async function child(opts: Parameters<typeof runBackgroundMapRefresh>[1] = {}) {
    const r = await captured(() => runBackgroundMapRefresh(repo, opts));
    return { outcome: r.value, out: r.out, err: r.err };
  }

  beforeEach(async () => {
    backend = new FakeBackend();
    spawned = [];
    onSpawn = () => {};
    home = realpathSync(mkdtempSync(join(tmpdir(), "ix-freshness-home-")));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "ix-freshness-repo-")));
    const endpoint = await backend.start();
    for (const k of [
      "HOME", "USERPROFILE", "IX_HOME", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_AUTO_MAP", "IX_MAP_EAGER",
      "IX_MAP_FULL_INGEST", "IX_MAP_DEADLINE_MS", "IX_MAP_REFRESH_DEBOUNCE_MS",
      "IX_MAP_BACKGROUND_REFRESH", "IX_MAP_BACKGROUND_TIMEOUT_MS",
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

  describe("ensureFreshMap (the reader)", () => {
    it("makes no request and starts nothing without a marker", async () => {
      await map();
      backend.requests.length = 0;
      const r = await read();
      expect(r.stale).toBe(false);
      expect(r.err).toBe("");
      expect(backend.requests).toEqual([]);
      expect(spawned).toEqual([]);
    });

    it("answers at once, maps nothing inline, and starts one background refresh", async () => {
      await deferred();
      const r = await read(() => 1_000_000);
      expect(r.stale).toBe(true);
      expect(r.out, "nothing on stdout").toBe("");
      expect(backend.mapRequests(), "no /v1/map from the reader").toBe(0);
      // The canonical root, which on Windows CI is the long form of the
      // 8.3 temp path (RUNNER~1) that `realpathSync` leaves as it is.
      expect(spawned).toEqual([canonicalWorkspacePath(repo)]);
      expect(r.err).toBe("ix: architecture map is stale (refreshing in background); regions shown may predate recent edits. Run ix map --remap to refresh.\n");
      expect(readMapStale(repo)?.lastAttemptAt, "the start is recorded for the debounce").toBe(1_000_000);
      expect(mapLockHeld(repo), "the reader does not keep the lock").toBe(false);
    });

    it("returns without waiting for the refresh it started", async () => {
      await deferred();
      // A map slower than any hook budget, run as the child would run it.
      backend.mapDelayMs = 3_000;
      let running: Promise<unknown> | undefined;
      onSpawn = (root) => { running = runBackgroundMapRefresh(root); };
      const t0 = Date.now();
      const r = await read();
      const took = Date.now() - t0;
      expect(r.stale).toBe(true);
      expect(took, "the reader did not wait for the 3 s map").toBeLessThan(2_000);
      expect(readMapStale(repo), "the refresh has not finished yet").not.toBeNull();

      // Meanwhile another reader sees the refresh holding the lock.
      await new Promise(resolve => setTimeout(resolve, 200));
      const second = await read(() => Date.now() + 60_000);
      expect(second.err).toMatch(/\(another ix map is running\)/);
      expect(spawned, "and starts no second one").toHaveLength(1);

      const outcome = await running as MapRefreshOutcome;
      expect(outcome.ok).toBe(true);
      expect(readMapStale(repo), "it cleared the marker").toBeNull();
      expect(hasCompletedMapBaseline(repo)).toBe(true);
      expect(backend.mapRequests()).toBe(1);
    });

    it("starts no refresh inside the debounce window, and one after it", async () => {
      await deferred();
      let clock = 1_000_000;
      const now = () => clock;
      await read(now);
      expect(spawned).toHaveLength(1);

      clock += 10_000;
      const debounced = await read(now);
      expect(spawned, "within 30 s of the start").toHaveLength(1);
      expect(debounced.stale).toBe(true);
      expect(debounced.err).toMatch(/^ix: architecture map is stale \(a refresh was tried moments ago\)/);

      clock += 30_000;
      await read(now);
      expect(spawned, "after the window").toHaveLength(2);
      expect(backend.mapRequests()).toBe(0);
    });

    it("starts no refresh while another process holds the map lock, and keeps the marker", async () => {
      await deferred();
      const marker = readMapStale(repo);
      const holder = acquireMapLock(repo, "holder")!;
      let r;
      try {
        r = await read();
      } finally {
        holder.release();
      }
      expect(spawned).toEqual([]);
      expect(backend.requests).toEqual([]);
      expect(readMapStale(repo)).toEqual(marker);
      expect(r.stale).toBe(true);
      expect(r.err).toMatch(/^ix: architecture map is stale \(another ix map is running\)/);
      expect(r.err.trim().split("\n"), "one line").toHaveLength(1);
    });

    it("says why when the last background refresh failed and the retry is debounced", async () => {
      await deferred();
      backend.mapStatus = 500;
      await child({ now: () => 1_000_000 });
      const r = await read(() => 1_000_000 + 5_000);
      expect(spawned).toEqual([]);
      expect(r.err).toMatch(/^ix: architecture map is stale \(its last background refresh failed\)/);
    });

    it("never refreshes with IX_MAP_BACKGROUND_REFRESH=0, and says the map is stale", async () => {
      await deferred();
      process.env.IX_MAP_BACKGROUND_REFRESH = "0";
      const r = await read();
      expect(spawned).toEqual([]);
      expect(backend.requests).toEqual([]);
      expect(r.stale).toBe(true);
      expect(r.err).toMatch(/^ix: architecture map is stale \(background refresh is off\)/);
      expect(readMapStale(repo)?.lastAttemptAt, "nothing was attempted").toBeUndefined();
    });

    it("never throws or sets an exit code when the refresh cannot start", async () => {
      await deferred();
      onSpawn = () => { throw new Error("EAGAIN"); };
      process.exitCode = undefined;
      const r = await read();
      expect(r.stale).toBe(true);
      expect(r.err).toMatch(/\(its refresh could not start\)/);
      expect(process.exitCode).toBeUndefined();
    });

    it("reads the marker again under the lock, and starts nothing for a map just refreshed", async () => {
      await deferred();
      const seen = readMapStale(repo)!;
      writeFileSync(mapStalePath(repo), JSON.stringify({ ...seen, lastAttemptAt: 1 }));
      // Between this reader's first look and its taking the lock, a refresh
      // finishes and removes the marker. The debounce reads the clock at that
      // first look, so the race is staged there.
      let calls = 0;
      const r = await read(() => {
        if (calls++ === 0) rmSync(mapStalePath(repo), { force: true });
        return 1_000_000;
      });
      expect(spawned).toEqual([]);
      expect(r.stale).toBe(false);
      expect(r.err).toBe("");
    });

    it("starts nothing for a workspace fed by a cloud runner", async () => {
      await deferred();
      registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => true });
      try {
        await read();
      } finally {
        registerRemoteRunner({ runIngestion: async () => {}, isReady: async () => false });
      }
      expect(spawned).toEqual([]);
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
      await read();
      expect(backend.requests).toEqual([]);
      expect(spawned).toEqual([]);
    });
  });

  describe("runBackgroundMapRefresh (the detached child)", () => {
    it("maps once when the marker is set, records the map, clears the marker and the outcome", async () => {
      await deferred();
      expect(hasCompletedMapBaseline(repo)).toBe(false);
      rmSync(mapResultCachePath(repo), { force: true });

      const r = await child();
      expect(r.out, "nothing on stdout").toBe("");
      expect(backend.mapRequests()).toBe(1);
      expect(readMapStale(repo)).toBeNull();
      expect(hasCompletedMapBaseline(repo), "the map baseline is saved").toBe(true);
      expect(existsSync(mapResultCachePath(repo)), "the result is stored").toBe(true);
      expect(r.outcome).toMatchObject({ ok: true, pid: process.pid });
      expect(readMapRefreshOutcome(repo)).toEqual(r.outcome);
      expect(mapLockHeld(repo), "the lock is let go").toBe(false);

      expect((await child()).outcome, "a second run is a no-op").toBeNull();
      expect(backend.mapRequests()).toBe(1);

      // And the next unchanged `ix map` reuses it rather than asking.
      await map();
      expect(backend.mapRequests()).toBe(1);
    });

    it("refreshes a root named under another spelling of the same directory", async () => {
      // Windows CI names the temp dir C:\Users\RUNNER~1\... (an 8.3 short name),
      // while `ix map` stores the long, canonical root in its baselines. A
      // junction (a symlink on POSIX) is the same mismatch on any platform.
      await deferred();
      const alias = join(home, "repo-alias");
      symlinkSync(repo, alias, "junction");
      expect(hasCompletedMapBaseline(alias), "an alias reads the same ingest baseline").toBe(false);

      const outcome = await runBackgroundMapRefresh(alias);
      expect(backend.mapRequests()).toBe(1);
      expect(outcome?.ok).toBe(true);
      expect(readMapStale(repo)).toBeNull();
      expect(hasCompletedMapBaseline(repo)).toBe(true);
      expect(hasCompletedMapBaseline(alias), "and the alias sees the map as complete").toBe(true);
    });

    it("does nothing while another process holds the map lock", async () => {
      await deferred();
      const marker = readMapStale(repo);
      const holder = acquireMapLock(repo, "holder")!;
      try {
        expect((await child()).outcome).toBeNull();
      } finally {
        holder.release();
      }
      expect(backend.requests).toEqual([]);
      expect(readMapStale(repo)).toEqual(marker);
      expect(readMapRefreshOutcome(repo)).toBeNull();
    });

    for (const [what, setUp, reason] of [
      ["a map whose outcome is not a completed one", (b: FakeBackend) => { b.mapOutcome = "partial"; }, /the map did not complete: outcome partial/],
      ["an empty map", (b: FakeBackend) => { b.emptyMap = true; }, /the map did not complete/],
    ] as const) {
      it(`leaves the stored map, the baseline and the marker as they were after ${what}`, async () => {
        await deferred();
        const marker = readMapStale(repo)!;
        const stored = readFileSync(mapResultCachePath(repo), "utf8");
        setUp(backend);
        process.exitCode = undefined;
        const r = await child();
        expect(r.out).toBe("");
        expect(backend.mapRequests()).toBe(1);
        expect(process.exitCode).toBeUndefined();
        const kept = readMapStale(repo);
        expect(kept, "the marker stays").not.toBeNull();
        expect(kept?.since).toBe(marker.since);
        expect(kept?.ingestRev).toBe(marker.ingestRev);
        expect(readFileSync(mapResultCachePath(repo), "utf8"), "the last map is still stored").toBe(stored);
        expect(hasCompletedMapBaseline(repo), "no completed map is claimed").toBe(false);
        expect(r.outcome?.ok).toBe(false);
        expect(r.outcome?.reason).toMatch(reason);
        expect(readMapRefreshOutcome(repo)).toEqual(r.outcome);
      });
    }

    it("records a failed request, never throws or sets an exit code, and keeps the marker", async () => {
      await deferred();
      const since = readMapStale(repo)!.since;
      backend.mapStatus = 500;
      process.exitCode = undefined;
      const r = await child();
      expect(process.exitCode).toBeUndefined();
      expect(readMapStale(repo)?.since).toBe(since);
      expect(r.outcome?.ok).toBe(false);
      expect(r.outcome?.reason).toMatch(/^the map request failed: /);
      expect(r.outcome?.reason, "one line").not.toContain("\n");
    });

    it("stops at its hard time limit, records why, and lets the lock go", async () => {
      await deferred();
      backend.mapDelayMs = 5_000;
      process.exitCode = undefined;
      const t0 = Date.now();
      const r = await child({ timeoutMs: 300 });
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(r.outcome).toMatchObject({ ok: false, reason: "timed out after 0.3 s" });
      expect(readMapStale(repo), "the marker stays").not.toBeNull();
      expect(mapLockHeld(repo)).toBe(false);
      expect(process.exitCode).toBeUndefined();
    });

    it("keeps a marker that was re-written while it mapped", async () => {
      await deferred();
      backend.onMap = () => markMapStale(repo, { since: Date.now() + 1, ingestRev: 999 });
      const r = await child();
      expect(backend.mapRequests()).toBe(1);
      expect(readMapStale(repo)?.ingestRev, "a newer ingest's marker stays").toBe(999);
      expect(r.outcome).toMatchObject({ ok: true, reason: expect.stringMatching(/files changed while it was refreshed/) });
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
      await child();
      expect(backend.mapRequests(), "the refresh asked once").toBe(1);
      expect(backend.hashes.get("src/m2.ts")?.hash, "the late edit reached the backend").toBe(hashOf(late));
      expect(readMapStale(repo), "the edit's map is deferred in turn").not.toBeNull();
      expect(takeMapRerun(repo), "and the request consumed").toBe(false);
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe("mapRefreshInvocation", () => {
  it("starts the same Node and CLI entry, detached, with no shell, no stdio and no window", async () => {
    const inv = await mapRefreshInvocation("/w/repo", "/opt/ix/dist/cli/main.js", ["--inspect"]);
    expect(inv.command).toBe(process.execPath);
    expect(inv.args, "debugger flags are not cloned").toEqual(["/opt/ix/dist/cli/main.js", MAP_REFRESH_ARG, "/w/repo"]);
    expect(inv.options).toMatchObject({ cwd: "/w/repo", detached: true, stdio: "ignore", windowsHide: true, shell: false });
  });

  it("keeps the source loader of a TypeScript entry", async () => {
    const inv = await mapRefreshInvocation("/w/repo", "/src/cli/main.ts", ["--import", "tsx"]);
    expect(inv.args).toEqual(["--import", "tsx", "/src/cli/main.ts", MAP_REFRESH_ARG, "/w/repo"]);
  });
});

describe("refresh settings", () => {
  it("mapRefreshDebounceMs defaults to 30 s, takes a plain number of ms, and 0 or empty for none", () => {
    expect(mapRefreshDebounceMs(undefined)).toBe(30_000);
    expect(mapRefreshDebounceMs("5000")).toBe(5_000);
    expect(mapRefreshDebounceMs("0")).toBe(0);
    expect(mapRefreshDebounceMs("")).toBe(0);
    expect(mapRefreshDebounceMs("30s"), "not a number of ms keeps the default").toBe(30_000);
  });

  it("mapBackgroundRefreshEnabled is on unless set to 0", () => {
    expect(mapBackgroundRefreshEnabled({})).toBe(true);
    expect(mapBackgroundRefreshEnabled({ IX_MAP_BACKGROUND_REFRESH: "1" })).toBe(true);
    expect(mapBackgroundRefreshEnabled({ IX_MAP_BACKGROUND_REFRESH: "0" })).toBe(false);
    expect(mapBackgroundRefreshEnabled({ IX_MAP_BACKGROUND_REFRESH: " 0 " })).toBe(false);
  });

  it("mapBackgroundTimeoutMs defaults to 5 min and takes a plain positive number of ms", () => {
    expect(mapBackgroundTimeoutMs(undefined)).toBe(300_000);
    expect(mapBackgroundTimeoutMs("60000")).toBe(60_000);
    expect(mapBackgroundTimeoutMs("0")).toBe(300_000);
    expect(mapBackgroundTimeoutMs("5m")).toBe(300_000);
  });
});
