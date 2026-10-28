// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DEGREE_MAX_IDS, registerRankCommand, scoreViaDegree } from "../commands/rank.js";

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
 * A small graph with what makes counting interesting: several edges between
 * one pair (under one predicate and under two), predicates a metric ignores,
 * ties, a zero, and an edge back to the node itself.
 */
const NODES = Array.from({ length: 12 }, (_, i) => ({
  id: `n${i}`,
  name: i === 3 ? "" : `Node${i}`,
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

/** Neighbour nodes over one hop, one entry per edge, as `/v1/expand` returns them. */
function neighbourNodes(id: string, direction: string, predicates: string[]) {
  const out: Array<{ id: string }> = [];
  for (const e of EDGES) {
    if (!predicates.includes(e.predicate)) continue;
    if (direction === "out" && e.from === id) out.push({ id: e.to });
    if (direction === "in" && e.to === id) out.push({ id: e.from });
  }
  return out;
}

const realExpand = async (id: string, opts: { direction: string; predicates: string[] }) =>
  ({ nodes: neighbourNodes(id, opts.direction, opts.predicates), edges: [] });
const realDegree = async (ids: string[], opts: { direction: string; predicates: string[]; distinct: boolean }) => ({
  rev: 1,
  truncated: false,
  counts: Object.fromEntries(ids.map(id => [id, new Set(neighbourNodes(id, opts.direction, opts.predicates).map(n => n.id)).size])),
});

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

describe("ix rank scores with one POST /v1/degree", () => {
  const METRICS = ["dependents", "callers", "importers", "members"];
  const FORMATS = ["json", "llm", "text"];
  const cases = METRICS.flatMap(m => FORMATS.map(f => [m, f] as const));

  it.each(cases)("--by %s --format %s: byte-identical to the expand path", async (metric, format) => {
    const args = ["--by", metric, "--kind", "class", "--top", "8", "--format", format];
    const before = await oldPathOutput(args);

    process.env.IX_ENDPOINT = freshEndpoint();
    expand.mockClear();
    degree.mockClear();
    const after = await run(args);

    expect(after).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
    // Only the 8 rows shown are checked against expand, not all 12 candidates.
    expect(expand).toHaveBeenCalledTimes(8);
  });

  it("sends the metric's direction and predicates, every candidate, and distinct: true", async () => {
    await run(["--by", "callers", "--kind", "class", "--format", "json"]);
    expect(degree).toHaveBeenCalledWith(NODES.map(n => n.id), { direction: "in", predicates: ["CALLS", "REFERENCES"], distinct: true });
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
    const args = ["--by", "dependents", "--kind", "class", "--top", "12", "--format", "json"];
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      delete (res.counts as Record<string, number>).n4;
      return res;
    });
    expand.mockClear();
    expect(await run(args)).toBe(before);
    // n4 scored by expanding it, then the other 11 shown rows checked.
    expect(expand.mock.calls[0][0]).toBe("n4");
    expect(expand).toHaveBeenCalledTimes(NODES.length);
  });

  it("a failed expand of a missing id gets today's diagnostic and score 0", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", "12", "--format", "json"];
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      delete (res.counts as Record<string, number>).n4;
      return res;
    });
    expand.mockRejectedValue(new Error("down"));
    const out = JSON.parse(await run(args));
    // The check of the shown rows fails too, so every candidate goes through
    // the expand path, and n4's diagnostic appears once.
    expect(out.diagnostics).toEqual(NODES.map(n => `Failed to expand entity ${n.id}`));
    expect(out.results.find((r: { name: string }) => r.name === "Node4").score).toBe(0);
  });

  it("truncated counts: a diagnostic, and the scores come from the expand path, never the truncated counts", async () => {
    const args = ["--by", "dependents", "--kind", "class", "--top", "12", "--format", "json"];
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
  const args = ["--by", "importers", "--kind", "class", "--top", "12", "--format", "llm"];

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

describe("ix rank checks /v1/degree counts against expand", () => {
  const args = ["--by", "dependents", "--kind", "class", "--top", "5", "--format", "json"];

  it("a backend that counts the seed too: the expand path, same output, no diagnostic, remembered", async () => {
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      for (const id of ids) (res.counts as Record<string, number>)[id]! += 1;
      return res;
    });
    expand.mockClear();
    degree.mockClear();
    expect(await run(args)).toBe(before);
    expect(expand).toHaveBeenCalledTimes(5 + NODES.length);

    // Not asked again for this backend.
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(1);
  });

  it("one shown row that differs is enough", async () => {
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    const top = JSON.parse(before).results[0].name as string;
    const topId = NODES.find(n => n.name === top)!.id;
    degree.mockImplementation(async (ids: string[], opts: any) => {
      const res = await realDegree(ids, opts);
      (res.counts as Record<string, number>)[topId]! += 1;
      return res;
    });
    expect(await run(args)).toBe(before);
  });

  it("an expand that fails during the check falls back without remembering", async () => {
    const before = await oldPathOutput(args);
    process.env.IX_ENDPOINT = freshEndpoint();
    expand.mockImplementationOnce(async () => { throw new TypeError("fetch failed"); });
    degree.mockClear();
    expect(await run(args)).toBe(before);
    expect(await run(args)).toBe(before);
    expect(degree).toHaveBeenCalledTimes(2);
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
