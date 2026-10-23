// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect, vi } from "vitest";
import { baseScore, resolveEntityFull, scoreCandidate } from "../resolve.js";
import { rankScore, searchSort } from "../commands/search.js";

// Graph reads refuse a directory no workspace covers (workspace_not_mapped),
// and this suite runs from a checkout that is not registered anywhere. It is
// about resolution, not scoping, so the directory counts as mapped here.
vi.mock("../bootstrap.js", async (orig) => ({
  ...(await orig<typeof import("../bootstrap.js")>()),
  resolveWorkspaceId: () => "ws-test",
}));


describe("search ranking with backend weight", () => {
  it("assigns tier 0-1 for exact name match with backend weight 100", () => {
    // Weight comes through attrs (as it does from real backend after parseNode)
    const node = { name: "IngestionService", kind: "class", attrs: { _search_weight: 100 } };
    const result = rankScore(node, "IngestionService", "class", undefined);
    // nameScore: exact 0, --kind -5, container -3, type-like -4 = -12
    expect(result.tier).toBe(0);
    expect(result.matchSource).toBe("name_exact");
  });

  it("assigns tier 3 for partial name match with backend weight 60", () => {
    const node = { name: "IngestionServiceImpl", kind: "class", attrs: { _search_weight: 60 } };
    const result = rankScore(node, "Ingestion", undefined, undefined);
    expect(result.tier).toBe(3);
    expect(result.matchSource).toBe("name_partial");
  });

  it("assigns tier 4 for provenance match with backend weight 40", () => {
    const node = { name: "unrelated", kind: "file", attrs: { _search_weight: 40 } };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(4);
    expect(result.matchSource).toBe("provenance");
  });

  it("assigns tier 4 for claim/decision match with backend weight 20", () => {
    const node = { name: "something", kind: "decision", attrs: { _search_weight: 20 } };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(4);
    expect(result.matchSource).toBe("claim_or_decision");
  });

  it("assigns tier 5 for no backend weight and fuzzy resolver match", () => {
    const node = { name: "totally_different", kind: "function" };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(5);
    expect(result.matchSource).toBe("attrs");
  });

  it("sorts exact matches above partial matches", () => {
    const exact = { name: "Node", kind: "class", attrs: { _search_weight: 100 } };
    const partial = { name: "NodeImpl", kind: "class", attrs: { _search_weight: 60 } };
    const rExact = rankScore(exact, "Node", undefined, undefined);
    const rPartial = rankScore(partial, "Node", undefined, undefined);
    expect(rExact.tier).toBeLessThan(rPartial.tier);
  });

  it("reads weight from attrs (real backend path) not top-level", () => {
    // This is the critical test: weight MUST come through attrs to survive
    // the parseNode → GraphNode → JSON serialization pipeline
    const nodeWithAttrsWeight = { name: "Node", kind: "class", attrs: { _search_weight: 100 } };
    const nodeWithTopLevelWeight = { name: "Node", kind: "class", _search_weight: 100 };
    const nodeWithNoWeight = { name: "Node", kind: "class", attrs: {} };

    const r1 = rankScore(nodeWithAttrsWeight, "Node", undefined, undefined);
    const r2 = rankScore(nodeWithTopLevelWeight, "Node", undefined, undefined);
    const r3 = rankScore(nodeWithNoWeight, "Node", undefined, undefined);

    // Both attrs and top-level paths should work (fallback chain)
    expect(r1.tier).toBe(0);
    expect(r1.matchSource).toBe("name_exact");
    expect(r2.tier).toBe(0);
    expect(r2.matchSource).toBe("name_exact");
    // No weight → falls through to resolver
    expect(r3.matchSource).toBe("resolver");
  });
});

describe("rankScore thresholds", () => {
  const w = (weight: number) => ({ _search_weight: weight });
  const rank = (node: any, term: string, kind?: string, path?: string) => rankScore(node, term, kind, path);

  it("weight 100: nameScore <= -3 is tier 0", () => {
    const r = rank({ name: "widget", kind: "class", attrs: w(100) }, "widget");
    expect(r).toMatchObject({ tier: 0, score: -103, matchSource: "name_exact" });
  });

  it("weight 100: nameScore -1 is tier 1", () => {
    const r = rank({ name: "parse", kind: "function", attrs: w(100) }, "parse");
    expect(r).toMatchObject({ tier: 1, score: -101, matchSource: "name_exact" });
  });

  // Each nameScore cut is pinned from both sides: -3 is tier 0 but -2 is not,
  // 0 is tier 1 but 1 is not, 2 is tier 2 but 3 is not.
  const halfPathChunk = { name: "parse", kind: "chunk", provenance: { sourceUri: "src/abcd" } };

  it("weight 100: nameScore -2 (chunk, half-length path match) is tier 1", () => {
    expect(baseScore(halfPathChunk, "parse", { path: "src/" })).toBe(-2);
    const r = rank({ ...halfPathChunk, attrs: w(100) }, "parse", undefined, "src/");
    expect(r).toMatchObject({ tier: 1, score: -102, matchSource: "name_exact" });
  });

  it("weight 100: nameScore 0 (exact name, no kind boost) is tier 1", () => {
    expect(baseScore({ name: "parse", kind: "variable" }, "parse")).toBe(0);
    const r = rank({ name: "parse", kind: "variable", attrs: w(100) }, "parse");
    expect(r).toMatchObject({ tier: 1, score: -100, matchSource: "name_exact" });
  });

  it("weight 100: nameScore 1 (chunk, weak path match) is tier 2", () => {
    const node = {
      name: "parse",
      kind: "chunk",
      provenance: { sourceUri: "src/some/deeply/nested/directory/structure/file.ts" },
      attrs: w(100),
    };
    expect(baseScore(node, "parse", { path: "src" })).toBe(1);
    const r = rank(node, "parse", undefined, "src");
    expect(r).toMatchObject({ tier: 2, score: -99, matchSource: "name_exact" });
  });

  it("weight 100: nameScore 5 is tier 2", () => {
    const r = rank({ name: "parse", kind: "chunk", attrs: w(100) }, "parse");
    expect(r).toMatchObject({ tier: 2, score: -95, matchSource: "name_exact" });
  });

  it("weights 99 and 60 are tier 3 name_partial", () => {
    for (const weight of [99, 60]) {
      const r = rank({ name: "widgetFactory", kind: "class", attrs: w(weight) }, "widget");
      expect(r.tier).toBe(3);
      expect(r.matchSource).toBe("name_partial");
    }
  });

  it("weights 59 and 40 are tier 4 provenance", () => {
    for (const weight of [59, 40]) {
      const r = rank({ name: "other", kind: "file", attrs: w(weight) }, "widget");
      expect(r).toMatchObject({ tier: 4, score: -weight, matchSource: "provenance" });
    }
  });

  it("weights 39 and 20 are tier 4 claim_or_decision", () => {
    for (const weight of [39, 20]) {
      const r = rank({ name: "other", kind: "decision", attrs: w(weight) }, "widget");
      expect(r).toMatchObject({ tier: 4, score: -weight, matchSource: "claim_or_decision" });
    }
  });

  it("weight 19 falls through to the resolver", () => {
    const r = rank({ name: "widget", kind: "class", attrs: w(19) }, "widget");
    expect(r).toMatchObject({ tier: 0, score: -3, matchSource: "resolver" });
  });

  it("no weight: exact function (nameScore -1) is tier 1", () => {
    const r = rank({ name: "parse", kind: "function" }, "parse");
    expect(r).toMatchObject({ tier: 1, score: -1, matchSource: "resolver" });
  });

  it("no weight: nameScore -2 is tier 1", () => {
    const r = rank(halfPathChunk, "parse", undefined, "src/");
    expect(r).toMatchObject({ tier: 1, score: -2, matchSource: "resolver" });
  });

  it("no weight: nameScore 0 is tier 1", () => {
    const r = rank({ name: "parse", kind: "variable" }, "parse");
    expect(r).toMatchObject({ tier: 1, score: 0, matchSource: "resolver" });
  });

  it("no weight: nameScore 1 (chunk with a weak path match) is tier 2", () => {
    const node = {
      name: "parse",
      kind: "chunk",
      provenance: { sourceUri: "src/some/deeply/nested/directory/structure/file.ts" },
    };
    const r = rank(node, "parse", undefined, "src");
    expect(r).toMatchObject({ tier: 2, score: 1, matchSource: "resolver" });
  });

  it("no weight: nameScore 2 is tier 2 and nameScore 3 is tier 5", () => {
    // Prefix 15, --kind class -5, container -3, path bonus -4 minus 1 or 0.
    const near = { name: "widgetFactory", kind: "class", provenance: { sourceUri: "lib/widgets/widgetFactory.ts" } };
    const far = { name: "widgetFactory", kind: "class", provenance: { sourceUri: "lib/widgets/factory/deeply/nested/widgetFactory.ts" } };
    expect(baseScore(near, "widget", { kind: "class", path: "lib/" })).toBe(2);
    expect(baseScore(far, "widget", { kind: "class", path: "l" })).toBe(3);
    expect(rank(near, "widget", "class", "lib/")).toMatchObject({ tier: 2, score: 2, matchSource: "resolver" });
    expect(rank(far, "widget", "class", "l")).toMatchObject({ tier: 5, score: 3, matchSource: "attrs" });
  });

  it("no weight: exact chunk with no path (nameScore 5) is tier 5", () => {
    const r = rank({ name: "parse", kind: "chunk" }, "parse");
    expect(r).toMatchObject({ tier: 5, score: 5, matchSource: "attrs" });
  });

  it("promotes a defining file whose stem matches the term (file_stem)", () => {
    const node = {
      name: "borderStylesReset.js",
      kind: "file",
      provenance: { sourceUri: "src/borderStylesReset.js" },
      attrs: w(60),
    };
    const r = rank(node, "borderStylesReset");
    expect(r.matchSource).toBe("file_stem");
    expect(r.tier).toBeLessThanOrEqual(2);
  });

  it("caps a demoted exact-name row (build output) at tier 2", () => {
    const node = {
      name: "widget",
      kind: "class",
      provenance: { sourceUri: "dist/widget.js" },
      attrs: { ...w(100), language: "javascript" },
    };
    const r = rank(node, "widget");
    expect(r.tier).toBe(2);
    expect(r.matchSource).toBe("name_exact");
  });
});

describe("searchSort tiebreak", () => {
  const row = (id: string, kind = "function") => {
    const node = { id, name: "twin", kind, attrs: { _search_weight: 100 } };
    return { node, rank: rankScore(node, "twin", undefined, undefined) };
  };

  it("orders fully tied rows by id whatever the input order", () => {
    const a = row("a-id");
    const b = row("b-id");
    expect([b, a].sort(searchSort).map((r) => r.node.id)).toEqual(["a-id", "b-id"]);
    expect([a, b].sort(searchSort).map((r) => r.node.id)).toEqual(["a-id", "b-id"]);
  });

  it("still ranks by tier before id", () => {
    const strong = { node: { id: "z-id", name: "twin", kind: "function" }, rank: { tier: 0, score: -1, matchSource: "x" } };
    const weak = { node: { id: "a-id", name: "twin", kind: "function" }, rank: { tier: 1, score: -1, matchSource: "x" } };
    expect([weak, strong].sort(searchSort).map((r) => r.node.id)).toEqual(["z-id", "a-id"]);
  });

  it("still ranks by name before id", () => {
    const x = { node: { id: "z-id", name: "alpha", kind: "function" }, rank: { tier: 1, score: -1, matchSource: "x" } };
    const y = { node: { id: "a-id", name: "beta", kind: "function" }, rank: { tier: 1, score: -1, matchSource: "x" } };
    expect([y, x].sort(searchSort).map((r) => r.node.id)).toEqual(["z-id", "a-id"]);
  });
});

describe("scoreCandidate: structural kinds outrank chunks", () => {
  // BUG-1 / BUG-2 regression: for PascalCase names, chunks must never outscore
  // function/method entities. Previously a +3 penalty on method/function for
  // looksTypeLikeSymbol names let chunks (score=0) beat them (score=2).

  it("method outscores chunk for PascalCase name (Apply)", () => {
    const method = { name: "Apply", kind: "method", provenance: { sourceUri: "etcd/apply/backend.go" } };
    const chunk  = { name: "Apply", kind: "chunk",  provenance: { sourceUri: "etcd/apply/backend.go" } };
    expect(scoreCandidate(method, "Apply")).toBeLessThan(scoreCandidate(chunk, "Apply"));
  });

  it("function outscores chunk for PascalCase name (StartEtcd)", () => {
    const fn    = { name: "StartEtcd", kind: "function", provenance: { sourceUri: "etcd/embed/etcd.go" } };
    const chunk = { name: "StartEtcd", kind: "chunk",    provenance: { sourceUri: "etcd/embed/etcd.go" } };
    expect(scoreCandidate(fn, "StartEtcd")).toBeLessThan(scoreCandidate(chunk, "StartEtcd"));
  });

  it("class still outscores function for PascalCase type-like name", () => {
    const cls = { name: "EtcdServer", kind: "class",    provenance: { sourceUri: "etcd/server.go" } };
    const fn  = { name: "EtcdServer", kind: "function", provenance: { sourceUri: "etcd/server.go" } };
    expect(scoreCandidate(cls, "EtcdServer")).toBeLessThan(scoreCandidate(fn, "EtcdServer"));
  });
});

describe("resolveEntityFull: method preferred over chunk for PascalCase names", () => {
  // BUG-1 regression: resolving "Apply" should return the method entity, not a chunk.
  it("resolves to method entity, not chunk, when both have the same name", async () => {
    const method = {
      id: "method-apply-id",
      name: "Apply",
      kind: "method",
      provenance: { sourceUri: "etcd/apply/backend.go" },
    };
    const chunk = {
      id: "chunk-apply-id",
      name: "Apply",
      kind: "chunk",
      provenance: { sourceUri: "etcd/apply/backend.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([chunk, method]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Apply", ["method"], { path: "etcd" });
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("method-apply-id");
      expect(result.entity.kind).toBe("method");
    }
  });

  it("resolves StartEtcd to function entity, not chunk (BUG-2 regression)", async () => {
    const fn = {
      id: "fn-startetcd-id",
      name: "StartEtcd",
      kind: "function",
      provenance: { sourceUri: "etcd/embed/etcd.go" },
    };
    const chunk = {
      id: "chunk-startetcd-id",
      name: "StartEtcd",
      kind: "chunk",
      provenance: { sourceUri: "etcd/embed/etcd.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([chunk, fn]),
    } as any;

    const result = await resolveEntityFull(mockClient, "StartEtcd", ["function"], { path: "etcd" });
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("fn-startetcd-id");
      expect(result.entity.kind).toBe("function");
    }
  });
});

describe("resolveEntityFull: same-kind ambiguity", () => {
  const duplicateClasses = [
    {
      id: "alpha-service-id",
      name: "DuplicateService",
      kind: "class",
      provenance: { sourceUri: "src/alpha/DuplicateService.ts" },
    },
    {
      id: "beta-service-id",
      name: "DuplicateService",
      kind: "class",
      provenance: { sourceUri: "src/beta/DuplicateService.ts" },
    },
  ];

  it("stays ambiguous when --kind matches multiple exact-name candidates", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue(duplicateClasses),
    } as any;

    const result = await resolveEntityFull(
      mockClient,
      "DuplicateService",
      ["class"],
      { kind: "class" },
    );

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.ambiguous).toBe(true);
      if (result.ambiguous) {
        expect(result.result.candidates.map(candidate => candidate.id)).toEqual([
          "alpha-service-id",
          "beta-service-id",
        ]);
      }
    }
  });

  it("honors --pick after --kind leaves multiple candidates", async () => {
    const mockClient = {
      search: vi.fn().mockResolvedValue(duplicateClasses),
    } as any;

    const result = await resolveEntityFull(
      mockClient,
      "DuplicateService",
      ["class"],
      { kind: "class", pick: 2 },
    );

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("beta-service-id");
      expect(result.entity.path).toBe("src/beta/DuplicateService.ts");
    }
  });
});

describe("resolveEntityFull --path hard exclusion", () => {
  it("excludes out-of-scope candidates even on exact name match", async () => {
    // Simulates Bug 1: etcd has 'Notifier' but prometheus does not.
    // With --path prometheus, the etcd candidate must be excluded entirely.
    const etcdNotifier = {
      id: "etcd-notifier-id",
      name: "Notifier",
      kind: "class",
      provenance: { sourceUri: "etcd/pkg/notify/notify.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([etcdNotifier]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Notifier", ["class"], { path: "prometheus" });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.ambiguous).toBe(false);
    }
  });

  it("resolves when the only candidate matches the path filter", async () => {
    const promNotifier = {
      id: "prom-notifier-id",
      name: "Notifier",
      kind: "class",
      provenance: { sourceUri: "prometheus/notifier/notifier.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([promNotifier]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Notifier", ["class"], { path: "prometheus" });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("prom-notifier-id");
    }
  });

  it("prefers in-scope candidate over higher-scored out-of-scope candidate", async () => {
    // Both repos have 'Manager'; only the prometheus one should be returned.
    const etcdManager = {
      id: "etcd-manager-id",
      name: "Manager",
      kind: "class",
      provenance: { sourceUri: "etcd/raft/manager.go" },
    };
    const promManager = {
      id: "prom-manager-id",
      name: "Manager",
      kind: "class",
      provenance: { sourceUri: "prometheus/notifier/manager.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([etcdManager, promManager]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Manager", ["class"], { path: "prometheus" });

    // etcdManager is excluded by the path filter; only promManager survives → single candidate → resolved
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("prom-manager-id");
    }
  });
});
