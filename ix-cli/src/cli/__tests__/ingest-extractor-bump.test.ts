// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { initialRepo, render, type Repo } from "./helpers/edit-fixture.js";

/**
 * tree-sitter/1.28 stops writing an edge whose destination has no node, so a
 * graph built by 1.27 holds edges no fresh map would write. `ix map` re-ingests
 * every file once when the extractor changes; this checks that the re-ingest
 * takes those edges with it, against the fake backend with the real backend's
 * commit semantics (see `ingest-equivalence.test.ts`).
 *
 * The 1.27 graph is made by the current parser with 1.27's two differences
 * put back: the extractor name (so the patch ids and the baseline say 1.27),
 * and a CALLS edge to `nodeId(file, callee)` -- an id no patch writes -- for
 * every call that resolved to nothing, which is what 1.27 wrote for them.
 */

const OLD_EXTRACTOR = "tree-sitter/1.27";

const legacy = vi.hoisted(() => ({ on: false }));

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, patchBuilder, languages] = await actual.loadIngestionModules();
      if (!legacy.on) return [ingestion, patchBuilder, languages];
      const asOldExtractor = {
        ...patchBuilder,
        extractorName: () => OLD_EXTRACTOR,
        buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, ...rest: any[]) => {
          const patch = (patchBuilder.buildPatchWithResolution as any)(parsed, hash, workspaceId, ...rest);
          const dangling: unknown[] = [];
          for (const op of patch.ops) {
            const names = op.type === "UpsertNode" ? op.attrs?.unresolved_calls : undefined;
            if (!Array.isArray(names)) continue;
            delete op.attrs.unresolved_calls;
            delete op.attrs.unresolved_call_count;
            for (const name of names) {
              dangling.push({
                type: "UpsertEdge", id: `old-${op.id}-${name}`, src: op.id,
                dst: patchBuilder.symbolNodeId(workspaceId, parsed.filePath, name), predicate: "CALLS", attrs: {},
              });
            }
          }
          patch.ops.push(...dangling);
          // The id 1.27 gave this file and content: the first previous extractor.
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

/** The fixture, plus calls in every language to names defined nowhere. */
function repoWithUnresolvedCalls(): Repo {
  const repo = initialRepo();
  for (const [path, fns] of repo) {
    fns[0]!.calls.push({ path, name: "notDefinedAnywhere" });
  }
  return repo;
}

/** Live edges with an end that is not a live node. */
function danglingEdges(backend: FakeBackend): string[] {
  const { nodes, edges } = backend.graphSignature();
  const live = new Set(nodes.map((line) => line.split(" ")[0]));
  return edges.filter((line) => {
    const [, src, dst] = line.split(" ");
    return !live.has(src!) || !live.has(dst!);
  });
}

describe("the tree-sitter/1.28 extractor bump", () => {
  vi.setConfig({ testTimeout: 120_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-extractor-bump-")));
  const repoDir = join(root, "repo");
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    for (const [p, fns] of repoWithUnresolvedCalls()) {
      mkdirSync(dirname(join(repoDir, p)), { recursive: true });
      writeFileSync(join(repoDir, p), render(p, fns), "utf8");
    }
    execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "ignore" });
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function map(home: string, endpoint: string): Promise<string> {
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await ingestFiles(repoDir, { recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true });
      return stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    } finally {
      stderr.mockRestore();
    }
  }

  it("re-ingests a 1.27 graph once and leaves no edge without both ends", async () => {
    const current = (await loadIngestionModules())[1].extractorName();
    const backend = new FakeBackend({ semantics: "head" });
    const fresh = new FakeBackend({ semantics: "head" });
    const home = join(root, "home");
    try {
      const endpoint = await backend.start();

      legacy.on = true;
      await map(home, endpoint);
      legacy.on = false;
      // 12 files, one call to a missing name in each.
      expect(danglingEdges(backend), "the 1.27 graph").toHaveLength(12);

      backend.resetRequests();
      const log = await map(home, endpoint);
      expect(log).toContain(`[extractor changed] ${OLD_EXTRACTOR} -> ${current}`);
      expect(backend.acceptedPatches(), "every file re-ingested").toBe(12);
      expect(danglingEdges(backend)).toEqual([]);

      // The same graph a fresh map writes, edges and all.
      await map(join(root, "fresh-home"), await fresh.start());
      expect(backend.graphSignature().edges).toEqual(fresh.graphSignature().edges);

      // Once: the next map has nothing to do.
      backend.resetRequests();
      expect(await map(home, endpoint)).not.toContain("[extractor changed]");
      expect(backend.acceptedPatches()).toBe(0);
    } finally {
      legacy.on = false;
      await backend.stop();
      await fresh.stop();
    }
  });
});
