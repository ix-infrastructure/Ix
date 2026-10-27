// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { ingestFiles } from "../commands/ingest.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { FakeBackend } from "./helpers/fake-backend.js";

/**
 * tree-sitter/1.31 adds Python receiver-type facts and package resolution.
 * A Python graph built by 1.30 has neither, and
 * an unchanged file keeps its patch and summary until the extractor changes.
 * This checks that the extractor change alone brings such a graph to what a
 * fresh map writes, typed edges included (see `ingest-extractor-bump.test.ts`).
 *
 * The 1.30 graph is made by the current parser with Python receiver facts
 * stripped from every parse result and summary, under the 1.30 extractor name
 * and patch ids.
 */

const OLD_EXTRACTOR = "tree-sitter/1.30";

const legacy = vi.hoisted(() => ({ on: false }));

vi.mock("../commands/ingestion-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/ingestion-loader.js")>();
  /** Approximate legacy Python extraction; other languages keep their facts. */
  const strip = (parsed: any): any => {
    if (!parsed || parsed.language !== 'python' || !Array.isArray(parsed.relationships)) return parsed;
    parsed.relationships = parsed.relationships.filter((r: any) => !r.receiverOnly);
    for (const r of parsed.relationships) { delete r.receiverType; delete r.receiverFactory; }
    delete parsed.receiverPackage; delete parsed.receiverFactories; delete parsed.receiverHeritage;
    return parsed;
  };
  return {
    ...actual,
    loadIngestionModules: async () => {
      const [ingestion, patchBuilder, languages] = await actual.loadIngestionModules();
      if (!legacy.on) return [ingestion, patchBuilder, languages];
      const asOldIngestion = {
        ...ingestion,
        parseFile: (...args: any[]) => strip((ingestion.parseFile as any)(...args)),
        summarizeParseResult: (parsed: any) => strip((ingestion.summarizeParseResult as any)(strip(parsed))),
        resolveEdges: (results: any[], ...rest: any[]) => (ingestion.resolveEdges as any)(results.map(strip), ...rest),
      };
      const asOldExtractor = {
        ...patchBuilder,
        extractorName: () => OLD_EXTRACTOR,
        buildPatchWithResolution: (parsed: any, hash: string, workspaceId: string, ...rest: any[]) => {
          const patch = (patchBuilder.buildPatchWithResolution as any)(strip(parsed), hash, workspaceId, ...rest);
          patch.patchId = patchBuilder.sourcePatchIdCandidates(parsed.filePath, hash, workspaceId)[
            (patchBuilder as unknown as { PREVIOUS_EXTRACTORS: string[] }).PREVIOUS_EXTRACTORS.indexOf(OLD_EXTRACTOR) + 1
          ];
          return patch;
        },
      };
      return [asOldIngestion, asOldExtractor, languages];
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

/** Typed receivers whose member name alone is ambiguous, in each language. */
const SOURCES: Record<string, string> = {
  "ts/dep.ts": "export class Dep { run() {} }\nexport class Other { run() {} }\n",
  "ts/use.ts": "import { Dep } from './dep';\nexport function use(d: Dep) { d.run(); }\n",
  "go/types.go": "package p\n\ntype Target struct{}\n",
  "go/methods.go": "package p\n\nfunc (t Target) Run() {}\n\ntype Other struct{}\n\nfunc (o Other) Run() {}\n",
  "go/use.go": "package p\n\nfunc use(t Target) { t.Run() }\n",
  "scala/model.scala": "package model\nclass Target { def run() = () }\nclass Other { def run() = () }\n",
  "scala/use.scala": "import model.Target\nobject Use { def use(d: Target) = d.run() }\n",
  "src/pkg/model.py": "class Target:\n    def run(self): pass\nclass Other:\n    def run(self): pass\n",
  "src/pkg/use.py": "from .model import Target\nclass Service:\n    def __init__(self):\n        self.dep = Target()\n    def execute(self):\n        self.dep.run()\n",
};

describe("the tree-sitter/1.31 extractor bump", () => {
  vi.setConfig({ testTimeout: 120_000 });

  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-receiver-bump-")));
  const repoDir = join(root, "repo");
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mkdirSync(repoDir);
    execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });
    for (const [p, text] of Object.entries(SOURCES)) {
      mkdirSync(dirname(join(repoDir, p)), { recursive: true });
      writeFileSync(join(repoDir, p), text, "utf8");
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

  it("re-ingests a 1.30 graph once and gains the fresh map's Python edges", async () => {
    const current = (await loadIngestionModules())[1].extractorName();
    const backend = new FakeBackend({ semantics: "head" });
    const fresh = new FakeBackend({ semantics: "head" });
    const home = join(root, "home");
    try {
      const endpoint = await backend.start();
      await map(join(root, "fresh-home"), await fresh.start());
      // One typed edge per language.
      expect(fresh.edgesOfTier("type"), "the fresh map").toHaveLength(4);

      legacy.on = true;
      await map(home, endpoint);
      legacy.on = false;
      expect(backend.edgesOfTier("type"), "the 1.30 graph").toHaveLength(3);
      expect(backend.graphSignature().edges).not.toEqual(fresh.graphSignature().edges);

      backend.resetRequests();
      const log = await map(home, endpoint);
      expect(log).toContain(`[extractor changed] ${OLD_EXTRACTOR} -> ${current}`);
      expect(backend.acceptedPatches(), "every file re-ingested").toBe(Object.keys(SOURCES).length);
      expect(backend.graphSignature()).toEqual(fresh.graphSignature());
      expect(backend.edgesOfTier("type")).toEqual(fresh.edgesOfTier("type"));

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
