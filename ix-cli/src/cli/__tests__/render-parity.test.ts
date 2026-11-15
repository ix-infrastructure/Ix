// Copyright 2026 Ix Infrastructure Inc.

/**
 * Byte-for-byte output of every renderer that used to live in format.ts, in
 * all three formats (#950).
 *
 * The snapshot was recorded on the code before the split, so a renderer that
 * moved to `render/<command>.ts` (or now goes through `emit`) must print
 * exactly what it printed before: the same lines, the same JSON and the same
 * colours. Colour is pinned to one level so the snapshot does not depend on
 * the terminal running the test.
 */

import chalk from "chalk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  formatBugs,
  formatConflicts,
  formatContext,
  formatDecisions,
  formatDiff,
  formatEdgeResults,
  formatExplain,
  formatIntents,
  formatLocateResults,
  formatNodes,
  formatPatches,
  formatTextResults,
  resetResolutionNotices,
  setPrettyJson,
  sliceEdgeResults,
  sliceRanked,
  type TextResult,
} from "../format.js";
import { setOutputShape } from "../output-shape.js";

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

const FORMATS = ["json", "llm", "text"] as const;

let savedLevel: typeof chalk.level;
beforeAll(() => {
  savedLevel = chalk.level;
  chalk.level = 1;
  setPrettyJson(true);
  setOutputShape({});
  resetResolutionNotices();
});
afterAll(() => {
  chalk.level = savedLevel;
  setPrettyJson(false);
});

const node = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, kind, name, attrs: { name, line_start: 10, line_end: 24 }, provenance: { source_uri: "src/a.ts" }, ...extra,
});

const nodes = [
  node("1111111122222222", "function", "parseConfig"),
  node("3333333344444444", "decision", "Use YAML", { attrs: { title: "Use YAML" } }),
  { id: "5555555566666666", kind: "file", name: "b.ts", attrs: { path: "src/b.ts" } },
];

const decisions = [
  { id: "aaaaaaaabbbbbbbb", name: "Use YAML", attrs: { rationale: "humans edit it" } },
  { id: "cccc", attrs: { title: "No rationale" } },
];

const bugs = [
  { id: "aaaaaaaabbbbbbbb", name: "Crash on empty", attrs: { status: "investigating", severity: "high" } },
  { id: "dddd", attrs: { title: "Defaults" } },
];

const patches = [
  { rev: 7, patch_id: "0123456789abcdef0123", intent: "map", timestamp: "2026-01-01T00:00:00Z", source: { uri: "src/a.ts" } },
  { rev: 8, patch_id: "fedcba9876543210", timestamp: "2026-01-02T00:00:00Z" },
];

const intents = [
  { id: "i1", attrs: { statement: "Ship it", status: "active", confidence: 0.9 } },
  { id: "i2", attrs: { statement: "Test it", status: "open", confidence: 0.4, parent_intent: "i1" } },
];

const diff = {
  fromRev: 3, toRev: 9,
  changes: [
    { changeType: "added", entityId: "e1e1e1e1e1", atToRev: { name: "Foo", kind: "class" }, summary: "new" },
    { changeType: "modified", entityId: "e2e2e2e2e2", atToRev: { attrs: { name: "bar" }, kind: "method" } },
    { changeType: "removed", entityId: "e3e3e3e3e3", atFromRev: { name: "Baz", kind: "function" } },
    { changeType: "added_or_modified", entityId: "e4e4e4e4e4", atToRev: { name: "Qux" } },
  ],
};

const texts: TextResult[] = [
  { path: "src/a.ts", line_start: 3, line_end: 3, snippet: "  const x = 1;  ", engine: "ripgrep", score: 1, language: "typescript", symbol_hint: "main" },
  { path: "src/b.ts", line_start: 9, line_end: 9, snippet: "x()", engine: "ripgrep", score: 0.5 },
  { path: "src/c.ts", line_start: 1, line_end: 1, snippet: "x", engine: "ripgrep", score: 0.1 },
];

const conflicts = [{ reason: "contradiction", recommendation: "pick one", claimA: "claimaaaaaaaaa", claimB: "claimbbbbbbbbb" }];

const explain = {
  kind: "function", name: "parseConfig", id: "1111111122222222", file: "src/a.ts", chunkKind: "body",
  container: { kind: "module", name: "config" }, introducedRev: 4, calledBy: 2, calls: 3, contains: 0,
  historyLength: 5, signature: "parseConfig(raw: string): Config", docstring: "Parse it.",
  callList: [
    { name: "readFile", resolved: true },
    { name: "mystery", resolved: false },
  ],
  diagnostics: [{ code: "stale_source" as const, message: "Source changed since the last map." }],
};

const context = {
  metadata: { query: "config", seedEntities: [1, 2], hopsExpanded: 1, asOfRev: 12 },
  claims: [{ finalScore: 0.9, claim: { statement: "parses yaml" } }, { finalScore: 0.3 }],
  conflicts: [{ reason: "r", recommendation: "rec" }],
  decisions: [{ title: "t", rationale: "why" }],
  intents: [{ statement: "s", status: "open" }],
};

const edgeRows = [
  node("1111111122222222", "function", "caller", { site: { path: "src/a.ts", line: 12, snippet: "callee()", also: [14] } }),
  node("2222222233333333", "method", "viaSuper", { dispatchVia: "Base.run", candidate: 1 }),
  { id: "0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e", kind: "function", attrs: {} },
];

describe("render parity with the pre-split format.ts (#950)", () => {
  for (const format of FORMATS) {
    describe(`--format ${format}`, () => {
      it("formatContext", () => expect(capture(() => formatContext(context, format))).toMatchSnapshot());
      it("formatNodes", () => {
        expect(capture(() => formatNodes(nodes, format))).toMatchSnapshot();
        expect(capture(() => formatNodes([], format))).toMatchSnapshot();
      });
      it("formatDecisions", () => {
        expect(capture(() => formatDecisions(decisions, format))).toMatchSnapshot();
        expect(capture(() => formatDecisions([], format))).toMatchSnapshot();
      });
      it("formatBugs", () => {
        expect(capture(() => formatBugs(bugs, format))).toMatchSnapshot();
        expect(capture(() => formatBugs([], format))).toMatchSnapshot();
      });
      it("formatPatches", () => {
        expect(capture(() => formatPatches(patches, format))).toMatchSnapshot();
        expect(capture(() => formatPatches([], format))).toMatchSnapshot();
      });
      it("formatIntents", () => {
        expect(capture(() => formatIntents(intents, format))).toMatchSnapshot();
        expect(capture(() => formatIntents([], format))).toMatchSnapshot();
      });
      it("formatDiff", () => {
        expect(capture(() => formatDiff(diff, format))).toMatchSnapshot();
        expect(capture(() => formatDiff({ fromRev: 1, toRev: 2, changes: [] }, format))).toMatchSnapshot();
      });
      it("formatTextResults", () => {
        expect(capture(() => formatTextResults(sliceRanked(texts, 2), format))).toMatchSnapshot();
        const page = sliceRanked(texts, 2, undefined, 2);
        expect(capture(() => formatTextResults(page, format, { windowFull: true }))).toMatchSnapshot();
        expect(capture(() => formatTextResults(sliceRanked(texts, 5, undefined, 9), format))).toMatchSnapshot();
        expect(capture(() => formatTextResults(sliceRanked([], 5), format))).toMatchSnapshot();
      });
      it("formatLocateResults", () => {
        const located = [
          { kind: "function", id: "1111111122222222", name: "parseConfig", file: "src/a.ts", line: 10, source: "graph" as const },
          { kind: "text", name: "parseConfig", source: "ripgrep" as const },
        ];
        expect(capture(() => formatLocateResults(located, format))).toMatchSnapshot();
        expect(capture(() => formatLocateResults([], format))).toMatchSnapshot();
      });
      it("formatEdgeResults", () => {
        const slice = sliceEdgeResults(edgeRows, 2);
        slice.next = "ix callers callee --offset 2";
        expect(capture(() => formatEdgeResults(
          slice, "callers", "callee", format,
          { id: "9999999988888888", kind: "function", name: "callee", resolutionMode: "fuzzy" },
          "graph+text",
          [{ code: "text_fallback_used", message: "Some rows came from text search." }],
          [{ n: 1, id: "9999999988888888", name: "callee", kind: "function", path: "src/z.ts" }],
        ))).toMatchSnapshot();
        expect(capture(() => formatEdgeResults(sliceEdgeResults([], 10), "callees", "lonely", format))).toMatchSnapshot();
        expect(capture(() => formatEdgeResults(sliceEdgeResults(edgeRows, 5, 7), "callers", "x", format))).toMatchSnapshot();
        expect(capture(() => formatEdgeResults(sliceEdgeResults(edgeRows, 5, 0, true), "imports", "y", format))).toMatchSnapshot();
      });
      it("formatConflicts", () => {
        expect(capture(() => formatConflicts(conflicts, format))).toMatchSnapshot();
        expect(capture(() => formatConflicts([], format))).toMatchSnapshot();
      });
      it("formatExplain", () => {
        expect(capture(() => formatExplain(explain, format))).toMatchSnapshot();
        expect(capture(() => formatExplain({ ...explain, signature: undefined, docstring: undefined, callList: undefined, diagnostics: undefined, container: undefined, file: undefined, chunkKind: undefined }, format))).toMatchSnapshot();
      });
    });
  }

  it("applies --fields to llm rows exactly as before", () => {
    setOutputShape({ fields: "path,name" });
    try {
      expect(capture(() => formatNodes(nodes, "llm"))).toMatchSnapshot();
      expect(capture(() => formatEdgeResults(sliceEdgeResults(edgeRows, 5), "callers", "callee", "llm"))).toMatchSnapshot();
    } finally {
      setOutputShape({});
    }
  });
});
