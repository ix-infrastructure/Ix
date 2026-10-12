// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

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
 */

const GHOST = "ghost";

const old = vi.hoisted(() => ({ on: false }));

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, patchBuilder, languages] = await actual.loadIngestionModules();
      if (!old.on) return [ingestion, patchBuilder, languages];
      const previous = (patchBuilder as unknown as { PREVIOUS_EXTRACTORS: string[] }).PREVIOUS_EXTRACTORS[0]!;
      const asOldExtractor = {
        ...patchBuilder,
        extractorName: () => previous,
        buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, ...rest: any[]) => {
          const patch = (patchBuilder.buildPatchWithResolution as any)(parsed, hash, workspaceId, ...rest);
          patch.ops.push({ type: "UpsertNode", id: `ghost-${parsed.filePath}`, kind: GHOST, name: `ghost ${parsed.filePath}`, attrs: {} });
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

  async function run(home: string, endpoint: string, extra: { force?: boolean; debug?: boolean } = {}): Promise<string> {
    mkdirSync(home, { recursive: true });
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

  function restoreAll(): void {
    for (const f of FILES) rmSync(join(repoDir, f), { force: true });
    writeFiles();
  }

  it("retires what the new extractor no longer writes, then everything of a deleted file", async () => {
    const current = (await loadIngestionModules())[1].extractorName();
    const backend = new FakeBackend({ semantics });
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
    const backend = new FakeBackend({ semantics });
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
    const backend = new FakeBackend({ semantics });
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
    const backend = new FakeBackend({ semantics });
    const home = join(root, `home-salted-${semantics}`);
    restoreAll();
    try {
      const endpoint = await backend.start();
      await mapAsOld(home, endpoint);
      backend.hidePatchReads = true;
      await run(home, endpoint);
      backend.hidePatchReads = false;
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("emits no DeleteNode on a later same-hash rebuild for a node an earlier reconcile already deleted", async () => {
    const backend = new FakeBackend({ semantics });
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
        expect(backend.lastOps.get(f)?.some((op) => op["type"] === "DeleteNode" && String(op["id"]).startsWith("ghost-"))).toBe(true);
      }

      backend.resetRequests();
      const log = await run(home, endpoint, { force: true });
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
    const backend = new FakeBackend({ semantics });
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
      const log = await run(home, endpoint, { force: true, debug: true });
      backend.failPatchReads = false;
      expect(log).not.toContain("[patch build error]");
      expect(log).toContain("[orphan reconcile skipped]");
      expect(lastExitCode ?? 0).toBe(0);
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });

  it("commits a rebuilt file whose stored patches are not found, without a patch build error", async () => {
    const backend = new FakeBackend({ semantics });
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
    const backend = new FakeBackend({ semantics });
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
      // Best effort: the orphans stay until the next rebuild or --force.
      expect(ghosts(backend)).toHaveLength(FILES.length);

      await run(home, endpoint, { force: true });
      expect(ghosts(backend)).toEqual([]);
    } finally {
      await backend.stop();
    }
  });
});
