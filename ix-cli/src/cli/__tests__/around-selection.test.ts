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

import { gatherAround } from "../around.js";
import { aroundJson, renderAroundLlm, renderAroundText } from "../around-render.js";
import { registerAroundCommand } from "../commands/around.js";
import { SourceFiles } from "../edge-sites.js";

afterEach(() => {
  vi.restoreAllMocks();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  state.root = "";
});

function fixture(target: string, contents: Record<string, string>, graphTests: string[] = []) {
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
    caps: { tests: 100 },
  });
}

describe("around test selection", () => {
  it("unions import-only, naming-only, both and graph evidence, ranking agreement first", async () => {
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
    const rows = result.symbols[0].tests.rows;
    expect(rows.map((r) => r.path).slice(0, 2)).toEqual(["tests/agreement.ts", "tests/graph.ts"]);
    expect(Object.fromEntries(rows.map((r: any) => [r.path, r.sources]))).toEqual({
      "tests/agreement.ts": ["graph", "import"],
      "tests/graph.ts": ["graph"],
      "tests/import-only.ts": ["import"],
      "src/widget.spec.ts": ["naming"],
      "src/widget.test.ts": ["naming"],
      "__tests__/widget-extra.ts": ["import", "naming"],
    });
    expect(JSON.stringify(aroundJson(result))).toContain('"sources":["graph","import"]');
    expect(renderAroundText(result)).toContain("[graph, import]");
    expect(renderAroundLlm(result).join("\n")).toContain("sources=graph,import");
  });

  it("resolves Python package initializers and JS/TS directory imports", async () => {
    const python = fixture("sample/__init__.py", {
      "tests/package.py": "import sample",
      "tests/from.py": "from sample import run",
      "tests/test_sample.py": "# naming only",
    });
    expect((await python()).symbols[0].tests.rows).toEqual(expect.arrayContaining([
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
    expect((await script()).symbols[0].tests.rows.map((r) => r.path)).toEqual([
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
    const rows = (await gather()).symbols[0].tests.rows;
    expect(Object.fromEntries(rows.map((r: any) => [r.path, r.sources]))).toEqual({
      "tests/import_only.py": ["import"], "tests/dotted.py": ["import"],
      "src/sample/tests/relative.py": ["import"], "test_widget.py": ["naming"],
      "widget_test.py": ["naming"], "tests/nested/test_widget_extra.py": ["import", "naming"],
    });
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
    expect(json.symbols[0].tests.rows).toHaveLength(9);
    expect(json.symbols[0].users.rows).toHaveLength(9);
    expect(json.importers.rows).toHaveLength(9);
    const text = await command(["--budget", "10000"]);
    expect(text).toContain("tests (5 of 9):");
    expect(text).toContain("used by importers (5 of 9):");
    const limited = JSON.parse(await command(["--format", "json", "--limit", "7"]));
    expect(limited.symbols[0].tests.rows).toHaveLength(7);
    expect(limited.importers.rows).toHaveLength(7);
    expect(await command(["--limit", "0", "--budget", "10000"])).toContain("tests (9):");
    expect(await command(["--limit", "7", "--budget", "10000"])).toContain("tests (7 of 9):");
    // Unlimited lists must still terminate when fitting the normal text budget.
    expect((await command(["--limit", "0"])).length).toBeLessThan(1800);
  });
});
