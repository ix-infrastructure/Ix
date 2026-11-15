// Copyright 2026 Ix Infrastructure Inc.

/**
 * The output core split out of format.ts (#950): `emit` owns the `--format`
 * switch, format.ts only re-exports the names it used to define, and those
 * names are the same functions the new modules export.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as legacy from "../format.js";
import type {
  Diagnostic,
  DiagnosticCode,
  EdgeCandidate,
  EntityRef,
  ExplainResult,
  LocateResult,
  ResultSource,
  Slice,
  TextPaging,
  TextResult,
} from "../format.js";
import { emit, type Renderer } from "../output/emit.js";
import { noteResolutionNotices, printJson, resetResolutionNotices, setPrettyJson } from "../output/json.js";
import { relativePath, rowLocation } from "../output/rows.js";
import { sliceEdgeResults, sliceRanked } from "../output/slice.js";
import { edgeResultsRenderer, formatEdgeResults } from "../render/edges.js";
import { formatNodes, nodesRenderer } from "../render/nodes.js";
import { textResultsRenderer } from "../render/text.js";

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

afterEach(() => {
  setPrettyJson(false);
  resetResolutionNotices();
});

describe("emit", () => {
  const calls: string[] = [];
  const renderer: Renderer<{ n: number }> = {
    text: (v) => {
      calls.push("text");
      console.log(`n is ${v.n}`);
    },
    json: (v) => {
      calls.push("json");
      return { n: v.n };
    },
    llm: (v) => {
      calls.push("llm");
      return ["thing", `n=${v.n}`];
    },
  };

  afterEach(() => {
    calls.length = 0;
  });

  it("prints the json payload through printJson", () => {
    expect(capture(() => emit(renderer, { n: 3 }, "json"))).toEqual(['{"n":3}']);
    expect(calls).toEqual(["json"]);
  });

  it("indents json when --pretty asked, as printJson does", () => {
    setPrettyJson(true);
    expect(capture(() => emit(renderer, { n: 3 }, "json"))).toEqual(['{\n  "n": 3\n}']);
  });

  it("adds queued resolution notices to the json object, as printJson does", () => {
    noteResolutionNotices([{ code: "fuzzy_match", message: "guessed" }]);
    const [out] = capture(() => emit(renderer, { n: 1 }, "json"));
    expect(JSON.parse(out)).toEqual({
      n: 1,
      resolutionMode: "fuzzy",
      resolutionNotices: [{ code: "fuzzy_match", message: "guessed" }],
    });
  });

  it("prints llm records one per line", () => {
    expect(capture(() => emit(renderer, { n: 2 }, "llm"))).toEqual(["thing", "n=2"]);
    expect(calls).toEqual(["llm"]);
  });

  it("prints text for text, and for a format it does not know, like the old switches", () => {
    expect(capture(() => emit(renderer, { n: 5 }, "text"))).toEqual(["n is 5"]);
    expect(capture(() => emit(renderer, { n: 5 }, "yaml"))).toEqual(["n is 5"]);
    expect(calls).toEqual(["text", "text"]);
  });
});

describe("renderers in render/", () => {
  const rows = [
    { id: "1111111122222222", kind: "function", name: "a", attrs: { line_start: 3, line_end: 9 }, provenance: { source_uri: "src/a.ts" } },
  ];

  it("emit with a renderer prints what its legacy format function prints", () => {
    for (const format of ["json", "llm", "text"]) {
      expect(capture(() => emit(nodesRenderer, rows, format))).toEqual(capture(() => formatNodes(rows, format)));
      const slice = sliceEdgeResults(rows, 10);
      expect(capture(() => emit(edgeResultsRenderer, { slice, relation: "callers", symbol: "b" }, format)))
        .toEqual(capture(() => formatEdgeResults(slice, "callers", "b", format)));
    }
  });

  it("text json stays a bare array of hits", () => {
    const hit: TextResult = { path: "src/a.ts", line_start: 1, line_end: 1, snippet: "x", engine: "ripgrep", score: 1 };
    expect(textResultsRenderer.json({ slice: sliceRanked([hit], 10) })).toEqual([hit]);
  });
});

describe("format.ts after the split", () => {
  it("still exports every runtime name it used to define, as the same function", async () => {
    const json = await import("../output/json.js");
    const slice = await import("../output/slice.js");
    const rowsMod = await import("../output/rows.js");
    expect(legacy.printJson).toBe(printJson);
    expect(legacy.captureJson).toBe(json.captureJson);
    expect(legacy.takeResolutionNotices).toBe(json.takeResolutionNotices);
    expect(legacy.sliceRanked).toBe(slice.sliceRanked);
    expect(legacy.EXPAND_MAX_EDGES).toBe(slice.EXPAND_MAX_EDGES);
    expect(legacy.relativePath).toBe(relativePath);
    expect(legacy.rowLocation).toBe(rowLocation);
    expect(legacy.confidenceColor).toBe(rowsMod.confidenceColor);
    expect(legacy.formatNodes).toBe(formatNodes);
    expect(legacy.formatEdgeResults).toBe(formatEdgeResults);

    // The runtime names format.ts exported before #950. A name dropped here
    // breaks an importer of `@ix/cli/cli/format.js`.
    expect(Object.keys(legacy).sort()).toEqual([
      "EXPAND_MAX_EDGES", "captureJson", "compactTreeNode", "confidenceColor", "disambiguatingIds",
      "expandCapped", "formatBugs", "formatConflicts", "formatContext", "formatDecisions", "formatDiff",
      "formatEdgeResults", "formatExplain", "formatIntents", "formatLocateResults", "formatNodes",
      "formatPatches", "formatTextResults", "lineSpan", "locationLabel", "noteResolutionNotices",
      "printJson", "relativePath", "renderConflictsLlm", "renderDiffLlm", "renderEdgeResultsLlm",
      "renderNodesLlm", "renderPatchesLlm", "renderTextResultsLlm", "resetResolutionNotices",
      "roundFloat", "rowLocation", "setPrettyJson", "siteLabel", "sliceEdgeResults", "sliceRanked",
      "stripNulls", "takeResolutionNotices", "truncationHint",
    ]);
  });

  it("still exports the type names it used to define", () => {
    // Compile-time: `npm run typecheck` fails here if one is dropped.
    type Exported = [
      Diagnostic, DiagnosticCode, EdgeCandidate, EntityRef, ExplainResult,
      LocateResult, ResultSource, Slice<unknown>, TextPaging, TextResult,
    ];
    const check: Exported | undefined = undefined;
    expect(check).toBeUndefined();
  });

  it("defines nothing itself, so no command-specific renderer lives in it", () => {
    const source = readFileSync(fileURLToPath(new URL("../format.ts", import.meta.url)), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .trim();
    // Every statement is `export { … } from "…"` or `export type { … } from "…"`.
    const statements = code.split(";").map((s) => s.trim()).filter((s) => s !== "");
    for (const statement of statements) {
      expect(statement).toMatch(/^export (type )?\{[^}]*\} from "\.\/(output|render)\/[a-z-]+\.js"$/);
    }
  });
});
