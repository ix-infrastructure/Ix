// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { rankScore, registerSearchCommand } from "../commands/search.js";
import { setOutputShape } from "../output-shape.js";

/**
 * `ix search <code name>` must lead with the code definition.
 *
 * Seen on SWE-PolyBench while resolving names from issue text: an import of a
 * name (a `module` entity whose path is the IMPORTING file) came back instead
 * of the file that defines it, and code-like terms matched CSS selectors,
 * markdown headings, JSON keys and build output ahead of code. Those rows are
 * demoted, not removed — except an import of the term, which is folded away
 * once the definition itself is listed (Ix#1017).
 */

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("../../client/api.js", () => ({
  IxClient: class {
    async search(...args: unknown[]) { return search(...args); }
    async semanticSearch() { return []; }
  },
}));
vi.mock("../resolve.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../resolve.js")>(),
  resolveReadSystemId: async () => "test-system",
}));

type Node = { id: string; name: string; kind: string; provenance: { sourceUri: string }; attrs: Record<string, unknown> };

function n(
  id: string, name: string, kind: string, path: string, weight: number,
  extra: Record<string, unknown> = {},
): Node {
  const ext = path.slice(path.lastIndexOf(".") + 1);
  const language = ({ js: "javascript", ts: "typescript", css: "css", md: "markdown", json: "json" } as Record<string, string>)[ext];
  return {
    id, name, kind, provenance: { sourceUri: path },
    attrs: { language, line_start: 1, line_end: 20, role: "production", _search_weight: weight, ...extra },
  };
}

/** An import entity: single-line `module` in the importing file. */
function imp(id: string, name: string, path: string, line = 3): Node {
  return n(id, name, "module", path, 100, { line_start: line, line_end: line });
}

/** A fake backend: honours `kind` and `limit` like `/v1/search` does. */
function dataset(nodes: Node[]) {
  search.mockImplementation(async (_term: string, opts: { limit?: number; kind?: string }) => {
    const matching = opts.kind ? nodes.filter((x) => x.kind === opts.kind) : nodes;
    return matching.slice(0, opts.limit);
  });
}

async function run(term: string, args: string[] = []) {
  const program = new Command().name("ix").exitOverride();
  registerSearchCommand(program);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  await program.parseAsync(["search", term, ...args, "--format", "json"], { from: "user" });
  return JSON.parse(output.join("\n")) as {
    results: Array<{ id: string; tier: number; score: number; matchSource: string }>;
  };
}

const ids = (out: { results: Array<{ id: string }> }) => out.results.map((r) => r.id);

describe("search: definitions rank above import entities", () => {
  beforeEach(() => { search.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  it("ranks the defining file above an import of the same name (tailwind borderStylesReset)", async () => {
    // The generator is an anonymous default export, so the only definition row
    // is its file; the backend scores the file as a partial name match.
    dataset([
      imp("import", "borderStylesReset", "src/lib/generateUtilities.js"),
      n("file", "borderStylesReset.js", "file", "src/generators/borderStylesReset.js", 60, { line_end: 8 }),
    ]);
    const out = await run("borderStylesReset");
    // The import is folded behind the file it imports (Ix#1017); it still
    // ranks in a lower tier, which is what orders it when nothing folds it.
    expect(ids(out)).toEqual(["file"]);
    const tierOf = (node: Node) => rankScore(node, "borderStylesReset", undefined, undefined).tier;
    expect(tierOf(n("file", "borderStylesReset.js", "file", "src/generators/borderStylesReset.js", 60)))
      .toBeLessThan(tierOf(imp("import", "borderStylesReset", "src/lib/generateUtilities.js")));
  });

  it("lists a same-named function and folds its import", async () => {
    dataset([
      imp("import", "parseConfig", "src/cli.ts"),
      n("fn", "parseConfig", "function", "src/config.ts", 100),
    ]);
    expect(ids(await run("parseConfig"))).toEqual(["fn"]);
  });

  it("finds the defining file even when imports fill the candidate window", async () => {
    // 40 importers of the name, then the file itself as a partial match: the
    // default window (limit * 3 = 30) never reaches it.
    dataset([
      ...Array.from({ length: 40 }, (_, i) => imp(`import-${i}`, "borderStylesReset", `src/lib/user${i}.js`)),
      n("file", "borderStylesReset.js", "file", "src/generators/borderStylesReset.js", 60),
    ]);
    const out = await run("borderStylesReset") as Awaited<ReturnType<typeof run>> & { diagnostics: Array<{ code: string; message: string }> };
    // Found, and then the imports that crowded it out are folded behind it.
    expect(ids(out)).toEqual(["file"]);
    expect(out.diagnostics.find((d) => d.code === "imports_folded")?.message).toMatch(/^\d+ import rows of borderStylesReset folded/);
  });

  it("looks for the defining file when the window holds only a map region of the name", async () => {
    dataset([
      { id: "region", name: "Format", kind: "region", provenance: { sourceUri: "ix:map" }, attrs: { _search_weight: 100 } },
      ...Array.from({ length: 40 }, (_, i) => n(`json-${i}`, "format", "config_entry", `pkg${i}/package.json`, 100)),
      n("file", "format.ts", "file", "src/cli/format.ts", 60),
    ]);
    const out = await run("format");
    expect(ids(out)[0]).toBe("file");
  });

  it("does not spend an extra request when a definition is already in the window", async () => {
    dataset([
      n("fn", "parseConfig", "function", "src/config.ts", 100),
      ...Array.from({ length: 40 }, (_, i) => imp(`import-${i}`, "parseConfig", `src/user${i}.ts`)),
    ]);
    const out = await run("parseConfig");
    expect(ids(out)[0]).toBe("fn");
    expect(search).toHaveBeenCalledTimes(1);
  });
});

describe("search: import rows fold once the definition is listed (Ix#1017)", () => {
  beforeEach(() => { search.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  async function runLlm(term: string, args: string[] = []) {
    const program = new Command().name("ix").exitOverride();
    registerSearchCommand(program);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => { output.push(parts.join(" ")); });
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    await program.parseAsync(["search", term, ...args, "--format", "llm"], { from: "user" });
    return output;
  }

  /** A Laravel class and every `use App\Models\Invoice;` of it. */
  const phpRows = () => [
    ...Array.from({ length: 12 }, (_, i) => imp(`use-${i}`, "Invoice", `app/Http/Controllers/C${i}.php`)),
    n("cls", "Invoice", "class", "app/Models/Invoice.php", 100, { language: "php" }),
    n("item", "InvoiceItem", "class", "app/Models/InvoiceItem.php", 60, { language: "php" }),
  ];

  it("lists the class and the next real match instead of a page of `use` rows", async () => {
    dataset(phpRows());
    const out = await run("Invoice");
    expect(ids(out)).toEqual(["cls", "item"]);
  });

  it("says how many import rows it folded and where to find them", async () => {
    dataset(phpRows());
    const out = await run("Invoice") as unknown as { diagnostics: Array<{ code: string; message: string }> };
    const folded = out.diagnostics.find((d) => d.code === "imports_folded");
    expect(folded?.message).toContain("12 import");
    expect(folded?.message).toContain("ix imported-by Invoice");
  });

  it("names the folded imports in llm output, and --quiet drops the note", async () => {
    dataset(phpRows());
    const lines = await runLlm("Invoice");
    expect(lines.some((l) => l.includes("code=imports_folded"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("node "))).toHaveLength(2);
    vi.restoreAllMocks();
    setOutputShape({ quiet: true });
    try {
      const quiet = await runLlm("Invoice");
      expect(quiet.some((l) => l.includes("imports_folded"))).toBe(false);
      expect(quiet.filter((l) => l.startsWith("node "))).toHaveLength(2);
    } finally {
      setOutputShape({});
    }
  });

  it("keeps the imports when no definition is in the answer", async () => {
    dataset([
      imp("use-a", "Invoice", "app/A.php"),
      imp("use-b", "Invoice", "app/B.php"),
    ]);
    const out = await run("Invoice") as unknown as { results: Array<{ id: string }>; diagnostics: Array<{ code: string }> };
    expect(ids(out).sort()).toEqual(["use-a", "use-b"]);
    expect(out.diagnostics.some((d) => d.code === "imports_folded")).toBe(false);
  });

  it("keeps the imports when the only definition is hidden as a test", async () => {
    dataset([
      n("cls", "Invoice", "class", "tests/Invoice.php", 100, { role: "test" }),
      imp("use-a", "Invoice", "app/A.php"),
    ]);
    expect(ids(await run("Invoice"))).toEqual(["use-a"]);
  });
});

describe("search: code definitions rank above non-code and generated matches", () => {
  beforeEach(() => { search.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  it("demotes a CSS selector in build output below a code definition (flex)", async () => {
    dataset([
      n("css", "flex", "class", "tailwind-output.css", 100),
      n("fn", "flex", "function", "src/plugins/flex.js", 100),
    ]);
    const out = await run("flex");
    expect(ids(out)).toEqual(["fn", "css"]);
  });

  it("demotes a markdown heading below a code definition (TypeScript)", async () => {
    dataset([
      n("heading", "TypeScript", "heading", "CHANGELOG.md", 100),
      n("cls", "TypeScript", "class", "src/language-js/TypeScript.js", 100),
    ]);
    expect(ids(await run("TypeScript"))).toEqual(["cls", "heading"]);
  });

  it("demotes JSON keys and CSS selectors below a code definition (version)", async () => {
    dataset([
      n("json", "version", "config_entry", "package.json", 100),
      n("css", "version", "class", "src/browser/media/code.css", 100),
      n("const", "version", "constant", "src/node/constants.ts", 100),
    ]);
    const out = await run("version");
    expect(ids(out)[0]).toBe("const");
    expect(ids(out).sort()).toEqual(["const", "css", "json"]);
  });

  it("demotes definitions in dist/, minified and fixture files below the source one", async () => {
    dataset([
      n("dist", "code", "function", "dist/index.js", 100),
      n("min", "code", "function", "vendor/code.min.js", 100),
      n("fixture", "code", "function", "test-plugin/fixtures/plugin.js", 100),
      n("sample", "code", "function", "samples/plugin.js", 100),
      n("src", "code", "function", "src/node/code.ts", 100),
    ]);
    const out = await run("code");
    expect(ids(out)[0]).toBe("src");
    expect(out.results).toHaveLength(5);
  });

  it("treats a committed build/ directory as source, ahead of an import of its definition", async () => {
    // `ix map` ingests tracked files only, so a `build/` directory in the graph
    // is committed source (VS Code's build/lib, Go's src/go/build, pip's
    // operations/build), not build output.
    dataset([
      imp("import", "generate_metadata", "src/pip/_internal/distributions/sdist.py"),
      n("fn", "generate_metadata", "function", "src/pip/_internal/operations/build/metadata.py", 100),
    ]);
    const out = await run("generate_metadata");
    // The build/ function counts as the definition, so its import folds.
    expect(ids(out)).toEqual(["fn"]);
  });

  it("keeps a demoted row when it is the only match", async () => {
    dataset([n("css", "flex", "class", "tailwind-output.css", 100)]);
    expect(ids(await run("flex"))).toEqual(["css"]);
  });

  it("does not demote CSS for a term that is not a code identifier", async () => {
    dataset([
      n("fn", "border-solid", "function", "src/util.js", 60),
      n("css", "border-solid", "class", "src/css/base.css", 100),
    ]);
    const out = await run("border-solid");
    expect(ids(out)[0]).toBe("css");
    expect(out.results[0].tier).toBeLessThanOrEqual(1);
  });

  it("does not demote the kind the caller asked for", async () => {
    dataset([
      n("heading", "Installation", "heading", "README.md", 100),
      n("heading2", "Installation", "heading", "docs/setup.md", 100),
    ]);
    const out = await run("Installation", ["--kind", "heading"]);
    expect(out.results.every((r) => r.tier <= 1)).toBe(true);
  });
});

describe("search: role filtering is unchanged by the demotion", () => {
  beforeEach(() => { search.mockReset(); });
  afterEach(() => vi.restoreAllMocks());

  const rows = () => [
    n("fixture", "prettier", "function", "tests/fixtures/plugin/prettier.js", 100, { role: "fixture" }),
    n("test", "prettier", "function", "tests/format.test.js", 100, { role: "test" }),
    n("src", "prettier", "function", "src/index.js", 100),
  ];

  it("hides test and fixture rows by default", async () => {
    dataset(rows());
    expect(ids(await run("prettier"))).toEqual(["src"]);
  });

  it("--include-tests keeps every row, the fixture stand-in last", async () => {
    // A test is code under test's own name and keeps its place; a fixture is a
    // stand-in and is demoted like a sample.
    dataset(rows());
    const out = await run("prettier", ["--include-tests"]);
    expect(ids(out)).toHaveLength(3);
    expect(ids(out)[2]).toBe("fixture");
  });

  it("--tests-only keeps only test and fixture rows", async () => {
    dataset(rows());
    expect(ids(await run("prettier", ["--tests-only"])).sort()).toEqual(["fixture", "test"]);
  });
});
