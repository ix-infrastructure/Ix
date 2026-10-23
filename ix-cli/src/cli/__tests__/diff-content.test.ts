// Copyright 2026 Ix Infrastructure Inc.

import { describe, it, expect } from "vitest";
import { computeTextualDiff } from "../commands/diff.js";

// ── Unit tests for computeTextualDiff ───────────────────────────────

describe("computeTextualDiff", () => {
  it("returns empty array for identical content", async () => {
    const result = await computeTextualDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(result).toEqual([]);
  });

  it("shows added lines with + prefix", async () => {
    const result = await computeTextualDiff("a\nb\n", "a\nb\nc\n");
    const added = result.filter(l => l.startsWith("+"));
    expect(added.length).toBeGreaterThan(0);
    expect(added.some(l => l.includes("c"))).toBe(true);
  });

  it("shows removed lines with - prefix", async () => {
    const result = await computeTextualDiff("a\nb\nc\n", "a\nb\n");
    const removed = result.filter(l => l.startsWith("-"));
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.some(l => l.includes("c"))).toBe(true);
  });

  it("replacement shows - then + without identical pairs", async () => {
    const result = await computeTextualDiff("// old comment\n", "// new comment\n");
    const removed = result.filter(l => l.startsWith("-"));
    const added = result.filter(l => l.startsWith("+"));
    expect(removed.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThan(0);
    // Must not have identical - and + lines
    for (const r of removed) {
      for (const a of added) {
        expect(r.slice(1)).not.toBe(a.slice(1));
      }
    }
  });

  it("replacement + insertion renders correctly", async () => {
    const before = "line1\n// old comment\nline3\n";
    const after = "line1\n// Another test comment replacing old\n// new comment entirely\nline3\n";
    const result = await computeTextualDiff(before, after);
    const removed = result.filter(l => l.startsWith("-"));
    const added = result.filter(l => l.startsWith("+"));
    expect(removed.some(l => l.includes("old comment"))).toBe(true);
    expect(added.some(l => l.includes("Another test comment"))).toBe(true);
    expect(added.some(l => l.includes("new comment entirely"))).toBe(true);
  });

  it("comment-only change is detected", async () => {
    const before = "function foo() {\n  return 1;\n}\n";
    const after = "function foo() {\n  // test comment\n  return 1;\n}\n";
    const result = await computeTextualDiff(before, after);
    expect(result.length).toBeGreaterThan(0);
    const added = result.filter(l => l.startsWith("+"));
    expect(added.some(l => l.includes("test comment"))).toBe(true);
  });
});
