// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  SourceFiles,
  anchorSpan,
  bareName,
  edgeTargetFor,
  findImports,
  findUses,
  importKeys,
  rankTextUses,
  withEdgeSites,
} from "../edge-sites.js";
import { formatEdgeResults, renderEdgeResultsLlm, sliceEdgeResults } from "../format.js";
import { setOutputShape } from "../output-shape.js";

const CALLER = [
  "import { target } from \"./lib.js\";", //  1
  "", //                                        2
  "// target() is called below", //            3
  "export function caller(x: number) {", //   4
  "  const a = x + 1;", //                     5
  "  const y = target(a);", //                 6
  "  log(target);", //                         7
  "  return target(", //                       8
  "    y,", //                                 9
  "  );", //                                  10
  "}", //                                     11
];

describe("findUses", () => {
  it("prefers call syntax, skips comments, and lists every call in the range", () => {
    expect(findUses(CALLER, "target", 4, 11)).toEqual([6, 8]);
  });

  it("falls back to a bare use when nothing in the range calls the name", () => {
    // REFERENCES edges are listed as callers too: a callback passed by name.
    expect(findUses(CALLER, "target", 7, 7)).toEqual([7]);
  });

  it("respects word boundaries", () => {
    expect(findUses(["targets(1);", "retarget(2);", "$target(3);"], "target", 1, 3)).toEqual([]);
  });

  it("never counts the name's own declaration as a use", () => {
    const recursive = ["function walk(n) {", "  return n && walk(n - 1);", "}"];
    expect(findUses(recursive, "walk", 1, 3)).toEqual([2]);
  });

  it("counts a constructor call", () => {
    expect(findUses(["const c = new IxClient(url);"], "IxClient", 1, 1)).toEqual([1]);
  });
});

describe("anchorSpan", () => {
  it("keeps a span whose declaration is where the graph says", () => {
    expect(anchorSpan(CALLER, "caller", 4, 11)).toEqual({ start: 4, end: 11, anchored: true });
  });

  it("shifts a span the file has moved out from under", () => {
    // The graph recorded lines 4-11; two lines were inserted above since.
    const moved = ["// new", "// new", ...CALLER];
    expect(anchorSpan(moved, "caller", 4, 11)).toEqual({ start: 6, end: 13, anchored: true });
  });

  it("says when it could not re-anchor, so the caller can widen instead", () => {
    expect(anchorSpan(["a", "b", "c", "d"], "missing", 2, 3).anchored).toBe(false);
  });
});

describe("importKeys / findImports", () => {
  it("imports a file by its stem, trying the directory first", () => {
    expect(importKeys("config.ts", "file", "ix-cli/src/cli/config.ts")).toEqual(["cli/config", "config"]);
    expect(importKeys("commander", "module", undefined)).toEqual(["commander"]);
  });

  it("finds the import line, not a use of the same word", () => {
    const lines = [
      "import { a } from \"../cli/config.js\";",
      "const config = load();",
      "from pkg.config import b",
    ];
    expect(findImports(lines, ["cli/config", "config"])).toEqual([1]);
    expect(findImports(lines, ["config"])).toEqual([1, 3]);
  });

  it("finds the module specifier line of a multi-line import", () => {
    const lines = ["import {", "  a,", "  b,", "} from \"./lib.js\";"];
    expect(findImports(lines, ["lib"])).toEqual([4]);
  });
});

describe("bareName", () => {
  it("is the last segment of a qualified name", () => {
    expect(bareName("Foo::bar")).toBe("bar");
    expect(bareName("Foo.bar")).toBe("bar");
    expect(bareName("plain")).toBe("plain");
  });
});

describe("rankTextUses", () => {
  it("puts calls first, comments last, and drops the declaration", () => {
    const ranked = rankTextUses([
      { snippet: "import { go } from \"./go.js\";" },
      { snippet: "// go() is documented here" },
      { snippet: "export function go() {" },
      { snippet: "const r = go();" },
    ], "go");
    expect(ranked.map((r) => r.snippet)).toEqual([
      "const r = go();",
      "import { go } from \"./go.js\";",
      "// go() is documented here",
    ]);
  });
});

describe("withEdgeSites against files on disk", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ix-edge-sites-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/caller.ts"), CALLER.join("\n"));
    writeFileSync(join(root, "src/lib.ts"), "export function target(n: number) {\n  return helper(n);\n}\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(() => setOutputShape({}));

  const callerRow = {
    id: "11111111-2222-3333-4444-555555555555", name: "caller", kind: "function",
    attrs: { line_start: 4, line_end: 11 }, provenance: { sourceUri: "src/caller.ts" },
  };

  it("callers: the call inside the caller's span, with the others in also", () => {
    const [row] = withEdgeSites([callerRow], "callers", { name: "target" }, { root });
    expect(row.site).toEqual({
      path: "src/caller.ts",
      line: 6,
      snippet: "const y = target(a);",
      also: [8],
    });
  });

  it("callees: the call inside the target's span, in the target's file", () => {
    const helper = { name: "helper", kind: "function", provenance: { sourceUri: "src/other.ts" } };
    const [row] = withEdgeSites([helper], "callees", {
      name: "target", kind: "function", path: "src/lib.ts", lineStart: 1, lineEnd: 3,
    }, { root });
    expect(row.site).toMatchObject({ path: "src/lib.ts", line: 2, snippet: "return helper(n);" });
  });

  it("imported-by: the import line in the importing file", () => {
    const importer = { name: "caller.ts", kind: "file", provenance: { sourceUri: "src/caller.ts" } };
    const [row] = withEdgeSites([importer], "imported-by", {
      name: "lib.ts", kind: "file", path: "src/lib.ts",
    }, { root });
    expect(row.site).toMatchObject({ path: "src/caller.ts", line: 1 });
  });

  it("re-anchors a span recorded before the file moved", () => {
    const [row] = withEdgeSites(
      [{ ...callerRow, attrs: { line_start: 8, line_end: 15 } }],
      "callers", { name: "target" }, { root },
    );
    // `caller` is declared on line 4 now, not 8: the span shifts to 4-11 and
    // the first call is 6 again, rather than 8 from the stale span.
    expect(row.site.line).toBe(6);
  });

  it("joins the continuation lines of a call left open", () => {
    writeFileSync(join(root, "src/multi.ts"), ["function m() {", "  return target(", "    y,", "  );", "}"].join("\n"));
    const [row] = withEdgeSites(
      [{ name: "m", kind: "function", attrs: { line_start: 1, line_end: 5 }, provenance: { sourceUri: "src/multi.ts" } }],
      "callers", { name: "target" }, { root },
    );
    expect(row.site).toMatchObject({ line: 2, snippet: "return target( y, );" });
  });

  it("leaves a row alone when its file is missing, or the relation has no site", () => {
    const gone = { ...callerRow, provenance: { sourceUri: "src/deleted.ts" } };
    expect(withEdgeSites([gone], "callers", { name: "target" }, { root })[0].site).toBeUndefined();
    expect(withEdgeSites([callerRow], "contains", { name: "target" }, { root })[0]).toBe(callerRow);
  });

  it("refuses a file outside every readable root", () => {
    const outside = { ...callerRow, provenance: { sourceUri: "/etc/hostname" } };
    expect(withEdgeSites([outside], "callers", { name: "target" }, { root })[0].site).toBeUndefined();
  });

  it("reads each file once", () => {
    const files = new SourceFiles(root);
    const spy = vi.spyOn(files, "lines");
    withEdgeSites([callerRow, callerRow], "callers", { name: "target" }, { root, files });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(files.lines("src/caller.ts")).toBe(files.lines("src/caller.ts"));
  });

  it("renders as site=path:line, also= and a snippet, after the row's own location", () => {
    const rows = withEdgeSites([callerRow], "callers", { name: "target" }, { root });
    const lines = renderEdgeResultsLlm(sliceEdgeResults(rows, 50), "callers", "target", "graph");
    expect(lines[1]).toBe(
      'ref name=caller kind=function path=src/caller.ts lines=4-11 site=src/caller.ts:6 also=8 snippet="const y = target(a);"',
    );
  });

  it("carries the site into json and onto a second text line", () => {
    const rows = withEdgeSites([callerRow], "callers", { name: "target" }, { root });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ")); });
    try {
      formatEdgeResults(sliceEdgeResults(rows, 50), "callers", "target", "json");
      formatEdgeResults(sliceEdgeResults(rows, 50), "callers", "target", "text");
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(out[0]).results[0].site).toEqual({
      path: "src/caller.ts", line: 6, snippet: "const y = target(a);", also: [8],
    });
    // eslint-disable-next-line no-control-regex
    const plain = out.slice(1).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    expect(plain).toContain("      at src/caller.ts:6  const y = target(a);");
  });
});

describe("edgeTargetFor", () => {
  const entity = vi.fn(async () => ({
    node: { attrs: { line_start: 10, line_end: 20 }, provenance: { sourceUri: "src/lib.ts" } },
  }));
  afterEach(() => entity.mockClear());

  it("asks the backend for the span only where the relation needs one", async () => {
    const target = { id: "x", name: "target", kind: "function", path: "src/lib.ts" };
    expect(await edgeTargetFor({ entity }, target, "callers")).toEqual({ name: "target", kind: "function", path: "src/lib.ts" });
    expect(entity).not.toHaveBeenCalled();
    expect(await edgeTargetFor({ entity }, target, "callees")).toMatchObject({ lineStart: 10, lineEnd: 20 });
    expect(entity).toHaveBeenCalledTimes(1);
  });

  it("fills in the path of a target resolved by id", async () => {
    const byId = { id: "x", name: "lib.ts", kind: "file" };
    expect(await edgeTargetFor({ entity }, byId, "imports")).toEqual({ name: "lib.ts", kind: "file", path: "src/lib.ts" });
  });

  it("degrades to what it has when the backend fails", async () => {
    const failing = { entity: async () => { throw new Error("down"); } };
    const target = { id: "x", name: "target", kind: "function", path: "src/lib.ts" };
    expect(await edgeTargetFor(failing, target, "callees")).toEqual({ name: "target", kind: "function", path: "src/lib.ts" });
  });

  it("bounds the source listing outside git", () => {
    const root = mkdtempSync(join(tmpdir(), "ix-source-walk-"));
    try {
      for (let i = 0; i < 5010; i++) writeFileSync(join(root, `f${i}.ts`), "");
      expect(new SourceFiles(root).sourcePaths()).toHaveLength(5000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
