// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";
import { leafRowLlm, leafTruncationLlm } from "../commands/impact.js";
import { sliceEdgeResults } from "../format.js";
import { IX_CALLER_ENV } from "../next-step.js";

const node = (name: string, line_start?: number, line_end?: number) => ({
  id: `id-${name}`,
  kind: "function",
  name,
  attrs: { path: "src/auth/token.ts", line_start, line_end },
});

describe("impact leaf llm rows", () => {
  it("carries path and lines on each caller row", () => {
    expect(leafRowLlm("caller", node("verify", 10, 42))).toBe(
      "caller name=verify kind=function path=src/auth/token.ts lines=10-42",
    );
  });

  it("omits lines when the node has no span", () => {
    expect(leafRowLlm("callee", node("hash"))).toBe("callee name=hash kind=function path=src/auth/token.ts");
  });

  it("cuts an over-limit list with honest shown and total and a truncation diagnostic", () => {
    const all = Array.from({ length: 25 }, (_, i) => node(`c${i}`, i + 1, i + 1));
    const slice = sliceEdgeResults(all, 10);
    expect(slice.shown).toBe(10);
    expect(slice.total).toBe(25);
    expect(slice.rows).toHaveLength(10);
    const diag = leafTruncationLlm("callers", slice, "verify");
    expect(diag).toEqual([
      'diagnostic code=results_truncated message="25 callers; showing 10. Raise --limit to see them, or page them with ix callers verify"',
    ]);
  });

  it("never points at --offset or next_offset: ix impact has no --offset", () => {
    const all = Array.from({ length: 25 }, (_, i) => node(`c${i}`, i + 1, i + 1));
    // Even a slice that carries a next page (as the paging helpers set one) prints none.
    const slice = { ...sliceEdgeResults(all, 10), nextOffset: 10, next: "ix callers verify --offset 10" };
    const diag = leafTruncationLlm("callers", slice, "verify").join("\n");
    expect(diag).not.toContain("--offset");
    expect(diag).not.toContain("next_offset");
    expect(diag).not.toContain("next:");
  });

  it("over MCP names the ix_neighbors call that pages the list", () => {
    const prev = process.env[IX_CALLER_ENV];
    process.env[IX_CALLER_ENV] = "mcp";
    try {
      const slice = sliceEdgeResults(Array.from({ length: 25 }, (_, i) => node(`c${i}`)), 10);
      expect(leafTruncationLlm("callees", slice, "verify")[0]).toBe(
        'diagnostic code=results_truncated message="25 callees; showing 10. To page them: ix_neighbors symbol=verify relation=callees"',
      );
    } finally {
      if (prev === undefined) delete process.env[IX_CALLER_ENV];
      else process.env[IX_CALLER_ENV] = prev;
    }
  });

  it("emits no diagnostic when the list fits", () => {
    const slice = sliceEdgeResults([node("a"), node("b")], 10);
    expect(leafTruncationLlm("callers", slice, "verify")).toEqual([]);
  });

  it("writes a single-line span as one number and drops path-less locations", () => {
    expect(leafRowLlm("caller", node("a", 10, 10))).toBe("caller name=a kind=function path=src/auth/token.ts lines=10");
    expect(leafRowLlm("caller", { id: "x", kind: "function", name: "b" })).toBe("caller name=b kind=function");
  });

  it("keeps named rows with a path when cutting a mixed list", () => {
    const raw = Array.from({ length: 5 }, () => ({ id: "0123456789abcdef0123456789abcdef", kind: "function", name: "0123456789abcdef0123456789abcdef" }));
    const nopath = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, kind: "function", name: `np${i}` }));
    const good = Array.from({ length: 4 }, (_, i) => node(`g${i}`, 1, 2));
    const slice = sliceEdgeResults([...raw, ...nopath, ...good], 4);
    expect(slice.rows.map((r: any) => r.name)).toEqual(["g0", "g1", "g2", "g3"]);
  });
});
