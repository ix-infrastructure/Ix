// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { stripMapModeOps } from "../commands/ingest.js";
import type { GraphPatchPayload } from "../../client/types.js";

describe("stripMapModeOps", () => {
  it("drops chunks and every edge that touches one, and nothing else", () => {
    const patch = {
      patchId: "p",
      ops: [
        { type: "UpsertNode", id: "file", kind: "file", name: "a.ts", attrs: {} },
        { type: "UpsertNode", id: "fn", kind: "function", name: "run", attrs: {} },
        { type: "UpsertNode", id: "c1", kind: "chunk", name: "run", attrs: {} },
        { type: "UpsertNode", id: "c2", kind: "chunk", name: "file_body:9", attrs: {} },
        { type: "UpsertEdge", id: "e1", src: "file", dst: "c1", predicate: "CONTAINS_CHUNK", attrs: {} },
        { type: "UpsertEdge", id: "e2", src: "c1", dst: "c2", predicate: "NEXT", attrs: {} },
        // The one that used to survive: its chunk is gone, so it dangled.
        { type: "UpsertEdge", id: "e3", src: "c1", dst: "fn", predicate: "DEFINES", attrs: {} },
        { type: "UpsertEdge", id: "e4", src: "file", dst: "fn", predicate: "CONTAINS", attrs: {} },
        { type: "AssertClaim", entityId: "fn", field: "calls:x", value: "x", confidence: null },
      ],
    } as unknown as GraphPatchPayload;

    const kept = stripMapModeOps(patch).ops.map((op) => String(op.id ?? op.type));

    expect(kept).toEqual(["file", "fn", "e4"]);
  });
});
