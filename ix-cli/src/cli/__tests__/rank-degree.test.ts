// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DEGREE_CHECK_MIN, DEGREE_MAX_IDS, DEGREE_TIMEOUT_MS, registerRankCommand, scoreViaDegree } from "../commands/rank.js";

const { listByKind, expand, degree } = vi.hoisted(() => ({ listByKind: vi.fn(), expand: vi.fn(), degree: vi.fn() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    constructor(public readonly endpoint: string) {}
    async listByKind(...args: unknown[]) { return listByKind(...args); }
    async expand(...args: unknown[]) { return expand(...args); }
    async degree(...args: unknown[]) { return degree(...args); }
  },
}));
vi.mock("../resolve.js", () => ({
  ensureReadScope: async () => {},
  activeReadScope: () => ({ workspaceId: "test-workspace" }),
}));

type Edge = { from: string; to: string; predicate: string };

/**
 * A graph with what makes counting interesting: several edges between one
 * pair (under one predicate and under two), predicates a metric ignores, ties,
 * a zero, a self-loop, and two hubs past `/v1/expand`'s 1000-neighbour limit.
 */
const NODES = Array.from({ length: 14 }, (_, i) => ({
  id: `n${i}`,
  name: i === 3 ? "" : i === 12 ? "Hub" : i === 13 ? "Hub2" : `Node${i}`,
  kind: i === 5 ? "interface" : "class",
  provenance: { sourceUri: i % 2 ? "src/odd.ts" : "src/even.ts" },
}));
const EDGES: Edge[] = [];
for (let i = 0; i < 12; i++) {
  for (let j = 0; j < 12; j++) {
    if (i === j) continue;
    if ((i * 7 + j * 3) % 5 === 0) EDGES.push({ from: `n${i}`, to: `n${j}`, predicate: "CALLS" });
    if ((i + j) % 4 === 0) EDGES.push({ from: `n${i}`, to: `n${j}`, predicate: "IMPORTS" });
    if ((i * j) % 6 === 1) EDGES.push({ from: `n${i}`, to: `n${j}`, predicate: "REFERENCES" });
    if (i < 3 && j > 8) EDGES.push({ from: `n${i}`, to: `n${j}`, predicate: "CONTAINS" });
  }
}
// Duplicates the old path counted once.
EDGES.push({ from: "n1", to: "n4", predicate: "CALLS" }, { from: "n1", to: "n4", predicate: "CALLS" });
EDGES.push({ from: "n2", to: "n6", predicate: "CALLS" }, { from: "n2", to: "n6", predicate: "REFERENCES" });
// A self-loop (a recursive call, a self-import): degree counts n7 as its own
// neighbour, expand leaves the seed out.
EDGES.push({ from: "n7", to: "n7", predicate: "CALLS" }, { from: "n7", to: "n7", predicate: "IMPORTS" });
EDGES.push({ from: "n9", to: "n9", predicate: "CONTAINS" });
// Hub: 1500 callers, 1100 importers and 1100 members, past expand's limit.
for (let k = 0; k < 1500; k++) EDGES.push({ from: `ext${k}`, to: "n12", predicate: "CALLS" });
for (let k = 0; k < 1100; k++) EDGES.push({ from: `ext${k}`, to: "n12", predicate: "IMPORTS" });
for (let k = 0; k < 1100; k++) EDGES.push({ from: "n12", to: `member${k}`, predicate: "CONTAINS" });
// Hub2: 1200 neighbours, each over two edges, so an expand that stops at 1000
// edges lists 500 distinct nodes, below the 1000 a degree count suggests.
for (let k = 0; k < 1200; k++) {
  EDGES.push({ from: `ext${k}`, to: "n13", predicate: "CALLS" }, { from: `ext${k}`, to: "n13", predicate: "REFERENCES" });
}

/** The edges a one-hop expand of `id` walks, one per edge. */
function hopEdges(id: string, direction: string, predicates: string[]): Array<{ id: string }> {
  const out: Array<{ id: string }> = [];
  for (const e of EDGES) {
    if (!predicates.includes(e.predicate)) continue;
    if (direction === "out" && e.from === id) out.push({ id: e.to });
    if (direction === "in" && e.to === id) out.push({ id: e.from });
  }
  return out;
}

/** The backend's default `/v1/expand` limit. */
const EXPAND_LIMIT = 1000;

/** `/v1/expand`: neighbour nodes, the seed left out, at most EXPAND_LIMIT edges. */
const realExpand = async (id: string, opts: { direction: string; predicates: string[] }) =>
  ({ nodes: hopEdges(id, opts.direction, opts.predicates).filter(n => n.id !== id).slice(0, EXPAND_LIMIT), edges: [] });
/** `/v1/degree` with `distinct`: every distinct neighbour, a self-loop's seed included, no limit. */
const realDegree = async (ids: string[], opts: { direction: string; predicates: string[]; distinct: boolean }) => ({
  rev: 1,
  truncated: false,
  counts: Object.fromEntries(ids.map(id => [id, new Set(hopEdges(id, opts.direction, opts.predicates).map(n => n.id)).size])),
});

/** `METRIC_CONFIG` in rank.ts. */
const CONFIG = {
  dependents: { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] },
  callers: { direction: "in", predicates: ["CALLS", "REFERENCES"] },
  importers: { direction: "in", predicates: ["IMPORTS"] },
  members: { direction: "out", predicates: ["CONTAINS"] },
};

let endpointSeq = 0;
/** A fresh endpoint per test, so the per-endpoint "route missing" memo starts empty. */
function freshEndpoint(): string {
  return `http://rank-test-${++endpointSeq}:8090`;
}

async function run(args: string[]): Promise<string> {
  const program = new Command().name("ix").exitOverride();
  registerRankCommand(program);
  const output: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(" ")); });
  try {
    await program.parseAsync(["rank", ...args], { from: "user" });
  } finally {
    spy.mockRestore();
  }
  return output.join("\n");
}

const savedEndpoint = process.env.IX_ENDPOINT;
beforeEach(() => {
  process.env.IX_ENDPOINT = freshEndpoint();
  listByKind.mockReset().mockResolvedValue(NODES);
  expand.mockReset().mockImplementation(realExpand);
  degree.mockReset().mockImplementation(realDegree);
});
afterEach(() => {
  if (savedEndpoint === undefined) delete process.env.IX_ENDPOINT;
  else process.env.IX_ENDPOINT = savedEndpoint;
  vi.restoreAllMocks();
});

/** The output of the per-entity expand path: `/v1/degree` fails the way an unreachable backend does. */
async function oldPathOutput(args: string[]): Promise<string> {
  process.env.IX_ENDPOINT = freshEndpoint();
  degree.mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
  expand.mockClear();
  const out = await run(args);
  expect(expand).toHaveBeenCalled();
  return out;
}

const METRICS = ["dependents", "callers", "importers", "members"];
const TOP = String(NODES.length);

describe("ix rank scores with one POST /v1/degree", () => {
  const FORMATS = ["json", "llm", "text"];
  const cases = METRICS.flatMap(m => FORMATS.map(f => [m, f] as const));

  it("the fixture has what the degree path must get right", async () => {
    const expandSize = async (id: string, metric: keyof typeof CONFIG) =>
      new Set((await realExpand(id, CONFIG[metric])).nodes.map(n => n.id)).size;
    const degreeOf = async (id: string, metric: keyof typeof CONFIG) => (await realDegree([id], { ...CONFIG[metric], distinct: true })).counts[id];
    // The self-loop: one more by degree than by expand.
    expect(await degreeOf("n7", "dependents")).toBe(await expandSize("n7", "dependents") + 1);
    expect(await degreeOf("n9", "members")).toBe(await expandSize("n9", "members") + 1);
    // The hubs: past expand's limit, and under it by distinct nodes.
    expect(await degreeOf("n12", "dependents")).toBe(1500);
    expect(await expandSize("n12", "dependents")).toBe(1000);
    expect(await degreeOf("n13", "callers")).toBe(1200);
    expect(await expandSize("n13", "callers")).toBe(500);
  });

  it.each(cases)("--by %s --format %s: byte-identical to the expand path", async (metric, format) => {
    const args = ["--by", metric, "--kind", "class", "--top", "3", "--format", format];
    const before = await oldPathOutput(args);

    process.env.IX_ENDPOINT = freshEndpoint();
    expand.mockClear();
    degree.mockClear();
    const after = await run(args);

    expect(after).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
  });

  it.each(METRICS)("--by %s: byte-identical for every --top, self-loops and hubs included", async (metric) => {
    for (let top = 1; top <= NODES.length; top++) {
      const args = ["--by", metric, "--kind", "class", "--top", String(top), "--format", "json"];
      const before = await oldPathOutput(args);
      process.env.IX_ENDPOINT = freshEndpoint();
      degree.mockClear();
      expect(await run(args), `--top ${top}`).toBe(before);
      expect(degree).toHaveBeenCalledTimes(1);
    }
  });

  it("a hub past expand's limit scores what expand gives, and a self-loop does not count", async () => {
    const out = JSON.parse(await run(["--by", "dependents", "--kind", "class", "--top", "3", "--format", "json"]));
    expect(out.results[0]).toEqual({ name: "Hub", kind: "class", score: 1000 });
    expect(out.results[1]).toEqual({ name: "Hub2", kind: "class", score: 500 });
    expect(out.diagnostics).toBeUndefined();
    // Nothing remembered against this backend: the next rank asks again.
    degree.mockClear();
    await run(["--by", "dependents", "--kind", "class", "--top", "3", "--format", "json"]);
    expect(degree).toHaveBeenCalledTimes(1);
  });

  it("sends the metric's direction and predicates, every candidate, and distinct: true", async () => {
    await run(["--by", "callers", "--kind", "class", "--format", "json"]);
    expect(degree).toHaveBeenCalledWith(NODES.map(n => n.id), {
      direction: "in", predicates: ["CALLS", "REFERENCES"], distinct: true, timeoutMs: DEGREE_TIMEOUT_MS,
    });
  });

  it("bounds the degree call well inside the 60 s read deadline, so the expand fallback keeps time to run", () => {
    expect(DEGREE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });

  it("keeps filters: only the candidates left after --path, --exclude-path and --exclude-kind are counted", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--path", "src/odd", "--exclude-kind", "interface", "--format", "json"];
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockClear();
    expect(await run(args)).toBe(before);
    expect(degree.mock.calls[0][0]).toEqual(NODES.filter((n, i) => i % 2 === 1 && n.kind !== "interface").map(n => n.id));
  });

  it("counts an id missing from `counts` the way the expand path does, by expanding it", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", "2", "--format", "json"];
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      delete (res.counts as Record<string, number>).n4;
      return res;
    });
    expand.mockClear();
    expect(await run(args)).toBe(before);
    expect(expand.mock.calls.map(c => c[0])).toContain("n4");
  });

  it("an expand that fails scores 0 with today's diagnostic, as on the expand path", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", TOP, "--format", "json"];
    const failN4 = async (id: string, opts: any) => {
      if (id === "n4") throw new Error("down");
      return realExpand(id, opts);
    };
    expand.mockImplementation(failN4);
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      delete (res.counts as Record<string, number>).n4;
      return res;
    });
    const after = await run(args);
    expect(after).toBe(before);
    const out = JSON.parse(after);
    expect(out.diagnostics).toEqual(["Failed to expand entity n4"]);
    expect(out.results.find((r: { name: string }) => r.name === "Node4").score).toBe(0);
  });

  it("after a failed expand, every candidate not yet expanded is expanded, in one more round", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", "1", "--format", "json"];
    const failHub = async (id: string, opts: any) => {
      if (id === "n12") throw new Error("down");
      return realExpand(id, opts);
    };
    expand.mockImplementation(failHub);
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    expand.mockClear();
    const after = await run(args);
    expect(after).toBe(before);
    expect(JSON.parse(after).diagnostics).toEqual(["Failed to expand entity n12"]);
    // Every candidate with a nonzero count, each once.
    const counts = (await realDegree(NODES.map(n => n.id), { ...CONFIG.dependents, distinct: true })).counts;
    const nonzero = NODES.filter(n => counts[n.id]! > 0).map(n => n.id);
    expect(expand.mock.calls.map(c => c[0]).sort()).toEqual([...nonzero].sort());
  });

  it("truncated counts: a diagnostic, and the scores come from the expand path, never the truncated counts", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", TOP, "--format", "json"];
    const before = JSON.parse(await oldPathOutput(args));
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(async (ids: string[]) => ({ rev: 1, truncated: true, counts: Object.fromEntries(ids.map(id => [id, 1])) }));
    expand.mockClear();
    const after = JSON.parse(await run(args));
    expect(after.results).toEqual(before.results);
    expect(after.diagnostics).toEqual([
      "Degree counts were truncated by the backend; scored each entity by expanding it instead.",
    ]);
    expect(expand).toHaveBeenCalledTimes(NODES.length);
  });
});

describe("ix rank /v1/degree fallback", () => {
  const args = ["--by", "importers", "--kind", "class", "--top", TOP, "--format", "llm"];

  it.each([
    ["404", new Error('404: {"error":"not found"}'), true],
    ["405", new Error("405: Method Not Allowed"), true],
    ["413", new Error("413: Payload Too Large"), false],
    ["transport error", new TypeError("fetch failed"), false],
  ] as const)("%s: the expand path, same output; route missing remembered: %s", async (_label, err, remembered) => {
    const before = await oldPathOutput(args);

    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockReset().mockRejectedValue(err);
    expand.mockClear();
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledTimes(NODES.length);

    // A second rank in the same process, against the same backend.
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(remembered ? 1 : 2);
  });

  it("remembers a missing route per backend, not for every backend", async () => {
    degree.mockReset().mockRejectedValue(new Error("404: not found"));
    await run(args);
    expect(degree).toHaveBeenCalledTimes(1);

    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(realDegree);
    await run(args);
    expect(degree).toHaveBeenCalledTimes(2);
  });

  it("a malformed answer falls back too", async () => {
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockReset().mockResolvedValue({ rev: 1 });
    expect(await run(args)).toBe(before);
  });
});

describe("ix rank when degree is no ceiling on expand", () => {
  const args = ["--by", "dependents", "--kind", "class", "--top", "5", "--format", "json"];

  it("an expand that lists more than the degree count: the expand path, same output, no diagnostic, remembered", async () => {
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    const top = JSON.parse(before).results[0].name as string;
    const topId = NODES.find(n => n.name === top)!.id;
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      (res.counts as Record<string, number>)[topId] = 999;
      return res;
    });
    expand.mockClear();
    degree.mockClear();
    expect(await run(args)).toBe(before);

    // Not asked again for this backend.
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
  });
});

describe("ix rank when degree undercounts a candidate it would not otherwise expand", () => {
  it.each(METRICS)("--by %s: a top row whose count is too low is caught by the check expands; the expand path, same output", async (metric) => {
    const args = ["--by", metric, "--kind", "class", "--top", "1", "--format", "json"];
    const before = await oldPathOutput(args);
    const topName = JSON.parse(before).results[0].name as string;
    const topId = NODES.find(n => (n.name || "(unnamed)") === topName)!.id;
    process.env.IX_ENDPOINT = freshEndpoint();
    // The true top row counted just under the highest floor of the others,
    // so the contender rounds never expand it; only the check can.
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      const counts = res.counts as Record<string, number>;
      const maxOtherFloor = Math.max(...ids.filter(id => id !== topId).map(id => Math.max(0, Math.min(counts[id]! - 1, 1000))));
      counts[topId] = Math.max(0, maxOtherFloor - 1);
      return res;
    });
    degree.mockClear();
    expect(await run(args)).toBe(before);
    // Remembered: the next rank against this backend expands straight away.
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
  });

  it(`expands at least ${DEGREE_CHECK_MIN} candidates beyond the shown rows, highest counts first`, async () => {
    const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: "class" }));
    const d = (id: string) => 40 - Number(id.slice(1));
    const expanded: string[] = [];
    const client = {
      endpoint: freshEndpoint(),
      degree: async (ids: string[]) => ({ rev: 1, truncated: false, counts: Object.fromEntries(ids.map(id => [id, d(id)])) }),
      expand: async (id: string) => {
        expanded.push(id);
        return { nodes: Array.from({ length: d(id) }, (_, k) => ({ id: `x${k}` })), edges: [] };
      },
    };
    const scored = await scoreViaDegree(candidates, { direction: "in", predicates: ["CALLS"] }, client as any, [], "class", 2);
    expect(scored!.map(s => s.score)).toEqual(candidates.map(c => d(c.id)));
    // The three that could be shown (c2's count reaches c1's floor), the
    // next ten checked, nothing else.
    expect([...expanded].sort()).toEqual(candidates.slice(0, 3 + DEGREE_CHECK_MIN).map(c => c.id).sort());
  });
});

describe("scoreViaDegree chunking", () => {
  it(`sends at most ${DEGREE_MAX_IDS} ids per request, in candidate order`, async () => {
    const candidates = Array.from({ length: 2 * DEGREE_MAX_IDS + 1 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, kind: "class" }));
    const calls: string[][] = [];
    const client = {
      endpoint: freshEndpoint(),
      degree: async (ids: string[]) => {
        calls.push(ids);
        return { rev: 1, truncated: false, counts: Object.fromEntries(ids.map(id => [id, Number(id.slice(1)) % 3])) };
      },
      expand: async () => { throw new Error("not expected"); },
    };
    const diagnostics: string[] = [];
    const scored = await scoreViaDegree(candidates, { direction: "in", predicates: ["CALLS"] }, client as any, diagnostics, "class");

    expect(calls.map(c => c.length)).toEqual([DEGREE_MAX_IDS, DEGREE_MAX_IDS, 1]);
    expect(calls.flat()).toEqual(candidates.map(c => c.id));
    expect(scored).not.toBeNull();
    expect(scored!.map(s => s.score)).toEqual(candidates.map((_, i) => i % 3));
    expect(diagnostics).toEqual([]);
  });
});
