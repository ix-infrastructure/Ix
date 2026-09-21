// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import { buildDependencyTree, renderDependsLlm, traversalHint } from "../commands/depends.js";

/**
 * A graph where every node has two callers, so the cone is 2^depth. Both
 * bounds were `Infinity`, which on a hub means the caller pays for thousands
 * of nodes before seeing any of them.
 */
function infiniteFanout() {
  let served = 0;
  const client = {
    expand: vi.fn(async (id: string, opts: { predicates: string[] }) => {
      if (opts.predicates[0] !== "CALLS") return { nodes: [] };
      served += 1;
      return {
        nodes: [
          { id: `${id}-a`, name: `n${served}a`, kind: "function", attrs: { line_start: 1, line_end: 4 }, provenance: { source_uri: "src/a.ts" } },
          { id: `${id}-b`, name: `n${served}b`, kind: "function", attrs: { line_start: 1, line_end: 4 }, provenance: { source_uri: "src/b.ts" } },
        ],
      };
    }),
  } as never;
  return client;
}

describe("depends traversal bounds", () => {
  it("stops at depth 3 by default", async () => {
    const out = await buildDependencyTree(infiniteFanout(), "root");
    expect(out.maxDepthReached).toBe(3);
    expect(out.depthLimited).toBe(true);
  });

  it("stops at 100 nodes by default", async () => {
    const out = await buildDependencyTree(infiniteFanout(), "root", { maxDepth: 50 });
    expect(out.nodesVisited).toBeLessThanOrEqual(100);
    expect(out.truncated).toBe(true);
  });

  it("still takes a caller's own bounds", async () => {
    const out = await buildDependencyTree(infiniteFanout(), "root", { maxDepth: 1, maxNodes: 500 });
    expect(out.maxDepthReached).toBe(1);
    expect(out.nodesVisited).toBe(2);
  });

  it("does not call a depth stop a truncation", async () => {
    // With a default of 3 this fires on most leaf branches. Claiming nodes
    // were lost when the walk simply reached its bound is the dishonest half
    // of a bound.
    const empty = { expand: vi.fn(async () => ({ nodes: [] })) } as never;
    const out = await buildDependencyTree(empty, "root");
    expect(out.truncated).toBe(false);
    expect(out.depthLimited).toBe(false);
  });
});

describe("the ranking the cap applies", () => {
  it("keeps a followable node over a dangling one", async () => {
    const client = {
      expand: vi.fn(async (_id: string, opts: { predicates: string[] }) => {
        if (opts.predicates[0] !== "CALLS") return { nodes: [] };
        return {
          nodes: [
            { id: "x1", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "function" },
            { id: "x2", name: "handleLogin", kind: "function" },
            { id: "x3", name: "verify", kind: "function", provenance: { source_uri: "src/a.ts" } },
          ],
        };
      }),
    } as never;
    const out = await buildDependencyTree(client, "root", { maxDepth: 1, maxNodes: 2 });
    expect(out.tree.map((n) => n.name)).toEqual(["verify", "handleLogin"]);
    expect(out.truncated).toBe(true);
  });
});

describe("traversalHint", () => {
  it("names the cap when the cap is what cut", () => {
    expect(traversalHint(3, 100, { truncated: true, depthLimited: true }))
      .toBe("Node cap of 100 reached; nodes were dropped. Raise --cap, or start from a narrower target.");
  });

  it("says only that it stopped when it only stopped", () => {
    expect(traversalHint(3, 100, { truncated: false, depthLimited: true }))
      .toBe("Stopped descending at depth 3; there may be more below. Raise --depth to look further.");
  });

  it("reaches the record stream with the right code", () => {
    const target = { id: "t", name: "verify", kind: "function" };
    const capped = renderDependsLlm(target, [], true, 100, 3, { maxDepth: 3, maxNodes: 100, depthLimited: true });
    expect(capped.some((l) => l.startsWith("diagnostic code=truncated"))).toBe(true);

    const stopped = renderDependsLlm(target, [], false, 8, 3, { maxDepth: 3, maxNodes: 100, depthLimited: true });
    expect(stopped[0]).toContain("depth_limited=true");
    expect(stopped.some((l) => l.startsWith("diagnostic code=depth_limited"))).toBe(true);
  });
});
