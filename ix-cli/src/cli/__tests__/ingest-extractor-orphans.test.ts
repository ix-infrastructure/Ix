// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { ingestFiles } from "../commands/ingest.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { initialRepo, render } from "./helpers/edit-fixture.js";

/**
 * IN-20. An extractor change re-ingests every file with the same bytes, so the
 * hash is unchanged and nothing reconciled the nodes the old extractor wrote
 * and the new one does not: they stayed live with no edges, and file deletion
 * never reached them either. The previous extractor's patch is made here by the
 * current parser plus one extra node of a kind the current extractor does not
 * write ("ghost"), under PREVIOUS_EXTRACTORS[0]'s patch id.
 *
 * `shared.on` adds one more node, SHARED, with the same id in every file: the
 * old extractor writes it from every file, the current one from
 * pkg/service.py only. It is still emitted, so no sweep may delete it.
 */

const GHOST = "ghost";

/** A node id as the patch builder makes them: a UUID. */
function uuidOf(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const SHARED = uuidOf("shared-node");

const old = vi.hoisted(() => ({ on: false }));
const shared = vi.hoisted(() => ({ on: false }));

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, patchBuilder, languages] = await actual.loadIngestionModules();
      const sharedNode = { type: "UpsertNode", id: SHARED, kind: "function", name: "shared", attrs: {} };
      if (!old.on) {
        if (!shared.on) return [ingestion, patchBuilder, languages];
        return [ingestion, {
          ...patchBuilder,
          buildPatchWithResolution: (parsed: any, ...rest: any[]) => {
            const patch = (patchBuilder.buildPatchWithResolution as any)(parsed, ...rest);
            if (parsed.filePath === "pkg/service.py") patch.ops.push(sharedNode);
            return patch;
          },
        }, languages];
      }
      const previous = (patchBuilder as unknown as { PREVIOUS_EXTRACTORS: string[] }).PREVIOUS_EXTRACTORS[0]!;
      const asOldExtractor = {
        ...patchBuilder,
        extractorName: () => previous,
        buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, ...rest: any[]) => {
          const patch = (patchBuilder.buildPatchWithResolution as any)(parsed, hash, workspaceId, ...rest);
          patch.ops.push({ type: "UpsertNode", id: uuidOf(`ghost-${parsed.filePath}`), kind: GHOST, name: `ghost ${parsed.filePath}`, attrs: {} });
          if (shared.on) patch.ops.push(sharedNode);
          patch.patchId = patchBuilder.sourcePatchIdCandidates(parsed.filePath, hash, workspaceId)[1];
          return patch;
        },
      };
      return [ingestion, asOldExtractor, languages];
    },
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS",
  "IX_RECONCILE_ON_FORCE", "IX_ORPHAN_SWEEP_MAX_MS", "IX_ORPHAN_SWEEP_MAX_REQUESTS", "IX_BULK_DELETES",
] as const;

const FILES = ["pkg/util.py", "pkg/service.py", "web/math.ts"];

function ghosts(backend: FakeBackend): string[] {
  return backend.graphSignature().nodes.filter((line) => line.split(" ")[1] === GHOST);
}

describe.each(["head", "legacy"] as const)("an extractor change over the %s backend", (semantics) => {
  vi.setConfig({ testTimeout: 120_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-extractor-orphans-")));
  const repoDir = join(root, "repo");
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    writeFiles();
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function writeFiles(): void {
    for (const [p, fns] of initialRepo()) {
      if (!FILES.includes(p)) continue;
      mkdirSync(dirname(join(repoDir, p)), { recursive: true });
      writeFileSync(join(repoDir, p), render(p, fns), "utf8");
    }
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  }

  /** The run's stderr; `lastExitCode` holds the exit code it set. */
  let lastExitCode: number | string | undefined;

  /**
   * `reconcileOnForce` opts a --force run at the current extractor into the
   * same-hash reconcile (IX_RECONCILE_ON_FORCE=1); without it only an
   * extractor change runs it.
   */
  async function run(
    home: string,
    endpoint: string,
    { reconcileOnForce, ...extra }: { force?: boolean; debug?: boolean; reconcileOnForce?: boolean } = {},
  ): Promise<string> {
    mkdirSync(home, { recursive: true });
    if (reconcileOnForce) process.env.IX_RECONCILE_ON_FORCE = "1";
    else delete process.env.IX_RECONCILE_ON_FORCE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitCodeBefore = process.exitCode;
    process.exitCode = undefined;
    try {
      await ingestFiles(repoDir, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true, ...extra });
      return stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      lastExitCode = process.exitCode;
      process.exitCode = exitCodeBefore;
      stderr.mockRestore();
    }
  }

  async function mapAsOld(home: string, endpoint: string): Promise<void> {
    old.on = true;
    try {
      await run(home, endpoint);
    } finally {
      old.on = false;
    }
  }

  /** A backend that takes deletes in bulk and serves the batched node read. */
  function newBackend(): FakeBackend {
    const backend = new FakeBackend({ semantics });
    backend.releaseVersion = "1.0.34";
    return backend;
  }

  function deleteNodesSent(backend: FakeBackend): number {
    return FILES.reduce((n, f) => n + (backend.lastOps.get(f) ?? []).filter((op) => op["type"] === "DeleteNode").length, 0);
  }

  function sweepNotices(log: string): string[] {
    return log.split("\n").filter((line) => line.includes("[orphans kept]"));
  }

  function restoreAll(): void {
    for (const f of FILES) rmSync(join(repoDir, f), { force: true });
    writeFiles();
  }

  it("retires what the new extractor no longer writes, then everything of a deleted file", async () => {
    const current = (await loadIngestionModules())[1].extractorName();
    const backend = newBackend();
    const home = join(root, `home-rebuild-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      expect(ghosts(backend)).toHaveLength(FILES.length);

      const log = await run(home, endpoint);
      expect(log).toContain("[extractor changed]");
      expect(log).toContain(`-> ${current}`);
      expect(ghosts(backend)).toEqual([]);

      // Delete a file: nothing for it stays live.
      rmSync(join(repoDir, "pkg/util.py"));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
      await run(home, endpoint);
      expect(backend.graphSignature().nodes.filter((line) => line.includes("util.py"))).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("--force at the current extractor retires the dropped kind when its patch was never committed", async () => {
    const backend = newBackend();
    const home = join(root, `home-force-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      expect(ghosts(backend)).toHaveLength(FILES.length);
      await run(home, endpoint, { force: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("a graph a pre-fix rebuild polluted is cleaned when the file is deleted at the same hash", async () => {
    const backend = newBackend();
    const home = join(root, `home-polluted-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);

      // The rebuild as it was before the fix: the current patch lands, nothing reconciles.
      backend.hidePatchReads = true;
      const log = await run(home, endpoint);
      backend.hidePatchReads = false;
      expect(log).not.toContain("[patch build error]");
      expect(ghosts(backend)).toHaveLength(FILES.length);

      rmSync(join(repoDir, "web/math.ts"));
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
      await run(home, endpoint);
      expect(backend.graphSignature().nodes.filter((line) => line.includes("math.ts"))).toEqual([]);
      expect(ghosts(backend)).toHaveLength(FILES.length - 1);
    } finally {
      await backend.stop();
    }
  });

  it("--force repairs a graph whose current patch is already committed, under a salted patch id", async () => {
    const backend = newBackend();
    const home = join(root, `home-salted-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.hidePatchReads = true;
      await run(home, endpoint);
      backend.hidePatchReads = false;
      expect(ghosts(backend)).toHaveLength(FILES.length);

      // A plain --force at the current extractor leaves them: no reconcile, no reads.
      backend.patchReads = 0;
      await run(home, endpoint, { force: true });
      expect(backend.patchReads).toBe(0);
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true, reconcileOnForce: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("emits no DeleteNode on a later same-hash rebuild for a node an earlier reconcile already deleted", async () => {
    const backend = newBackend();
    const home = join(root, `home-redelete-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      await run(home, endpoint);
      expect(ghosts(backend)).toEqual([]);
      // The rebuild's reconcile deleted the ghosts, so its stored patch names
      // them as DeleteNode targets.
      for (const f of FILES) {
        expect(backend.lastOps.get(f)?.some((op) => op["type"] === "DeleteNode" && op["id"] === uuidOf(`ghost-${f}`))).toBe(true);
      }

      backend.resetRequests();
      const log = await run(home, endpoint, { force: true, reconcileOnForce: true });
      expect(log).not.toContain("[patch build error]");
      for (const f of FILES) {
        expect(backend.lastOps.get(f)?.filter((op) => op["type"] === "DeleteNode")).toEqual([]);
      }
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("commits a forced file whose old-extractor patch cannot be read, skipping only the orphan cleanup", async () => {
    const backend = newBackend();
    const home = join(root, `home-second5xx-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.hidePatchReads = true;
      await run(home, endpoint);
      backend.hidePatchReads = false;
      expect(ghosts(backend)).toHaveLength(FILES.length);

      // The current extractor's patch reads fine; only the old one, which
      // names the ghosts, fails.
      backend.failPatchReads = (_id, ops) => ops?.some((op) => op["kind"] === GHOST) ?? false;
      const log = await run(home, endpoint, { force: true, debug: true, reconcileOnForce: true });
      backend.failPatchReads = false;
      expect(log).not.toContain("[patch build error]");
      expect(log).toContain("[orphan reconcile skipped]");
      expect(lastExitCode ?? 0).toBe(0);
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true, reconcileOnForce: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("commits a rebuilt file whose stored patches are not found, without a patch build error", async () => {
    const backend = newBackend();
    const home = join(root, `home-besteffort-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.resetRequests();
      backend.hidePatchReads = true;
      const log = await run(home, endpoint);
      expect(log).not.toContain("[patch build error]");
      expect(backend.acceptedPatches()).toBe(FILES.length);
    } finally {
      await backend.stop();
    }
  });

  it("commits a rebuilt file whose stored patches answer 500, with one skip line, no parse error and exit code 0", async () => {
    const backend = newBackend();
    const home = join(root, `home-5xx-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.resetRequests();
      backend.failPatchReads = true;
      const log = await run(home, endpoint, { debug: true });
      backend.failPatchReads = false;
      expect(log).not.toContain("[patch build error]");
      expect(lastExitCode ?? 0).toBe(0);
      expect(backend.acceptedPatches()).toBe(FILES.length);
      for (const f of FILES) {
        expect(log.split("\n").filter((line) => line.includes(`[orphan reconcile skipped] ${f}:`))).toHaveLength(1);
      }
      // Best effort: the orphans stay until the next extractor change or an
      // opted-in --force.
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true, reconcileOnForce: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it.each([
    ["an older release", "1.0.31"],
    ["1.0.32, which applies bulk deletes but has no batched node read", "1.0.32"],
    ["no release (a dev or self-built image)", null],
  ] as const)("against %s: no sweep, no extra request, the patches as built, one notice", async (_label, release) => {
    const backend = new FakeBackend({ semantics });
    backend.releaseVersion = release;
    const home = join(root, `home-old-${semantics}-${String(release)}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      const singlesBefore = backend.singleCount;
      backend.resetRequests();
      backend.patchReads = 0;
      backend.nodesReads = 0;
      backend.entityReads = 0;
      const log = await run(home, endpoint);
      expect(log).toContain("[extractor changed]");
      expect(deleteNodesSent(backend)).toBe(0);
      expect(backend.patchReads).toBe(0);
      expect(backend.nodesReads).toBe(0);
      expect(backend.entityReads).toBe(0);
      expect(backend.singleCount).toBe(0);
      expect(singlesBefore).toBe(0);
      expect(backend.acceptedPatches()).toBe(FILES.length);
      const notices = sweepNotices(log);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(release === null ? "unversioned" : `release ${release}`);
      expect(ghosts(backend)).toHaveLength(FILES.length);
      expect(lastExitCode ?? 0).toBe(0);
    } finally {
      await backend.stop();
    }
  });

  it("deletes the orphans in the bulk commit, with one stored-patch read per file, one node read and no entity reads", async () => {
    const backend = newBackend();
    backend.bulkManifests = true;
    const home = join(root, `home-bulk-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.resetRequests();
      backend.patchReads = 0;
      backend.nodesReads = 0;
      backend.entityReads = 0;
      const log = await run(home, endpoint);
      expect(sweepNotices(log)).toEqual([]);
      expect(ghosts(backend)).toEqual([]);
      expect(deleteNodesSent(backend)).toBe(FILES.length);
      expect(backend.singleCount).toBe(0);
      expect(backend.bulkCount).toBeGreaterThan(0);
      expect(backend.patchReads).toBeLessThanOrEqual(FILES.length);
      expect(backend.nodesReads).toBe(1);
      expect(backend.entityReads).toBe(0);
    } finally {
      await backend.stop();
    }
  });

  it("never deletes a node another file still emits", async () => {
    const backend = newBackend();
    backend.bulkManifests = true;
    const home = join(root, `home-shared-${semantics}`);
    restoreAll();
    shared.on = true;
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      expect(backend.graphSignature().nodes.some((line) => line.startsWith(`${SHARED} `))).toBe(true);
      // One file per commit, so no delete can hide behind another patch's
      // upsert in the same bulk request.
      process.env.IX_COMMIT_HTTP_MAX_FILES = "1";
      try {
        await run(home, endpoint);
      } finally {
        delete process.env.IX_COMMIT_HTTP_MAX_FILES;
      }
      expect(ghosts(backend)).toEqual([]);
      expect(backend.graphSignature().nodes.some((line) => line.startsWith(`${SHARED} `))).toBe(true);
      for (const f of FILES) {
        expect(backend.lastOps.get(f)?.some((op) => op["type"] === "DeleteNode" && op["id"] === SHARED)).toBe(false);
      }
    } finally {
      shared.on = false;
      await backend.stop();
    }
  });

  it("stops at its budget: the files past it commit as built, counted in one line", async () => {
    const backend = newBackend();
    const home = join(root, `home-budget-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.patchReads = 0;
      process.env.IX_ORPHAN_SWEEP_MAX_REQUESTS = "1";
      let log: string;
      try {
        log = await run(home, endpoint);
      } finally {
        delete process.env.IX_ORPHAN_SWEEP_MAX_REQUESTS;
      }
      expect(backend.patchReads).toBe(1);
      const notices = sweepNotices(log);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(`${FILES.length - 1} file(s) were committed without it`);
      expect(ghosts(backend)).toHaveLength(FILES.length - 1);
      expect(backend.acceptedPatches()).toBeGreaterThanOrEqual(FILES.length);
      expect(lastExitCode ?? 0).toBe(0);
    } finally {
      await backend.stop();
    }
  });

  it("turns itself off for the run, with one notice, when the backend does not serve the batched node read", async () => {
    const backend = newBackend();
    backend.serveNodes = false;
    const home = join(root, `home-nonodes-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      const log = await run(home, endpoint);
      expect(sweepNotices(log)).toHaveLength(1);
      expect(sweepNotices(log)[0]).toContain("POST /v1/nodes");
      expect(deleteNodesSent(backend)).toBe(0);
      expect(ghosts(backend)).toHaveLength(FILES.length);
      expect(lastExitCode ?? 0).toBe(0);
    } finally {
      await backend.stop();
    }
  });
});

/**
 * The same-hash reconcile reads stored patches, so it must cost nothing where
 * no extractor changed: a plain --force made no patch reads before IN-20 and
 * an edited file made one, and both stay so.
 */
describe("the orphan reconcile's patch reads at an unchanged extractor", () => {
  vi.setConfig({ testTimeout: 120_000 });

  const COUNT = 200;
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-reconcile-cost-")));
  const repoDir = join(root, "repo");
  const home = join(root, "home");
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mkdirSync(join(repoDir, "pkg"), { recursive: true });
    for (let i = 0; i < COUNT; i++) {
      writeFileSync(join(repoDir, "pkg", `m${i}.py`), `def f${i}(x):\n    return x + ${i}\n`, "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
    mkdirSync(home, { recursive: true });
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function run(endpoint: string, force = false, runHome = home): Promise<void> {
    mkdirSync(runHome, { recursive: true });
    process.env.HOME = runHome;
    process.env.USERPROFILE = runHome;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(runHome, "locks");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitCodeBefore = process.exitCode;
    try {
      await ingestFiles(repoDir, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true, force });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      process.exitCode = exitCodeBefore;
      stderr.mockRestore();
    }
  }

  it("an extractor upgrade over 200 files makes at most one stored-patch read per file, one node read per batch and no entity reads", async () => {
    const backend = new FakeBackend({ semantics: "head" });
    backend.bulkManifests = true;
    try {
      const endpoint = await backend.start();
      const upgradeHome = join(root, "home-upgrade");
      old.on = true;
      try {
        await run(endpoint, false, upgradeHome);
      } finally {
        old.on = false;
      }
      expect(backend.graphSignature().nodes.filter((line) => line.split(" ")[1] === GHOST)).toHaveLength(COUNT);
      backend.patchReads = 0;
      backend.nodesReads = 0;
      backend.entityReads = 0;
      const bulksBefore = backend.bulkCount;
      await run(endpoint, false, upgradeHome);
      expect(backend.patchReads).toBeLessThanOrEqual(COUNT);
      expect(backend.entityReads).toBe(0);
      // One batched node read per build batch that had candidates, and no
      // more batches than bulk commits.
      expect(backend.nodesReads).toBeGreaterThanOrEqual(1);
      expect(backend.nodesReads).toBeLessThanOrEqual(backend.bulkCount - bulksBefore);
      expect(backend.singleCount).toBe(0);
      expect(backend.graphSignature().nodes.filter((line) => line.split(" ")[1] === GHOST)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("makes no patch reads on a plain --force over 200 files, and one for a single edited file", async () => {
    const backend = new FakeBackend({ semantics: "head" });
    try {
      const endpoint = await backend.start();
      await run(endpoint);
      expect(backend.acceptedPatches()).toBe(COUNT);

      backend.patchReads = 0;
      await run(endpoint, true);
      expect(backend.patchReads).toBe(0);

      writeFileSync(join(repoDir, "pkg", "m7.py"), "def f7(x):\n    return x * 7\n", "utf8");
      backend.patchReads = 0;
      await run(endpoint);
      expect(backend.patchReads).toBe(1);
    } finally {
      await backend.stop();
    }
  });
});
