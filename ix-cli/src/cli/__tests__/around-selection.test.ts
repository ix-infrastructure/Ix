// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

vi.mock("../resolve.js", () => ({
  ensureReadScope: vi.fn(async () => undefined),
  activeReadScope: () => ({ workspaceId: "ws-test" }),
}));
vi.mock("../graph-health.js", () => ({
  checkGraphHealth: vi.fn(async () => undefined),
  isUnhealthy: () => false,
}));
const state = vi.hoisted(() => ({ root: "", client: {} as any }));
vi.mock("../../client/factory.js", () => ({ createClient: () => state.client }));
vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(),
  resolveWorkspaceRoot: () => state.root,
}));

import { DEFAULT_TOKEN_BUDGET, fitToBudget, gatherAround, type AroundResult } from "../around.js";
import { aroundJson, renderAroundLlm, renderAroundText } from "../around-render.js";
import { limitOption, registerAroundCommand } from "../commands/around.js";
import { SourceFiles } from "../edge-sites.js";

afterEach(() => {
  vi.restoreAllMocks();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  state.root = "";
});

function fixture(target: string, contents: Record<string, string>, graphTests: string[] = [], heuristic = true) {
  state.root = mkdtempSync(join(process.cwd(), ".around-fixture-"));
  const all = { [target]: target.endsWith(".py") ? "def run():\n    pass" : "export function run() {}", ...contents };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(state.root, file, ".."), { recursive: true });
    writeFileSync(join(state.root, file), text);
  }
  const node = (id: string, kind: string, file: string) => ({
    id, kind, name: kind === "function" ? "run" : file.split("/").pop(),
    provenance: { sourceUri: file }, attrs: { line_start: 1, line_end: 2 },
  });
  const file = node("target-file", "file", target);
  const def = node("target-def", "function", target);
  state.client = {
    search: vi.fn(async () => [file]),
    expand: vi.fn(async (id: string, opts: any) => {
      if (id === file.id && opts.predicates.includes("CONTAINS")) return {
        nodes: [def], edges: [{ src: file.id, dst: def.id, predicate: "CONTAINS" }],
      };
      if (id === file.id) return {
        nodes: Object.keys(contents).filter((p) => p.startsWith("users/")).map((p) => node(p, "file", p)), edges: [],
      };
      return { nodes: graphTests.map((p) => node(p, "function", p)), edges: [] };
    }),
  };
  return () => gatherAround(state.client, {
    relPath: target, anchorLines: all[target].split("\n"), files: new SourceFiles(state.root),
    caps: { tests: 100 }, heuristicTests: heuristic,
  });
}

describe("around test selection", () => {
  it("tags graph tests with agreeing file-level evidence and lists the rest once for the file", async () => {
    const gather = fixture("src/widget.ts", {
      "tests/import-only.ts": 'import { run as subject } from "../src/widget.js";',
      "src/widget.spec.ts": "// naming only",
      "src/widget.test.ts": "// naming only",
      "__tests__/widget-extra.ts": 'import "../src/widget";',
      "tests/agreement.ts": 'import "../src/widget";',
      "tests/graph.ts": "run();",
      "tests/wrong.ts": 'import "../other/widget";',
      "tests/comment.ts": '// import "../src/widget";',
      "other/widget.ts": "export const value = 1;",
    }, ["tests/graph.ts", "tests/agreement.ts"]);
    const result = await gather();
    expect(result.symbols[0].tests.rows.map((r) => [r.path, r.sources])).toEqual([
      ["tests/agreement.ts", ["graph", "import"]],
      ["tests/graph.ts", ["graph"]],
    ]);
    // Import, then naming; nearest first. The root __tests__/widget-extra.ts is
    // as near other/widget.ts as this widget.ts, so its name is no evidence.
    expect(result.fileTests!.rows.map((r) => [r.path, r.sources])).toEqual([
      ["__tests__/widget-extra.ts", ["import"]],
      ["tests/import-only.ts", ["import"]],
      ["src/widget.spec.ts", ["naming"]],
      ["src/widget.test.ts", ["naming"]],
    ]);
    expect(JSON.stringify(aroundJson(result))).toContain('"sources":["graph","import"]');
    expect(JSON.stringify(aroundJson(result).fileTests)).toContain('"sources":["naming"]');
    const text = renderAroundText(result);
    expect(text).toContain("[graph, import]");
    expect(text).toContain("file-level tests of widget.ts (4):\n  __tests__/widget-extra.ts:1 [import]");
    const llm = renderAroundLlm(result).join("\n");
    expect(llm).toContain("sources=graph,import");
    expect(llm).toContain("file_tests shown=4 total=4\nfile_test site=__tests__/widget-extra.ts:1 sources=import");
  });

  it("resolves Python package initializers and JS/TS directory imports", async () => {
    const python = fixture("sample/__init__.py", {
      "tests/package.py": "import sample",
      "tests/from.py": "from sample import run",
      "tests/test_sample.py": "# naming only",
    });
    expect((await python()).fileTests!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "tests/package.py", sources: ["import"] }),
      expect.objectContaining({ path: "tests/from.py", sources: ["import"] }),
      expect.objectContaining({ path: "tests/test_sample.py", sources: ["naming"] }),
    ]));
    rmSync(state.root, { recursive: true, force: true });
    const script = fixture("src/widget/index.ts", {
      "tests/directory.ts": 'import {\n run as subject,\n} from "../src/widget";',
      "tests/commonjs.ts": 'const subject = require("../src/widget");',
      "tests/dynamic.ts": 'const subject = import("../src/widget/index.js");',
      "tests/bare.ts": 'import "widget";',
    });
    expect((await script()).fileTests!.rows.map((r) => r.path)).toEqual([
      "tests/commonjs.ts", "tests/directory.ts", "tests/dynamic.ts",
    ]);
  });

  it("resolves Python package and relative imports without requiring symbol use", async () => {
    const gather = fixture("src/sample/widget.py", {
      "src/sample/__init__.py": "",
      "tests/import_only.py": "from sample import (\n    widget as subject,\n)",
      "tests/dotted.py": "import sample.widget as subject",
      "src/sample/tests/relative.py": "from ..widget import run as subject",
      "test_widget.py": "# naming only",
      "widget_test.py": "# naming only",
      "tests/nested/test_widget_extra.py": "from sample.widget import run",
      "tests/unrelated.py": "from other import widget",
      "other/widget.py": "def other(): pass",
      "tests/__fixtures__/test_widget.py": "from sample import widget",
    });
    const rows = (await gather()).fileTests!.rows;
    // Root-level names are as near other/widget.py: no naming evidence.
    expect(Object.fromEntries(rows.map((r: any) => [r.path, r.sources]))).toEqual({
      "tests/import_only.py": ["import"], "tests/dotted.py": ["import"],
      "src/sample/tests/relative.py": ["import"], "tests/nested/test_widget_extra.py": ["import"],
    });
    rmSync(state.root, { recursive: true, force: true });
    const alone = fixture("src/sample/widget.py", {
      "test_widget.py": "# naming only", "widget_test.py": "# naming only",
      "tests/nested/test_widget_extra.py": "from sample.widget import run", "src/sample/__init__.py": "",
    });
    expect(Object.fromEntries((await alone()).fileTests!.rows.map((r: any) => [r.path, r.sources]))).toEqual({
      "test_widget.py": ["naming"], "widget_test.py": ["naming"], "tests/nested/test_widget_extra.py": ["import", "naming"],
    });
  });

  it("names a test for a file only in the file's own part of the tree, nearest and import-matched first", async () => {
    const gather = fixture("pkg3/src/m4.ts", {
      ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`pkg${i}/__tests__/m4.test.ts`, "// naming only"])),
      "pkg3/test/imports.ts": 'import { run } from "../src/m4";',
      "pkg3/src/m4.spec.ts": "// naming only",
      "tests/m4.test.ts": "// naming only",
      "packages/b/src/m4.test.ts": "// naming only",
    });
    const rows = (await gather()).fileTests!.rows;
    expect(rows.map((r: any) => [r.path, r.sources])).toEqual([
      ["pkg3/test/imports.ts", ["import"]],
      ["pkg3/src/m4.spec.ts", ["naming"]],
      ["pkg3/__tests__/m4.test.ts", ["naming"]],
      ["tests/m4.test.ts", ["naming"]],
    ]);
    rmSync(state.root, { recursive: true, force: true });
    const python = fixture("packages/a/src/models.py", {
      "packages/a/tests/test_models.py": "# naming only",
      "packages/c/tests/test_models.py": "# naming only",
      "packages/b/src/models_test.py": "# naming only",
    });
    expect((await python()).fileTests!.rows.map((r) => r.path)).toEqual(["packages/a/tests/test_models.py"]);
  });

  it("takes a name as evidence only when no same-named module is as near the test", async () => {
    const monorepo = fixture("packages/a/utils.py", {
      "packages/b/utils.py": "",
      "tests/test_utils.py": "# root: as near both utils.py",
      "packages/a/tests/test_utils.py": "# a's own",
      "packages/b/tests/test_utils.py": "# b's own",
    });
    expect((await monorepo()).fileTests!.rows.map((r) => r.path)).toEqual(["packages/a/tests/test_utils.py"]);
    rmSync(state.root, { recursive: true, force: true });
    // A colocated test is nearer its own module than a same-named one below it.
    const script = fixture("src/widget.ts", {
      "src/sub/widget.ts": "export const other = 1;",
      "src/widget.test.ts": "// naming only",
      "src/sub/widget.test.ts": "// the other's",
    });
    expect((await script()).fileTests!.rows.map((r) => r.path)).toEqual(["src/widget.test.ts"]);
  });

  it("does not take a standard-library or site-package import for a same-named local module", async () => {
    const gather = fixture("app/json.py", {
      "app/__init__.py": "",
      "tests/test_api.py": "import json",
      "tests/test_other.py": "from json import dumps",
      "tests/test_dotted.py": "import os.path",
      "tests/test_local.py": "from app import json",
      "tests/test_qualified.py": "import app.json as subject",
      "lib/os/path.py": "",
    });
    expect((await gather()).fileTests!.rows.map((r: any) => [r.path, r.sources])).toEqual([
      ["tests/test_local.py", ["import"]],
      ["tests/test_qualified.py", ["import"]],
    ]);
  });

  it("reads a bounded number of test files, nearest the target first", async () => {
    const gather = fixture("src/widget.ts", {
      ...Object.fromEntries(Array.from({ length: 450 }, (_, i) => [`far/away/t${i}.test.ts`, "// unrelated"])),
      "src/widget-import.test.ts": 'import "./widget";',
    });
    const reads = vi.spyOn(SourceFiles.prototype, "lines");
    const rows = (await gather()).fileTests!.rows;
    expect(rows.map((r) => r.path)).toEqual(["src/widget-import.test.ts"]);
    expect(reads.mock.calls.filter(([p]) => String(p).endsWith(".test.ts")).length).toBe(400);
  });

  it("leaves file-level test evidence to callers that ask for it, so the post-edit hook lists no files", async () => {
    const gather = fixture("src/widget.ts", {
      "src/widget.test.ts": 'import { run } from "./widget";',
    }, [], false);
    const listing = vi.spyOn(SourceFiles.prototype, "sourcePaths");
    const result = await gather();
    expect(result.symbols[0].tests.total).toBe(0);
    expect(result.fileTests).toBeUndefined();
    expect(listing).not.toHaveBeenCalled();
  });

  it("tags no sources on graph-only rows when file-level evidence is off, so the hook text is unchanged", async () => {
    const gather = fixture("src/widget.ts", { "tests/graph.ts": "run();" }, ["tests/graph.ts"], false);
    const result = await gather();
    expect(result.symbols[0].tests.rows.map((r) => r.sources)).toEqual([undefined]);
    expect(renderAroundText(result)).not.toContain("[graph]");
  });

  it("resolves extensionless imports of dotted basenames", async () => {
    const gather = fixture("src/foo.service.ts", {
      "tests/service.ts": 'import { FooService } from "../src/foo.service";',
    });
    expect(Object.fromEntries((await gather()).fileTests!.rows.map((r: any) => [r.path, r.sources])))
      .toEqual({ "tests/service.ts": ["import"] });
  });

  it("names a test only when the name continues past a separator", async () => {
    const script = fixture("src/a.ts", {
      "__tests__/api.test.ts": "// other module", "__tests__/a.extra.test.ts": "// naming only",
    });
    expect((await script()).fileTests!.rows.map((r) => r.path)).toEqual(["__tests__/a.extra.test.ts"]);
    rmSync(state.root, { recursive: true, force: true });
    const python = fixture("a.py", {
      "tests/test_auth.py": "# other module", "tests/test_a_more.py": "# naming only",
    });
    expect((await python()).fileTests!.rows.map((r) => r.path)).toEqual(["tests/test_a_more.py"]);
  });

  it("drops a naming-only test that is listed but gone from disk, keeping one that is there but unread", async () => {
    const gather = fixture("src/widget.ts", { "src/widget.spec.ts": "// naming only" });
    vi.spyOn(SourceFiles.prototype, "sourcePaths").mockReturnValue(["src/widget.spec.ts", "src/widget.test.ts", "src/widget.ts"]);
    const lines = SourceFiles.prototype.lines;
    vi.spyOn(SourceFiles.prototype, "lines").mockImplementation(function (this: SourceFiles, p) {
      return p === "src/widget.spec.ts" ? null : lines.call(this, p);
    });
    expect((await gather()).fileTests!.rows.map((r) => r.path)).toEqual(["src/widget.spec.ts"]);
  });

  it("leaves JSON uncapped, retains text defaults, and honors explicit limits including all", async () => {
    fixture("src/widget.ts", Object.fromEntries([
      ...Array.from({ length: 9 }, (_, i) => [`tests/case${i}.ts`, 'import "../src/widget";']),
      ...Array.from({ length: 9 }, (_, i) => [`users/user${i}.ts`, 'import { run } from "../src/widget";\nrun();']),
    ]));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    async function command(args: string[]) {
      const program = new Command();
      registerAroundCommand(program);
      await program.parseAsync(["around", "src/widget.ts", ...args], { from: "user" });
      return String(output.mock.calls.at(-1)![0]);
    }
    const json = JSON.parse(await command(["--format", "json"]));
    expect(json.fileTests.rows).toHaveLength(9);
    expect(json.symbols[0].users.rows).toHaveLength(9);
    expect(json.importers.rows).toHaveLength(9);
    const text = await command(["--budget", "10000"]);
    expect(text).toContain("file-level tests of widget.ts (5 of 9):");
    expect(text).toContain("used by importers (5 of 9):");
    const limited = JSON.parse(await command(["--format", "json", "--limit", "7"]));
    expect(limited.fileTests.rows).toHaveLength(7);
    expect(limited.importers.rows).toHaveLength(7);
    expect(await command(["--limit", "0", "--budget", "10000"])).toContain("widget.ts (9):");
    expect(await command(["--limit", "7", "--budget", "10000"])).toContain("widget.ts (7 of 9):");
    // A malformed limit falls back as it always did, without failing the run.
    const exit = process.exitCode;
    expect(JSON.parse(await command(["--format", "json", "--limit", "abc"])).fileTests.rows).toHaveLength(8);
    expect(await command(["--limit", "1e3", "--budget", "10000"])).toContain("widget.ts (1 of 9):");
    expect(process.exitCode).toBe(exit);
    expect([limitOption("-1"), limitOption("abc"), limitOption("0"), limitOption(undefined)]).toEqual([1, 8, 0, undefined]);
    // Unlimited lists must still terminate when fitting the normal text budget.
    expect((await command(["--limit", "0"])).length).toBeLessThan(1800);
  });
});

/** A file of `names` functions, each called from `callers` other files; `graphTests` maps a name to the tests calling it. */
function symbolsFixture(names: string[], callers: number, graphTests: Record<string, string[]>, contents: Record<string, string>) {
  state.root = mkdtempSync(join(process.cwd(), ".around-fixture-"));
  const target = "src/widget.ts";
  const all = { [target]: names.map((n) => `export function ${n}() {}`).join("\n"), ...contents };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(join(state.root, file, ".."), { recursive: true });
    writeFileSync(join(state.root, file), text);
  }
  const node = (id: string, kind: string, name: string, file: string, line = 1) => ({
    id, kind, name, provenance: { sourceUri: file }, attrs: { line_start: line, line_end: line },
  });
  const file = node("target-file", "file", "widget.ts", target);
  const defs = names.map((n, i) => node(`def-${n}`, "function", n, target, i + 1));
  state.client = {
    search: vi.fn(async () => [file]),
    expand: vi.fn(async (id: string, opts: any) => {
      if (id === file.id && opts.predicates.includes("CONTAINS")) return {
        nodes: defs, edges: defs.map((d) => ({ src: file.id, dst: d.id, predicate: "CONTAINS" })),
      };
      const def = defs.find((d) => d.id === id);
      if (!def || opts.hops === 2) return { nodes: [], edges: [] };
      return {
        nodes: [
          ...Array.from({ length: callers }, (_, i) => node(`${def.name}-c${i}`, "function", `use${i}`, `lib/${def.name}/c${i}.ts`)),
          ...(graphTests[def.name] ?? []).map((p) => node(p, "function", "it", p)),
        ],
        edges: [],
      };
    }),
  };
  return (caps: Record<string, number> = {}) => gatherAround(state.client, {
    relPath: target, anchorLines: all[target].split("\n"), files: new SourceFiles(state.root), caps, heuristicTests: true,
  });
}

describe("around file-level tests over several symbols", () => {
  it("lists file-level tests once for the file, not under each symbol, and cuts them before callers", async () => {
    const gather = symbolsFixture(["run", "stop", "reset"], 4, { run: ["tests/run.test.ts"] }, {
      "tests/run.test.ts": 'import { run } from "../src/widget";\nrun();',
      ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`tests/case${i}.ts`, 'import "../src/widget";'])),
      ...Object.fromEntries(["run", "stop", "reset"].flatMap((n) => Array.from({ length: 4 }, (_, i) => [
        `lib/${n}/c${i}.ts`, `export const value${i} = ${n}(); // a call site long enough to cost the budget`,
      ]))),
    });
    const result = await gather();
    expect(result.symbols.map((s) => [s.name, s.tests.total])).toEqual([["run", 1], ["stop", 0], ["reset", 0]]);
    // The graph's test agrees with the import; it is not repeated in the file's list.
    expect(result.symbols[0].tests.rows.map((r) => [r.path, r.sources])).toEqual([["tests/run.test.ts", ["graph", "import"]]]);
    expect(result.fileTests!.rows.map((r) => r.path)).toEqual([0, 1, 2, 3, 4].map((i) => `tests/case${i}.ts`));

    // The file's tests cost no symbol a caller row it would have kept without them.
    const render = (r: AroundResult) => renderAroundText(r);
    const fitted = fitToBudget(result, render, DEFAULT_TOKEN_BUDGET);
    const callersKept = (r: AroundResult) => r.symbols.map((s) => s.callers.rows.length);
    expect(callersKept(fitted)).toEqual(callersKept(fitToBudget({ ...result, fileTests: undefined }, render, DEFAULT_TOKEN_BUDGET)));
    const text = render(fitted);
    expect(text).not.toContain("`stop` tests");
    expect(text).toMatch(/file-level tests of widget\.ts \(\d of 5\):/);
    expect(text.split("tests/case0.ts").length - 1).toBe(1);
  });

  it("looks up call sites on disk for a bounded number of callers, keeping every row", async () => {
    const gather = symbolsFixture(["run"], 120, {}, {});
    const reads = vi.spyOn(SourceFiles.prototype, "lines");
    const result = await gather({ callers: Infinity });
    expect(result.symbols[0].callers.rows).toHaveLength(120);
    expect(result.symbols[0].callers.rows[119]).toMatchObject({ path: "lib/run/c119.ts", line: 1 });
    expect(new Set(reads.mock.calls.map(([p]) => p).filter((p) => String(p).startsWith("lib/"))).size).toBe(100);
  });
});
