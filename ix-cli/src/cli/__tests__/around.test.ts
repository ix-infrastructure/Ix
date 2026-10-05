// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../resolve.js", () => ({
  ensureReadScope: vi.fn(async () => undefined),
  activeReadScope: () => ({ workspaceId: "ws-test" }),
}));

import {
  CONTAINER_KINDS, declarationLines, DEFAULT_CAPS, localityRank, estimateTokens, findUseInImporter, fitToBudget, gatherAround, importStatementText, isTestFile,
  outermostDefs, parseAroundTarget, placeDefs, selectEdited, type AroundResult, type FileDef,
} from "../around.js";
import { aroundJson, renderAroundLlm, renderAroundText } from "../around-render.js";
import { SourceFiles } from "../edge-sites.js";
import { aroundRelPath } from "../commands/around.js";

describe("parseAroundTarget", () => {
  it("reads a path, a line, and a range", () => {
    expect(parseAroundTarget("src/a.ts")).toEqual({ file: "src/a.ts" });
    expect(parseAroundTarget("src/a.ts:12")).toEqual({ file: "src/a.ts", range: { start: 12, end: 12 } });
    expect(parseAroundTarget("src/a.ts:12-20")).toEqual({ file: "src/a.ts", range: { start: 12, end: 20 } });
  });

  it("keeps a Windows drive letter in the path and refuses a backwards range", () => {
    expect(parseAroundTarget("C:\\a.ts")).toEqual({ file: "C:\\a.ts" });
    expect(parseAroundTarget("a.ts:20-12")).toBeUndefined();
    expect(parseAroundTarget("a.ts:0")).toBeUndefined();
  });
});

describe("aroundRelPath", () => {
  it("places an absolute path reached through a link inside the workspace", () => {
    const base = mkdtempSync(join(tmpdir(), "ix-around-link-"));
    try {
      const root = join(base, "repo");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
      symlinkSync(root, join(base, "link"), "dir");
      expect(aroundRelPath(join(base, "link/src/a.ts"), root)).toBe("src/a.ts");
      expect(aroundRelPath(join(root, "src/a.ts"), join(base, "link"))).toBe("src/a.ts");
      expect(aroundRelPath(join(base, "elsewhere.ts"), root)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("isTestFile", () => {
  it("knows the test layouts of the benchmark languages", () => {
    for (const p of [
      "src/__tests__/a.test.ts", "tests/test_api.py", "pkg/api_test.go", "src/test/java/a/FooTest.java",
      "ix-cli/test/client.test.ts", "lib/foo.spec.js",
    ]) expect(isTestFile(p), p).toBe(true);
  });

  it("does not count source or fixtures", () => {
    for (const p of ["src/cli/commands/test.ts", "src/testing.py", "core/test-fixtures/ts/sample.ts"]) {
      expect(isTestFile(p), p).toBe(false);
    }
  });
});

const def = (id: string, name: string, lineStart: number, lineEnd: number, extra: Partial<FileDef> = {}): FileDef =>
  ({ id, name, kind: "function", lineStart, lineEnd, topLevel: true, ...extra });

describe("placeDefs: re-anchoring after the file moved", () => {
  // As the graph recorded the file.
  const defs = [def("a", "alpha", 1, 3), def("b", "beta", 5, 7)];

  it("shifts spans to where the declarations are now", () => {
    const now = ["// new header", "// another", "function alpha() {", "  return 1;", "}", "", "function beta() {", "  return 2;", "}"];
    const placed = placeDefs(defs, now);
    expect(placed.find((d) => d.id === "a")).toMatchObject({ start: 3, end: 5 });
    expect(placed.find((d) => d.id === "b")).toMatchObject({ start: 7, end: 9 });
  });

  it("stretches the end of a definition that grew, keeping its gap to the next one", () => {
    const now = ["function alpha() {", "  const x = 1;", "  const y = 2;", "  return x + y;", "}", "", "function beta() {", "  return 2;", "}"];
    const placed = placeDefs(defs, now);
    expect(placed.find((d) => d.id === "a")).toMatchObject({ start: 1, end: 5 });
  });
});

describe("selectEdited", () => {
  const placed = placeDefs([
    def("cls", "Box", 1, 20, { kind: "class" }),
    def("m1", "open", 2, 5, { kind: "method", topLevel: false, container: "Box" }),
    def("m2", "close", 7, 10, { kind: "method", topLevel: false, container: "Box" }),
    def("f", "free", 22, 25),
  ], []);

  it("puts the innermost definition first and leaves out the class around it", () => {
    expect(selectEdited(placed, [{ start: 3, end: 3 }], 3).map((d) => d.id)).toEqual(["m1"]);
  });

  it("keeps the class when the edit also touched it outside its methods", () => {
    expect(selectEdited(placed, [{ start: 4, end: 6 }], 3).map((d) => d.id)).toEqual(["m1", "cls"]);
  });

  it("reports every definition a range spans, up to the cap", () => {
    expect(selectEdited(placed, [{ start: 3, end: 23 }], 2).map((d) => d.id)).toEqual(["m1", "m2"]);
  });

  it("counts an insertion only for a definition holding both neighbours", () => {
    expect(selectEdited(placed, [{ start: 5, end: 6, insertion: true }], 3).map((d) => d.id)).toEqual(["cls"]);
    expect(selectEdited(placed, [{ start: 20, end: 21, insertion: true }], 3)).toEqual([]);
  });

  it("finds the outermost definitions for a whole-file question", () => {
    expect(outermostDefs(placed).map((d) => d.id)).toEqual(["cls", "f"]);
  });
});

describe("declarationLines: an edit to a class outside its methods", () => {
  const placed = placeDefs([
    def("cls", "Box", 1, 20, { kind: "class" }),
    def("m1", "open", 2, 5, { kind: "method", topLevel: false, container: "Box" }),
    def("m2", "close", 7, 10, { kind: "method", topLevel: false, container: "Box" }),
    def("f", "free", 22, 25),
  ], []);
  const cls = placed.find((d) => d.id === "cls")!;

  it("finds the edited lines no member covers -- a field, a declaration", () => {
    expect(declarationLines(cls, placed, [{ start: 12, end: 14 }])).toEqual({ start: 12, end: 14 });
    expect(declarationLines(cls, placed, [{ start: 4, end: 6 }])).toEqual({ start: 6, end: 6 });
  });

  it("is undefined when every edited line is inside a method", () => {
    expect(declarationLines(cls, placed, [{ start: 3, end: 4 }, { start: 8, end: 9 }])).toBeUndefined();
  });

  it("is undefined for a function, whose callers are calls", () => {
    expect(declarationLines(placed.find((d) => d.id === "f")!, placed, [{ start: 23, end: 23 }])).toBeUndefined();
  });

  it("covers the class-like kinds", () => {
    for (const k of ["class", "interface", "enum", "struct", "trait"]) expect(CONTAINER_KINDS.has(k), k).toBe(true);
    for (const k of ["function", "method", "constructor"]) expect(CONTAINER_KINDS.has(k), k).toBe(false);
  });

  it("renders as declarations, with the type's references counted, not listed", () => {
    const result = {
      path: "src/Box.java",
      symbols: [{
        id: "cls", name: "Box", kind: "class", path: "src/Box.java", lineStart: 1, lineEnd: 20,
        callers: { total: 40, rows: [{ path: "src/A.java", line: 3, snippet: "Box b = new Box();" }] },
        users: { total: 0, rows: [] },
        tests: { total: 1, rows: [{ path: "test/BoxTest.java", line: 9, snippet: "new Box()" }] },
        sameName: [],
        declarations: { lineStart: 12, lineEnd: 14 },
      }],
      importers: { total: 0, tests: 0, rows: [] },
    } as any;
    const text = renderAroundText(result, { lead: "Ix: you changed" });
    expect(text).toContain("Ix: you changed declarations in `Box` outside its methods (src/Box.java:12-14).");
    expect(text).toContain("the class is referenced from 40 places.");
    expect(text).not.toContain("src/A.java:3");
    expect(text).toContain("test/BoxTest.java:9");
    expect(renderAroundLlm(result).filter((l) => l.startsWith("caller "))).toEqual([]);
  });
});

describe("importers that use the symbol", () => {
  const importer = [
    "import {", //                          1
    "  parseBudgetOption,", //              2
    "  parsePickOption,", //                3
    "} from \"../options.js\";", //         4
    "", //                                  5
    "program.option(\"--pick <n>\", \"n\", parsePickOption);", // 6
  ];

  it("reads a multi-line import as one statement", () => {
    expect(importStatementText(importer, 4)).toMatchObject({ start: 1, end: 4 });
  });

  it("finds the use of a name the import brings in, outside the import", () => {
    expect(findUseInImporter(importer, [4], { name: "parsePickOption" })).toBe(6);
  });

  it("is nothing for a name imported but unused, or never imported", () => {
    expect(findUseInImporter(importer, [4], { name: "parseBudgetOption" })).toBeUndefined();
    expect(findUseInImporter(importer, [4], { name: "parseRevisionOption" })).toBeUndefined();
  });

  it("through the class, counts only a call to the member", () => {
    const viaClass = ["import { IxClient } from \"./api.js\";", "const o = { expand: true };", "await client.expand(id);"];
    expect(findUseInImporter(viaClass, [1], { name: "expand", container: "IxClient" })).toBe(3);
    expect(findUseInImporter(viaClass.slice(0, 2), [1], { name: "expand", container: "IxClient" })).toBeUndefined();
  });
});

// ── gatherAround over a mocked backend ───────────────────────────────────────

const node = (id: string, kind: string, name: string, path: string, lines?: [number, number]) => ({
  id, kind, name, provenance: { sourceUri: path },
  attrs: lines ? { line_start: lines[0], line_end: lines[1] } : {},
});

const FILES: Record<string, string[]> = {
  "src/lib.ts": [
    "export function target(x: number) {", // 1
    "  return x + 1;", //                      2
    "}", //                                    3
    "", //                                     4
    "export function other() {", //            5
    "  return 0;", //                          6
    "}", //                                    7
  ],
  "src/app.ts": [
    "import { target } from \"./lib.js\";", // 1
    "export function run() {", //              2
    "  return target(2);", //                  3
    "}", //                                    4
  ],
  "src/cli.ts": [
    "import { target } from \"./lib.js\";", // 1
    "program.option(\"--x <n>\", \"x\", target);", // 2
  ],
  "src/__tests__/app.test.ts": [
    "import { run } from \"../app.js\";", //   1
    "it(\"runs\", () => expect(run()).toBe(3));", // 2
  ],
};

let root: string;
const env = { ...process.env };

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ix-around-"));
  for (const [rel, lines] of Object.entries(FILES)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), lines.join("\n"));
  }
  process.env.IX_HOME = join(root, ".ix-home");
  process.env.IX_GRAPH_HEALTH = "0";
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = env;
});

function mockClient(extraCallers: number = 0) {
  const file = node("f-lib", "file", "lib.ts", "src/lib.ts");
  const target = node("d-target", "function", "target", "src/lib.ts", [1, 3]);
  const other = node("d-other", "function", "other", "src/lib.ts", [5, 7]);
  const run = node("d-run", "function", "run", "src/app.ts", [2, 4]);
  const testFile = node("f-test", "file", "app.test.ts", "src/__tests__/app.test.ts");
  const fillers = Array.from({ length: extraCallers }, (_, i) =>
    node(`d-fill${i}`, "function", `fill${i}`, `src/fill${i}.ts`, [1, 3]));
  return {
    endpoint: "http://mock",
    search: vi.fn(async () => [file]),
    workspaceSystem: vi.fn(async () => ({ systemId: null })),
    currentRevision: vi.fn(async () => ({ rev: 1 })),
    stats: vi.fn(async () => ({})),
    expand: vi.fn(async (id: string, opts: any) => {
      const preds = (opts?.predicates ?? []).join(",");
      if (id === "f-lib" && preds === "CONTAINS") {
        return { nodes: [target, other], edges: [
          { src: "f-lib", dst: "d-target", predicate: "CONTAINS" },
          { src: "f-lib", dst: "d-other", predicate: "CONTAINS" },
        ] };
      }
      if (id === "f-lib" && preds === "IMPORTS") {
        return { nodes: [node("f-app", "file", "app.ts", "src/app.ts"), node("f-cli", "file", "cli.ts", "src/cli.ts")], edges: [] };
      }
      if (id === "d-target" && preds === "CALLS,REFERENCES") {
        if ((opts.hops ?? 1) === 2) {
          return { nodes: [run, testFile, ...fillers], edges: [
            { src: "d-run", dst: "d-target", predicate: "CALLS" },
            { src: "f-test", dst: "d-run", predicate: "CALLS" },
          ] };
        }
        return { nodes: [run, ...fillers], edges: [] };
      }
      return { nodes: [], edges: [] };
    }),
  };
}

describe("gatherAround", () => {
  it("reports callers at their sites, importers that use the symbol, and tests two hops back", async () => {
    const result = await gatherAround(mockClient() as any, {
      relPath: "src/lib.ts",
      ranges: [{ start: 2, end: 2 }],
      anchorLines: FILES["src/lib.ts"],
      files: new SourceFiles(root),
    });
    expect(result.symbols).toHaveLength(1);
    const s = result.symbols[0];
    expect(s).toMatchObject({ name: "target", lineStart: 1, lineEnd: 3 });
    expect(s.callers).toEqual({ total: 1, rows: [{ path: "src/app.ts", line: 3, snippet: "return target(2);", name: "run" }] });
    // app.ts is already a caller; cli.ts hands `target` over by name, which the graph has no edge for.
    expect(s.users.rows).toEqual([{ path: "src/cli.ts", line: 2, snippet: "program.option(\"--x <n>\", \"x\", target);" }]);
    expect(s.tests.rows).toEqual([{ path: "src/__tests__/app.test.ts", line: 2, snippet: "it(\"runs\", () => expect(run()).toBe(3));", name: undefined, via: "run" }]);
    expect(result.importers.total).toBe(2);
  });

  it("counts the edited definitions it was told to leave out", async () => {
    const req = { relPath: "src/lib.ts", ranges: [{ start: 2, end: 2 }], anchorLines: FILES["src/lib.ts"], files: new SourceFiles(root) };
    const result = await gatherAround(mockClient() as any, { ...req, exclude: new Set(["d-target"]) });
    expect(result.symbols).toEqual([]);
    expect(result.excluded).toBe(1);
    expect((await gatherAround(mockClient() as any, req)).excluded).toBeUndefined();
  });

  it("caps callers and keeps the total", async () => {
    const result = await gatherAround(mockClient(20) as any, {
      relPath: "src/lib.ts",
      ranges: [{ start: 1, end: 1 }],
      anchorLines: FILES["src/lib.ts"],
      files: new SourceFiles(root),
      caps: { callers: 4 },
    });
    expect(result.symbols[0].callers.total).toBe(21);
    expect(result.symbols[0].callers.rows).toHaveLength(4);
    expect(renderAroundText(result)).toContain("callers (4 of 21):");
  });

  it("answers a whole-file question with the most-called top-level definitions", async () => {
    const result = await gatherAround(mockClient() as any, {
      relPath: "src/lib.ts", anchorLines: FILES["src/lib.ts"], files: new SourceFiles(root),
    });
    expect(result.symbols.map((s) => s.name)).toEqual(["target", "other"]);
  });

  it("refuses a file the graph does not hold", async () => {
    const client = mockClient();
    client.search.mockResolvedValueOnce([]);
    await expect(gatherAround(client as any, {
      relPath: "src/missing.ts", anchorLines: [], files: new SourceFiles(root),
    })).rejects.toMatchObject({ code: "file_not_in_graph" });
  });
});

// ── Rendering and size ──────────────────────────────────────────────────────

function bigResult(): AroundResult {
  const refs = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
    path: `src/very/long/path/to/${prefix}${i}.ts`, line: 100 + i,
    snippet: `const value${i} = await someLongFunctionName(argumentNumberOne, argumentNumberTwo, ${i});`,
  }));
  const sym = (name: string) => ({
    id: name, name, kind: "function", path: "src/lib.ts", lineStart: 10, lineEnd: 40,
    callers: { total: 40, rows: refs(8, `${name}-caller`) },
    users: { total: 9, rows: refs(5, `${name}-user`) },
    tests: { total: 12, rows: refs(5, `${name}-test`) },
    sameName: [],
  });
  return {
    path: "src/lib.ts",
    symbols: [sym("alpha"), sym("beta"), sym("gamma")],
    importers: { total: 30, tests: 4, rows: refs(5, "importer") },
  };
}

describe("fitToBudget", () => {
  it("brings text and llm output under the token budget and keeps the totals", () => {
    for (const render of [(r: AroundResult) => renderAroundText(r, { importerRows: true }), (r: AroundResult) => renderAroundLlm(r).join("\n")]) {
      const fitted = fitToBudget(bigResult(), render, 300, DEFAULT_CAPS);
      expect(estimateTokens(render(fitted))).toBeLessThanOrEqual(300);
      expect(fitted.symbols[0].callers.total).toBe(40);
    }
  });

  it("leaves an answer that already fits alone", () => {
    const small = bigResult();
    small.symbols = small.symbols.slice(0, 1).map((s) => ({ ...s, callers: { total: 1, rows: s.callers.rows.slice(0, 1) }, users: { total: 0, rows: [] }, tests: { total: 0, rows: [] } }));
    const render = (r: AroundResult) => renderAroundText(r);
    expect(render(fitToBudget(small, render, 300))).toBe(render(small));
  });
});

describe("renderers", () => {
  it("drop empty sections instead of printing none", () => {
    const r = bigResult();
    r.symbols = [{ ...r.symbols[0], users: { total: 0, rows: [] }, tests: { total: 0, rows: [] } }];
    const text = renderAroundText(r);
    expect(text).not.toMatch(/used by importers|^tests|none/m);
    const llm = renderAroundLlm(r);
    expect(llm.some((l) => l.startsWith("user ") || l.startsWith("test "))).toBe(false);
    expect(llm[0]).toBe("around path=src/lib.ts symbols=1");
  });

  it("say the graph is degraded rather than implying there are no dependents", () => {
    const r: AroundResult = { ...bigResult(), graph: { status: "degraded", reason: "hollow", message: "m", fix: "f" } };
    expect(renderAroundText(r)).toContain("Graph is degraded");
    expect(renderAroundLlm(r)[1]).toMatch(/^graph status=degraded reason=hollow/);
    expect(aroundJson(r).graph).toMatchObject({ status: "degraded" });
  });
});

describe("localityRank", () => {
  it("puts the edited file's own directory first, then the nearest", () => {
    const edited = "src/main/java/a/b/Foo.java";
    expect(localityRank(edited, "src/main/java/a/b/Bar.java")).toBe(0);
    expect(localityRank(edited, "src/main/java/a/b/c/Baz.java")).toBe(1);
    expect(localityRank(edited, "src/main/java/a/x/Qux.java")).toBe(2);
    expect(localityRank(edited, "other/module/Z.java")).toBeGreaterThan(localityRank(edited, "src/main/java/a/x/Qux.java"));
  });

  it("orders a list nearest first", () => {
    const edited = "lib/plugins/aws/deploy.js";
    const sorted = ["lib/classes/Service.js", "lib/plugins/aws/package.js", "lib/plugins/print.js"]
      .sort((a, b) => localityRank(edited, a) - localityRank(edited, b));
    expect(sorted).toEqual(["lib/plugins/aws/package.js", "lib/plugins/print.js", "lib/classes/Service.js"]);
  });
});
