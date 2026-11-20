// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { builtFirstAlternatives, fullModePatchId, ingestFiles, modeAlternatives, patchForMode } from "../commands/ingest.js";
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
 * never got its chunks. A full run now re-sends content the backend holds
 * under a full-mode id, and a reader looks for a stored patch under both.
 * Every other patch keeps the built id, which is what a CLI from before this
 * reads back on the file's next edit or deletion.
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

  /** The HTTP status `GET /v1/patches/{id}` answers: what any CLI's reconcile reads. */
  async patchStatus(target: { endpoint: string }, id: string): Promise<number> {
    const res = await fetch(`${target.endpoint}/v1/patches/${encodeURIComponent(id)}`);
    await res.arrayBuffer();
    return res.status;
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

describe("a forced full ingest after ix map writes under its own patch id (Ix#965)", () => {
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
      // The map patches stay, under the built id a CLI from before this reads.
      for (const [uri, id] of mapIds) expect(await world.patchStatus(target, id), uri).toBe(200);
    }, 120_000);

    it(`${semantics}: a full ingest, then a forced map: the full payload and graph stay`, async () => {
      const target = await world.backend(semantics);
      await world.run(target, "full");
      const fullIds = new Map(target.backend.lastPatchIds);

      await world.run(target, "map", true);
      const mapIds = new Map(target.backend.lastPatchIds);
      for (const [uri, id] of fullIds) expect(mapIds.get(uri), uri).toBe(fullModePatchId(id));
      for (const [uri] of mapIds) {
        expect(target.backend.lastOps.get(uri)!.some((op) => op.kind === "chunk"), uri).toBe(true);
      }

      // A file already ingested in full keeps its chunks and their edges.
      // The forced map resends the full payload under the held-content id.
      expect(target.backend.graphSignature()).toEqual(freshFull);
    }, 120_000);
  }

  it("map, then an unforced full ingest upgrades unchanged files to full", async () => {
    // A mode upgrade bypasses the hash baseline even without --force.
    const target = await world.backend("head");
    await world.run(target, "map");
    const mapIds = new Map(target.backend.lastPatchIds);

    await world.run(target, "full");
    for (const [uri, id] of mapIds) expect(target.backend.lastPatchIds.get(uri), uri).toBe(fullModePatchId(id));
    expect(target.backend.graphSignature()).toEqual(freshFull);
  }, 120_000);

  it("the same source keeps one patch id, and a full run of new files sends the built one, as ix map does", async () => {
    const ids: Map<string, string>[] = [];
    for (const mode of ["map", "full", "full"] as const) {
      const a = await world.backend("head");
      await world.run(a, mode);
      ids.push(new Map(a.backend.lastPatchIds));
    }
    expect(ids[1]).toEqual(ids[0]);
    expect(ids[2]).toEqual(ids[0]);
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
        // Mode upgrades refresh unchanged files too; a map run keeps files
        // previously ingested in full at full fidelity.
        expect(withoutChunks(after)).toEqual(withoutChunks(fresh));
        if (second === "full") {
          expect(after).toEqual(fresh);
        } else {
          expect(after).toEqual(await world.fresh("full"));
        }
      }
      expect(after.nodes.filter((line) => line.endsWith(" beta") && !line.includes(" chunk "))).toEqual([]);
    }, 120_000);
  }
});

describe("a CLI from before the split finds the patch a full run stores", () => {
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

  /** The built ids of the repo as it is now: what `ix map` sends, and an older CLI reads back. */
  const builtIds = async (): Promise<Map<string, string>> => {
    const fresh = await world.backend("head");
    await world.run(fresh, "map");
    return new Map(fresh.backend.lastPatchIds);
  };

  it("new and edited files, and an edit after a forced run, are stored under the built id", async () => {
    const target = await world.backend("head");
    await world.run(target, "full");
    expect(target.backend.lastPatchIds).toEqual(await builtIds());

    world.write("src/a.ts", A_WITHOUT_BETA);
    await world.run(target, "full");
    const edited = await builtIds();
    expect(target.backend.lastPatchIds.get("src/a.ts")).toBe(edited.get("src/a.ts"));

    // A forced run re-sends held content under the full-mode id. The built
    // patch stays, and the next edit goes under the built id again.
    await world.run(target, "full", true);
    for (const [uri, id] of edited) {
      expect(target.backend.lastPatchIds.get(uri), uri).toBe(fullModePatchId(id));
      expect(await world.patchStatus(target, id), uri).toBe(200);
    }
    world.write("src/a.ts", SOURCES["src/a.ts"]!);
    await world.run(target, "full");
    expect(target.backend.lastPatchIds.get("src/a.ts")).toBe((await builtIds()).get("src/a.ts"));
    for (const [uri, id] of target.backend.lastPatchIds) expect(await world.patchStatus(target, id), uri).toBe(200);
  }, 120_000);
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

  it("keeps the built id, but for held content in a full run", () => {
    const patch = {
      patchId: ID, actor: "t", timestamp: "", baseRev: 0, replaces: [],
      source: { uri: "a.ts", sourceHash: "h", extractor: "x", sourceType: "code" },
      ops: [{ type: "UpsertNode", id: "n", kind: "chunk" }, { type: "UpsertNode", id: "f", kind: "function" }],
    } as unknown as Parameters<typeof patchForMode>[0];
    expect(patchForMode(patch, true)).toMatchObject({ patchId: ID, ops: [{ id: "f" }] });
    expect(patchForMode(patch, true, { held: true })).toMatchObject({ patchId: ID, ops: [{ id: "f" }] });
    expect(patchForMode(patch, false)).toMatchObject({ patchId: ID, ops: patch.ops });
    expect(patchForMode(patch, false, { held: true })).toMatchObject({ patchId: fullModePatchId(ID), ops: patch.ops });
  });

  it("names the superseded patch under both ids, only when there is one, never the patch's own", () => {
    const PREV = "11111111-2222-3333-4444-555555555555";
    const OLD = "66666666-7777-8888-9999-000000000000";
    const patch = {
      patchId: ID, actor: "t", timestamp: "", baseRev: 0, replaces: [PREV, OLD],
      source: { uri: "a.ts", sourceHash: "h", extractor: "x", sourceType: "code" },
      ops: [],
    } as unknown as Parameters<typeof patchForMode>[0];
    // The first entry (this extractor, previous hash) may be stored under
    // either id; the earlier extractors' predate the split and stay single.
    const named = [PREV, OLD, fullModePatchId(PREV)];
    for (const mapMode of [true, false]) {
      for (const held of [true, false]) {
        expect(patchForMode(patch, mapMode, { held, supersedes: true }).replaces).toEqual(named);
        // No previous hash: the first entry is the legacy id, never sent
        // under a full-mode id, so nothing is added.
        expect(patchForMode(patch, mapMode, { held }).replaces).toEqual([PREV, OLD]);
      }
    }
    // The built patch is left as it was.
    expect(patch.replaces).toEqual([PREV, OLD]);

    // A list that starts with the built id itself: the patch does not
    // replace itself, nor its full-mode twin.
    const self = { ...patch, replaces: [ID, PREV] };
    expect(patchForMode(self, false, { supersedes: true }).replaces).toEqual([ID, PREV]);
    expect(patchForMode(self, true, { supersedes: true }).replaces).toEqual([ID, PREV]);
    expect(patchForMode({ ...patch, replaces: [] }, false, { supersedes: true }).replaces).toEqual([]);
  });

  it("pairs each candidate with its full-mode id: built first, but in a full run's reconcile", () => {
    expect(builtFirstAlternatives(["a", "b"])).toEqual([["a", fullModePatchId("a")], ["b", fullModePatchId("b")]]);
    expect(modeAlternatives(["a", "b"], true)).toEqual(builtFirstAlternatives(["a", "b"]));
    expect(modeAlternatives(["a", "b"], false)).toEqual([[fullModePatchId("a"), "a"], [fullModePatchId("b"), "b"]]);
  });
});
