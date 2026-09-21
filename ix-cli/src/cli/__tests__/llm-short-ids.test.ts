// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { llmShortId } from "../llm.js";
import { renderEdgeResultsLlm, renderNodesLlm, renderConflictsLlm, sliceEdgeResults } from "../format.js";
import { renderEntityLlm } from "../commands/entity.js";
import { renderSubsystemScoreLlm } from "../commands/subsystems.js";

const UUID = "8ebf63f9-a75b-ccd0-d899-b02950ecb240";
const UUID_2 = "21309739-2f48-31d9-bfcc-be8652fd95e6";

/** A full v4-shaped id anywhere in a record is what this task exists to remove. */
const FULL_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("llmShortId", () => {
  it("cuts an opaque id to a prefix the CLI still accepts", () => {
    expect(llmShortId(UUID)).toBe("8ebf63f9");
    expect(llmShortId("d41d8cd98f00b204e9800998ecf8427e")).toBe("d41d8cd9");
  });

  it("leaves anything that is not an opaque id alone", () => {
    // Truncating these would corrupt a value rather than abbreviate one.
    expect(llmShortId("c-8f31a2")).toBe("c-8f31a2");
    expect(llmShortId("root")).toBe("root");
    expect(llmShortId("ix-cli/src/cli/format.ts")).toBe("ix-cli/src/cli/format.ts");
  });

  it("drops nothing-values the way every other field does", () => {
    expect(llmShortId(undefined)).toBeUndefined();
    expect(llmShortId(null)).toBeUndefined();
    expect(llmShortId("")).toBeUndefined();
  });
});

describe("no renderer emits a full id", () => {
  it("entity, with its edges", () => {
    const lines = renderEntityLlm({
      node: { id: UUID, kind: "function", name: "relativePath", createdRev: 2500 },
      edges: [{ predicate: "CALLS", dst: UUID_2 }],
    });
    expect(lines.join("\n")).not.toMatch(FULL_UUID);
    expect(lines[0]).toContain("id=8ebf63f9");
    expect(lines[1]).toContain("dst=21309739");
  });

  it("nodes", () => {
    expect(renderNodesLlm([{ id: UUID, kind: "class", name: "Foo" }]).join("\n")).not.toMatch(FULL_UUID);
  });

  it("edge results", () => {
    const lines = renderEdgeResultsLlm(
      // #688 made this take a Slice rather than a bare array.
      sliceEdgeResults([{ id: UUID, name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } }], 10),
      "callers", "verify_token", "graph",
    );
    expect(lines.join("\n")).not.toMatch(FULL_UUID);
  });

  it("conflicts, which name two claims and nothing else", () => {
    const lines = renderConflictsLlm([{ reason: "r", recommendation: "x", claimA: UUID, claimB: UUID_2 }]);
    expect(lines.join("\n")).not.toMatch(FULL_UUID);
  });

  it("subsystem regions", () => {
    const line = renderSubsystemScoreLlm({
      region_id: UUID, name: "CLI", label_kind: "module", level: 1, file_count: 107,
      health_score: 0.5, chunk_density: 0, smell_files: 0, confidence: 0.7,
    } as never);
    expect(line).not.toMatch(FULL_UUID);
    expect(line).toContain("id=8ebf63f9");
  });
});

describe("a shortened reference still resolves inside the same output", () => {
  it("keeps an id and a reference to it in step", () => {
    // `parent=` on one region has to match `id=` on another, so both sides go
    // through the same shortener or the tree stops being re-buildable.
    expect(llmShortId(UUID_2)).toBe(llmShortId(UUID_2.toLowerCase()));
    expect(llmShortId(UUID_2)).toBe("21309739");
  });
});
