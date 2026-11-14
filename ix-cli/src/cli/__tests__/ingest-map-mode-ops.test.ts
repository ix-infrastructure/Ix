// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { applyIngestMode, ingestFiles, stripMapModeOps } from "../commands/ingest.js";
import { mapModeForIngest } from "../commands/map.js";
import { loadIngestionModules } from "../commands/ingestion-loader.js";
import { loadIngestBaseline } from "../ingest-baseline.js";
import { ingestMtimeCachePath } from "../config.js";
import type { GraphPatchPayload } from "../../client/types.js";
import { FakeBackend } from "./helpers/fake-backend.js";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

describe("stripMapModeOps", () => {
  it("drops chunks and every edge that touches one, and nothing else", () => {
    const patch = {
      patchId: "p",
      ops: [
        { type: "UpsertNode", id: "file", kind: "file", name: "a.ts", attrs: {} },
        { type: "UpsertNode", id: "fn", kind: "function", name: "run", attrs: {} },
        { type: "UpsertNode", id: "c1", kind: "chunk", name: "run", attrs: {} },
        { type: "UpsertNode", id: "c2", kind: "chunk", name: "file_body:9", attrs: {} },
        { type: "UpsertEdge", id: "e1", src: "file", dst: "c1", predicate: "CONTAINS_CHUNK", attrs: {} },
        { type: "UpsertEdge", id: "e2", src: "c1", dst: "c2", predicate: "NEXT", attrs: {} },
        // The one that used to survive: its chunk is gone, so it dangled.
        { type: "UpsertEdge", id: "e3", src: "c1", dst: "fn", predicate: "DEFINES", attrs: {} },
        { type: "UpsertEdge", id: "e4", src: "file", dst: "fn", predicate: "CONTAINS", attrs: {} },
        { type: "AssertClaim", entityId: "fn", field: "calls:x", value: "x", confidence: null },
      ],
    } as unknown as GraphPatchPayload;

    const kept = stripMapModeOps(patch).ops.map((op) => String("id" in op ? op.id : op.type));

    expect(kept).toEqual(["file", "fn", "e4"]);
    const full = applyIngestMode(patch, false);
    const map = applyIngestMode(patch, true);
    expect(map.patchId).not.toBe(full.patchId);
    expect(map.patchId).not.toBe(patch.patchId);
    expect(full.patchId).not.toBe(patch.patchId);
    expect(applyIngestMode(patch, true)).toEqual(map);
    expect(applyIngestMode(patch, false)).toEqual(full);
    expect(full.ops).toEqual(patch.ops);
    expect(map.ops).toEqual(stripMapModeOps(patch).ops);
  });
});

describe("map/full ingestion identity (#965)", () => {
  let root: string;
  let repo: string;
  let backend: FakeBackend;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-ingest-mode-")));
    repo = join(root, "repo");
    const home = join(root, "home");
    mkdirSync(repo);
    mkdirSync(home);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("IX_HOME", join(home, ".ix"));
    vi.stubEnv("IX_LOCK_DIR", join(home, "locks"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.ts"), "export function run() { return 42; }\n");
    execFileSync("git", ["add", "a.ts"], { cwd: repo });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    await backend?.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function ingest(mapMode: boolean, force = false, target = repo) {
    await ingestFiles(target, { root: repo, recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode, force });
  }

  for (const semantics of ["legacy", "head"] as const) {
    for (const force of [true, false]) {
      it(`map then full stores chunks (${semantics}, force=${force})`, async () => {
        backend = new FakeBackend({ semantics });
        vi.stubEnv("IX_ENDPOINT", await backend.start());
        await ingest(mapModeForIngest("0"));
        const mapId = backend.lastPatchIds.get("a.ts");
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("map");
        expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(false);

        await ingest(false, force);
        expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(true);
        expect(backend.lastPatchIds.get("a.ts")).not.toBe(mapId);
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
        expect(loadIngestBaseline(repo)!.replayedFiles).toEqual([]);
        const fullGraph = backend.graphSignature();
        await ingest(true, force);
        expect(backend.graphSignature()).toEqual(fullGraph);
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
        expect(backend.unknownPaths).toEqual([]);
      });

      it(`full then map preserves the full graph (${semantics}, force=${force})`, async () => {
        backend = new FakeBackend({ semantics });
        vi.stubEnv("IX_ENDPOINT", await backend.start());
        await ingest(false);
        const fullId = backend.lastPatchIds.get("a.ts");
        const fullGraph = backend.graphSignature();
        expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(true);
        expect(fullGraph.edges.some(e => e.includes(" CONTAINS_CHUNK "))).toBe(true);
        expect(fullGraph.edges.some(e => e.includes(" DEFINES "))).toBe(true);

        await ingest(mapModeForIngest("0"), force);
        expect(backend.graphSignature()).toEqual(fullGraph);
        expect(backend.lastPatchIds.get("a.ts")).toBe(fullId);
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
        await ingest(false, force);
        expect(backend.graphSignature()).toEqual(fullGraph);
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
        expect(backend.unknownPaths).toEqual([]);
      });
    }

    it(`map edits and deletes a fully ingested file without losing chunk edges (${semantics})`, async () => {
      backend = new FakeBackend({ semantics });
      backend.bulkManifests = true;
      vi.stubEnv("IX_ENDPOINT", await backend.start());
      await ingest(false);
      writeFileSync(join(repo, "a.ts"), "\nexport function renamed() { return 43; }\n");
      await ingest(true, false, join(repo, "a.ts"));
      const graph = backend.graphSignature();
      expect(graph.nodes.some(n => n.endsWith(" chunk renamed"))).toBe(true);
      expect(graph.nodes.some(n => n.endsWith(" chunk run"))).toBe(false);
      expect(graph.edges.some(e => e.includes(" CONTAINS_CHUNK "))).toBe(true);
      expect(graph.edges.some(e => e.includes(" DEFINES "))).toBe(true);
      expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
      rmSync(join(repo, "a.ts"));
      await ingest(false);
      expect(backend.graphSignature()).toEqual({ nodes: [], edges: [] });
      expect(loadIngestBaseline(repo)!.files.size).toBe(0);
    });
  }

  for (const bulkManifests of [false, true]) {
    for (const mapMode of [false, true]) {
      it(`deletes chunks retained by an earlier full-to-map downgrade (manifests=${bulkManifests}, map=${mapMode})`, async () => {
        backend = new FakeBackend({ semantics: "head" });
        backend.bulkManifests = bulkManifests;
        const endpoint = await backend.start();
        vi.stubEnv("IX_ENDPOINT", endpoint);
        await ingest(false);

        // Reproduce the history written before full baselines were preserved:
        // both manifests exist, but the map baseline does not name the chunk.
        const [, builder] = await loadIngestionModules();
        const workspaceId = backend.sourceWorkspaceIds[0]!;
        const sourceHash = createHash("sha256").update(readFileSync(join(repo, "a.ts"))).digest("hex");
        const patch = applyIngestMode({
          patchId: builder.sourcePatchIdCandidates("a.ts", sourceHash, workspaceId)[0]!,
          source: { uri: "a.ts", workspaceId, sourceHash },
          ops: backend.lastOps.get("a.ts")!,
        } as GraphPatchPayload, true);
        const seeded = await fetch(`${endpoint}/v1/patches/bulk`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ patches: [patch] }),
        });
        expect(seeded.ok).toBe(true);
        const baselinePath = ingestMtimeCachePath(repo);
        const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
        baseline.fileModes[join(repo, "a.ts")] = "map";
        writeFileSync(baselinePath, JSON.stringify(baseline));
        expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(true);

        rmSync(join(repo, "a.ts"));
        await ingest(mapMode);
        expect(backend.graphSignature()).toEqual({ nodes: [], edges: [] });
        expect(loadIngestBaseline(repo)!.files.size).toBe(0);
        expect(loadIngestBaseline(repo)!.fileModes.size).toBe(0);
        expect(backend.unknownPaths).toEqual([]);
      });
    }
  }

  for (const semantics of ["legacy", "head"] as const) {
    for (const force of [false, true]) {
      it(`map preserves a legacy full graph without mode metadata (${semantics}, force=${force})`, async () => {
        backend = new FakeBackend({ semantics });
        vi.stubEnv("IX_ENDPOINT", await backend.start());
        await ingest(false);
        const [, builder] = await loadIngestionModules();
        const workspaceId = backend.sourceWorkspaceIds[0]!;
        const sourceHash = createHash("sha256").update(readFileSync(join(repo, "a.ts"))).digest("hex");
        const legacyId = builder.sourcePatchIdCandidates("a.ts", sourceHash, workspaceId)[0]!;
        const ops = backend.lastOps.get("a.ts")!;
        // Seed only the pre-fix ID: no mode-aware patch has been committed.
        await backend.stop();
        backend = new FakeBackend({ semantics });
        const endpoint = await backend.start();
        vi.stubEnv("IX_ENDPOINT", endpoint);
        const seeded = await fetch(`${endpoint}/v1/patches/bulk`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ patches: [{
            patchId: legacyId, source: { uri: "a.ts", workspaceId, sourceHash },
            ops,
          }] }),
        });
        expect(seeded.ok).toBe(true);
        const baselinePath = ingestMtimeCachePath(repo);
        const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
        delete baseline.fileModes;
        writeFileSync(baselinePath, JSON.stringify(baseline));
        const fullGraph = backend.graphSignature();
        expect(fullGraph.edges.some(e => e.includes(" CONTAINS_CHUNK "))).toBe(true);
        expect(fullGraph.edges.some(e => e.includes(" DEFINES "))).toBe(true);

        await ingest(true, force);
        expect(backend.graphSignature()).toEqual(fullGraph);
        expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
        expect(backend.unknownPaths).toEqual([]);
      });
    }
  }

  it("preserves modes outside a scoped run and skips a repeated mode", async () => {
    backend = new FakeBackend({ semantics: "legacy" });
    vi.stubEnv("IX_ENDPOINT", await backend.start());
    writeFileSync(join(repo, "b.ts"), "export function other() { return 7; }\n");
    execFileSync("git", ["add", "b.ts"], { cwd: repo });
    await ingest(true);
    await ingest(false, false, join(repo, "a.ts"));
    expect(loadIngestBaseline(repo)!.fileModes).toEqual(new Map([
      [join(repo, "a.ts"), "full"], [join(repo, "b.ts"), "map"],
    ]));
    backend.resetRequests();
    await ingest(false, false, join(repo, "a.ts"));
    expect(backend.commitCount).toBe(0);
    await ingest(false);
    expect([...loadIngestBaseline(repo)!.fileModes.values()]).toEqual(["full", "full"]);
    expect(loadIngestBaseline(repo)!.replayedFiles).toEqual([]);
  });

  it("keeps the previous mode after a failed commit and retries unchanged bytes", async () => {
    backend = new FakeBackend({ semantics: "legacy" });
    vi.stubEnv("IX_ENDPOINT", await backend.start());
    await ingest(true);
    backend.poison = ["a.ts"];
    await expect(ingest(false)).rejects.toThrow();
    expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("map");
    backend.poison = [];
    await ingest(false);
    expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
    expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(true);
  });

  it("upgrades a legacy map ID and a baseline without mode records", async () => {
    backend = new FakeBackend({ semantics: "legacy" });
    const endpoint = await backend.start();
    vi.stubEnv("IX_ENDPOINT", endpoint);
    await ingest(true);
    const [, builder] = await loadIngestionModules();
    const workspaceId = backend.sourceWorkspaceIds[0]!;
    const hash = createHash("sha256").update(readFileSync(join(repo, "a.ts"))).digest("hex");
    const legacyId = builder.sourcePatchIdCandidates("a.ts", hash, workspaceId)[0];
    const seeded = await fetch(`${endpoint}/v1/patch`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ patchId: legacyId, source: { uri: "a.ts", workspaceId, sourceHash: hash }, ops: backend.lastOps.get("a.ts") }),
    });
    expect(seeded.ok).toBe(true);
    const baselinePath = ingestMtimeCachePath(repo);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    delete baseline.fileModes;
    writeFileSync(baselinePath, JSON.stringify(baseline));
    expect(loadIngestBaseline(repo)!.fileModes.size).toBe(0);
    await ingest(false);
    expect(backend.graphSignature().nodes.some(n => n.includes(" chunk "))).toBe(true);
    expect(backend.lastPatchIds.get("a.ts")).not.toBe(legacyId);
    expect(loadIngestBaseline(repo)!.fileModes.get(join(repo, "a.ts"))).toBe("full");
  });

  it("reconciles renamed symbols and deletions from mode-aware stored patches", async () => {
    backend = new FakeBackend({ semantics: "head" });
    vi.stubEnv("IX_ENDPOINT", await backend.start());
    await ingest(true);
    writeFileSync(join(repo, "a.ts"), "export function renamed() { return 43; }\n");
    await ingest(false);
    expect(backend.graphSignature().nodes.some(n => n.endsWith(" function run"))).toBe(false);
    expect(backend.graphSignature().nodes.some(n => n.endsWith(" function renamed"))).toBe(true);
    rmSync(join(repo, "a.ts"));
    await ingest(false);
    expect(backend.graphSignature().nodes).toEqual([]);
    expect(loadIngestBaseline(repo)!.fileModes.size).toBe(0);
    expect(backend.unknownPaths).toEqual([]);
  });
});
