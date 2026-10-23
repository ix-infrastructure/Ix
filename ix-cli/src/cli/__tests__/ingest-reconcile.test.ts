// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";

import type { GraphNode, GraphPatchPayload } from "../../client/types.js";
import {
  BATCH_NODE_READS_SINCE,
  BULK_DELETES_SINCE,
  BatchNodeReadsUnsupported,
  backendAppliesBulkDeletes,
  orphanSweepBudget,
  orphanSweepUnsupportedReason,
  patchRequiresPerFileCommit,
  planDeletedFileRecovery,
  reconcileRemovedEntities,
  sweepOrphanNodes,
} from "../commands/ingest.js";
import { createLimiter } from "../tree-walk.js";

function patchWith(ops: GraphPatchPayload["ops"]): GraphPatchPayload {
  return {
    patchId: "next-patch",
    actor: "ix/ingestion",
    timestamp: "2026-08-10T00:00:00.000Z",
    source: {
      uri: "src/example.ts",
      sourceHash: "next-hash",
      extractor: "tree-sitter/1.25",
      sourceType: "code",
      workspaceId: "deadbeef",
    },
    baseRev: 0,
    ops,
    replaces: [],
  };
}

describe("reconcileRemovedEntities", () => {
  it("routes patches with deletion ops away from the bulk endpoint, unless it applies them", () => {
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteNode", id: "old-node" }]))).toBe(true);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteEdge", id: "old-edge" }]))).toBe(true);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "UpsertNode", id: "node" }]))).toBe(false);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteNode", id: "old-node" }]), true)).toBe(false);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteEdge", id: "old-edge" }]), true)).toBe(false);
  });

  it("trusts the bulk route with deletes from the release that applies them", () => {
    const env = {};
    expect(backendAppliesBulkDeletes({ release_version: BULK_DELETES_SINCE }, env)).toBe(true);
    expect(backendAppliesBulkDeletes({ release_version: "1.0.34" }, env)).toBe(true);
    expect(backendAppliesBulkDeletes({ release_version: "v1.1.0" }, env)).toBe(true);
    expect(backendAppliesBulkDeletes({ release_version: "1.0.31" }, env)).toBe(false);
    expect(backendAppliesBulkDeletes({ release_version: "0.9.99" }, env)).toBe(false);
    // No release, or not a version: an image the release pipeline did not build.
    expect(backendAppliesBulkDeletes({}, env)).toBe(false);
    expect(backendAppliesBulkDeletes({ release_version: "dev" }, env)).toBe(false);
    expect(backendAppliesBulkDeletes(null, env)).toBe(false);
    expect(backendAppliesBulkDeletes({}, { IX_BULK_DELETES: "1" })).toBe(true);
    expect(backendAppliesBulkDeletes({ release_version: "1.0.34" }, { IX_BULK_DELETES: "0" })).toBe(false);
  });

  it("looks up no chunk the stored patch names as one, in map mode", async () => {
    const getPatch = vi.fn().mockResolvedValue({
      data: {
        ops: [
          { type: "UpsertNode", id: "file-node", kind: "file" },
          { type: "UpsertNode", id: "chunk-L10", kind: "chunk" },
          { type: "UpsertNode", id: "gone-fn", kind: "function" },
        ],
      },
    });
    const entity = vi.fn().mockResolvedValue({ node: { kind: "function" }, claims: [], edges: [] });
    const patch = patchWith([{ type: "UpsertNode", id: "file-node", kind: "file", name: "example.ts" }]);

    const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patch, ["prev"], undefined, true);

    expect(entity.mock.calls.map(c => c[0])).toEqual(["gone-fn"]);
    expect(reconciled.ops.filter(o => o.type === "DeleteNode").map(o => o["id"])).toEqual(["gone-fn"]);
  });

  it("runs the entity lookups within the limit, and keeps candidate order whatever finishes first", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const getPatch = vi.fn().mockResolvedValue({
      data: { ops: ids.map(id => ({ type: "UpsertNode", id, kind: "function" })) },
    });
    let active = 0;
    let peak = 0;
    const entity = vi.fn().mockImplementation(async (id: string) => {
      active++;
      peak = Math.max(peak, active);
      // Later ids finish first.
      await new Promise(r => setTimeout(r, 40 - Number(id.slice(1)) * 2));
      active--;
      return { node: {}, claims: [], edges: [{ id: `e-${id}`, provenance: { sourceUri: "src/caller.ts" } }] };
    });
    const patch = patchWith([]);

    const reconciled = await reconcileRemovedEntities(
      { getPatch, entity }, patch, ["prev"], undefined, false, createLimiter(4),
    );

    expect(peak).toBe(4);
    expect(reconciled.ops.filter(o => o.type === "DeleteNode").map(o => o["id"])).toEqual(ids);
    expect(reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"])).toEqual(ids.map(id => `e-${id}`));
  });

  describe("an external package node, which every caller in the workspace shares", () => {
    const ext = { type: "UpsertNode", id: "ext-filter", kind: "function", attrs: { external: true, package: "dplyr" } };
    const edges = [
      { id: "own-call", predicate: "CALLS", provenance: { sourceUri: "src/example.ts" } },
      { id: "other-call", predicate: "CALLS", provenance: { sourceUri: "src/other.ts" } },
    ];

    it("stays, with the other files' edges, when this file stops calling it", async () => {
      const getPatch = vi.fn().mockResolvedValue({ data: { ops: [ext] } });
      const entity = vi.fn().mockResolvedValue({ node: { kind: "function" }, claims: [], edges });
      const dependents = new Set<string>();

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["prev"], dependents);

      expect(reconciled.ops.filter(o => o.type === "DeleteNode")).toEqual([]);
      expect(reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"])).toEqual(["own-call"]);
      expect([...dependents], "the other file keeps its edge, so it is not a dependent").toEqual([]);
    });

    it("is recognised from the entity's attrs when the stored patch kept no ops", async () => {
      const getPatch = vi.fn().mockResolvedValue({
        data: { entityIds: ["ext-filter"], nodeOpCount: 1, edgeOpCount: 0 },
      });
      const entity = vi.fn().mockResolvedValue({
        node: { kind: "function", attrs: { external: true } }, claims: [], edges,
      });

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["prev"]);

      expect(reconciled.ops.filter(o => o.type === "DeleteNode")).toEqual([]);
      expect(reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"])).toEqual(["own-call"]);
    });

    it("goes when this file was its last caller", async () => {
      const getPatch = vi.fn().mockResolvedValue({ data: { ops: [ext] } });
      const entity = vi.fn().mockResolvedValue({ node: { kind: "function" }, claims: [], edges: [edges[0]] });

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["prev"]);

      expect(reconciled.ops.filter(o => o.type === "DeleteNode").map(o => o["id"])).toEqual(["ext-filter"]);
      expect(reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"])).toEqual(["own-call"]);
    });
  });

  it("reingests surviving dependents when a deleted file returns", () => {
    const projectRoot = nodePath.resolve("workspace");
    const returnedPath = nodePath.join(projectRoot, "src", "returned.ts");
    const callerPath = nodePath.join(projectRoot, "src", "caller.ts");
    const stillDeletedPath = nodePath.join(projectRoot, "src", "still-deleted.ts");
    const deletedFiles = new Map([
      ["src/returned.ts", ["src/caller.ts", "src/missing.ts"]],
      ["src/still-deleted.ts", ["src/other.ts"]],
    ]);

    const plan = planDeletedFileRecovery(
      projectRoot,
      [returnedPath, callerPath],
      deletedFiles,
    );

    expect(plan.recreatedPaths).toEqual([returnedPath]);
    expect(plan.previousDeletedFiles).toEqual(
      new Map([
        [returnedPath, ["src/caller.ts", "src/missing.ts"]],
        [stillDeletedPath, ["src/other.ts"]],
      ]),
    );
    expect(plan.forceReingestPaths).toEqual(new Set([callerPath]));
    expect(plan.nextDeletedFiles).toEqual(
      new Map([[stillDeletedPath, ["src/other.ts"]]]),
    );
  });

  it("deletes removed nodes and their incident edges while preserving current entities", async () => {
    const getPatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("404: not found"))
      .mockResolvedValueOnce({
        data: {
          entityIds: ["kept-node", "removed-node", "kept-edge", "removed-edge"],
          nodeOpCount: 2,
          edgeOpCount: 2,
        },
      });
    const entity = vi.fn().mockResolvedValue({
      node: {},
      claims: [],
      edges: [
        { id: "removed-edge", provenance: { sourceUri: "src/example.ts" } },
        { id: "incoming-edge", provenance: { sourceUri: "src/caller.ts" } },
        { id: "kept-edge", provenance: { sourceUri: "src/example.ts" } },
      ],
    });
    const patch = patchWith([
      { type: "UpsertNode", id: "kept-node", kind: "file", name: "example.ts", attrs: {} },
      {
        type: "UpsertEdge",
        id: "kept-edge",
        src: "kept-node",
        dst: "kept-node",
        predicate: "CONTAINS",
        attrs: {},
      },
      { type: "AssertClaim", entityId: "kept-node", field: "calls:x", value: "x" },
    ]);

    const dependents = new Set<string>();
    const reconciled = await reconcileRemovedEntities(
      { getPatch, entity },
      patch,
      ["missing-patch", "previous-patch"],
      dependents,
    );

    expect(getPatch).toHaveBeenCalledTimes(2);
    expect(entity).toHaveBeenCalledWith("removed-node");
    expect(dependents).toEqual(new Set(["src/caller.ts"]));
    expect(reconciled.ops).toEqual([
      { type: "DeleteNode", id: "removed-node" },
      patch.ops[0],
      { type: "DeleteEdge", id: "removed-edge" },
      { type: "DeleteEdge", id: "incoming-edge" },
      patch.ops[1],
      patch.ops[2],
    ]);
  });

  it("does not repeat edge deletions from a prior tombstone when a file returns", async () => {
    const getPatch = vi.fn().mockResolvedValue({
      data: {
        ops: [
          { type: "DeleteNode", id: "returned-node" },
          { type: "DeleteEdge", id: "incoming-edge" },
        ],
      },
    });
    const entity = vi.fn();
    const patch = patchWith([
      { type: "UpsertNode", id: "returned-node", kind: "file", name: "example.ts" },
    ]);

    const reconciled = await reconcileRemovedEntities(
      { getPatch, entity },
      patch,
      ["tombstone-patch"],
    );

    expect(reconciled.ops).toEqual(patch.ops);
    expect(entity).not.toHaveBeenCalled();
  });

  it("does not delete chunk nodes in map mode", async () => {
    // stripMapModeOps drops chunk UpsertNodes but keeps DeleteNode, and chunk
    // ids hash the start line — so any edit that shifts lines made every
    // downstream chunk look removed. Without this guard, `ix map` after an
    // `ix ingest` deleted the file's chunks and never recreated them.
    const getPatch = vi.fn().mockResolvedValue({
      data: { entityIds: ["file-node", "chunk-L1", "chunk-L10"], nodeOpCount: 3, edgeOpCount: 0 },
    });
    const entity = vi.fn().mockImplementation(async (id: string) => ({
      node: { kind: id.startsWith("chunk") ? "chunk" : "function" },
      claims: [],
      edges: [],
    }));
    const patch = patchWith([
      { type: "UpsertNode", id: "file-node", kind: "file", name: "example.ts" },
      { type: "UpsertNode", id: "chunk-L1", kind: "chunk", name: "a" },
      { type: "UpsertNode", id: "chunk-L12", kind: "chunk", name: "b" },
    ]);

    const reconciled = await reconcileRemovedEntities(
      { getPatch, entity }, patch, ["prev"], undefined, true,
    );

    const deleted = reconciled.ops.filter(o => o.type === "DeleteNode").map(o => o["id"]);
    expect(deleted).toEqual([]);
  });

  it("still deletes chunk nodes outside map mode", async () => {
    const getPatch = vi.fn().mockResolvedValue({
      data: { entityIds: ["file-node", "chunk-L10"], nodeOpCount: 2, edgeOpCount: 0 },
    });
    const entity = vi.fn().mockResolvedValue({ node: { kind: "chunk" }, claims: [], edges: [] });
    const patch = patchWith([
      { type: "UpsertNode", id: "file-node", kind: "file", name: "example.ts" },
    ]);

    const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patch, ["prev"]);

    const deleted = reconciled.ops.filter(o => o.type === "DeleteNode").map(o => o["id"]);
    expect(deleted).toEqual(["chunk-L10"]);
  });

  it("leaves chunk-carrying edges alone in map mode", async () => {
    const getPatch = vi.fn().mockResolvedValue({
      data: { entityIds: ["gone"], nodeOpCount: 1, edgeOpCount: 0 },
    });
    const entity = vi.fn().mockResolvedValue({
      node: { kind: "function" },
      claims: [],
      edges: [
        { id: "contains-chunk", predicate: "CONTAINS_CHUNK", provenance: {} },
        { id: "next-chunk", predicate: "NEXT", provenance: {} },
        { id: "calls-edge", predicate: "CALLS", provenance: {} },
      ],
    });

    const reconciled = await reconcileRemovedEntities(
      { getPatch, entity }, patchWith([]), ["prev"], undefined, true,
    );

    const deletedEdges = reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"]);
    expect(deletedEdges).toEqual(["calls-edge"]);
  });

  it("fails closed when the previous patch has no entity manifest", async () => {
    const getPatch = vi.fn().mockResolvedValue({ data: {} });
    const entity = vi.fn();

    await expect(
      reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["previous-patch"]),
    ).rejects.toThrow("has no entity manifest");
    expect(entity).not.toHaveBeenCalled();
  });

  describe("across the first two stored patches", () => {
    const notFound = () => Object.assign(new Error("404: patch not found"), { status: 404 });
    const ops = (...ids: string[]) => ({ data: { ops: ids.map(id => ({ type: "UpsertNode", id, kind: id.startsWith("h") ? "heading" : "function" })) } });
    const liveEntity = () => vi.fn().mockResolvedValue({ node: { kind: "function" }, claims: [], edges: [] });
    const deleted = (p: GraphPatchPayload) => p.ops.filter(o => o.type === "DeleteNode").map(o => o["id"]);

    it("emits DeleteNode on an unchanged-hash rebuild for ids the old extractor's patch has and the new one lacks", async () => {
      const getPatch = vi.fn(async (id: string) => {
        if (id === "current@H") throw notFound();
        return ops("a", "h1", "h2");
      });
      const entity = vi.fn().mockResolvedValue({
        node: { kind: "heading" }, claims: [],
        edges: [{ id: "e-h1", predicate: "CONTAINS", provenance: { sourceUri: "src/example.ts" } }],
      });
      const patch = patchWith([{ type: "UpsertNode", id: "a", kind: "function" }]);

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patch, ["current@H", "old@H", "legacy@H"]);

      expect(deleted(reconciled)).toEqual(["h1", "h2"]);
      expect(reconciled.ops.filter(o => o.type === "DeleteEdge").map(o => o["id"])).toEqual(["e-h1"]);
      expect(entity.mock.calls.map(c => c[0])).toEqual(["h1", "h2"]);
    });

    it("merges the manifests of the first two existing candidates, primary order first", async () => {
      const getPatch = vi.fn(async (id: string) => (id === "current@H" ? ops("a", "b") : ops("a", "b", "h1", "h2")));
      const entity = liveEntity();
      const patch = patchWith([{ type: "UpsertNode", id: "a", kind: "function" }]);

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patch, ["current@H", "old@H", "legacy@H"]);

      expect(deleted(reconciled)).toEqual(["b", "h1", "h2"]);
    });

    it("gives an id only the second manifest names no DeleteNode when it is already gone, but still deletes an absent primary id", async () => {
      const getPatch = vi.fn(async (id: string) => (id === "current@H" ? ops("b") : ops("b", "h1")));
      const entity = vi.fn().mockRejectedValue(notFound());
      const patch = patchWith([]);

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patch, ["current@H", "old@H"]);

      expect(deleted(reconciled)).toEqual(["b"]);
    });

    it("reads no further than the window when a window candidate exists", async () => {
      const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
      const getPatch = vi.fn(async (id: string) => {
        if (id === "c0") return ops("a");
        throw notFound();
      });
      await reconcileRemovedEntities({ getPatch, entity: liveEntity() }, patchWith([]), ids);
      expect(getPatch.mock.calls.map(c => c[0]).sort()).toEqual(["c0", "c1"]);
    });

    it("walks the rest of the candidates when neither window candidate exists", async () => {
      const ids = ["c0", "c1", "c2", "c3"];
      const getPatch = vi.fn(async (id: string) => {
        if (id === "c2") return ops("a");
        throw notFound();
      });
      const reconciled = await reconcileRemovedEntities({ getPatch, entity: liveEntity() }, patchWith([]), ids);
      expect(deleted(reconciled)).toEqual(["a"]);
      expect(getPatch.mock.calls.map(c => c[0])).toEqual(["c0", "c1", "c2"]);

      await expect(
        reconcileRemovedEntities({ getPatch: vi.fn().mockRejectedValue(notFound()), entity: liveEntity() }, patchWith([]), ids),
      ).rejects.toThrow("Previous source patch was not found");
    });

    it("leaves chunks alone in map mode, across merged manifests", async () => {
      const getPatch = vi.fn(async (id: string) => {
        if (id === "current@H") return ops("a");
        return { data: { ops: [
          { type: "UpsertNode", id: "a", kind: "function" },
          { type: "UpsertNode", id: "chunk-L9", kind: "chunk" },
          { type: "UpsertNode", id: "h1", kind: "heading" },
        ] } };
      });
      const entity = vi.fn().mockResolvedValue({
        node: { kind: "heading" }, claims: [],
        edges: [{ id: "chunk-edge", predicate: "NEXT", provenance: { sourceUri: "src/example.ts" } }],
      });

      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["current@H", "old@H"], undefined, true);

      expect(entity.mock.calls.map(c => c[0]).sort()).toEqual(["a", "h1"]);
      expect(deleted(reconciled).sort()).toEqual(["a", "h1"]);
      expect(reconciled.ops.some(o => o["id"] === "chunk-L9")).toBe(false);
      expect(reconciled.ops.filter(o => o.type === "DeleteEdge")).toEqual([]);
    });

    it("skips a second patch with no entity manifest or a failed read, but fails when the read before any found patch fails", async () => {
      const entity = liveEntity();
      const noManifest = vi.fn(async (id: string) => (id === "current@H" ? ops("a") : { data: {} }));
      expect(deleted(await reconcileRemovedEntities({ getPatch: noManifest, entity }, patchWith([]), ["current@H", "old@H"]))).toEqual(["a"]);

      // The patch found first is the one the first-hit walk always used; a
      // backend error on the extra one only loses its extra ids, and says so.
      const second5xx = vi.fn(async (id: string) => {
        if (id === "current@H") return ops("a");
        throw Object.assign(new Error("500"), { status: 500 });
      });
      const onWindowSkipped = vi.fn();
      const reconciled = await reconcileRemovedEntities(
        { getPatch: second5xx, entity }, patchWith([]), ["current@H", "old@H"], undefined, false, undefined, { onWindowSkipped },
      );
      expect(deleted(reconciled)).toEqual(["a"]);
      expect(onWindowSkipped).toHaveBeenCalledTimes(1);
      expect(String(onWindowSkipped.mock.calls[0]![0])).toContain("old@H");

      // Nothing found before the failed read: the first-hit walk failed here too.
      const firstMissingSecond5xx = vi.fn(async (id: string) => {
        if (id === "current@H") throw notFound();
        throw Object.assign(new Error("500"), { status: 500 });
      });
      await expect(reconcileRemovedEntities({ getPatch: firstMissingSecond5xx, entity }, patchWith([]), ["current@H", "old@H"])).rejects.toThrow("500");

      const first5xx = vi.fn(async (id: string) => {
        if (id === "current@H") throw Object.assign(new Error("500"), { status: 500 });
        return ops("a");
      });
      await expect(reconcileRemovedEntities({ getPatch: first5xx, entity }, patchWith([]), ["current@H", "old@H"])).rejects.toThrow("500");
    });

    it("leaves the changed-hash path re-emitting an already-absent primary id, as before", async () => {
      const getPatch = vi.fn(async (id: string) => {
        if (id === "current@H") return { data: { ops: [{ type: "DeleteNode", id: "x" }, { type: "UpsertNode", id: "a", kind: "function" }] } };
        throw notFound();
      });
      const entity = vi.fn().mockRejectedValue(notFound());
      const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["current@H", "old@H"]);
      expect(deleted(reconciled)).toEqual(["x", "a"]);
    });
  });
});

describe("sweepOrphanNodes (IN-20 same-hash sweep)", () => {
  const notFound = () => Object.assign(new Error("404: patch not found"), { status: 404 });
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G = id(7);
  const node = (nid: string, over: Record<string, unknown> = {}): GraphNode => ({
    id: nid, kind: "function", name: nid, attrs: {}, provenance: { sourceUri: "src/example.ts" }, ...over,
  }) as unknown as GraphNode;
  const fileWith = (ops: GraphPatchPayload["ops"], uri = "src/example.ts") => {
    const patch = patchWith(ops);
    return { patch: { ...patch, source: { ...patch.source, uri } }, previousPatchIds: [`old@${uri}`] };
  };

  it("derives orphans from the stored node list with one patch read per file and one batched node read, no entity reads", async () => {
    // Bulk-stored manifests: ids only, no kinds.
    const getPatch = vi.fn(async (pid: string) => (pid === "old@src/example.ts"
      ? { data: { nodeIds: [A, B, C] } }
      : { data: { nodeIds: [D, E] } }));
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({
      rev: 1,
      nodes: [node(B), node(C, { attrs: { external: true } }), node(E, { provenance: { sourceUri: "src/other.ts" } })]
        .filter(n => ids.includes(n.id)),
      missing: [],
    }));
    const budget = orphanSweepBudget({});
    const files = [
      fileWith([{ type: "UpsertNode", id: A, kind: "function" }]),
      fileWith([{ type: "UpsertNode", id: D, kind: "function" }], "src/other.ts"),
    ];

    const orphans = await sweepOrphanNodes({ getPatch, nodes }, files, { mapMode: false, budget });

    // B: live, written by this file -> deleted. C: external -> kept.
    // E: live and written by src/other.ts -> deleted for that file.
    expect(orphans).toEqual([[B], [E]]);
    expect(getPatch).toHaveBeenCalledTimes(2);
    expect(nodes).toHaveBeenCalledTimes(1);
    expect(nodes.mock.calls[0]![1]).toBe("full");
    expect(budget.requests).toBe(3);
  });

  it("never deletes a node another file wrote last, one a patch of the batch upserts, an absent one, or a chunk in map mode", async () => {
    const getPatch = vi.fn(async () => ({ data: { nodeIds: [A, B, C, D, E] } }));
    const nodes = vi.fn(async (_ids: string[], _fields?: "full") => ({
      rev: 1,
      nodes: [
        node(A, { provenance: { sourceUri: "src/elsewhere.ts" } }),
        node(B),
        node(D, { kind: "chunk" }),
        node(E),
      ],
      missing: [C],
    }));
    const orphans = await sweepOrphanNodes(
      { getPatch, nodes }, [fileWith([])], { mapMode: true, budget: orphanSweepBudget({}), batchUpserts: new Set([E]) },
    );
    expect(orphans).toEqual([[B]]);
    // E is upserted by the batch: not even looked up.
    expect((nodes.mock.calls[0] as unknown as [string[]])[0]).not.toContain(E);
  });

  it("uses the kinds a stored patch with ops recorded: no lookup for its externals or, in map mode, its chunks", async () => {
    const getPatch = vi.fn(async () => ({ data: { ops: [
      { type: "UpsertNode", id: A, kind: "function" },
      { type: "UpsertNode", id: B, kind: "chunk" },
      { type: "UpsertNode", id: C, kind: "function", attrs: { external: true } },
      { type: "DeleteNode", id: D },
    ] } }));
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({ rev: 1, nodes: ids.map(i => node(i)), missing: [] }));
    const orphans = await sweepOrphanNodes({ getPatch, nodes }, [fileWith([])], { mapMode: true, budget: orphanSweepBudget({}) });
    // D was only deleted by the stored patch: not a node it wrote.
    expect(orphans).toEqual([[A]]);
    expect((nodes.mock.calls[0] as unknown as [string[]])[0]).toEqual([A]);
  });

  it("makes no node read when no file has a candidate, and skips a file whose patch is not found", async () => {
    const getPatch = vi.fn(async (pid: string) => {
      if (pid === "old@src/gone.ts") throw notFound();
      return { data: { nodeIds: [A] } };
    });
    const nodes = vi.fn();
    const onSkip = vi.fn();
    const orphans = await sweepOrphanNodes(
      { getPatch, nodes },
      [fileWith([{ type: "UpsertNode", id: A, kind: "function" }]), fileWith([], "src/gone.ts")],
      { mapMode: false, budget: orphanSweepBudget({}), onSkip },
    );
    expect(orphans).toEqual([[], []]);
    expect(nodes).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("reports a failed patch or node read for the files it covers and deletes nothing for them", async () => {
    const getPatch = vi.fn(async (pid: string) => {
      if (pid === "old@src/bad.ts") throw new Error("500: transaction begin timeout");
      return { data: { nodeIds: [A] } };
    });
    const onSkip = vi.fn();
    const failingNodes = vi.fn().mockRejectedValue(new Error("500: busy"));
    const orphans = await sweepOrphanNodes(
      { getPatch, nodes: failingNodes }, [fileWith([]), fileWith([], "src/bad.ts")],
      { mapMode: false, budget: orphanSweepBudget({}), onSkip },
    );
    expect(orphans).toEqual([[], []]);
    expect(onSkip.mock.calls.map(c => String(c[1]))).toEqual(["500: transaction begin timeout", "node read failed: 500: busy"]);
  });

  it("throws BatchNodeReadsUnsupported when the backend has no batched node read", async () => {
    const getPatch = vi.fn(async () => ({ data: { nodeIds: [A] } }));
    const nodes = vi.fn().mockRejectedValue(new Error("404: no such endpoint /v1/nodes"));
    await expect(sweepOrphanNodes({ getPatch, nodes }, [fileWith([])], { mapMode: false, budget: orphanSweepBudget({}) }))
      .rejects.toBeInstanceOf(BatchNodeReadsUnsupported);
  });

  it("turns itself off, not silently empty, when the batched read leaves out provenance", async () => {
    const getPatch = vi.fn(async () => ({ data: { nodeIds: [A] } }));
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({
      rev: 1, nodes: ids.map(i => node(i, { provenance: undefined })), missing: [],
    }));
    await expect(sweepOrphanNodes({ getPatch, nodes }, [fileWith([])], { mapMode: false, budget: orphanSweepBudget({}) }))
      .rejects.toThrow(/provenance/);
    const snake = vi.fn(async (ids: string[], _fields?: "full") => ({
      rev: 1, nodes: ids.map(i => node(i, { provenance: { source_uri: "src/example.ts" } })), missing: [],
    }));
    expect(await sweepOrphanNodes({ getPatch, nodes: snake }, [fileWith([])], { mapMode: false, budget: orphanSweepBudget({}) }))
      .toEqual([[A]]);
  });

  it("reads every stored patch a file names, merging their candidates, and reports the files it did not finish", async () => {
    const getPatch = vi.fn(async (pid: string) => {
      if (pid === "older@src/example.ts") return { data: { nodeIds: [B, C] } };
      if (pid === "old@src/bad.ts") throw new Error("500: busy");
      if (pid === "older@src/gone.ts") throw notFound();
      return { data: { nodeIds: [A, B] } };
    });
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({ rev: 1, nodes: ids.map(i => node(i)), missing: [] }));
    const two = { ...fileWith([]), previousPatchIds: ["old@src/example.ts", "older@src/example.ts"] };
    const bad = fileWith([], "src/bad.ts");
    const gone = { ...fileWith([], "src/gone.ts"), previousPatchIds: ["older@src/gone.ts"] };
    const late = fileWith([]);
    const budget = orphanSweepBudget({ IX_ORPHAN_SWEEP_MAX_REQUESTS: "4" });
    const onUnswept = vi.fn();
    const orphans = await sweepOrphanNodes(
      { getPatch, nodes }, [two, bad, gone, late], { mapMode: false, budget, concurrency: 1, onUnswept },
    );
    expect(orphans[0]!.sort()).toEqual([A, B, C]);
    expect(orphans.slice(1)).toEqual([[], [], []]);
    // bad: its read failed. late: past the budget. gone: not found, nothing to sweep.
    expect(onUnswept.mock.calls.map(c => c[0])).toEqual([bad, late]);
    expect(budget.skipped).toBe(1);
  });

  it("reads at most 1000 ids per node read", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => id(100 + i));
    const getPatch = vi.fn(async () => ({ data: { nodeIds: many } }));
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({ rev: 1, nodes: [], missing: ids }));
    await sweepOrphanNodes({ getPatch, nodes }, [fileWith([])], { mapMode: false, budget: orphanSweepBudget({}) });
    expect(nodes.mock.calls.map(c => (c[0] as string[]).length)).toEqual([1000, 1000, 500]);
  });

  it("stops at its request budget and counts the files it skipped, across batches", async () => {
    const getPatch = vi.fn(async () => ({ data: { nodeIds: [F] } }));
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({ rev: 1, nodes: ids.map(i => node(i)), missing: [] }));
    const budget = orphanSweepBudget({ IX_ORPHAN_SWEEP_MAX_REQUESTS: "3" });
    const batch = () => [fileWith([]), fileWith([]), fileWith([])];
    const first = await sweepOrphanNodes({ getPatch, nodes }, batch(), { mapMode: false, budget, concurrency: 1 });
    expect(first.filter(ids => ids.length > 0)).toHaveLength(3);
    expect(budget.requests).toBe(4);
    const second = await sweepOrphanNodes({ getPatch, nodes }, batch(), { mapMode: false, budget, concurrency: 1 });
    expect(second).toEqual([[], [], []]);
    expect(budget.skipped).toBe(3);
    expect(getPatch).toHaveBeenCalledTimes(3);
  });

  it("stops at its time budget", async () => {
    let clock = 0;
    const getPatch = vi.fn(async () => { clock += 40; return { data: { nodeIds: [G] } }; });
    const nodes = vi.fn(async (ids: string[], _fields?: "full") => ({ rev: 1, nodes: ids.map(i => node(i)), missing: [] }));
    const budget = orphanSweepBudget({ IX_ORPHAN_SWEEP_MAX_MS: "100" });
    const orphans = await sweepOrphanNodes(
      { getPatch, nodes }, [fileWith([]), fileWith([]), fileWith([]), fileWith([])],
      { mapMode: false, budget, concurrency: 1, now: () => clock },
    );
    expect(orphans.filter(ids => ids.length > 0)).toHaveLength(3);
    expect(budget.skipped).toBe(1);
    expect(budget.usedMs).toBe(120);
  });
});

describe("orphanSweepUnsupportedReason", () => {
  it("allows the sweep from the release that serves batched node reads, and not before", () => {
    expect(orphanSweepUnsupportedReason({ release_version: "1.0.34" }, {})).toBeNull();
    expect(orphanSweepUnsupportedReason({ release_version: BATCH_NODE_READS_SINCE }, {})).toBeNull();
    expect(orphanSweepUnsupportedReason({ release_version: "1.0.32" }, {})).toContain("older than 1.0.33");
    expect(orphanSweepUnsupportedReason({ release_version: "1.0.31" }, {})).toContain("release 1.0.31");
    expect(orphanSweepUnsupportedReason({}, {})).toContain("unversioned");
    expect(orphanSweepUnsupportedReason(null, {})).toContain("unversioned");
    // Forced onto bulk deletes: tried, and turned off at run time if /v1/nodes is missing.
    expect(orphanSweepUnsupportedReason({}, { IX_BULK_DELETES: "1" })).toBeNull();
    expect(orphanSweepUnsupportedReason({ release_version: "1.0.34" }, { IX_BULK_DELETES: "0" })).not.toBeNull();
  });
});
