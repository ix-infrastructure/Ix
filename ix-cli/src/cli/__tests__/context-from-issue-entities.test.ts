// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";

import { buildBundle, clampBudgets } from "../commands/context.js";
import { contextBundleSchema } from "../context-bundle-schema.js";
import type { GraphNode } from "../../client/types.js";
import type { ContextFacts, EntityLocation } from "../explain/facts.js";
import { collectIssueEntities, ISSUE_ENTITIES_PER_KIND, rankIssueEntities } from "../explain/issue-entities.js";
import { MAX_BM25_BYTES, MAX_RANKED_FILES } from "../explain/issue.js";

const path = "src/cache.py";
const near: EntityLocation = { id: "near", name: "prepare", kind: "method", path, lineStart: 2, lineEnd: 3 };
const far: EntityLocation = { id: "far", name: "restore", kind: "method", path, lineStart: 4, lineEnd: 6 };

function bundle(query: string, source: string, members = [near, far], edges = [
  { src: "start", dst: "near", predicate: "CALLS" },
  { src: "near", dst: "bridge", predicate: "CALLS" },
  { src: "bridge", dst: "far", predicate: "CALLS" },
], discoveredEntities: EntityLocation[] = [], maxEntities = 3) {
  const read = vi.fn(() => source);
  const issue = {
    startingPoints: [{ id: "start", name: "Cache", kind: "class", path, token: "Cache", via: "identifier in issue" as const }],
    unresolved: [], fallback: false, rankedFiles: [{ path, score: 1, reason: "bm25" }],
    query, repo: { read }, discoveredEntities,
  };
  const result = buildBundle({
    resolved: { id: "start", name: "Cache", kind: "class", resolutionMode: "issue" },
    facts: {
      id: "start", name: "Cache", kind: "class", path, stale: false,
      memberRefs: members, members: members.map(m => m.name), memberCount: members.length,
      topCallers: [], topDependents: [], diagnostics: [],
      historyLength: 1,
    } as unknown as ContextFacts,
    context: {
      nodes: [], edges, claims: [], conflicts: [], decisions: [], intents: [],
      metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
    } as never,
    provenance: {}, budgets: clampBudgets({ maxEntities }),
    isStale: () => false, issue,
  });
  return { result, read };
}

describe("issue entity ranking", () => {
  it("keeps a body-matched graph-far method ahead of unrelated neighbours before budgeting", () => {
    const { result, read } = bundle("expired entries survive snapshot recovery", [
      "class Cache:", "    def prepare(self):", "        return self.ready",
      "    def restore(self):", '        """Discard expired entries during snapshot recovery."""', "        return self.snapshot",
    ].join("\n"));
    expect(result.entities.map(e => e.id)).toEqual(["start", "far", "near"]);
    expect(result.entities[1]).toMatchObject({ path, lineStart: 4, lineEnd: 6, stale: false });
    expect(read).toHaveBeenCalledTimes(1);
    const parsed = contextBundleSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed.entities[1]).toHaveProperty("score", expect.any(Number));
  });

  it("breaks a lexical tie by distance from the strongest starts", () => {
    const source = [
      "class Cache:", "    def prepare(self):", "        return snapshot_recovery()",
      "    def restore(self):", "        return snapshot_recovery()", "",
    ].join("\n");
    const lexical = rank([far, near], "snapshot recovery", source).result;
    expect(lexical[0].score).toBe(lexical[1].score);
    const { result } = bundle("snapshot recovery", source, [far, near]);
    expect(result.entities.map(e => e.id)).toEqual(["start", "near", "far"]);
    expect(result.entities[1].score).toBeGreaterThan(result.entities[2].score!);
  });

  it("refines equivalent split identifiers by an exact issue identifier hit", () => {
    const { result } = bundle("`resetCache` retains expired snapshots", [
      "class Cache:", "    def reset_cache(self):", "        return expired_snapshots()",
      "    def resetCache(self):", "        return expired_snapshots()", "",
    ].join("\n"), [{ ...near, name: "reset_cache" }, { ...far, name: "resetCache" }]);
    expect(result.entities.map(e => e.id)).toEqual(["start", "far", "near"]);
    expect(result.entities[1].score).toBeGreaterThan(result.entities[2].score!);
  });

  it("combines direct facts from another start with context edges using the shortest distance", () => {
    const result = rankIssueEntities([near, far], {
      query: "snapshot recovery",
      repo: { read: () => ["class Cache:", "    def prepare(self):", "        return snapshot_recovery()",
        "    def restore(self):", "        return snapshot_recovery()", ""].join("\n") },
      rankedFiles: [{ path, score: 1, reason: "bm25" }],
      startingPoints: ["first", "second"].map(id => ({ id, name: id, token: id, kind: "function", path, via: "identifier in issue" })),
      distances: new Map([["far", 1]]), // second start directly calls far
    }, [{ src: "first", dst: "bridge" }, { src: "bridge", dst: "near" }, { src: "near", dst: "far" }]);
    expect(result.map(e => e.id)).toEqual(["far", "near"]);
  });

  it("keeps the target, starting points and structure in budget under many matches", () => {
    const methods: EntityLocation[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, name: `recover${i}`, kind: "method", path, lineStart: i + 2, lineEnd: i + 2,
    }));
    const source = ["class Cache:", ...methods.map(m => `    def ${m.name}(self): return snapshot_recovery()`)].join("\n");
    const imported: EntityLocation = { id: "imp", name: "store", kind: "module" };
    const other = { id: "other", name: "Snapshot", kind: "class", path: "src/snapshot.py", token: "Snapshot", via: "identifier in issue" as const };
    const result = buildBundle({
      resolved: { id: "start", name: "Cache", kind: "class", resolutionMode: "issue" },
      facts: {
        id: "start", name: "Cache", kind: "class", path, stale: false,
        memberRefs: [], members: [], memberCount: 0, importRefs: [imported],
        topCallers: [], topDependents: [], diagnostics: [], historyLength: 1,
      } as unknown as ContextFacts,
      context: {
        nodes: [], edges: [{ src: "start", dst: "imp", predicate: "IMPORTS" }],
        claims: [], conflicts: [], decisions: [], intents: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {}, budgets: clampBudgets({}), isStale: () => false,
      issue: {
        startingPoints: [{ id: "start", name: "Cache", kind: "class", path, token: "Cache", via: "identifier in issue" as const }, other],
        unresolved: [], fallback: false, rankedFiles: [{ path, score: 1, reason: "bm25" }],
        query: "snapshot recovery", repo: { read: () => source }, discoveredEntities: methods,
      },
    });
    const ids = result.entities.map(e => e.id);
    const limit = clampBudgets({}).maxEntities;
    expect(ids.slice(0, 2)).toEqual(["start", "other"]);
    expect(ids).toContain("imp");
    expect(result.relationships).toEqual([{ src: "start", dst: "imp", predicate: "IMPORTS" }]);
    expect(ids.filter(id => id.startsWith("m")).length).toBeLessThan(limit);
    expect(result.entities[2].score).toBeGreaterThan(0);
  });

  it.each(["nodes", "summaries"])("keeps backend-only dependencies ahead of unmatched discoveries (%s)", shape => {
    const methods: EntityLocation[] = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`, name: `prepare${i}`, kind: "method", path,
    }));
    const edge = { src: "start", dst: "dependency", predicate: "IMPORTS" };
    const build = (discoveredEntities: EntityLocation[], extraEntities: EntityLocation[] = []) => buildBundle({
      resolved: { id: "start", name: "Cache", kind: "class", resolutionMode: "issue" },
      facts: {
        id: "start", name: "Cache", kind: "class", path, stale: false,
        memberRefs: [], members: [], memberCount: 0, importRefs: [],
        topCallers: [], topDependents: [], diagnostics: [], historyLength: 1,
      } as unknown as ContextFacts,
      context: {
        nodes: shape === "nodes" ? [{ id: "dependency", name: "store", kind: "module" }] : [],
        edges: shape === "nodes" ? [edge] : [],
        nodeSummaries: shape === "summaries" ? [{ id: "dependency", name: "store", kind: "module" }] : [],
        edgeSummaries: shape === "summaries" ? [edge] : [],
        claims: [], conflicts: [], decisions: [], intents: [],
        metadata: { query: "", seedEntities: [], hopsExpanded: 1, asOfRev: 1 },
      } as never,
      provenance: {}, budgets: clampBudgets({}), isStale: () => false,
      issue: {
        startingPoints: [{ id: "start", name: "Cache", kind: "class", path, token: "Cache", via: "identifier in issue" as const }],
        unresolved: [], fallback: false, rankedFiles: [{ path, score: 1, reason: "bm25" }],
        query: "snapshot recovery", repo: { read: () => "" }, discoveredEntities, extraEntities,
      },
    });
    const baseline = build([]);
    const result = build(methods);
    expect(baseline.entities.map(e => e.id)).toEqual(["start", "dependency"]);
    expect(baseline.relationships).toEqual([edge]);
    expect(result.entities).toHaveLength(clampBudgets({}).maxEntities);
    expect(result.entities.slice(0, 2)).toEqual(baseline.entities);
    expect(result.entities.every(e => e.score === 0)).toBe(true);
    expect(result.relationships).toEqual(baseline.relationships);

    // A stale backend summary must not replace a discovered definition's location.
    const located = { id: "dependency", name: "loadStore", kind: "function", path: "src/store.py", lineStart: 7, lineEnd: 9 };
    const overlap = build([...methods, located]);
    expect(overlap.entities[1]).toMatchObject(located);
    expect(overlap.entities.filter(e => e.id === located.id)).toHaveLength(1);
    expect(overlap.relationships).toEqual(baseline.relationships);

    const neighbour = { id: "other-neighbour", name: "store.py", kind: "file", path: "src/store.py" };
    const withNeighbour = build(methods, [neighbour]);
    expect(withNeighbour.entities.slice(0, 3).map(e => e.id)).toEqual(["start", neighbour.id, "dependency"]);
    expect(withNeighbour.relationships).toEqual(baseline.relationships);
  });

  it("retains new scores through JSON validation while accepting old entities without them", () => {
    const { result } = bundle("snapshot recovery", "");
    expect(result.entities.every(e => typeof e.score === "number" && Number.isFinite(e.score))).toBe(true);
    const legacy = { ...result, entities: result.entities.map(({ score: _score, ...entity }) => entity) };
    expect(contextBundleSchema.safeParse(legacy).success).toBe(true);
    expect(result.metadata.rankingRule).toBe("issue-bm25");
  });
});

function rank(entities: EntityLocation[], query: string, source: string | undefined) {
  const read = vi.fn(() => source);
  const result = rankIssueEntities(entities, {
    query, repo: { read }, startingPoints: [], rankedFiles: [{ path, score: 1, reason: "bm25" }],
  }, []);
  return { result, read };
}

describe("bounded definition text", () => {
  it("includes an adjacent TypeScript doc comment and splits body identifiers", () => {
    const { result } = rank([
      { ...near, name: "prepare", lineStart: 1, lineEnd: 1 },
      { ...far, name: "restore", lineStart: 5, lineEnd: 5 },
    ], "snapshot recovery", [
      "function prepare() { return ready; }", "/**", " * snapshotRecovery", " */",
      "function restore() { return cached; }",
    ].join("\n"));
    expect(result[0].id).toBe("far");
    expect(result[0].score).toBeGreaterThan(0);
    expect(result[1].score).toBe(0);
  });

  it.each([undefined, "x".repeat(MAX_BM25_BYTES + 1)])("falls back to names for unavailable or oversized source", source => {
    const { result, read } = rank([near, far], "snapshot recovery", source);
    expect(result.every(e => e.score === 0)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not borrow a whole file's words when spans are missing or invalid", () => {
    const { result } = rank([
      { ...near, lineStart: undefined, lineEnd: undefined },
      { ...far, lineStart: 10, lineEnd: 5 },
    ], "snapshot recovery", "snapshot recovery");
    expect(result.every(e => e.score === 0)).toBe(true);
  });

  it("only reads functions in the bounded top-file pool", () => {
    const read = vi.fn(() => "snapshot recovery");
    const files = Array.from({ length: MAX_RANKED_FILES + 1 }, (_, i) => ({ path: `src/f${i}.ts`, score: 1, reason: "bm25" }));
    const result = rankIssueEntities([
      { ...near, kind: "file", path: files[0].path },
      { ...far, path: files[MAX_RANKED_FILES].path },
    ], { query: "snapshot recovery", repo: { read }, startingPoints: [], rankedFiles: files }, []);
    expect(read).not.toHaveBeenCalled();
    expect(result.every(e => e.score === 0)).toBe(true);
  });
});

describe("issue candidate discovery", () => {
  function node(entity: EntityLocation): GraphNode {
    return {
      id: entity.id, name: entity.name, kind: entity.kind,
      provenance: { sourceUri: entity.path },
      attrs: { line_start: entity.lineStart, line_end: entity.lineEnd },
    } as unknown as GraphNode;
  }

  it("discovers and ranks a method absent from the starting neighbourhood", async () => {
    const listByKind = vi.fn(async (kind: string) => kind === "method" ? [node(far)] : []);
    const candidates = await collectIssueEntities({ listByKind }, [{ path, score: 1, reason: "bm25" }], { workspaceId: "fixture" });
    const { result } = bundle("expired entries survive snapshot recovery", [
      "class Cache:", "    def prepare(self):", "        return self.ready",
      "    def restore(self):", '        """Discard expired entries during snapshot recovery."""', "        return self.snapshot",
    ].join("\n"), [near], [], candidates);
    expect(result.entities[1].id).toBe("far");
    expect(listByKind).toHaveBeenCalledTimes(2);
    expect(listByKind).toHaveBeenCalledWith("method", { workspaceId: "fixture", scope: path, limit: ISSUE_ENTITIES_PER_KIND });
  });

  it("bounds listings and filters unrelated paths from backends that ignore scope", async () => {
    const listByKind = vi.fn(async (kind: string) => kind === "function"
      ? [node({ ...far, kind, path: "src/other.py" })]
      : Array.from({ length: ISSUE_ENTITIES_PER_KIND + 10 }, (_, i) => node({ ...far, id: `m${i}` })));
    const files = Array.from({ length: MAX_RANKED_FILES + 5 }, (_, i) => ({ path: i === 0 ? path : `src/f${i}.py`, score: 1, reason: "bm25" }));
    const candidates = await collectIssueEntities({ listByKind }, files, { systemId: "fixture" });
    expect(listByKind).toHaveBeenCalledTimes(2 * MAX_RANKED_FILES);
    expect(candidates).toHaveLength(ISSUE_ENTITIES_PER_KIND);
    expect(candidates.every(e => e.path === path)).toBe(true);
  });

  it("uses at most two listings per ranked file even with thousands of definitions", async () => {
    const files = Array.from({ length: MAX_RANKED_FILES + 5 }, (_, i) => ({ path: `src/f${i}.py`, score: 1, reason: "bm25" }));
    const listByKind = vi.fn(async (kind: string, opts: { scope?: string }) =>
      Array.from({ length: ISSUE_ENTITIES_PER_KIND + 10 }, (_, i) => node({
        ...far, kind, path: opts.scope!, id: `${opts.scope}:${kind}:${i}`,
      })));
    const candidates = await collectIssueEntities({ listByKind }, files, { systemId: "fixture" });
    expect(listByKind).toHaveBeenCalledTimes(2 * MAX_RANKED_FILES);
    expect(candidates).toHaveLength(2 * MAX_RANKED_FILES * ISSUE_ENTITIES_PER_KIND);
    for (const file of files.slice(0, MAX_RANKED_FILES)) {
      for (const kind of ["function", "method"]) {
        expect(listByKind).toHaveBeenCalledWith(kind, {
          systemId: "fixture", scope: file.path, limit: ISSUE_ENTITIES_PER_KIND,
        });
      }
    }
    expect(candidates.some(entity => entity.path === files[MAX_RANKED_FILES].path)).toBe(false);
  });

  it("keeps other candidates when one listing fails", async () => {
    const listByKind = vi.fn(async (kind: string) => {
      if (kind === "function") throw new Error("unavailable");
      return [node(far)];
    });
    expect(await collectIssueEntities({ listByKind }, [{ path, score: 1, reason: "bm25" }], {})).toEqual([far]);
  });
});
