// Copyright 2026 Ix Infrastructure Inc.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import fc from "fast-check";

import { ingestFiles } from "../commands/ingest.js";
import { FakeBackend } from "./helpers/fake-backend.js";
import { applyEdit, EDIT_KINDS, initialRepo, render, type Edit, type EditKind, type Lang, type Repo } from "./helpers/edit-fixture.js";

// Two parse workers rather than `cpus - 1`. Every ingest starts its own pool
// and this file runs a few hundred of them; at one worker per core that is
// over a gigabyte of grammars per run on a large machine.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, cpus: () => actual.cpus().slice(0, 3) };
});

/**
 * Incremental equals fresh: after any sequence of edits, the graph that
 * incremental `ix map` runs leave on the backend must equal the graph a fresh
 * map of the final tree writes into an empty backend.
 *
 * Every test drives the real `ingestFiles` (discovery, the worker parse pool,
 * the commit engine) against `FakeBackend` with `semantics` set, so the fake
 * stores the graph and answers commits the way Ix-memory does: a bulk commit
 * sweeps the edges of the files it carries, `/v1/patch` does not, a patch id
 * seen before is not written again, and `/v1/source-hashes` reports the head
 * patch. Graphs are compared by `graphSignature()`: live nodes as
 * `id kind name`, live edges as `id src dst predicate`.
 *
 * Each class of defect has a fixed scenario. A class that fails on `main` is
 * marked `it.fails` with the card that fixes it; that card deletes the marker,
 * and from then on the test guards the fix. The two properties run random
 * sequences: one over the edits that are correct today, and one over every
 * edit, which passes in `head` mode once IN-04, IN-10 and IN-11 have landed.
 *
 * The fast-check seed is fixed so a marked test cannot pass by luck. Set
 * IX_EQUIV_SEED to explore other sequences, and IX_EQUIV_RUNS for more runs.
 */

type Semantics = "legacy" | "head";
type Signature = { nodes: string[]; edges: string[] };

const SEED = Number(process.env.IX_EQUIV_SEED ?? 20261002);
const RUNS = Number(process.env.IX_EQUIV_RUNS ?? 20);

/** Variables `ingestFiles` reads that a developer's shell could have set. */
const ENV_KEYS = [
  "HOME", "USERPROFILE", "IX_ENDPOINT", "IX_LOCK_DIR", "IX_HOME", "IX_DEBUG",
  "IX_COMMIT_FAILURE_LIMIT", "IX_COMMIT_HTTP_MAX_FILES", "IX_COMMIT_CONCURRENCY",
  "IX_STITCH_COOLDOWN_MS", "IX_STITCH_WAIT_MS", "IX_MAP_DEADLINE_MS",
] as const;

/**
 * One working tree, one backend and home for the incremental runs, and a new
 * backend and home for each reference ingest. The tree lives at the same path
 * for both, so both compute the same workspace id and patch ids.
 */
class World {
  readonly root = realpathSync.native(mkdtempSync(join(tmpdir(), "ix-equiv-")));
  readonly repo = join(this.root, "repo");
  backend!: FakeBackend;
  private home = "";
  private endpoint = "";
  private homes = 0;
  /** The tree as last written, so `write` touches only what changed. */
  private onDisk = new Map<string, string>();

  constructor(private readonly semantics: Semantics) {
    mkdirSync(this.repo);
    // Discovery prefers `git ls-files`, which keeps the walk order fixed.
    execFileSync("git", ["init", "-q"], { cwd: this.repo, stdio: "ignore" });
  }

  async start(): Promise<void> {
    [this.backend, this.home, this.endpoint] = await this.newBackend();
  }

  private async newBackend(): Promise<[FakeBackend, string, string]> {
    const backend = new FakeBackend({ semantics: this.semantics });
    const home = join(this.root, `home${++this.homes}`);
    mkdirSync(home);
    return [backend, home, await backend.start()];
  }

  /** Make the working tree match `repo`, and stage it so discovery sees it. */
  write(repo: Repo): void {
    const want = new Map([...repo].map(([p, fns]) => [p, render(p, fns)]));
    for (const p of this.onDisk.keys()) if (!want.has(p)) rmSync(join(this.repo, p));
    for (const [p, text] of want) {
      if (this.onDisk.get(p) === text) continue;
      mkdirSync(dirname(join(this.repo, p)), { recursive: true });
      writeFileSync(join(this.repo, p), text, "utf8");
    }
    this.onDisk = want;
    execFileSync("git", ["add", "-A"], { cwd: this.repo, stdio: "ignore" });
  }

  private ingestWith(home: string, endpoint: string) {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.IX_LOCK_DIR = join(home, "locks");
    return ingestFiles(this.repo, {
      recursive: true, format: "json", printSummary: false, suppressOutput: true, mapMode: true,
    });
  }

  /** An incremental `ix map` against the long-lived backend. */
  map() {
    this.backend.resetRequests();
    return this.ingestWith(this.home, this.endpoint);
  }

  /** The graph a fresh map of the current tree writes into an empty backend. */
  async freshSignature(): Promise<Signature> {
    const [backend, home, endpoint] = await this.newBackend();
    try {
      await this.ingestWith(home, endpoint);
      return backend.graphSignature();
    } finally {
      await backend.stop();
    }
  }

  async stop(): Promise<void> {
    try {
      await this.backend?.stop();
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}

/** The lines two signatures disagree on, with edge endpoints named. */
function signatureDiff(world: World, live: Signature, want: Signature): string {
  const named = (line: string) => {
    const [id, src, dst, predicate] = line.split(" ");
    return `${predicate} ${world.backend.nodeName(src!)} -> ${world.backend.nodeName(dst!)} (${id!.slice(0, 8)})`;
  };
  const out: string[] = [];
  for (const key of ["nodes", "edges"] as const) {
    const show = key === "edges" ? named : (line: string) => line;
    const inLive = new Set(live[key]);
    const inWant = new Set(want[key]);
    for (const x of live[key]) if (!inWant.has(x)) out.push(`stale   ${show(x)}`);
    for (const x of want[key]) if (!inLive.has(x)) out.push(`missing ${show(x)}`);
  }
  return out.join("\n");
}

/**
 * Map the initial tree, map again after each edit, then compare the live graph
 * with a fresh map of the final tree. `check` runs after the last map, before
 * the comparison.
 */
async function runSequence(
  semantics: Semantics,
  edits: Edit[],
  opts: { langs?: Lang[]; check?: (world: World) => void } = {},
): Promise<void> {
  const world = new World(semantics);
  try {
    await world.start();
    let repo = initialRepo();
    const history: Repo[] = [repo];
    world.write(repo);
    await world.map();
    for (const edit of edits) {
      for (const state of applyEdit(repo, edit, history, opts.langs)) {
        repo = state;
        history.push(repo);
        world.write(repo);
        await world.map();
      }
    }
    opts.check?.(world);
    const live = world.backend.graphSignature();
    const want = await world.freshSignature();
    expect(signatureDiff(world, live, want), `graph after ${JSON.stringify(edits)} differs from a fresh map`).toBe("");
  } finally {
    await world.stop();
  }
}

const edit = (kind: EditKind, path?: string, b = 0): Edit => ({ kind, a: 0, b, path });

function property(semantics: Semantics, kinds: readonly EditKind[], langs?: Lang[]): Promise<void> {
  const edits = fc.array(
    fc.record({ kind: fc.constantFrom(...kinds), a: fc.nat(60), b: fc.nat(60) }),
    { minLength: 1, maxLength: 3 },
  );
  return fc.assert(
    fc.asyncProperty(edits, (es) => runSequence(semantics, es, { langs })),
    { numRuns: RUNS, seed: SEED },
  );
}

describe("incremental ix map equals a fresh map (fake backend)", () => {
  // Generous, because each property is a few hundred real ingests. Each one
  // takes about 0.2 s here.
  vi.setConfig({ testTimeout: 300_000 });

  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("the harness: two fresh maps of one tree give one graph", async () => {
    await runSequence("head", []);
  });

  it("a re-map with nothing changed commits nothing", async () => {
    // A revert to the first state is a second map of an unchanged tree.
    await runSequence("head", [{ kind: "revert", a: 0, b: 0 }], {
      check: (world) => expect(world.backend.commitCount).toBe(0),
    });
  });

  it("a body edit to a TypeScript file keeps every edge", async () => {
    await runSequence("head", [edit("editBody", "web/calc.ts"), edit("addFunction", "web/report.ts")]);
  });

  // F-03. An edited Python or Java file is resolved against the batch of
  // changed files alone, so its cross-file CALLS are re-pointed at phantom
  // module nodes or dropped. TypeScript is spared by the index prescan.
  it.fails("IN-10: a body edit to a Python or Java file keeps its cross-file edges", async () => {
    await runSequence("head", [edit("editBody", "pkg/app.py"), edit("editBody", "src/com/ex/App.java")]);
  });

  // F-07. A new file has no backend hash, so the whole repository takes the
  // first-ingest path and every file is parsed and sent again.
  it.fails("IN-01: adding a file sends one patch", async () => {
    await runSequence("head", [edit("addFile", undefined, 0)], {
      langs: ["ts"],
      check: (world) => {
        const sent = world.backend.requests
          .filter((r) => r.path === "/v1/patches/bulk" || r.path === "/v1/patch")
          .reduce((sum, r) => sum + r.patches, 0);
        expect(sent, "patches on the wire").toBe(1);
      },
    });
  });

  // F-04. Dropping the file's last import removes a node, the patch carries a
  // DeleteNode, and a delete-bearing patch goes to `/v1/patch`, which does not
  // sweep: the removed CALLS and IMPORTS edges stay live.
  it.fails("IN-04: removing a file's last call retires its edges", async () => {
    await runSequence("head", [edit("removeCall", "web/main.ts")]);
  });

  // F-03. Files that call a renamed or deleted function are unchanged, so
  // nothing re-resolves them. Fresh, their calls are unresolved; incremental,
  // the edges are simply gone, and after a restore they never come back.
  it.fails("IN-11: renaming a called function re-resolves its callers", async () => {
    await runSequence("head", [edit("renameFunction", "web/math.ts", 0)]);
  });

  it.fails("IN-11: restoring a deleted file re-binds its callers", async () => {
    await runSequence("head", [edit("deleteThenRestore", "web/math.ts")]);
  });

  it("a revert and a delete-then-restore re-apply, on a backend with BEW-03", async () => {
    await runSequence("head", [edit("addFunction", "web/main.ts"), { kind: "revert", a: 0, b: 0 }]);
    await runSequence("head", [edit("deleteThenRestore", "web/main.ts")]);
  });

  // F-01, on the backend as shipped. The reverted file's patch id was
  // committed before, so the backend answers Idempotent, writes nothing, and
  // the graph keeps the edit. BEW-03 fixes it in the backend and IN-02 makes
  // the CLI report it. This one stays marked: `legacy` is the old backend.
  it.fails("F-01: a revert is lost on a backend without BEW-03", async () => {
    await runSequence("legacy", [edit("addFunction", "web/main.ts"), { kind: "revert", a: 0, b: 0 }]);
  });

  it("random TypeScript edits that add or change code", async () => {
    await property("head", ["editBody", "addFunction", "addCall", "addFile"], ["ts"]);
  });

  // The acceptance gate for the F-03 chain: IN-04, IN-10 and IN-11. The last
  // of them to land deletes this marker.
  it.fails("IN-11: random edit sequences of every kind", async () => {
    await property("head", EDIT_KINDS);
  });
});
