// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { buildBundle, clampBudgets, renderBundle } from "../commands/context.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import { collectRelatedFiles, isTestPath, type RelatedRef } from "../explain/related-files.js";

/**
 * `collectRelatedFiles` against a small in-memory graph.
 *
 * Each case is one of the shapes the ix-bench bundles missed, or one of the
 * ways a two-hop walk goes wrong: a hub everything reaches, a test that bridges
 * to everything, a file the bundle already names.
 */

type Edge = { src: string; dst: string; predicate: string };
type Node = { id: string; kind: string; name: string; provenance: { sourceUri: string } };

class Graph {
  nodes = new Map<string, Node>();
  edges: Edge[] = [];

  file(path: string): string {
    const id = `file:${path}`;
    this.nodes.set(id, { id, kind: "file", name: path.split("/").pop()!, provenance: { sourceUri: path } });
    return id;
  }

  fn(path: string, name: string): string {
    const id = `fn:${path}:${name}`;
    this.nodes.set(id, { id, kind: "function", name, provenance: { sourceUri: path } });
    this.edge(`file:${path}`, id, "CONTAINS");
    return id;
  }

  edge(src: string, dst: string, predicate: string): void {
    this.edges.push({ src, dst, predicate });
  }

  /** `/v1/expand`: breadth-first over the given predicates and direction. */
  client() {
    return {
      expand: async (id: string, opts?: { direction?: string; predicates?: string[]; hops?: number }) => {
        const direction = opts?.direction ?? "both";
        const hops = opts?.hops ?? 1;
        const allowed = (e: Edge) => !opts?.predicates || opts.predicates.includes(e.predicate);
        const seen = new Set([id]);
        const edges: Edge[] = [];
        let frontier = [id];
        for (let hop = 0; hop < hops; hop++) {
          const next: string[] = [];
          for (const at of frontier) {
            for (const e of this.edges.filter(allowed)) {
              const out = direction !== "in" && e.src === at ? e.dst : undefined;
              const inn = direction !== "out" && e.dst === at ? e.src : undefined;
              for (const other of [out, inn]) {
                if (!other) continue;
                if (!edges.includes(e)) edges.push(e);
                if (!seen.has(other)) {
                  seen.add(other);
                  next.push(other);
                }
              }
            }
          }
          frontier = next;
        }
        seen.delete(id);
        return { nodes: [...seen].map((n) => this.nodes.get(n)!).filter(Boolean), edges };
      },
    };
  }
}

const loc = (g: Graph, id: string): EntityLocation => {
  const n = g.nodes.get(id)!;
  return { id, name: n.name, kind: n.kind, path: n.provenance.sourceUri };
};

describe("collectRelatedFiles", () => {
  it("finds a caller's import for a symbol target, and says which caller's file led there", async () => {
    // parseBudgetOption is called from context.ts, which imports the schema
    // the new flag has to be added to. options.ts itself never touches it.
    const g = new Graph();
    g.file("src/options.ts");
    const target = g.fn("src/options.ts", "parseBudgetOption");
    g.file("src/context.ts");
    const caller = g.fn("src/context.ts", "registerContextCommand");
    g.edge(caller, target, "CALLS");
    g.file("src/schema.ts");
    g.edge("file:src/context.ts", "file:src/schema.ts", "IMPORTS");

    const related = await collectRelatedFiles(g.client(), { id: target, kind: "function" }, {
      path: "src/options.ts",
      topCallerRefs: [loc(g, caller)],
    });

    const schema = related.find((r) => r.path === "src/schema.ts");
    expect(schema).toBeDefined();
    expect(schema!.via).toContain("context.ts");
    expect(related.map((r) => r.path)).not.toContain("src/options.ts");
  });

  it("ranks a sibling sharing a rare callee above one sharing only a common helper", async () => {
    // inventory.ts and rank.ts both call listByKind (two callers); trace.ts
    // shares only resolveWorkspaceId, which every command calls.
    const g = new Graph();
    g.file("src/api.ts");
    const listByKind = g.fn("src/api.ts", "listByKind");
    g.file("src/bootstrap.ts");
    const common = g.fn("src/bootstrap.ts", "resolveWorkspaceId");
    g.file("src/inventory.ts");
    const inventory = g.fn("src/inventory.ts", "registerInventoryCommand");
    g.edge(inventory, listByKind, "CALLS");
    g.edge(inventory, common, "CALLS");
    g.file("src/rank.ts");
    const rank = g.fn("src/rank.ts", "registerRankCommand");
    g.edge(rank, listByKind, "CALLS");
    g.edge(rank, common, "CALLS");
    for (const name of ["trace", "read", "overview", "impact", "callers", "depends"]) {
      g.file(`src/${name}.ts`);
      g.edge(g.fn(`src/${name}.ts`, `register_${name}`), common, "CALLS");
    }

    const related = await collectRelatedFiles(g.client(), { id: "file:src/inventory.ts", kind: "file" }, {
      path: "src/inventory.ts",
      memberRefs: [loc(g, inventory)],
      // What the facts collector already names: the target's callees' files.
      calleeRefs: [loc(g, listByKind), loc(g, common)],
    });

    expect(related[0]?.path).toBe("src/rank.ts");
    expect(related[0]?.via).toContain("listByKind");
    // Already one hop out, so not spent on a related slot.
    expect(related.map((r) => r.path)).not.toContain("src/api.ts");
    expect(related.map((r) => r.path)).not.toContain("src/bootstrap.ts");
  });

  it("does not let a test that touches everything outrank a real neighbour", async () => {
    const g = new Graph();
    g.file("src/watch.ts");
    const watch = g.fn("src/watch.ts", "registerWatchCommand");
    g.file("src/extensions.ts");
    const exts = g.fn("src/extensions.ts", "SUPPORTED_EXTENSIONS");
    g.edge(watch, exts, "REFERENCES");
    g.file("src/walker.ts");
    g.edge(g.fn("src/walker.ts", "walk"), exts, "REFERENCES");
    g.file("src/__tests__/everything.test.ts");
    const test = g.fn("src/__tests__/everything.test.ts", "suite");
    g.edge(test, watch, "CALLS");
    g.edge(test, exts, "CALLS");
    for (let i = 0; i < 5; i++) {
      g.file(`src/unrelated${i}.ts`);
      g.edge(test, g.fn(`src/unrelated${i}.ts`, `u${i}`), "CALLS");
    }

    const related = await collectRelatedFiles(g.client(), { id: "file:src/watch.ts", kind: "file" }, {
      path: "src/watch.ts",
      memberRefs: [loc(g, watch)],
    });

    const order = related.map((r) => r.path);
    expect(order.indexOf("src/walker.ts")).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 5; i++) {
      const u = order.indexOf(`src/unrelated${i}.ts`);
      if (u >= 0) expect(u).toBeGreaterThan(order.indexOf("src/walker.ts"));
    }
  });

  it("divides a file by its import degree, so a hub needs more than one path", async () => {
    const g = new Graph();
    g.file("src/target.ts");
    const t = g.fn("src/target.ts", "doThing");
    g.file("src/helper.ts");
    const helper = g.fn("src/helper.ts", "shared");
    g.edge(t, helper, "CALLS");
    g.file("src/peer.ts");
    g.edge(g.fn("src/peer.ts", "peer"), helper, "CALLS");
    g.file("src/format.ts");
    g.edge(g.fn("src/format.ts", "fmt"), helper, "CALLS");
    for (let i = 0; i < 30; i++) g.edge(g.file(`src/cmd${i}.ts`), "file:src/format.ts", "IMPORTS");

    const related = await collectRelatedFiles(g.client(), { id: "file:src/target.ts", kind: "file" }, {
      path: "src/target.ts",
      memberRefs: [loc(g, t)],
      calleeRefs: [loc(g, helper)],
    });
    const order = related.map((r) => r.path);
    expect(order.indexOf("src/peer.ts")).toBeLessThan(order.indexOf("src/format.ts"));
  });

  it("returns nothing, rather than failing, when the graph cannot be read", async () => {
    const client = { expand: async () => { throw new Error("backend down"); } };
    await expect(collectRelatedFiles(client, { id: "x", kind: "file" }, { path: "a.ts" })).resolves.toEqual([]);
  });

  it("treats fixtures as test data", () => {
    expect(isTestPath("core-ingestion/test-fixtures/typescript/sample-command.ts")).toBe(true);
    expect(isTestPath("src/__tests__/a.test.ts")).toBe(true);
    expect(isTestPath("src/cli/commands/test.ts")).toBe(false);
  });
});

describe("related files in a bundle", () => {
  const MEMBERS: EntityLocation[] = Array.from({ length: 8 }, (_, i) => ({
    id: `m-${i}`, name: `member${i}`, kind: "function", path: "src/inventory.ts", lineStart: i * 10 + 1, lineEnd: i * 10 + 5,
  }));
  const facts = (relatedRefs: RelatedRef[]): ContextFacts => ({
    id: "f", name: "inventory.ts", kind: "file", path: "src/inventory.ts",
    members: MEMBERS.map((m) => m.name),
    memberRefs: MEMBERS,
    memberCount: MEMBERS.length, callerCount: 0, calleeCount: 0, dependentCount: 0, importerCount: 0,
    topCallers: [], topDependents: [], historyLength: 1, introducedRev: 1, stale: false, diagnostics: [],
    relatedRefs,
  });
  const rank: RelatedRef = {
    id: "file:src/rank.ts", name: "rank.ts", kind: "file", path: "src/rank.ts",
    score: 1, reason: "two steps from the target, through listByKind", via: ["listByKind"],
  };
  const peer: RelatedRef = {
    id: "file:src/peer.ts", name: "peer.ts", kind: "file", path: "src/peer.ts",
    score: 0.5, reason: "linked to the target directly", via: [],
  };

  function build(refs: RelatedRef[]) {
    return buildBundle({
      resolved: { id: "f", name: "inventory.ts", kind: "file", resolutionMode: "exact" },
      facts: facts(refs),
      context: {
        claims: [], conflicts: [], decisions: [], intents: [], nodes: [], edges: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {},
      budgets: clampBudgets({}),
      isStale: () => false,
    });
  }

  it("names every related file in one evidence row, with what connects it", () => {
    const bundle = build([rank, peer]);
    const rows = bundle.evidence.filter((e) => e.source === "facts.related");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("related files: src/rank.ts, src/peer.ts");
    expect(rows[0].reason).toContain("rank.ts via listByKind");
    expect(rows[0].reason).toContain("peer.ts directly");
    expect(rows[0].refs).toEqual(["file:src/rank.ts", "file:src/peer.ts"]);
    expect(bundle.entities.map((e) => e.path)).toContain("src/rank.ts");
  });

  it("puts the row after the leading members and ahead of the rest, and prints the paths", () => {
    const bundle = build([rank]);
    const titles = bundle.evidence.map((e) => e.title);
    const at = titles.findIndex((t) => t.startsWith("related files:"));
    expect(at).toBeGreaterThan(titles.indexOf("member member4"));
    expect(at).toBeLessThan(titles.indexOf("member member5"));

    const lines: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      renderBundle(bundle, "text");
    } finally {
      console.log = orig;
    }
    expect(lines.join("\n")).toContain("src/rank.ts");
  });

  it("adds no row when nothing was found", () => {
    expect(build([]).evidence.some((e) => e.source === "facts.related")).toBe(false);
  });
});
