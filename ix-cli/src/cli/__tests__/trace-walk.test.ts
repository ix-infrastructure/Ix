// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

import { registerTraceCommand } from "../commands/trace.js";
import { compactTreeNode } from "../format.js";
import { isRawId } from "../resolve.js";
import { EXPAND_CONCURRENCY } from "../tree-walk.js";
import { expandAnswer } from "./helpers/expand-answer.js";

/**
 * `ix trace --upstream/--downstream` and the both-directions mode, end to end
 * through the command, against the depth-first walk they used before the
 * shared breadth-first one (kept here verbatim as the oracle).
 */

const expand = vi.hoisted(() => vi.fn());
vi.mock("../../client/api.js", () => ({
  IxClient: class { async expand(...args: unknown[]) { return expand(...args); } },
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveFileOrReport: async (_client: unknown, name: string) => ({ id: name, name, kind: "function" }),
}));

const PREDICATES = ["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS", "CONTAINS"];

/** `buildTraceTree` as it was before the breadth-first walk. */
async function oldBuildTraceTree(
  client: any, rootId: string,
  opts: { direction: "in" | "out"; predicates: string[]; maxDepth: number; maxNodes: number },
) {
  const { direction, predicates, maxDepth, maxNodes } = opts;
  const visited = new Set<string>([rootId]);
  let nodesVisited = 0;
  let truncated = false;
  let depthLimited = false;
  let maxDepthReached = 0;

  async function expandNode(nodeId: string, depth: number): Promise<any[]> {
    if (depth > maxDepth) { depthLimited = true; return []; }
    if (nodesVisited >= maxNodes) { truncated = true; return []; }
    maxDepthReached = Math.max(maxDepthReached, depth);
    const results = await Promise.all(
      predicates.map((p) => client.expand(nodeId, { direction, predicates: [p], hops: 1 })),
    );
    const children: any[] = [];
    const levelSeen = new Set<string>();
    for (const result of results) {
      for (const n of result.nodes) {
        if (nodesVisited >= maxNodes) { truncated = true; break; }
        if (levelSeen.has(n.id)) continue;
        const name = n.name || n.attrs?.name || "";
        const resolved = !!name && !isRawId(name);
        const isCycle = visited.has(n.id);
        nodesVisited++;
        levelSeen.add(n.id);
        visited.add(n.id);
        const child: any = {
          id: n.id,
          name: resolved ? name : n.id.slice(0, 8),
          kind: n.kind ?? "unknown",
          resolved,
          path: n.provenance?.sourceUri ?? n.provenance?.source_uri ?? undefined,
          children: [],
          ...(isCycle ? { cycle: true } : {}),
        };
        if (!isCycle && resolved) child.children = await expandNode(n.id, depth + 1);
        children.push(child);
      }
    }
    return children;
  }

  const tree = await expandNode(rootId, 1);
  return { tree, truncated, depthLimited, nodesVisited, maxDepthReached };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Separate in- and out-adjacency per predicate, with cycles and shared nodes. */
function randomGraph(seed: number, size: number, maxFanout: number) {
  const rand = mulberry32(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  const nodeFor = (i: number): any => {
    const roll = (i * 7919 + seed) % 20;
    const id = `n${i}`;
    if (roll === 0) return { id, name: "0123456789abcdef0123456789abcdef", kind: "function" };
    if (roll === 1) return { id, attrs: { name: `attr${i}` }, kind: "method" };
    if (roll < 8) return { id, name: `fn${i}`, kind: "function" };
    return { id, name: `fn${i}`, kind: "function", provenance: { source_uri: `src/f${i % 5}.ts` } };
  };
  const graph: Record<string, Record<string, Record<string, any[]>>> = { in: {}, out: {} };
  for (const direction of ["in", "out"]) {
    for (let i = 0; i < size; i++) {
      const lists: Record<string, any[]> = {};
      for (const p of PREDICATES) lists[p] = Array.from({ length: pick(maxFanout + 1) }, () => nodeFor(pick(size)));
      graph[direction][`n${i}`] = lists;
    }
  }
  return graph;
}

type Graph = ReturnType<typeof randomGraph>;

let inFlight = 0;
let maxInFlight = 0;

function serve(graph: Graph, delaySeed?: number) {
  const rand = delaySeed === undefined ? undefined : mulberry32(delaySeed);
  inFlight = 0;
  maxInFlight = 0;
  expand.mockReset().mockImplementation(async (id: string, opts: { direction: string; predicates: string[] }) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (rand) await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
      return expandAnswer(id, opts.direction, graph[opts.direction]?.[id], opts.predicates);
    } finally {
      inFlight--;
    }
  });
}

async function trace(args: string[]) {
  const program = new Command().name("ix").exitOverride();
  registerTraceCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  await program.parseAsync(["trace", "n0", ...args, "--format", "json"], { from: "user" });
  return JSON.parse(output.join("\n"));
}

/** What the command prints for one direction, computed from the oracle. */
async function expected(graph: Graph, direction: "in" | "out", maxDepth: number, maxNodes: number) {
  const client = { expand: async (id: string, o: { direction: string; predicates: string[] }) => ({ nodes: graph[o.direction]?.[id]?.[o.predicates[0]] ?? [] }) };
  const r = await oldBuildTraceTree(client, "n0", { direction, predicates: PREDICATES, maxDepth, maxNodes });
  return JSON.parse(JSON.stringify({
    tree: r.tree.map(compactTreeNode),
    summary: {
      nodes_visited: r.nodesVisited,
      max_depth: r.maxDepthReached,
      truncated: r.truncated ? true : undefined,
      depth_limited: r.depthLimited ? true : undefined,
    },
  }));
}

describe("ix trace directional output against the depth-first walk", () => {
  beforeEach(() => { inFlight = 0; maxInFlight = 0; });
  afterEach(() => vi.restoreAllMocks());

  // One test per graph: each runs the whole command nine times, and all twelve
  // in one test outran the 20 s timeout on the Windows CI runner.
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))("is identical upstream, downstream and both ways when no cap cuts (graph %i)", async (seed) => {
    const graph = randomGraph(seed, 25, 2);
    for (const [depth, cap] of [[1000, 1000000], [3, 1000000], [2, 1000000]] as const) {
      const bounds = ["--depth", String(depth), "--cap", String(cap)];
      const up = await expected(graph, "in", depth, cap);
      const down = await expected(graph, "out", depth, cap);

      serve(graph, seed);
      const upOut = await trace(["--upstream", ...bounds]);
      expect({ tree: upOut.tree ?? [], summary: upOut.summary }, `seed ${seed} up`).toEqual({ tree: up.tree, summary: up.summary });

      serve(graph, seed + 100);
      const downOut = await trace(["--downstream", ...bounds]);
      expect({ tree: downOut.tree ?? [], summary: downOut.summary }, `seed ${seed} down`).toEqual({ tree: down.tree, summary: down.summary });

      serve(graph, seed + 200);
      const both = await trace(bounds);
      expect(both.upstream, `seed ${seed} both/up`).toEqual(up);
      expect(both.downstream, `seed ${seed} both/down`).toEqual(down);
    }
  });

  it(`keeps both directions together under ${EXPAND_CONCURRENCY} requests in flight`, async () => {
    serve(randomGraph(4, 150, 4), 9);
    await trace(["--depth", "4", "--cap", "400"]);
    expect(maxInFlight).toBe(EXPAND_CONCURRENCY);
  });

  it("sends one expand per visited node and direction, asking for every predicate", async () => {
    serve(randomGraph(3, 40, 3), 3);
    const out = await trace(["--depth", "4", "--cap", "1000000"]);
    expect(out.upstream.summary.nodes_visited).toBeGreaterThan(0);
    expect(out.downstream.summary.nodes_visited).toBeGreaterThan(0);
    const perNode = new Map<string, number>();
    for (const [id, opts] of expand.mock.calls) {
      expect(opts).toMatchObject({ predicates: PREDICATES, hops: 1 });
      const key = `${opts.direction}|${id}`;
      perNode.set(key, (perNode.get(key) ?? 0) + 1);
    }
    expect([...perNode].filter(([, n]) => n !== 1)).toEqual([]);
  });

  it("keeps the shallowest nodes when the cap cuts, and says so", async () => {
    const fn = (id: string) => ({ id, name: id, kind: "function" });
    // n0 -> a, b, c;  a -> a1 -> a2
    const graph: Graph = {
      in: {},
      out: { n0: { CALLS: [fn("a"), fn("b"), fn("c")] }, a: { CALLS: [fn("a1")] }, a1: { CALLS: [fn("a2")] } },
    };
    serve(graph);
    const out = await trace(["--downstream", "--kind", "calls", "--depth", "5", "--cap", "3"]);
    expect(out.tree.map((n: { name: string; children?: unknown[] }) => [n.name, n.children?.length ?? 0]))
      .toEqual([["a", 0], ["b", 0], ["c", 0]]);
    expect(out.summary).toEqual({ nodes_visited: 3, max_depth: 1, truncated: true });
    expect(out.diagnostics.map((d: { code: string }) => d.code)).toEqual(["truncated"]);
  });
});
