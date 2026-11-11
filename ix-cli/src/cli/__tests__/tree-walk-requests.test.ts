// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import { buildDependencyTree } from "../commands/depends.js";
import { EXPAND_MAX_EDGES } from "../format.js";
import { walkTree } from "../tree-walk.js";
import { expandAnswer } from "./helpers/expand-answer.js";

/**
 * How many `/v1/expand` requests the tree walk behind `ix depends` and
 * `ix trace` sends: one per visited node, asking for every predicate at once,
 * with the answer split by edge predicate into the lists the walk used to
 * fetch one predicate at a time. The tree must not change.
 */

const PREDICATES = ["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS"];
type Adjacency = Record<string, Record<string, any[]>>;

const fn = (id: string, path?: string) => ({ id, name: id, kind: "function", ...(path ? { provenance: { source_uri: path } } : {}) });

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

/** Random callers per predicate: shared nodes, cycles, repeats, dangling ids, self-loops. */
function randomGraph(seed: number, size: number, maxFanout: number): Adjacency {
  const rand = mulberry32(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  const nodeFor = (i: number): any => {
    const roll = (i * 7919 + seed) % 20;
    if (roll === 0) return { id: `n${i}`, name: "0123456789abcdef0123456789abcdef", kind: "function" };
    return fn(`n${i}`, roll < 8 ? undefined : `src/f${i % 5}.ts`);
  };
  const adjacency: Adjacency = {};
  for (let i = 0; i < size; i++) {
    const lists: Record<string, any[]> = {};
    for (const p of PREDICATES) lists[p] = Array.from({ length: pick(maxFanout + 1) }, () => nodeFor(pick(size)));
    adjacency[`n${i}`] = lists;
  }
  return adjacency;
}

/**
 * A client over `adjacency`. `splittable: false` answers a request for
 * several predicates without edges, as an answer the walk cannot split, so it
 * must fetch one predicate at a time: the walk as it was.
 */
function clientFor(adjacency: Adjacency, opts: { splittable?: boolean; edgeCap?: number; sortNodes?: boolean } = {}) {
  const expand = vi.fn(async (id: string, o: { direction: string; predicates: string[]; hops?: number }) => {
    const answer = expandAnswer(id, o.direction, adjacency[id], o.predicates);
    if (opts.sortNodes) {
      // A server that sorts nodes and hands back edges in an order of their own.
      answer.nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      answer.edges.reverse();
    }
    if (opts.splittable === false && o.predicates.length > 1) return { nodes: answer.nodes, edges: [] };
    if (opts.edgeCap !== undefined && answer.edges.length > opts.edgeCap) {
      const edges = answer.edges.slice(0, opts.edgeCap);
      const keep = new Set(edges.map((e) => e.src === id ? e.dst : e.src));
      return { nodes: answer.nodes.filter((n) => keep.has(n.id)), edges };
    }
    return answer;
  });
  return { client: { expand } as never, expand };
}

/** Requests per node id. */
function perNode(expand: ReturnType<typeof vi.fn>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [id] of expand.mock.calls) counts.set(id as string, (counts.get(id as string) ?? 0) + 1);
  return counts;
}

describe("ix depends: one expand per visited node", () => {
  it.each([1, 2, 3, 4, 5, 6])("asks once for every predicate, and builds the same tree (graph %i)", async (seed) => {
    const adjacency = randomGraph(seed, 40, 3);
    for (const bounds of [{ maxDepth: 3, maxNodes: 100 }, { maxDepth: 6, maxNodes: 10_000 }, { maxDepth: 4, maxNodes: 17 }]) {
      const now = clientFor(adjacency);
      const walk = await buildDependencyTree(now.client, "n0", bounds);

      const before = clientFor(adjacency, { splittable: false });
      const oracle = await buildDependencyTree(before.client, "n0", bounds);

      expect(walk, `seed ${seed} ${JSON.stringify(bounds)}`).toEqual(oracle);
      for (const [id, count] of perNode(now.expand)) expect(count, `requests for ${id}`).toBe(1);
      for (const [, o] of now.expand.mock.calls) {
        expect(o).toEqual({ direction: "in", predicates: PREDICATES, hops: 1 });
      }
      // The oracle really did walk one predicate at a time.
      const rootSingles = before.expand.mock.calls.filter(([id, o]) => id === "n0" && (o as any).predicates.length === 1);
      expect(rootSingles.map(([, o]) => (o as any).predicates[0])).toEqual(PREDICATES);
    }
  });

  it.each([1, 2, 3, 4, 5, 6])("builds the same tree when the server sorts nodes apart from edges (graph %i)", async (seed) => {
    // The one-predicate requests were read in `nodes` order: a sorted one.
    const adjacency = randomGraph(seed, 40, 3);
    const bounds = { maxDepth: 4, maxNodes: 17 };
    const now = clientFor(adjacency, { sortNodes: true });
    const before = clientFor(adjacency, { splittable: false, sortNodes: true });
    expect(await buildDependencyTree(now.client, "n0", bounds)).toEqual(await buildDependencyTree(before.client, "n0", bounds));
    for (const [id, count] of perNode(now.expand)) expect(count, `requests for ${id}`).toBe(1);
  });

  it("follows nodes order within a predicate when nodes do not follow the edges", async () => {
    const answer = {
      nodes: [fn("x"), fn("y"), fn("z")],
      edges: [
        { src: "z", dst: "root", predicate: "CALLS" },
        { src: "y", dst: "root", predicate: "IMPORTS" },
        { src: "x", dst: "root", predicate: "CALLS" },
      ],
    };
    const expand = vi.fn(async (id: string) => (id === "root" ? answer : { nodes: [], edges: [] }));
    const walk = await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => n.name)).toEqual(["x", "z", "y"]);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("skips an edge that does not touch the node instead of asking again", async () => {
    const answer = {
      nodes: [fn("a"), fn("b")],
      edges: [
        { src: "a", dst: "root", predicate: "CALLS" },
        { src: "a", dst: "b", predicate: "CALLS" },
        { src: "b", dst: "root", predicate: "IMPORTS" },
      ],
    };
    const expand = vi.fn(async (id: string) => (id === "root" ? answer : { nodes: [], edges: [] }));
    const walk = await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => `${n.name}:${n.relation}`)).toEqual(["a:called_by", "b:imported_by"]);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("still asks per predicate when only a stray edge reaches a listed node", async () => {
    const answer = {
      nodes: [fn("a"), fn("b")],
      edges: [
        { src: "a", dst: "root", predicate: "CALLS" },
        { src: "a", dst: "b", predicate: "CALLS" },
      ],
    };
    const expand = vi.fn(async (id: string) => (id === "root" ? answer : { nodes: [], edges: [] }));
    await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(expand).toHaveBeenCalledTimes(1 + PREDICATES.length);
  });

  it("lists a node reached through two predicates once, under the first", async () => {
    const adjacency: Adjacency = {
      root: { CALLS: [fn("a"), fn("b")], IMPORTS: [fn("b"), fn("c")], IMPLEMENTS: [fn("a")] },
    };
    const { client, expand } = clientFor(adjacency);
    const walk = await buildDependencyTree(client, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => `${n.name}:${n.relation}`)).toEqual(["a:called_by", "b:called_by", "c:imported_by"]);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("keeps one predicate's order when the backend interleaves predicates", async () => {
    // Edges come CALLS z, IMPORTS y, CALLS x: the CALLS list is still z, x.
    const answer = {
      nodes: [fn("z"), fn("y"), fn("x")],
      edges: [
        { src: "z", dst: "root", predicate: "CALLS" },
        { src: "y", dst: "root", predicate: "IMPORTS" },
        { src: "x", dst: "root", predicate: "CALLS" },
      ],
    };
    const expand = vi.fn(async (id: string) => (id === "root" ? answer : { nodes: [], edges: [] }));
    const walk = await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => n.name)).toEqual(["z", "x", "y"]);
  });

  it("does not list a self-loop the backend leaves out of nodes", async () => {
    const answer = {
      nodes: [fn("a")],
      edges: [
        { src: "root", dst: "root", predicate: "CALLS" },
        { src: "a", dst: "root", predicate: "REFERENCES" },
      ],
    };
    const expand = vi.fn(async (id: string) => (id === "root" ? answer : { nodes: [], edges: [] }));
    const walk = await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => `${n.name}:${n.relation}`)).toEqual(["a:referenced_by"]);
    expect(expand).toHaveBeenCalledTimes(1);
  });

  it("falls back to one expand per predicate when the combined answer may be cut", async () => {
    // Each predicate fits the server's edge cap alone; together they do not.
    const half = EXPAND_MAX_EDGES / 2 + 100;
    const adjacency: Adjacency = {
      hub: {
        CALLS: Array.from({ length: half }, (_, i) => fn(`c${i}`)),
        IMPORTS: Array.from({ length: half }, (_, i) => fn(`i${i}`)),
      },
    };
    const { client, expand } = clientFor(adjacency, { edgeCap: EXPAND_MAX_EDGES });
    const walk = await buildDependencyTree(client, "hub", { maxDepth: 1, maxNodes: 10_000 });
    expect(walk.tree).toHaveLength(2 * half);
    expect(walk.tree.slice(0, half).every((n) => n.relation === "called_by")).toBe(true);
    // The combined request, then one per predicate.
    expect(expand.mock.calls.map(([, o]) => (o as any).predicates)).toEqual([PREDICATES, ...PREDICATES.map((p) => [p])]);
  });

  it("falls back when the backend says it truncated the answer", async () => {
    const answer = { nodes: [fn("a")], edges: [{ src: "a", dst: "root", predicate: "CALLS" }], truncated: true };
    const expand = vi.fn(async (id: string, o: { predicates: string[] }) => {
      if (id !== "root") return { nodes: [], edges: [] };
      if (o.predicates.length > 1) return answer;
      return o.predicates[0] === "IMPORTS" ? { nodes: [fn("b")], edges: [] } : o.predicates[0] === "CALLS" ? { nodes: [fn("a")], edges: [] } : { nodes: [], edges: [] };
    });
    const walk = await buildDependencyTree({ expand } as never, "root", { maxDepth: 1 });
    expect(walk.tree.map((n) => n.name)).toEqual(["a", "b"]);
    expect(expand).toHaveBeenCalledTimes(1 + PREDICATES.length);
  });

  it("sends the single-predicate request it always did for one predicate", async () => {
    const adjacency: Adjacency = { root: { CALLS: [fn("a")] }, a: { CALLS: [fn("b")] } };
    const { client, expand } = clientFor(adjacency);
    await buildDependencyTree(client, "root", { predicates: ["CALLS"] });
    expect(expand.mock.calls.map(([id, o]) => [id, (o as any).predicates])).toEqual([["root", ["CALLS"]], ["a", ["CALLS"]], ["b", ["CALLS"]]]);
  });
});

describe("walkTree without expandAll", () => {
  it("still sends one expand per predicate, for callers that pass only expand", async () => {
    const adjacency: Adjacency = { root: { CALLS: [fn("a")], IMPORTS: [fn("b")] } };
    const expand = vi.fn(async (id: string, p: string) => ({ nodes: adjacency[id]?.[p] ?? [] }));
    const walk = await walkTree({
      rootId: "root", maxDepth: 2, maxNodes: 100, predicates: ["CALLS", "IMPORTS"], expand,
      makeNode: (n, p, { name }) => ({ id: n.id, name: `${name}:${p}`, children: [] as any[] }),
    });
    expect(walk.tree.map((n) => n.name)).toEqual(["a:CALLS", "b:IMPORTS"]);
    expect(expand.mock.calls.filter(([id]) => id === "root").map(([, p]) => p)).toEqual(["CALLS", "IMPORTS"]);
  });
});
