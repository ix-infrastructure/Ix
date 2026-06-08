import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeLineDiff, computeTextualDiff } from "../commands/diff.js";

const diffTsPath = path.resolve(__dirname, "../commands/diff.ts");
const diffContent = fs.readFileSync(diffTsPath, "utf-8");

// ── Unit tests for computeLineDiff ──────────────────────────────────

describe("computeLineDiff", () => {
  it("identical input produces all context lines", () => {
    const result = computeLineDiff("a\nb\nc", "a\nb\nc");
    expect(result).toEqual(["  a", "  b", "  c"]);
  });

  it("added lines produce + prefixed lines", () => {
    const result = computeLineDiff("a\nb", "a\nb\nc");
    expect(result).toEqual(["  a", "  b", "+ c"]);
  });

  it("removed lines produce - prefixed lines", () => {
    const result = computeLineDiff("a\nb\nc", "a\nb");
    expect(result).toEqual(["  a", "  b", "- c"]);
  });

  it("modified lines produce - then + pairs", () => {
    const result = computeLineDiff("a\nold\nc", "a\nnew\nc");
    expect(result).toEqual(["  a", "- old", "+ new", "  c"]);
  });

  it("empty before produces all + lines", () => {
    const result = computeLineDiff("", "a\nb");
    expect(result).toEqual(["- ", "+ a", "+ b"]);
  });

  it("empty after produces - then + for first line, then - for remaining", () => {
    const result = computeLineDiff("a\nb", "");
    expect(result).toEqual(["- a", "+ ", "- b"]);
  });

  it("both empty produces single context line", () => {
    const result = computeLineDiff("", "");
    expect(result).toEqual(["  "]);
  });
});

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

// ── Source-reading: diff.ts structure ───────────────────────────────

describe("diff.ts textual diff model", () => {
  it("has computeTextualDiff using git diff --no-index", () => {
    expect(diffContent).toContain("computeTextualDiff");
    expect(diffContent).toContain("--no-index");
  });

  it("has loadFileAtTimestamp for full file content via git", () => {
    expect(diffContent).toContain("loadFileAtTimestamp");
    expect(diffContent).toContain("--before=");
  });

  it("has loadFileFromDisk for current disk content", () => {
    expect(diffContent).toContain("loadFileFromDisk");
  });

  it("uses git show to retrieve historical file content", () => {
    expect(diffContent).toMatch(/`\$\{hash\}:\$\{relPath\}`/);
    expect(diffContent).toContain('"show"');
  });

  it("falls back to readSourceSpan on git failure", () => {
    expect(diffContent).toContain("return readSourceSpan(node)");
  });

  it("has readSourceSpanAtTimestamp for span-level historical content", () => {
    expect(diffContent).toContain("readSourceSpanAtTimestamp");
  });

  it("formatDiffContent is async", () => {
    expect(diffContent).toContain("async function formatDiffContent");
  });

  it("uses await formatDiffContent at call site", () => {
    expect(diffContent).toContain("await formatDiffContent(result)");
  });

  it("parseDiffOutput strips git diff headers", () => {
    expect(diffContent).toContain("parseDiffOutput");
    expect(diffContent).toContain('line.startsWith("@@")');
  });

  it("resolves before timestamp from graph changes or patch list", () => {
    expect(diffContent).toContain("resolveFromTimestamp");
    expect(diffContent).toContain("getRevisionTimestamp");
  });

  it("resolves after timestamp for non-latest revisions", () => {
    expect(diffContent).toContain("resolveToTimestamp");
  });

  it("has loadContentAtRev for revision-aware content loading", () => {
    expect(diffContent).toContain("loadContentAtRev");
    expect(diffContent).toContain("loadFileFromDisk(fileUri)");
    expect(diffContent).toContain("loadFileAtTimestamp(fileUri, ts)");
  });

  it("content mode uses loadContentAtRev for both sides", () => {
    expect(diffContent).toContain('loadContentAtRev(client, fileUri, from, changes, "from")');
    expect(diffContent).toContain('loadContentAtRev(client, fileUri, to, changes, "to")');
  });

  it("detects textual changes when graph shows no changes", () => {
    expect(diffContent).toContain("textualChanges");
    expect(diffContent).toContain("not captured by parser");
  });

  it("uses computeTextualDiff for source span diffs in graph fallback", () => {
    expect(diffContent).toContain("computeTextualDiff(beforeSource, afterSource)");
  });

  it("uses a private temp dir under os.tmpdir for git diff --no-index and cleans it up", () => {
    expect(diffContent).toContain("os.tmpdir()");
    // Atomic private temp dir (mkdtempSync) + recursive cleanup, not predictably
    // named files in the shared tmpdir (CodeQL js/insecure-temporary-file).
    expect(diffContent).toContain("mkdtempSync");
    expect(diffContent).toContain("rmSync");
  });
});

// ── Resolver flags in diff ──────────────────────────────────────────

describe("diff.ts resolver flags", () => {
  it("supports --pick option", () => {
    expect(diffContent).toContain('"--pick <n>"');
  });

  it("supports --kind option", () => {
    expect(diffContent).toContain('"--kind <kind>"');
  });

  it("supports --path option", () => {
    expect(diffContent).toContain('"--path <path>"');
  });

  it("passes resolver opts to resolveFileOrEntity", () => {
    expect(diffContent).toContain("resolveFileOrEntity(client, target, resolveOpts)");
  });

  it("converts --pick string to number", () => {
    expect(diffContent).toContain("parseInt(opts.pick, 10)");
  });

  it("imports printResolved for text-mode output", () => {
    expect(diffContent).toContain("printResolved");
  });

  it("outputs structured JSON for ambiguous targets", () => {
    expect(diffContent).toContain("resolveEntityFull");
    expect(diffContent).toContain("fullResult.ambiguous");
  });
});

// ── Symbol diff body extraction ─────────────────────────────────────

describe("diff.ts symbol diff correctness", () => {
  it("has getSymbolSpans for before/after line ranges", () => {
    expect(diffContent).toContain("getSymbolSpans");
    expect(diffContent).toContain("symbolSpans.before");
    expect(diffContent).toContain("symbolSpans.after");
  });

  it("extracts symbol body via sliceContent", () => {
    expect(diffContent).toContain("sliceContent");
    expect(diffContent).toContain("sliceContent(beforeFile");
    expect(diffContent).toContain("sliceContent(afterFile");
  });

  it("diffs symbol bodies directly instead of slicing hunks", () => {
    // Symbol diff computes textual diff on extracted bodies, not sliced file hunks
    expect(diffContent).toContain("computeTextualDiff(beforeBody, afterBody)");
  });

  it("keeps file diff separate from symbol diff", () => {
    // File targets diff the whole file
    expect(diffContent).toContain("computeTextualDiff(beforeFile, afterFile)");
    // Symbol targets use extracted bodies
    expect(diffContent).toContain("computeTextualDiff(beforeBody, afterBody)");
  });

  it("reports correct diffMode for file vs symbol", () => {
    expect(diffContent).toContain('diffMode = "symbol"');
    expect(diffContent).toContain('diffMode = "file"');
  });
});
