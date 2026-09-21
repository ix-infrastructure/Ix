// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { renderEdgeResultsLlm, sliceEdgeResults, sliceRanked } from "../format.js";
import { renderInventoryLlm } from "../commands/inventory.js";
import { scanWindow, textResultPriority } from "../commands/text.js";

function node(name: string, path?: string) {
  return { id: `${name}-0000-0000-0000-000000000000`, name, kind: "function", ...(path ? { provenance: { source_uri: path } } : {}) };
}

describe("sliceRanked", () => {
  it("reports the count before the cut, not after it", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`caller${i}`, "src/a.ts"));
    const slice = sliceRanked(all, 50);
    expect(slice.shown).toBe(50);
    expect(slice.total).toBe(212);
    expect(slice.truncated).toBe(true);
  });

  it("is not truncated when everything fits", () => {
    const slice = sliceRanked([node("a", "src/a.ts")], 50);
    expect(slice).toMatchObject({ shown: 1, total: 1, truncated: false });
  });

  it("keeps the source order among rows that rank equally", () => {
    const all = [node("b", "src/b.ts"), node("a", "src/a.ts")];
    expect(sliceRanked(all, 10, () => 0).rows.map((n) => n.name)).toEqual(["b", "a"]);
  });

  it("does not mutate the caller's array", () => {
    const all = [node("b", "src/b.ts"), node("a")];
    const copy = [...all];
    sliceRanked(all, 10, (n) => (n.provenance ? 0 : 1));
    expect(all).toEqual(copy);
  });
});

describe("sliceEdgeResults", () => {
  it("keeps followable rows over dangling ones when the cut bites", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method" },
      { id: "cccccccc-3333-0000-0000-000000000000", name: "verify", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const rows = sliceEdgeResults(all, 2).rows.map((n) => n.name);
    expect(rows).toEqual(["verify", "handleLogin"]);
  });

  it("still reports the rows it dropped", () => {
    const all = [
      { id: "aaaaaaaa-1111-0000-0000-000000000000", name: "d41d8cd98f00b204e9800998ecf8427e", kind: "method" },
      { id: "bbbbbbbb-2222-0000-0000-000000000000", name: "handleLogin", kind: "method", provenance: { source_uri: "src/a.ts" } },
    ];
    const header = renderEdgeResultsLlm(sliceEdgeResults(all, 1), "callers", "verify_token", "graph")[0];
    expect(header).toBe("callers target=verify_token shown=1 total=2 resolved=1");
  });

  it("names the flag that would show the rest", () => {
    const all = Array.from({ length: 212 }, (_, i) => node(`c${i}`, "src/a.ts"));
    const lines = renderEdgeResultsLlm(sliceEdgeResults(all, 50), "callers", "verify_token", "graph");
    expect(lines[1]).toBe(
      'diagnostic code=results_truncated message="212 callers; showing 50. Raise --limit to see the rest."',
    );
  });
});

describe("renderInventoryLlm", () => {
  it("says shown, and marks a full window rather than inventing a total", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes, true).slice(0, 2)).toEqual([
      "inventory kind=class shown=1 truncated=true",
      'diagnostic code=results_truncated message="More than 1 class entities exist. Raise --limit, or narrow with --path."',
    ]);
  });

  it("says nothing about truncation when the window was not full", () => {
    const nodes = [{ name: "Foo", kind: "class", provenance: { source_uri: "src/a.ts" } }];
    expect(renderInventoryLlm("class", null, nodes)[0]).toBe("inventory kind=class shown=1");
  });
});

describe("text result ranking", () => {
  it("scans past the limit so ranking has something to rank", () => {
    expect(scanWindow(20)).toBe(100);
    expect(scanWindow(1)).toBe(5);
    expect(scanWindow(400)).toBe(500);
  });

  it("puts code above tests, and tests above prose", () => {
    expect(textResultPriority("ix-cli/src/cli/format.ts")).toBe(0);
    expect(textResultPriority("ix-cli/src/cli/__tests__/format.test.ts")).toBe(1);
    expect(textResultPriority("ix-cli/test/fixtures/a.ts")).toBe(1);
    expect(textResultPriority("README.md")).toBe(2);
    expect(textResultPriority("docs/api/README.md")).toBe(2);
    expect(textResultPriority("package-lock.json")).toBe(2);
  });

  it("reorders the answer before the limit cuts it", () => {
    const rows = [
      { path: "README.md", line_start: 1, line_end: 1, snippet: "a", engine: "ripgrep", score: 1 },
      { path: "docs/guide.md", line_start: 2, line_end: 2, snippet: "b", engine: "ripgrep", score: 1 },
      { path: "src/a.ts", line_start: 3, line_end: 3, snippet: "c", engine: "ripgrep", score: 1 },
    ];
    const slice = sliceRanked(rows, 1, (r) => textResultPriority(r.path));
    expect(slice.rows.map((r) => r.path)).toEqual(["src/a.ts"]);
    expect(slice.total).toBe(3);
  });
});
