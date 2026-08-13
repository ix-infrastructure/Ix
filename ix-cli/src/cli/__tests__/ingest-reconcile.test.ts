import { describe, expect, it, vi } from "vitest";
import * as nodePath from "node:path";

import type { GraphPatchPayload } from "../../client/types.js";
import {
  patchRequiresPerFileCommit,
  planDeletedFileRecovery,
  reconcileRemovedEntities,
} from "../commands/ingest.js";

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
  it("routes patches with deletion ops away from the bulk endpoint", () => {
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteNode", id: "old-node" }]))).toBe(true);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "DeleteEdge", id: "old-edge" }]))).toBe(true);
    expect(patchRequiresPerFileCommit(patchWith([{ type: "UpsertNode", id: "node" }]))).toBe(false);
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
});
