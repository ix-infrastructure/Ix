// Copyright 2026 Ix Infrastructure Inc.

// Real-backend correctness scenarios: after any sequence of edits and maps the
// graph must equal a fresh ingest of the same tree. Run with
// `IX_E2E=1 npm run test:e2e` against the stack from `npm run e2e:up`
// (test/e2e/README.md).
//
// A scenario whose fix has not landed is wrapped in failsUntil([...]) and
// titled "[fails until <task ids>]" with every plan task it waits for. It
// passes while the graphs differ and turns red as soon as they match, so the
// PR that lands the last of those fixes has to unwrap it. A fix that lands
// earlier takes its own id out of the title and the list. Any other error (a
// crashed map, an unreachable database) fails the run either way.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Checkout,
  type E2eEnv,
  checkout,
  cleanupScratch,
  e2eEnv,
  freshSignature,
  git,
  ix,
  map,
  resetBackend,
  expectSameGraph,
  signature,
  workspaceId,
} from "./harness.js";
import { IxClient } from "../../src/client/api.js";
import { loadIngestionModules } from "../../src/cli/commands/ingestion-loader.js";

let env: E2eEnv;

beforeAll(() => {
  env = e2eEnv();
});

beforeEach(async () => {
  await resetBackend(env);
});

afterAll(() => {
  cleanupScratch();
});

function edit(co: Checkout, rel: string, change: (text: string) => string): void {
  const path = join(co.dir, rel);
  const before = readFileSync(path, "utf8");
  const after = change(before);
  if (after === before) throw new Error(`edit of ${rel} changed nothing`);
  writeFileSync(path, after);
}

const replaceAll = (from: string, to: string) => (text: string) => text.split(from).join(to);

describe("revert to earlier content", () => {
  // Was [fails until BEW-03]. BEW-03 is in the pinned backend; what was left
  // was the edited Python file's cross-file calls, resolved against itself
  // alone until the persisted symbol table (IN-10).
  it("A -> B -> A equals A", async () => {
    const co = checkout("polyglot");
    map(env, co);
    const a = await signature(env, co);

    edit(
      co,
      "app/pricing.py",
      (t) => t + "\n\ndef surcharge(amount):\n    return add_tax(amount) + 100\n",
    );
    map(env, co);
    edit(co, "app/pricing.py", (t) => t.slice(0, t.indexOf("\n\ndef surcharge")));
    map(env, co);

    expectSameGraph("A->B->A", await signature(env, co), a);
  });

  // Marked [fails until BEW-03] until tree-sitter/1.28. All that was left of
  // the renamed state was edges with no live node at either end: the renamed
  // function's CALLS to names that resolve nowhere (`re.sub`, `lower`) and
  // its chunk's DEFINES. 1.28 writes neither. A -> B -> A still covers BEW-03.
  it("rename a function and back equals the original", async () => {
    const co = checkout("polyglot");
    map(env, co);
    const a = await signature(env, co);

    for (const f of ["app/utils.py", "app/repository.py"])
      edit(co, f, replaceAll("to_snake_case", "to_snake_case_renamed"));
    map(env, co);
    git(co.dir, "checkout", "--", ".");
    map(env, co);

    expectSameGraph("rename and back", await signature(env, co), a);
  });

  // Was failsUntil BEW-03/IN-04(/IN-10). What was left was callers of the
  // deleted or renamed file's names: unchanged, so nothing re-resolved them.
  // IN-11 re-resolves the files that refer to a changed name.
  it("delete a file and restore it equals the original", async () => {
    const co = checkout("polyglot");
    map(env, co);
    const a = await signature(env, co);

    rmSync(join(co.dir, "app/pricing.py"));
    map(env, co);
    git(co.dir, "checkout", "--", "app/pricing.py");
    map(env, co);

    expectSameGraph("delete and restore", await signature(env, co), a);
  });

  // Was failsUntil BEW-03/IN-04(/IN-10). What was left was callers of the
  // deleted or renamed file's names: unchanged, so nothing re-resolved them.
  // IN-11 re-resolves the files that refer to a changed name.
  it("branch round trip equals the starting branch", async () => {
    const co = checkout("polyglot");
    git(co.dir, "checkout", "-q", "-b", "feature");
    edit(co, "app/services.py", replaceAll("def charge(", "def charge_order("));
    edit(co, "app/services.py", replaceAll("service.charge(", "service.charge_order("));
    edit(co, "web/src/cart.ts", replaceAll("summary()", "describe()"));
    edit(co, "web/src/index.ts", replaceAll("cart.summary()", "cart.describe()"));
    rmSync(join(co.dir, "app/events.py"));
    writeFileSync(
      join(co.dir, "app/audit.py"),
      "from app.utils import slugify\n\n\ndef audit_key(name):\n    return slugify(name)\n",
    );
    git(co.dir, "add", "-A");
    git(co.dir, "commit", "-q", "-m", "feature");
    git(co.dir, "checkout", "-q", "main");

    map(env, co);
    const main = await signature(env, co);
    git(co.dir, "checkout", "-q", "feature");
    map(env, co);
    git(co.dir, "checkout", "-q", "main");
    map(env, co);

    expectSameGraph("branch round trip", await signature(env, co), main);
  });
});

describe("two workspaces in one backend", () => {
  it("mapping a second workspace leaves the first one's graph alone (BEW-01, backend 1.0.31)", async () => {
    const one = checkout("polyglot");
    const two = checkout("polyglot-b");
    // Both register in one IX_HOME, as two repos on one machine would.
    const shared: Checkout = { dir: two.dir, ixHome: one.ixHome };

    map(env, one);
    const before = await signature(env, one);
    map(env, shared);
    await signature(env, shared); // the second workspace really was ingested

    expectSameGraph("first workspace after the second maps", await signature(env, one), before);
  });
});

describe("incremental equals fresh", () => {
  it("edit one Python file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    edit(co, "app/services.py", (t) => t + "\n# edited\n");
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("python edit", incremental, await freshSignature(env, co));
  });

  it("edit one TypeScript file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    edit(co, "web/src/cart.ts", (t) => t + "\n// edited\n");
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("typescript edit", incremental, await freshSignature(env, co));
  });

  // Was [fails until IN-04, IN-10]. Both have landed.
  it("rename a file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    renameSync(join(co.dir, "app/events.py"), join(co.dir, "app/bus.py"));
    for (const f of ["app/services.py", "app/api.py"])
      edit(co, f, replaceAll("from app.events import", "from app.bus import"));
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("file rename", incremental, await freshSignature(env, co));
  });

  it("add a file", async () => {
    const co = checkout("polyglot");
    map(env, co);
    writeFileSync(
      join(co.dir, "app/refunds.py"),
      "from app.pricing import add_tax\nfrom app.utils import format_money\n\n\ndef refund(amount):\n    return format_money(-add_tax(amount))\n",
    );
    map(env, co);
    const incremental = await signature(env, co);

    expectSameGraph("file add", incremental, await freshSignature(env, co));
  });

  it("map twice gives the same graph", async () => {
    const co = checkout("polyglot");
    map(env, co);
    const first = await signature(env, co);
    map(env, co);

    expectSameGraph("map twice", await signature(env, co), first);
  });
});

// The outcome contract agents route on (ix-cli/src/cli/outcome.ts), against a
// real backend: `clamp` is defined in app/utils.py and web/src/math.ts, and
// app/pricing.py imports it (`from app.utils import clamp`, a one-line module
// entity the ambiguity lists as --pick 1 but --all skips).
describe("agent outcomes", () => {
  it("exits 0 / 2 / 3 / 4 for results, ambiguity, a miss and an unmapped directory", () => {
    const co = checkout("polyglot");
    map(env, co);

    expect(ix(env, co, ["locate", "slugify", "--format", "json"]).status).toBe(0);

    const ambiguous = ix(env, co, ["callers", "clamp", "--format", "json"], true);
    expect(ambiguous.status).toBe(2);
    expect(JSON.parse(ambiguous.stdout).error).toBe("ambiguous_target");

    const miss = ix(env, co, ["locate", "definitelyNotAName", "--format", "json"], true);
    expect(miss.status).toBe(3);
    expect(JSON.parse(miss.stdout).error).toBe("unresolved_target");

    const unmapped = checkout("polyglot-b");
    const notMapped = ix(env, unmapped, ["locate", "slugify", "--format", "json"], true);
    expect(notMapped.status).toBe(4);
    expect(JSON.parse(notMapped.stdout).error).toBe("workspace_not_mapped");

    process.env.IX_LEGACY_EXIT_CODES = "1";
    try {
      expect(ix(env, co, ["callers", "clamp", "--format", "json"], true).status).toBe(1);
    } finally {
      delete process.env.IX_LEGACY_EXIT_CODES;
    }
  });

  it("--all answers every candidate, and several targets answer in one call", () => {
    const co = checkout("polyglot");
    map(env, co);

    const all = JSON.parse(ix(env, co, ["callers", "clamp", "--all", "--format", "json"]).stdout);
    expect(all.resolutionMode).toBe("all");
    expect(all.candidates.map((c: { path: string }) => c.path).sort()).toEqual(["app/utils.py", "web/src/math.ts"]);
    expect(all.results.length).toBeGreaterThan(0);
    // Each candidate keeps the number --pick gives it in the ambiguity list.
    const listed = JSON.parse(ix(env, co, ["callers", "clamp", "--format", "json"], true).stdout).candidates;
    for (const c of all.candidates) {
      expect(listed.find((l: { rank: number }) => l.rank === c.n)).toMatchObject({ id: c.id });
    }
    for (const row of all.results) expect(all.candidates.map((c: { n: number }) => c.n)).toContain(row.candidate);

    const many = ix(env, co, ["locate", "slugify", "clamp", "definitelyNotAName", "--format", "json"], true);
    expect(many.status).toBe(3);
    expect(JSON.parse(many.stdout).targets.map((t: { exitCode: number }) => t.exitCode)).toEqual([0, 2, 3]);
  });
});

describe("an extractor upgrade over a real backend (IN-20)", () => {
  // The orphan sweep decides ownership from what POST /v1/nodes returns
  // (provenance.sourceUri, attrs.external, deletedRev). The unit suite proves
  // it against a hand-written fake; this proves the real route's answer.
  const uuidOf = (text: string): string => {
    const h = createHash("sha256").update(text).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  it("retires a node the previous extractor wrote and the current one does not, and keeps an external one", async () => {
    const co = checkout("polyglot");
    const fresh = await freshSignature(env, co);
    map(env, co);

    // What the previous extractor left for app/pricing.py at its current
    // bytes: a stored patch, under that extractor's patch id, upserting a
    // node the current extractor does not write, an external package node and
    // an edge between them. Committed through the bulk route, as the CLI does.
    const [, patchBuilder] = await loadIngestionModules();
    const previous = (patchBuilder as unknown as { PREVIOUS_EXTRACTORS: string[] }).PREVIOUS_EXTRACTORS[0]!;
    const file = "app/pricing.py";
    const hash = createHash("sha256").update(readFileSync(join(co.dir, file))).digest("hex");
    const ws = workspaceId(co);
    const ghost = uuidOf(`e2e-ghost-${ws}`);
    const external = uuidOf(`e2e-ghost-external-${ws}`);
    const client = new IxClient(env.endpoint);
    await client.commitPatchBulk([{
      patchId: patchBuilder.sourcePatchIdCandidates(file, hash, ws)[1]!,
      actor: "ix-e2e",
      timestamp: new Date().toISOString(),
      baseRev: 0,
      source: { uri: file, sourceHash: hash, extractor: previous, sourceType: "code", workspaceId: ws },
      ops: [
        { type: "UpsertNode", id: ghost, kind: "function", name: "e2e_ghost", attrs: {} },
        { type: "UpsertNode", id: external, kind: "module", name: "e2e-ghost-external", attrs: { external: true } },
        { type: "UpsertEdge", id: uuidOf(`e2e-ghost-edge-${ws}`), src: ghost, dst: external, predicate: "CALLS", attrs: {} },
      ],
      replaces: [],
      intent: "e2e: a previous extractor's output",
    }]);
    const before = await client.nodes([ghost, external], "full");
    expect(before.nodes.map((n) => n.id).sort()).toEqual([ghost, external].sort());
    // The fields the sweep reads, as the real route names them.
    const ghostNode = before.nodes.find((n) => n.id === ghost)!;
    expect((ghostNode.provenance as { sourceUri?: string }).sourceUri).toBe(file);
    expect((before.nodes.find((n) => n.id === external)!.attrs as { external?: boolean }).external).toBe(true);

    // The baseline says the workspace was last mapped by the previous extractor.
    const baselineFile = readdirSync(co.ixHome).find((f) => f.startsWith("ingest_mtimes_"));
    expect(baselineFile).toBeDefined();
    const baselinePath = join(co.ixHome, baselineFile!);
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { extractor?: string };
    baseline.extractor = previous;
    writeFileSync(baselinePath, JSON.stringify(baseline));

    const res = map(env, co);
    expect(res.stderr).not.toContain("[orphans kept]");

    const after = await client.nodes([ghost, external], "full");
    expect(after.missing).toContain(ghost);
    expect(after.nodes.map((n) => n.id)).toEqual([external]);
    // Everything else, the ghost's edge included, matches a fresh ingest.
    const actual = await signature(env, co);
    expectSameGraph(
      "extractor upgrade retires the dropped node",
      { nodes: actual.nodes.filter((line) => !line.includes("e2e-ghost-external")), edges: actual.edges },
      fresh,
    );
  });
});
