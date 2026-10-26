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
], extraEntities: EntityLocation[] = []) {
  const read = vi.fn(() => source);
  const issue = {
    startingPoints: [{ id: "start", name: "Cache", kind: "class", path, token: "Cache", via: "identifier in issue" as const }],
    unresolved: [], fallback: false, rankedFiles: [{ path, score: 1, reason: "bm25" }],
    query, repo: { read }, extraEntities,
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
    provenance: {}, budgets: clampBudgets({ maxEntities: 2 }),
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
    expect(result.entities[0].id).toBe("far");
    expect(result.entities[0]).toMatchObject({ path, lineStart: 4, lineEnd: 6, stale: false });
    expect(read).toHaveBeenCalledTimes(1);
    const parsed = contextBundleSchema.parse(JSON.parse(JSON.stringify(result)));
    expect(parsed.entities[0]).toHaveProperty("score", expect.any(Number));
  });

  it("breaks a lexical tie by distance from the strongest starts", () => {
    const source = [
      "class Cache:", "    def prepare(self):", "        return snapshot_recovery()",
      "    def restore(self):", "        return snapshot_recovery()", "",
    ].join("\n");
    const lexical = rank([far, near], "snapshot recovery", source).result;
    expect(lexical[0].score).toBe(lexical[1].score);
    const { result } = bundle("snapshot recovery", source, [far, near]);
    expect(result.entities.map(e => e.id)).toEqual(["near", "far"]);
    expect(result.entities[0].score).toBeGreaterThan(result.entities[1].score!);
  });

  it("refines equivalent split identifiers by an exact issue identifier hit", () => {
    const { result } = bundle("`resetCache` retains expired snapshots", [
      "class Cache:", "    def reset_cache(self):", "        return expired_snapshots()",
      "    def resetCache(self):", "        return expired_snapshots()", "",
    ].join("\n"), [{ ...near, name: "reset_cache" }, { ...far, name: "resetCache" }]);
    expect(result.entities.map(e => e.id)).toEqual(["far", "near"]);
    expect(result.entities[0].score).toBeGreaterThan(result.entities[1].score!);
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
    expect(result.entities[0].id).toBe("far");
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

  it("keeps other candidates when one listing fails", async () => {
    const listByKind = vi.fn(async (kind: string) => {
      if (kind === "function") throw new Error("unavailable");
      return [node(far)];
    });
    expect(await collectIssueEntities({ listByKind }, [{ path, score: 1, reason: "bm25" }], {})).toEqual([far]);
  });
});
