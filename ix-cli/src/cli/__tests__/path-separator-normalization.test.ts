import { describe, expect, it } from "vitest";
import { applyPathFilters } from "../commands/rank.js";
import { normalizePathSeparators } from "../path-match.js";

/**
 * Ix#636: `--path` accepted only POSIX separators in `rank` and `inventory`,
 * while every stored source_uri is POSIX by construction
 * (`ingest.ts` → `toWorkspaceRelative` → `rel.split(nodePath.sep).join('/')`).
 * So on Windows the natural `--path src\cli` matched nothing at all, silently.
 *
 * These pin the separator half only. Case is deliberately NOT normalized here:
 * the resolver lowercases and rank/inventory/backend do not, and reconciling
 * that is a separate product decision tracked in the same issue.
 */
const node = (sourceUri: string) => ({ provenance: { sourceUri } });

describe("normalizePathSeparators", () => {
  it("converts Windows separators and leaves POSIX alone", () => {
    expect(normalizePathSeparators("src\\cli\\rank.ts")).toBe("src/cli/rank.ts");
    expect(normalizePathSeparators("src/cli/rank.ts")).toBe("src/cli/rank.ts");
  });

  it("does not touch case", () => {
    expect(normalizePathSeparators("IX-Memory\\Src")).toBe("IX-Memory/Src");
  });

  it("treats null and undefined as empty", () => {
    expect(normalizePathSeparators(undefined)).toBe("");
    expect(normalizePathSeparators(null)).toBe("");
  });
});

describe("rank --path separator handling", () => {
  const nodes = [node("ix-cli/src/cli/commands/rank.ts"), node("ix-cli/src/api/client.ts")];

  it("matches a Windows-style --path against POSIX source_uris", () => {
    // The regression: this returned [] before the fix.
    expect(applyPathFilters(nodes, "src\\cli")).toHaveLength(1);
    expect(applyPathFilters(nodes, "src\\cli")[0].provenance.sourceUri)
      .toBe("ix-cli/src/cli/commands/rank.ts");
  });

  it("still matches a POSIX --path exactly as before", () => {
    expect(applyPathFilters(nodes, "src/cli")).toHaveLength(1);
  });

  it("applies the same normalization to --exclude-path", () => {
    expect(applyPathFilters(nodes, undefined, "src\\cli")).toHaveLength(1);
    expect(applyPathFilters(nodes, undefined, "src\\cli")[0].provenance.sourceUri)
      .toBe("ix-cli/src/api/client.ts");
  });

  it("normalizes a backslash-bearing source_uri too", () => {
    // Defensive: github/transform.ts builds its own source_uris, and graphs
    // ingested before toWorkspaceRelative normalized separators can hold them.
    expect(applyPathFilters([node("legacy\\src\\cli\\old.ts")], "src/cli")).toHaveLength(1);
  });

  it("leaves case-sensitivity unchanged (still case-SENSITIVE here)", () => {
    // Pins the deliberate non-change: flipping this is the open half of #636.
    expect(applyPathFilters([node("IX-Memory/src/a.ts")], "ix-memory")).toHaveLength(0);
    expect(applyPathFilters([node("IX-Memory/src/a.ts")], "IX-Memory")).toHaveLength(1);
  });
});
