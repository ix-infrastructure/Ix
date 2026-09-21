// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { dropIncidentalMatches, foldChunkTwins, tierRelevance } from "../commands/search.js";

function row(node: Record<string, unknown>, tier: number) {
  return { node, rank: { tier, score: -tier, matchSource: "test" } };
}

function withPath(name: string, kind: string, path: string) {
  return { name, kind, provenance: { sourceUri: path } };
}

describe("tierRelevance", () => {
  it("is positive, bounded and best-first", () => {
    const scores = [0, 1, 2, 3, 4, 5].map(tierRelevance);
    expect(scores).toEqual([1, 0.83, 0.67, 0.5, 0.33, 0.17]);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < scores.length; i += 1) expect(scores[i]).toBeLessThan(scores[i - 1]);
  });

  it("clamps a tier outside the known range rather than going negative", () => {
    expect(tierRelevance(-3)).toBe(1);
    expect(tierRelevance(99)).toBe(tierRelevance(5));
  });
});

describe("foldChunkTwins", () => {
  it("drops a chunk whose symbol is already in the answer", () => {
    const folded = foldChunkTwins([
      row(withPath("resolveWorkspaceRoot", "function", "ix-cli/src/cli/config.ts"), 0),
      row(withPath("resolveWorkspaceRoot", "chunk", "ix-cli/src/cli/config.ts"), 0),
    ]);
    expect(folded.map((s) => s.node.kind)).toEqual(["function"]);
  });

  it("keeps a chunk that is the only row standing for its text", () => {
    const folded = foldChunkTwins([
      row(withPath("resolveWorkspaceRoot", "function", "ix-cli/src/cli/config.ts"), 0),
      row(withPath("file_body:120", "chunk", "ix-cli/src/cli/config.ts"), 3),
    ]);
    expect(folded).toHaveLength(2);
  });

  it("keeps a same-named chunk from a different file", () => {
    // Same name, different file: not a twin, and the symbol row for that file
    // is not in the answer to replace it.
    const folded = foldChunkTwins([
      row(withPath("parse", "function", "ix-cli/src/a.ts"), 0),
      row(withPath("parse", "chunk", "ix-cli/src/b.ts"), 0),
    ]);
    expect(folded).toHaveLength(2);
  });

  it("leaves a chunk-only answer alone", () => {
    const rows = [row(withPath("file_body:1", "chunk", "a.ts"), 5)];
    expect(foldChunkTwins(rows)).toEqual(rows);
  });
});

describe("dropIncidentalMatches", () => {
  it("drops the bottom tier when something matched by name", () => {
    const kept = dropIncidentalMatches([
      row(withPath("search", "method", "a.ts"), 1),
      row(withPath("unrelated", "function", "b.ts"), 5),
    ]);
    expect(kept.map((s) => s.node.name)).toEqual(["search"]);
  });

  it("keeps the bottom tier when it is all there is", () => {
    const rows = [
      row(withPath("unrelated", "function", "b.ts"), 5),
      row(withPath("other", "function", "c.ts"), 5),
    ];
    expect(dropIncidentalMatches(rows)).toEqual(rows);
  });

  it("runs before the limit, so a dropped row makes room", () => {
    const scored = [
      row(withPath("a", "function", "a.ts"), 0),
      row(withPath("fuzz", "config_entry", "z.ts"), 5),
      row(withPath("b", "function", "b.ts"), 3),
    ];
    const shown = dropIncidentalMatches(scored).slice(0, 2);
    expect(shown.map((s) => s.node.name)).toEqual(["a", "b"]);
  });
});
