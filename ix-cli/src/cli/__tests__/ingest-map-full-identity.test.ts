// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { fullModePatchId, ingestFiles, modeAlternatives, patchForMode } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";

// Two parse workers, as in ingest-equivalence.test.ts.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

/**
 * Ix#965: `ix map` strips chunks, their edges and claims from each patch, and
 * `ix ingest` / `ix watch` send the whole patch. Both used to send it under
 * the same patch id, and the backend skips an id it already holds, so a
 * forced full ingest after `ix map` was answered `Idempotent` and the file
 * never got its chunks. Each mode now has its own id for the same source, and
 * a reader looks for a stored patch under both, this run's mode first.
 */

const ENV_KEYS = ["HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG"] as const;

const SOURCES: Record<string, string> = {
  "src/a.ts": [
    "import { helper } from './b';",
    "",
    "export function alpha(x: number): number {",
    "  return helper(x) + 1;",
    "}",
    "",
    "export function beta(): number {",
    "  return alpha(2);",
    "}",
    "",
  ].join("\n"),
  "src/b.ts": [
    "export function helper(x: number): number {",
    "  return x * 2;",
    "}",
    "",
  ].join("\n"),
};

type Mode = "map" | "full";

class World {
  readonly root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-mode-id-")));
  readonly repo = join(this.root, "repo");
  private homes = 0;
  private readonly backends: FakeBackend[] = [];

  constructor() {
    mkdirSync(join(this.repo, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: this.repo, stdio: "ignore" });
    for (const [p, text] of Object.entries(SOURCES)) writeFileSync(join(this.repo, p), text, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: this.repo, stdio: "ignore" });
  }

  /** A backend with commit semantics, and a home of its own. */
  async backend(semantics: "legacy" | "head"): Promise<{ backend: FakeBackend; home: string; endpoint: string }> {
    const backend = new FakeBackend({ semantics });
    this.backends.push(backend);
    const home = join(this.root, `home${++this.homes}`);
    mkdirSync(home);
    return { backend, home, endpoint: await backend.start() };
  }

  run(target: { home: string; endpoint: string }, mode: Mode, force = false) {
    process.env.HOME = target.home;
    process.env.USERPROFILE = target.home;
    process.env.IX_ENDPOINT = target.endpoint;
    process.env.IX_LOCK_DIR = join(target.home, "locks");
    return ingestFiles(this.repo, {
      recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: mode === "map", force,
    });
  }

  /** Rewrite one source and stage it, as an edit between runs. */
  write(path: string, text: string): void {
    writeFileSync(join(this.repo, path), text, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: this.repo, stdio: "ignore" });
  }

  /** The graph one run of `mode` writes into an empty backend. */
  async fresh(mode: Mode): Promise<{ nodes: string[]; edges: string[] }> {
    const target = await this.backend("head");
    await this.run(target, mode);
    return target.backend.graphSignature();
  }

  async stop(): Promise<void> {
    try {
      for (const b of this.backends) await b.stop();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}

const chunkNodes = (nodes: string[]): string[] => nodes.filter((line) => line.split(" ")[1] === "chunk");
const withoutChunks = (sig: { nodes: string[]; edges: string[] }) => {
  const chunks = new Set(chunkNodes(sig.nodes).map((line) => line.split(" ")[0]));
  return {
    nodes: sig.nodes.filter((line) => !chunks.has(line.split(" ")[0]!)),
    edges: sig.edges.filter((line) => {
      const [, src, dst] = line.split(" ");
      return !chunks.has(src!) && !chunks.has(dst!);
    }),
  };
};

describe("ix map and a full ingest write under different patch ids (Ix#965)", () => {
  const saved: Record<string, string | undefined> = {};
  let world: World;
  let freshFull: { nodes: string[]; edges: string[] };
  let freshMap: { nodes: string[]; edges: string[] };

  beforeAll(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.IX_HOME;
    delete process.env.IX_DEBUG;
    world = new World();
    freshFull = await world.fresh("full");
    freshMap = await world.fresh("map");
  }, 120_000);

  afterAll(async () => {
    await world?.stop();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("the fixture has chunks in full mode and none in map mode", () => {
    expect(chunkNodes(freshFull.nodes).length).toBeGreaterThan(0);
    expect(chunkNodes(freshMap.nodes)).toEqual([]);
  });

  for (const semantics of ["legacy", "head"] as const) {
    it(`${semantics}: map, then a forced full ingest, writes the chunks`, async () => {
      const target = await world.backend(semantics);
      await world.run(target, "map");
      const mapIds = new Map(target.backend.lastPatchIds);
      expect(chunkNodes(target.backend.graphSignature().nodes)).toEqual([]);

      await world.run(target, "full", true);
      const fullIds = new Map(target.backend.lastPatchIds);
      expect([...fullIds.keys()].sort()).toEqual([...mapIds.keys()].sort());
      for (const [uri, id] of fullIds) expect(id, uri).not.toBe(mapIds.get(uri));

      expect(target.backend.graphSignature()).toEqual(freshFull);
    }, 120_000);

    it(`${semantics}: a full ingest, then a forced map, sends map content under its own id`, async () => {
      const target = await world.backend(semantics);
      await world.run(target, "full");
      const fullIds = new Map(target.backend.lastPatchIds);

      await world.run(target, "map", true);
      const mapIds = new Map(target.backend.lastPatchIds);
      expect([...mapIds.keys()].sort()).toEqual([...fullIds.keys()].sort());
      for (const [uri, id] of mapIds) {
        expect(id, uri).not.toBe(fullIds.get(uri));
        expect(target.backend.lastOps.get(uri)!.some((op) => op.kind === "chunk"), uri).toBe(false);
      }

      // The topology is the map's. Map mode does not reconcile chunks, so the
      // nodes the full ingest wrote are left in place.
      const after = target.backend.graphSignature();
      expect(withoutChunks(after)).toEqual(withoutChunks(freshMap));
      expect(chunkNodes(after.nodes)).toEqual(chunkNodes(freshFull.nodes));
    }, 120_000);
  }

  it("map, then an unforced full ingest: unchanged files are skipped, so it takes --force to add the chunks", async () => {
    // The hash baseline skips an unchanged file whichever mode stored it, so
    // the full run sends nothing; the forced run above is how chunks arrive.
    const target = await world.backend("head");
    await world.run(target, "map");
    const mapIds = new Map(target.backend.lastPatchIds);
    const mapOps = new Map(target.backend.lastOps);

    await world.run(target, "full");
    expect(target.backend.lastPatchIds).toEqual(mapIds);
    expect(target.backend.lastOps).toEqual(mapOps);
    expect(chunkNodes(target.backend.graphSignature().nodes)).toEqual([]);
  }, 120_000);

  it("the same source in the same mode keeps one patch id", async () => {
    for (const mode of ["map", "full"] as const) {
      const a = await world.backend("head");
      await world.run(a, mode);
      const b = await world.backend("head");
      await world.run(b, mode);
      expect(b.backend.lastPatchIds).toEqual(a.backend.lastPatchIds);
    }
  }, 120_000);
});

/** `src/a.ts` without `beta`: an edit whose reconcile must delete its nodes. */
const A_WITHOUT_BETA = [
  "import { helper } from './b';",
  "",
  "export function alpha(x: number): number {",
  "  return helper(x) + 1;",
  "}",
  "",
].join("\n");

describe("an edit finds the stored patch whichever mode wrote it (Ix#965)", () => {
  const saved: Record<string, string | undefined> = {};
  const worlds: World[] = [];

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.IX_HOME;
    delete process.env.IX_DEBUG;
  });

  afterAll(async () => {
    for (const w of worlds) await w.stop();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const cases: Array<[Mode, Mode]> = [["map", "map"], ["full", "full"], ["map", "full"], ["full", "map"]];
  for (const [first, second] of cases) {
    it(`${first}, edit, ${second}: the removed function's nodes are gone`, async () => {
      const world = new World();
      worlds.push(world);
      const target = await world.backend("head");
      await world.run(target, first);
      expect(target.backend.graphSignature().nodes.some((line) => line.endsWith(" beta"))).toBe(true);

      world.write("src/a.ts", A_WITHOUT_BETA);
      await world.run(target, second);
      const after = target.backend.graphSignature();
      const fresh = await world.fresh(second);
      if (first === second) {
        expect(after).toEqual(fresh);
      } else {
        // Across modes the topology is the fresh one. Chunks are not: a map run
        // leaves them alone (the removed function's stays), and a full run
        // re-sends only the edited file, so only it gains chunks.
        expect(withoutChunks(after)).toEqual(withoutChunks(fresh));
        if (second === "full") {
          expect(chunkNodes(after.nodes).map((line) => line.split(" ")[2])).toEqual(["alpha"]);
        }
      }
      expect(after.nodes.filter((line) => line.endsWith(" beta") && !line.includes(" chunk "))).toEqual([]);
    }, 120_000);
  }
});

/** `src/a.ts` one line lower and without `beta`: every chunk id it had changes. */
const A_SHIFTED_WITHOUT_BETA = ["// shifted", A_WITHOUT_BETA].join("\n");

describe("a full run reconciles against the full patch when both modes stored one (Ix#965)", () => {
  const saved: Record<string, string | undefined> = {};
  let world: World;

  beforeAll(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.IX_HOME;
    delete process.env.IX_DEBUG;
    world = new World();
  });

  afterAll(async () => {
    await world?.stop();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("map, forced full, an ix map of another edit, then a full edit: the old chunks are gone", async () => {
    const target = await world.backend("head");
    await world.run(target, "map");
    await world.run(target, "full", true);
    // Both modes now hold a patch for src/a.ts at this hash; the map one has no chunks.
    world.write("src/b.ts", `${SOURCES["src/b.ts"]}// edited\n`);
    await world.run(target, "map");

    world.write("src/a.ts", A_SHIFTED_WITHOUT_BETA);
    await world.run(target, "full");
    const fresh = await world.fresh("full");
    const ofA = (nodes: string[]) => chunkNodes(nodes).filter((line) => ["alpha", "beta"].includes(line.split(" ")[2]!));
    expect(ofA(fresh.nodes).map((line) => line.split(" ")[2])).toEqual(["alpha"]);
    expect(ofA(target.backend.graphSignature().nodes)).toEqual(ofA(fresh.nodes));
  }, 120_000);
});

describe("mode-specific patch ids", () => {
  const ID = "032b0445-6782-eea8-db9e-1b31a00080ff";

  it("derives a stable full-mode id of the same shape", () => {
    expect(fullModePatchId(ID)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(fullModePatchId(ID)).toBe(fullModePatchId(ID));
    expect(fullModePatchId(ID)).not.toBe(ID);
  });

  it("keeps the built id in map mode and derives it in full mode", () => {
    const patch = {
      patchId: ID, actor: "t", timestamp: "", baseRev: 0, replaces: [],
      source: { uri: "a.ts", sourceHash: "h", extractor: "x", sourceType: "code" },
      ops: [{ type: "UpsertNode", id: "n", kind: "chunk" }, { type: "UpsertNode", id: "f", kind: "function" }],
    } as unknown as Parameters<typeof patchForMode>[0];
    expect(patchForMode(patch, true)).toMatchObject({ patchId: ID, ops: [{ id: "f" }] });
    expect(patchForMode(patch, false)).toMatchObject({ patchId: fullModePatchId(ID), ops: patch.ops });
  });

  it("pairs each candidate with its other-mode id, this run's mode first", () => {
    expect(modeAlternatives(["a", "b"], true)).toEqual([["a", fullModePatchId("a")], ["b", fullModePatchId("b")]]);
    expect(modeAlternatives(["a", "b"], false)).toEqual([[fullModePatchId("a"), "a"], [fullModePatchId("b"), "b"]]);
  });
});
