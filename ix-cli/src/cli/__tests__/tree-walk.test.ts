// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import { buildDependencyTree, type DependencyNode } from "../commands/depends.js";
import { searchPath } from "../commands/trace.js";
import { isRawId } from "../resolve.js";
import { createLimiter, EXPAND_CONCURRENCY, walkTree } from "../tree-walk.js";
import { expandAnswer } from "./helpers/expand-answer.js";

/**
 * The walks behind `ix depends` and `ix trace` fetch breadth-first now. The
 * contract is that nobody can tell from the output unless the node cap cut the
 * walk: the depth-first walks they replaced are kept below, verbatim, as the
 * oracle.
 */

// ── Oracles: the implementations this replaced ──────────────────────

const PREDICATE_META: Record<string, { relation: DependencyNode["relation"]; sourceEdge: DependencyNode["sourceEdge"] }> = {
  CALLS:      { relation: "called_by",      sourceEdge: "CALLS" },
  IMPORTS:    { relation: "imported_by",    sourceEdge: "IMPORTS" },
  REFERENCES: { relation: "referenced_by", sourceEdge: "REFERENCES" },
  EXTENDS:    { relation: "extended_by",   sourceEdge: "EXTENDS" },
  IMPLEMENTS: { relation: "implemented_by", sourceEdge: "IMPLEMENTS" },
};
const DEPENDS_PREDICATES = Object.keys(PREDICATE_META);

function nodePriority(n: any): number {
  const name = n.name || n.attrs?.name || "";
  if (!name || isRawId(name)) return 2;
  return (n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path) ? 0 : 1;
}

/** `buildDependencyTree` as it was before the breadth-first walk. */
async function oldBuildDependencyTree(client: any, rootId: string, opts: { maxDepth: number; maxNodes: number }) {
  const { maxDepth, maxNodes } = opts;
  const activePredicates = DEPENDS_PREDICATES;
  const visited = new Set<string>([rootId]);
  let nodesVisited = 0;
  let truncated = false;
  let depthLimited = false;
  let maxDepthReached = 0;

  async function expand(nodeId: string, depth: number): Promise<DependencyNode[]> {
    if (depth > maxDepth) { depthLimited = true; return []; }
    if (nodesVisited >= maxNodes) { truncated = true; return []; }
    maxDepthReached = Math.max(maxDepthReached, depth);
    const expandResults = await Promise.all(
      activePredicates.map((p) => client.expand(nodeId, { direction: "in", predicates: [p], hops: 1 })),
    );
    const children: DependencyNode[] = [];
    const levelSeen = new Set<string>();
    const processNodes = async (rawNodes: any[], relation: DependencyNode["relation"], sourceEdge: DependencyNode["sourceEdge"]) => {
      const nodes = [...rawNodes].sort((a, b) => nodePriority(a) - nodePriority(b));
      for (const n of nodes) {
        if (nodesVisited >= maxNodes) { truncated = true; break; }
        if (levelSeen.has(n.id)) continue;
        const name = n.name || n.attrs?.name || "";
        const resolved = !!name && !isRawId(name);
        const isCycle = visited.has(n.id);
        nodesVisited++;
        levelSeen.add(n.id);
        visited.add(n.id);
        const child: DependencyNode = {
          id: n.id,
          name: resolved ? name : n.id.slice(0, 8),
          kind: n.kind ?? "unknown",
          resolved,
          relation,
          sourceEdge,
          path: n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path ?? undefined,
          children: [],
          ...(isCycle ? { cycle: true } : {}),
        };
        if (!isCycle && resolved) {
          child.children = await expand(n.id, depth + 1);
        }
        children.push(child);
      }
    };
    for (let i = 0; i < activePredicates.length; i++) {
      const meta = PREDICATE_META[activePredicates[i]];
      await processNodes(expandResults[i].nodes, meta.relation, meta.sourceEdge);
    }
    return children;
  }

  const tree = await expand(rootId, 1);
  return { tree, truncated, depthLimited, nodesVisited, maxDepthReached };
}

/** `searchPath` as it was before its queue was prefetched. */
async function oldSearchPath(client: any, fromId: string, toId: string, predicates: string[], maxDepth: number, maxNodes: number) {
  if (maxNodes < 1) return { path: null, cut: true, cutReason: "node-cap" };
  if (fromId === toId) return { path: [{ id: fromId, name: "", kind: "" }], cut: false };
  const nodeMap = new Map<string, { name: string; kind: string }>();
  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
  const visited = new Set<string>([fromId]);
  let depthCut = false;
  while (queue.length > 0) {
    const { id, path } = queue.shift()!;
    if (path.length - 1 >= maxDepth) { depthCut = true; continue; }
    const [outResult, inResult] = await Promise.all([
      client.expand(id, { direction: "out", predicates, hops: 1 }),
      client.expand(id, { direction: "in", predicates, hops: 1 }),
    ]);
    for (const n of [...outResult.nodes, ...inResult.nodes]) {
      if (visited.has(n.id)) continue;
      if (visited.size >= maxNodes) return { path: null, cut: true, cutReason: "node-cap" };
      visited.add(n.id);
      const name = n.name || n.attrs?.name || n.id.slice(0, 8);
      if (!nodeMap.has(n.id)) nodeMap.set(n.id, { name, kind: n.kind ?? "unknown" });
      if (n.id === toId) {
        return {
          path: [...path, n.id].map((nodeId) => {
            if (nodeId === fromId) return { id: nodeId, name: "", kind: "" };
            const meta = nodeMap.get(nodeId) ?? { name: nodeId.slice(0, 8), kind: "unknown" };
            return { id: nodeId, ...meta };
          }),
          cut: false,
        };
      }
      queue.push({ id: n.id, path: [...path, n.id] });
    }
  }
  return { path: null, cut: depthCut, cutReason: depthCut ? "depth" : undefined };
}

// ── Graphs and clients ──────────────────────────────────────────────

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

type Adjacency = Record<string, Record<string, any[]>>;

/**
 * Branching, shared children, cycles back to the root and to ancestors,
 * self-loops, one node under two predicates, and the node shapes the walk
 * treats differently: unresolved (raw-id or empty name), name only in attrs,
 * with and without a path.
 */
function randomGraph(seed: number, size: number, predicates: string[], maxFanout = 3): Adjacency {
  const rand = mulberry32(seed);
  const pick = (n: number) => Math.floor(rand() * n);
  const nodeFor = (i: number): any => {
    const roll = (i * 7919 + seed) % 20;
    const id = `n${i}`;
    if (roll === 0) return { id, name: `${String(i).padStart(4, "0")}d41d8cd98f00b204e9800998ecf8427e`, kind: "function" };
    if (roll === 1) return { id, name: "", kind: "function" };
    if (roll === 2) return { id, attrs: { name: `attr${i}` }, kind: "method" };
    if (roll < 8) return { id, name: `fn${i}`, kind: "function" };
    return { id, name: `fn${i}`, kind: "function", provenance: { source_uri: `src/f${i % 5}.ts` } };
  };
  const adjacency: Adjacency = {};
  for (let i = 0; i < size; i++) {
    const lists: Record<string, any[]> = {};
    for (const p of predicates) {
      const k = pick(maxFanout + 1);
      lists[p] = Array.from({ length: k }, () => nodeFor(pick(size)));
    }
    adjacency[`n${i}`] = lists;
  }
  return adjacency;
}

/**
 * A client over an adjacency, with optional per-request delays (so responses
 * come back out of order) and in-flight accounting.
 */
function clientFor(adjacency: Adjacency, delaySeed?: number) {
  const rand = delaySeed === undefined ? undefined : mulberry32(delaySeed);
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0, ids: [] as string[] };
  const client = {
    expand: vi.fn(async (id: string, opts: { direction?: string; predicates: string[] }) => {
      stats.calls++;
      stats.ids.push(id);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        if (rand) await new Promise((r) => setTimeout(r, Math.floor(rand() * 4)));
        return expandAnswer(id, opts.direction ?? "in", adjacency[id], opts.predicates);
      } finally {
        stats.inFlight--;
      }
    }),
  };
  return { client: client as never, stats };
}

/** Breadth-first listing of a tree: `depth:name` per node. */
function levelOrder(tree: Array<{ name: string; children: any[] }>): string[] {
  const out: string[] = [];
  let level = tree.map((n) => ({ n, d: 1 }));
  while (level.length > 0) {
    const next: typeof level = [];
    for (const { n, d } of level) {
      out.push(`${d}:${n.name}`);
      for (const c of n.children) next.push({ n: c, d: d + 1 });
    }
    level = next;
  }
  return out;
}

const UNBOUNDED = { maxDepth: Infinity, maxNodes: Infinity };

// ── Same output when no bound cuts ──────────────────────────────────

describe("the breadth-first walk reproduces the depth-first one", () => {
  it("on a hand-built graph with a shared child, a diamond and cycles", async () => {
    // root <- a, b;  a <- c;  c <- shared, and d under two predicates;
    // b <- shared, root (a cycle);  shared <- a (a cycle back up). The old
    // walk expands `shared` under `c`, its first occurrence in pre-order, at
    // depth 3, and marks it a cycle under `b` at depth 2 — a level-order walk
    // would do it the other way round.
    const fn = (id: string) => ({ id, name: id, kind: "function", provenance: { source_uri: `src/${id}.ts` } });
    const adjacency: Adjacency = {
      root: { CALLS: [fn("a"), fn("b")] },
      a: { CALLS: [fn("c")] },
      c: { CALLS: [fn("shared"), fn("d")], REFERENCES: [fn("d")] },
      b: { CALLS: [fn("shared"), fn("root")] },
      shared: { REFERENCES: [fn("a")] },
    };
    for (const bounds of [UNBOUNDED, { maxDepth: 2, maxNodes: Infinity }, { maxDepth: 3, maxNodes: 100 }]) {
      const expected = await oldBuildDependencyTree(clientFor(adjacency).client, "root", bounds);
      const actual = await buildDependencyTree(clientFor(adjacency).client, "root", bounds);
      expect(actual).toEqual(expected);
    }
    const walk = await buildDependencyTree(clientFor(adjacency).client, "root", UNBOUNDED);
    const c = walk.tree[0].children[0];
    expect(c.children.map((n) => [n.name, n.relation, !!n.cycle])).toEqual([["shared", "called_by", false], ["d", "called_by", false]]);
    expect(c.children[0].children.map((n) => [n.name, !!n.cycle])).toEqual([["a", true]]);
    expect(walk.tree[1].children.map((n) => [n.name, !!n.cycle])).toEqual([["shared", true], ["root", true]]);
  });

  it("on random graphs, unbounded and depth-limited, for every counter and every node", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const adjacency = randomGraph(seed, 12 + (seed % 25), DEPENDS_PREDICATES);
      for (const maxDepth of [Infinity, 1, 2, 3, 5]) {
        const bounds = { maxDepth, maxNodes: Infinity };
        const expected = await oldBuildDependencyTree(clientFor(adjacency).client, "n0", bounds);
        const actual = await buildDependencyTree(clientFor(adjacency).client, "n0", bounds);
        expect(actual, `seed ${seed} depth ${maxDepth}`).toEqual(expected);
      }
    }
  });

  it("whenever the cap does not cut the breadth-first walk", async () => {
    let compared = 0;
    let exact = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const adjacency = randomGraph(seed, 20, DEPENDS_PREDICATES, 1);
      for (const maxNodes of [0, 1, 5, 10, 20, 40, 80, 160]) {
        const bounds = { maxDepth: 3, maxNodes };
        const actual = await buildDependencyTree(clientFor(adjacency).client, "n0", bounds);
        if (actual.truncated) continue;
        compared++;
        const expected = await oldBuildDependencyTree(clientFor(adjacency).client, "n0", bounds);
        // The one deliberate difference: the old walk said `truncated` when
        // the cap was spent exactly on the last node, though nothing was left.
        if (expected.truncated) {
          exact++;
          expect(expected.nodesVisited).toBe(maxNodes);
        }
        expect(actual, `seed ${seed} cap ${maxNodes}`).toEqual({ ...expected, truncated: false });
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(exact).toBeGreaterThan(0);
  });

  it("the same tree however the responses are ordered in time", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const adjacency = randomGraph(seed, 30, DEPENDS_PREDICATES);
      for (const bounds of [UNBOUNDED, { maxDepth: 3, maxNodes: 25 }]) {
        const inOrder = await buildDependencyTree(clientFor(adjacency).client, "n0", bounds);
        for (const delaySeed of [11, 12, 13]) {
          const shuffled = await buildDependencyTree(clientFor(adjacency, delaySeed * seed).client, "n0", bounds);
          expect(shuffled, `seed ${seed} delays ${delaySeed}`).toEqual(inOrder);
        }
      }
    }
  });
});

// ── Cap semantics under level order ─────────────────────────────────

describe("when the node cap cuts the walk", () => {
  const fn = (id: string) => ({ id, name: id, kind: "function", provenance: { source_uri: `src/${id}.ts` } });
  // root <- a, b, c;  a <- a1 <- a2 <- a3;  b <- b1
  const adjacency: Adjacency = {
    root: { CALLS: [fn("a"), fn("b"), fn("c")] },
    a: { CALLS: [fn("a1")] },
    a1: { CALLS: [fn("a2")] },
    a2: { CALLS: [fn("a3")] },
    b: { CALLS: [fn("b1")] },
  };

  it("keeps the shallowest nodes, where depth-first kept the first branch", async () => {
    const bounds = { maxDepth: 10, maxNodes: 4 };
    const old = await oldBuildDependencyTree(clientFor(adjacency).client, "root", bounds);
    expect(levelOrder(old.tree)).toEqual(["1:a", "2:a1", "3:a2", "4:a3"]);

    const walk = await buildDependencyTree(clientFor(adjacency).client, "root", bounds);
    expect(levelOrder(walk.tree)).toEqual(["1:a", "1:b", "1:c", "2:a1"]);
    expect(walk).toMatchObject({ nodesVisited: 4, maxDepthReached: 2, truncated: true, depthLimited: false });
  });

  it("is a prefix of the next larger cap's walk, level by level", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const graph = randomGraph(seed, 40, DEPENDS_PREDICATES);
      let previous: string[] | undefined;
      for (let cap = 1; cap <= 60; cap++) {
        const walk = await buildDependencyTree(clientFor(graph).client, "n0", { maxDepth: 4, maxNodes: cap });
        if (!walk.truncated) break;
        expect(walk.nodesVisited).toBe(cap);
        const order = levelOrder(walk.tree);
        expect(order).toHaveLength(cap);
        if (previous) expect(order.slice(0, previous.length), `seed ${seed} cap ${cap}`).toEqual(previous);
        previous = order;
      }
    }
  });

  it("reports the depth bound only for kept nodes it stopped descending into", async () => {
    // cap 4 keeps a, b, c, a1 and drops b1; a1 sits at the depth limit of 2
    // and has a caller, so the walk stopped descending there as well.
    const both = await buildDependencyTree(clientFor(adjacency).client, "root", { maxDepth: 2, maxNodes: 4 });
    expect(levelOrder(both.tree)).toEqual(["1:a", "1:b", "1:c", "2:a1"]);
    expect(both).toMatchObject({ nodesVisited: 4, maxDepthReached: 2, truncated: true, depthLimited: true });

    // cap 3 is spent on the first level: nothing kept reached the depth limit.
    const capOnly = await buildDependencyTree(clientFor(adjacency).client, "root", { maxDepth: 2, maxNodes: 3 });
    expect(capOnly).toMatchObject({ nodesVisited: 3, maxDepthReached: 1, truncated: true, depthLimited: false });
  });

  it("does not claim a cut when the budget is spent exactly and nothing is left below", async () => {
    // Four nodes in all; a cap of four keeps all of them.
    const small: Adjacency = { root: { CALLS: [fn("a"), fn("b")] }, a: { CALLS: [fn("a1"), fn("a2")] } };
    const walk = await buildDependencyTree(clientFor(small).client, "root", { maxDepth: 10, maxNodes: 4 });
    expect(walk.nodesVisited).toBe(4);
    expect(walk.truncated).toBe(false);
  });

  it("stops requesting once the cap is reached", async () => {
    // Every node has two callers, forever.
    const fanout = () => ({
      expand: vi.fn(async (id: string, opts: { direction?: string; predicates: string[] }) =>
        expandAnswer(id, opts.direction ?? "in", { CALLS: [fn(`${id}.a`), fn(`${id}.b`)] }, opts.predicates)),
    });
    const bounds = { maxDepth: 50, maxNodes: 100 };
    const client = fanout();
    const walk = await buildDependencyTree(client as never, "root", bounds);
    expect(walk.truncated).toBe(true);
    const sent = client.expand.mock.calls.length;
    const expanded = new Set(client.expand.mock.calls.map(([id]) => id));
    // Level order reads 1 + 2 + 4 + 8 + 16 nodes and 19 of the next 32
    // before the 100th kept node: 50. Past that is only prefetches of nodes
    // the walk kept: one request for each (all predicates at once), and none
    // for a node beyond the cap. How far the prefetch runs ahead of the reads
    // depends on response timing, so it is bounded by the kept nodes.
    expect(expanded.size).toBeGreaterThanOrEqual(50);
    const kept = new Set<string>(["root"]);
    const collect = (nodes: DependencyNode[]): void => { for (const n of nodes) { kept.add(n.id); collect(n.children); } };
    collect(walk.tree);
    expect([...expanded].filter((id) => !kept.has(id))).toEqual([]);
    expect(sent).toBe(expanded.size);
    // Nothing still queued goes out once the walk has returned.
    await new Promise((r) => setTimeout(r, 5));
    expect(client.expand.mock.calls.length).toBe(sent);

    // The depth-first walk spent the same budget on 73 expansions, most of
    // them one long branch, at one request per predicate each.
    const old = fanout();
    await oldBuildDependencyTree(old, "root", bounds);
    expect(new Set(old.expand.mock.calls.map(([id]) => id)).size).toBe(73);
    expect(old.expand.mock.calls.length).toBe(73 * 5);
  });
});

// ── Bounded concurrency ─────────────────────────────────────────────

describe("in-flight requests", () => {
  it(`never exceed ${EXPAND_CONCURRENCY}, and the walk does use them`, async () => {
    const adjacency = randomGraph(7, 200, DEPENDS_PREDICATES, 6);
    const { client, stats } = clientFor(adjacency, 99);
    await buildDependencyTree(client, "n0", { maxDepth: 4, maxNodes: 500 });
    expect(stats.maxInFlight).toBeLessThanOrEqual(EXPAND_CONCURRENCY);
    expect(stats.maxInFlight).toBe(EXPAND_CONCURRENCY);
  });

  it("hold across walks that share a limiter", async () => {
    const adjacency = randomGraph(8, 200, ["CALLS"], 6);
    const { client, stats } = clientFor(adjacency, 5);
    const limiter = createLimiter(3);
    const walk = (rootId: string) => walkTree({
      rootId, maxDepth: 4, maxNodes: 200, predicates: ["CALLS"], limiter,
      expand: (id, p) => (client as any).expand(id, { predicates: [p] }),
      makeNode: (n, _p, { name }) => ({ id: n.id, name, children: [] as any[] }),
    });
    await Promise.all([walk("n0"), walk("n1"), walk("n2")]);
    expect(stats.maxInFlight).toBe(3);
  });

  it("the limiter runs tasks in the order they were queued", async () => {
    const limit = createLimiter(2);
    const started: number[] = [];
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => limit(async () => {
      started.push(i);
      await new Promise((r) => setTimeout(r, (6 - i) % 3));
    })));
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

// ── Failures ────────────────────────────────────────────────────────

describe("a failed expand", () => {
  it("still rejects the walk, and a prefetch nobody reads does not crash the process", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const client = {
        expand: vi.fn(async (id: string) => {
          if (id === "bad") throw new Error("500: boom");
          return { nodes: id === "root" ? [{ id: "bad", name: "bad", kind: "function" }, { id: "ok", name: "ok", kind: "function" }] : [] };
        }),
      };
      await expect(buildDependencyTree(client as never, "root", UNBOUNDED)).rejects.toThrow("500: boom");
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

// ── Path mode ───────────────────────────────────────────────────────

describe("trace --to with a prefetched queue", () => {
  it("returns the route, cut and reason the one-at-a-time search did", async () => {
    let compared = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const adjacency = randomGraph(seed, 40, ["out", "in"], 2);
      const directed = (a: Adjacency) => ({
        expand: async (id: string, opts: { direction: string }) => ({ nodes: a[id]?.[opts.direction] ?? [], edges: [] }),
      });
      const shuffled = (a: Adjacency, s: number) => {
        const rand = mulberry32(s);
        return {
          expand: async (id: string, opts: { direction: string }) => {
            await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
            return { nodes: a[id]?.[opts.direction] ?? [], edges: [] };
          },
        };
      };
      for (const [to, maxDepth, maxNodes] of [["n7", 10, 100], ["n13", 3, 100], ["n21", 10, 8], ["n39", 2, 1000]] as const) {
        const expected = await oldSearchPath(directed(adjacency), "n0", to, ["X"], maxDepth, maxNodes);
        expect(await searchPath(directed(adjacency) as never, "n0", to, ["X"], maxDepth, maxNodes)).toEqual(expected);
        expect(await searchPath(shuffled(adjacency, seed) as never, "n0", to, ["X"], maxDepth, maxNodes)).toEqual(expected);
        compared++;
      }
    }
    expect(compared).toBe(160);
  });

  it(`keeps at most ${EXPAND_CONCURRENCY} requests in flight`, async () => {
    const adjacency = randomGraph(3, 300, ["out", "in"], 5);
    const { stats } = clientFor(adjacency);
    let inFlight = 0;
    const client = {
      expand: async (id: string, opts: { direction: string }) => {
        inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { nodes: adjacency[id]?.[opts.direction] ?? [], edges: [] };
      },
    };
    await searchPath(client as never, "n0", "nowhere", ["X"], 4, 1000);
    expect(stats.maxInFlight).toBe(EXPAND_CONCURRENCY);
  });
});
