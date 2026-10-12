// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";

import type { GraphPatchPayload } from "../../client/types.js";
import {
  BULK_DELETES_SINCE,
  backendAppliesBulkDeletes,
  patchRequiresPerFileCommit,
  planDeletedFileRecovery,
  reconcileRemovedEntities,
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

    describe("on a same-hash reconcile (liveOnly)", () => {
      const withDelete = (deletedId: string, ...ids: string[]) => ({ data: { ops: [
        { type: "DeleteNode", id: deletedId },
        ...ids.map(id => ({ type: "UpsertNode", id, kind: "function" })),
      ] } });

      it("emits no DeleteNode for an id an earlier reconcile already deleted, and does not look it up", async () => {
        const getPatch = vi.fn(async (id: string) => {
          if (id === "current@H") return withDelete("x", "a");
          throw notFound();
        });
        const entity = vi.fn().mockRejectedValue(notFound());
        const patch = patchWith([{ type: "UpsertNode", id: "a", kind: "function" }]);

        const reconciled = await reconcileRemovedEntities(
          { getPatch, entity }, patch, ["current@H", "old@H"], undefined, false, undefined, { liveOnly: true },
        );

        expect(deleted(reconciled)).toEqual([]);
        expect(entity).not.toHaveBeenCalled();
      });

      it("deletes only live nodes an earlier patch created, not absent ones, across both manifests", async () => {
        // x: deleted by the current patch, created by the old one, now gone.
        // gone: created, already absent. live: created and still live.
        const getPatch = vi.fn(async (id: string) => (id === "current@H" ? withDelete("x", "a", "gone") : ops("a", "x", "live")));
        const entity = vi.fn().mockImplementation(async (id: string) => {
          if (id === "live") return { node: { kind: "function" }, claims: [], edges: [] };
          throw notFound();
        });
        const patch = patchWith([{ type: "UpsertNode", id: "a", kind: "function" }]);

        const reconciled = await reconcileRemovedEntities(
          { getPatch, entity }, patch, ["current@H", "old@H"], undefined, false, undefined, { liveOnly: true },
        );

        expect(deleted(reconciled)).toEqual(["live"]);
      });

      it("leaves the changed-hash path re-emitting an already-absent primary id, as before", async () => {
        const getPatch = vi.fn(async (id: string) => {
          if (id === "current@H") return withDelete("x", "a");
          throw notFound();
        });
        const entity = vi.fn().mockRejectedValue(notFound());
        const reconciled = await reconcileRemovedEntities({ getPatch, entity }, patchWith([]), ["current@H", "old@H"]);
        expect(deleted(reconciled)).toEqual(["x", "a"]);
      });
    });
  });
});
