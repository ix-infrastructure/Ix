import { describe, it, expect } from "vitest";
import { renderNodesLlm, renderPatchesLlm, renderTextResultsLlm, type TextResult } from "../format.js";
import { renderSearchLlm } from "../commands/search.js";
import { renderHistoryLlm } from "../commands/history.js";

describe("renderNodesLlm", () => {
  it("emits one node record per entity with an 8-char id", () => {
    expect(renderNodesLlm([{ kind: "class", id: "abcdef1234567890", name: "Foo" }]))
      .toEqual(["node kind=class id=abcdef12 name=Foo"]);
  });
});

describe("renderPatchesLlm", () => {
  it("emits patch records with 12-char id and quoted intent", () => {
    const lines = renderPatchesLlm([
      { rev: 5, patch_id: "abcdef1234567890", intent: "fix bug", timestamp: "2026-01-01", source: { uri: "src/a.ts" } },
    ]);
    expect(lines).toEqual(['patch rev=5 id=abcdef123456 intent="fix bug" ts=2026-01-01 source=src/a.ts']);
  });
});

describe("renderTextResultsLlm", () => {
  it("emits match records with trimmed (quoted) snippet and language", () => {
    const results: TextResult[] = [
      { path: "src/a.ts", line_start: 42, line_end: 42, snippet: "  const x = 1  ", engine: "ripgrep", score: 1, language: "typescript" },
    ];
    expect(renderTextResultsLlm(results)).toEqual(['match path=src/a.ts line=42 lang=typescript snippet="const x = 1"']);
  });
});

describe("renderSearchLlm", () => {
  it("emits a header, node rows, then diagnostic rows", () => {
    const lines = renderSearchLlm(
      [{ name: "Foo", kind: "class", id: "abcdef1234567890", path: "src/a.ts", score: 5 }],
      10,
      [{ code: "unfiltered_search", message: "broad" }],
    );
    expect(lines).toEqual([
      "search count=1 candidates=10",
      "node name=Foo kind=class id=abcdef12 path=src/a.ts score=5",
      "diagnostic code=unfiltered_search message=broad",
    ]);
  });
});

describe("renderHistoryLlm", () => {
  it("emits a header then one patch record per revision", () => {
    const lines = renderHistoryLlm({ name: "Foo", kind: "class" }, [
      { rev: 3, data: { timestamp: "t1", intent: "init", source: { uri: "a.ts" } } },
    ]);
    expect(lines).toEqual([
      "history target=Foo kind=class count=1",
      "patch rev=3 ts=t1 intent=init source=a.ts",
    ]);
  });
});
