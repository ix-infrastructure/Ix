// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  bm25Rank,
  bm25Tokens,
  chooseCentre,
  extractCandidates,
  isSourcePath,
  issueConfidence,
  leanIssueView,
  pickStartingPoints,
  planIssue,
  rankIssueFiles,
  readIssueText,
  type SymbolHit,
} from "../explain/issue.js";
import { gitRepoAccess, type RepoAccess } from "../explain/text-references.js";

/**
 * `ix context --from-issue`: from an issue's text to where the fix starts.
 *
 * The cases are the ones the SWE-PolyBench pilot got wrong before its picker
 * was fixed: a CSS output file, a changelog and test fixtures chosen as
 * starting points, an import chosen over the definition it imports, and a
 * prose word resolved as if it were a code name.
 */

function memoryRepo(files: Record<string, string>): RepoAccess {
  return {
    files: () => Object.keys(files),
    read: (path) => files[path],
    grep: () => [],
  };
}

/** A search that answers from a fixed table, and records what it was asked. */
function fakeSearch(table: Record<string, SymbolHit[]>) {
  const asked: string[] = [];
  const search = async (name: string) => {
    asked.push(name);
    return table[name] ?? [];
  };
  return { search, asked };
}

const hit = (name: string, kind: string, path: string, lines?: [number, number]): SymbolHit => ({
  id: `${kind}:${path}:${name}`, name, kind, path,
  ...(lines ? { lineStart: lines[0], lineEnd: lines[1] } : {}),
});

describe("extractCandidates", () => {
  it("takes paths first, then multi-part names, then backticked words, and never prose", () => {
    const text = [
      "Calling `save` on a model fails in keras/src/saving/saving_api.py.",
      "The `saveModel` helper and GsonBuilder both call new_json_writer,",
      "but `flex` and `code` are fine. The Widget renders the page.",
    ].join("\n");
    const { paths, identifiers } = extractCandidates(text);
    expect(paths).toEqual(["keras/src/saving/saving_api.py"]);
    expect(identifiers.slice(0, 3)).toEqual(["saveModel", "GsonBuilder", "new_json_writer"]);
    // Single words only from backticks, four letters or more, after every
    // multi-part name.
    expect(identifiers.slice(-3)).toEqual(["save", "flex", "code"]);
    for (const prose of ["Calling", "model", "fails", "Widget", "renders", "page", "The"]) {
      expect(identifiers).not.toContain(prose);
    }
  });

  it("tries a specific single word before a common one the issue mentions first", () => {
    // Three names become starts. `repeat` came first in the issue and took a
    // slot `Stylesheet` needed.
    const { identifiers } = extractCandidates("`repeat` then `ignore` breaks `Stylesheet` and `Selector`");
    expect(identifiers).toEqual(["Stylesheet", "Selector", "repeat", "ignore"]);
  });

  it("drops short backticked words and keeps a name once", () => {
    const { identifiers } = extractCandidates("`id` and `run` then `listByKind` and listByKind again");
    expect(identifiers).toEqual(["listByKind"]);
  });
});

describe("isSourcePath", () => {
  it("accepts code and refuses tests, fixtures, docs, build output, vendored and non-code files", () => {
    expect(isSourcePath("src/cli/commands/rank.ts")).toBe(true);
    expect(isSourcePath("keras/src/saving/saving_api.py")).toBe(true);
    // Only the directory: a file named for one is code.
    for (const code of ["src/website.ts", "lib/playground.js", "src/sites/a.ts", "src/benchmark/timer.ts"]) {
      expect(isSourcePath(code), code).toBe(true);
    }
    for (const noise of [
      "src/css/preflight.css", "CHANGELOG.md", "docs/api.ts", "package.json",
      "src/__tests__/rank.test.ts", "tests/test_saving.py", "src/saving_test.py",
      "test-fixtures/typescript/sample.ts", "__fixtures__/a.js", "examples/demo.js",
      "vendor/lib.js", "dist/index.js", "build/out.js", "lib/jquery.min.js",
      // A project's website, playground, test config, benchmarks, stories, e2e.
      "site/src/routes/index.svelte", "website/static/worker.js", "packages/docs-site/a.ts",
      "website/playground/markdown.js", "tests_config/run_spec.js", "test-config/setup.js",
      "benchmarks/run.py", ".storybook/main.js", "packages/app/e2e/login.ts", "cypress/support/a.js",
    ]) {
      expect(isSourcePath(noise), noise).toBe(false);
    }
  });
});

describe("pickStartingPoints", () => {
  it("does not start from a CSS output file for `flex`", async () => {
    const { search } = fakeSearch({ flex: [hit("flex", "rule", "src/css/output.css")] });
    const out = await pickStartingPoints("Setting `flex` breaks the layout", { files: [], search });
    expect(out.starts).toEqual([]);
    expect(out.unresolved).toEqual(["flex"]);
  });

  it("chooses the definition, not the module entity of the file that imports it", async () => {
    const { search } = fakeSearch({
      borderStylesReset: [
        hit("borderStylesReset", "module", "src/util/generateUtilities.js"),
        hit("borderStylesReset", "function", "src/util/borderStylesReset.js", [3, 20]),
      ],
    });
    const out = await pickStartingPoints("borderStylesReset is applied twice", { files: [], search });
    expect(out.starts).toHaveLength(1);
    expect(out.starts[0]).toMatchObject({
      token: "borderStylesReset", path: "src/util/borderStylesReset.js", kind: "function",
      lineStart: 3, lineEnd: 20, via: "identifier in issue",
    });
  });

  it("leaves a name unresolved when its only hit is an import", async () => {
    const { search } = fakeSearch({ borderStylesReset: [hit("borderStylesReset", "module", "src/a.js")] });
    const out = await pickStartingPoints("`borderStylesReset`", { files: [], search });
    expect(out.starts).toEqual([]);
    expect(out.unresolved).toEqual(["borderStylesReset"]);
  });

  it("ignores changelog, markdown and test hits, and inexact names", async () => {
    const { search } = fakeSearch({
      newJsonWriter: [
        hit("newJsonWriter", "section", "CHANGELOG.md"),
        hit("newJsonWriter", "heading", "docs/guide.md"),
        hit("newJsonWriter", "method", "gson/src/test/java/com/google/gson/GsonTest.java"),
        hit("newJsonWriterAsync", "method", "gson/src/main/java/com/google/gson/Other.java"),
      ],
    });
    const out = await pickStartingPoints("newJsonWriter drops the lenient flag", { files: [], search });
    expect(out.starts).toEqual([]);
    expect(out.unresolved).toEqual(["newJsonWriter"]);
  });

  it("puts a multi-part name ahead of a single backticked word", async () => {
    const { search } = fakeSearch({
      save: [hit("save", "function", "keras/src/models/model.py", [10, 40])],
      saveModel: [hit("saveModel", "function", "keras/src/saving/saving_api.py", [5, 60])],
    });
    const out = await pickStartingPoints("`save` fails, and so does `saveModel`", { files: [], search });
    expect(out.starts.map((s) => s.token)).toEqual(["saveModel", "save"]);
    expect(out.starts[0].path).toBe("keras/src/saving/saving_api.py");
  });

  it("keeps at most three starting points, one per file", async () => {
    const { search } = fakeSearch({
      alphaOne: [hit("alphaOne", "function", "src/a.ts")],
      alphaTwo: [hit("alphaTwo", "function", "src/a.ts")],
      betaOne: [hit("betaOne", "function", "src/b.ts")],
      gammaOne: [hit("gammaOne", "function", "src/c.ts")],
      deltaOne: [hit("deltaOne", "function", "src/d.ts")],
    });
    const out = await pickStartingPoints("alphaOne alphaTwo betaOne gammaOne deltaOne", { files: [], search });
    expect(out.starts.map((s) => s.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(out.unresolved).toEqual([]);
  });

  it("breaks a tie between two definitions of one name by the issue's text", async () => {
    const { search } = fakeSearch({
      renderRow: [hit("renderRow", "function", "src/table.ts"), hit("renderRow", "function", "src/grid.ts")],
    });
    const out = await pickStartingPoints("renderRow in the grid", {
      files: [], search, fileScore: (p) => (p === "src/grid.ts" ? 2 : 1),
    });
    expect(out.starts[0].path).toBe("src/grid.ts");
  });
});

describe("path candidates resolve against the tracked files", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("resolves a unique basename and a unique suffix via git ls-files, and refuses an ambiguous one", async () => {
    dir = mkdtempSync(join(tmpdir(), "ix-from-issue-"));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir!, path)), { recursive: true });
      writeFileSync(join(dir!, path), text);
    };
    execFileSync("git", ["init", "-q"], { cwd: dir });
    write("keras/src/saving/saving_api.py", "def save_model():\n  pass\n");
    write("src/a/index.ts", "export {};\n");
    write("src/b/index.ts", "export {};\n");
    write("src/untracked.ts", "export {};\n");
    execFileSync("git", ["add", "keras", "src/a", "src/b"], { cwd: dir });
    const repo = gitRepoAccess(dir)!;

    const { search, asked } = fakeSearch({});
    const out = await pickStartingPoints(
      "See saving_api.py, then a/index.ts; index.ts and untracked.ts are unrelated.",
      { files: repo.files(), search },
    );
    expect(out.starts.map((s) => [s.path, s.via])).toEqual([
      ["keras/src/saving/saving_api.py", "path in issue"],
      ["src/a/index.ts", "path in issue"],
    ]);
    expect(out.unresolved).toEqual(expect.arrayContaining(["index.ts", "untracked.ts"]));
    // A path is resolved against the file list, not the symbol index.
    expect(asked).not.toContain("saving_api.py");
  });
});

describe("readIssueText", () => {
  it("reads stdin for `-`", async () => {
    const text = await readIssueText("-", Readable.from(["The `listByKind` ", "call is slow\n"]));
    expect(text).toBe("The `listByKind` call is slow\n");
  });

  it("reads a file path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ix-issue-text-"));
    try {
      writeFileSync(join(dir, "issue.md"), "rank is wrong\n");
      expect(await readIssueText(join(dir, "issue.md"))).toBe("rank is wrong\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("BM25", () => {
  it("splits camelCase and snake_case, keeps a multi-part name whole too, and drops short parts", () => {
    expect(bm25Tokens("listByKind save_model_v2 a IO HTTPServer plain"))
      .toEqual(["list", "kind", "listbykind", "save", "model", "savemodelv2", "http", "server", "httpserver", "plain"]);
  });

  it("spells a whole name the same in camelCase and snake_case", () => {
    expect(bm25Tokens("saveModel")).toContain("savemodel");
    expect(bm25Tokens("save_model")).toContain("savemodel");
    expect(bm25Tokens("__init__ _private")).toEqual(["init", "private"]);
  });

  it("ranks the file that defines a name the issue gives above files that only share its parts", () => {
    // Split into parts alone, `borderStylesReset` is "border styles reset",
    // which borders.js says more often: the old tokenizer ranked it first.
    const repo = memoryRepo({
      "src/preflight.js": "export function borderStylesReset() { return {}; }\nexport const other = 1;",
      "src/borders.js": "// border styles reset\nexport function reset(border, styles) { return border; }",
      "src/theme.js": "export const theme = { border: 1, styles: 2, reset: 3 };",
      "src/a.js": "export const a = 1;",
      "src/b.js": "export const b = 1;",
    });
    const ranked = bm25Rank(repo, repo.files(), "`borderStylesReset` drops the border styles on reset");
    expect(ranked[0].path).toBe("src/preflight.js");
  });

  it("ignores the prose words an issue is written in", () => {
    // Without stopwords the chatty file wins on "should", "would", "expected"
    // and "behavior", which say nothing about where the fix is.
    const chatty = "// This should work. It would be expected behavior when we should do this.\n";
    const repo = memoryRepo({
      "src/comments.ts": chatty.repeat(5),
      "src/tooltip.ts": "export function placeTooltip() {}",
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
    });
    const ranked = bm25Rank(repo, repo.files(),
      "The tooltip should open where I would have expected; the behavior should be the same as before.");
    expect(ranked[0].path).toBe("src/tooltip.ts");
    expect(ranked.map((r) => r.path)).not.toContain("src/comments.ts");
  });

  it("weights the words of a code name the issue mentions above the same words in prose", () => {
    // "store" and "cache" each match one file once, and the files are alike:
    // unweighted, the tie goes to the path, cache.ts.
    const repo = memoryRepo({
      "src/cache.ts": "export const cache = 1;",
      "src/store.ts": "export const store = 1;",
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 1;",
    });
    const ranked = bm25Rank(repo, repo.files(), "Calling `store_state` fails: the cache is wrong.");
    expect(ranked.map((r) => r.path)).toEqual(["src/store.ts", "src/cache.ts"]);
    expect(ranked[0].score).toBeCloseTo(2 * ranked[1].score, 5);
  });
});

describe("planIssue", () => {
  it("falls back to BM25 when nothing in the issue resolves, and says so", async () => {
    const repo = memoryRepo({
      "src/auth/login.ts": "export function checkPassword(password: string) { return password.length > 0; }",
      "src/util/strings.ts": "export function trim(s: string) { return s.trim(); }",
      "src/auth/login.test.ts": "password password password login login",
      "CHANGELOG.md": "login password login password",
    });
    const { search } = fakeSearch({});
    const plan = await planIssue("The login page crashes when the password is empty. `flex`", { repo, search });
    expect(plan.fallback).toBe(true);
    expect(plan.starts).toHaveLength(1);
    expect(plan.starts[0]).toMatchObject({ path: "src/auth/login.ts", via: "bm25 fallback" });
    expect(plan.unresolved).toEqual(["flex"]);
    // BM25 ranks source files only.
    expect(plan.bm25.map((r) => r.path)).not.toContain("src/auth/login.test.ts");
    expect(plan.bm25.map((r) => r.path)).not.toContain("CHANGELOG.md");
  });

  it("does not fall back when a name resolves", async () => {
    const repo = memoryRepo({ "src/client/api.ts": "listByKind", "src/other.ts": "other" });
    const { search } = fakeSearch({ listByKind: [hit("listByKind", "method", "src/client/api.ts", [141, 152])] });
    const plan = await planIssue("`listByKind` returns nothing", { repo, search });
    expect(plan.fallback).toBe(false);
    expect(plan.starts.map((s) => s.path)).toEqual(["src/client/api.ts"]);
  });
});

describe("rankIssueFiles", () => {
  const starts = [
    { token: "listByKind", name: "listByKind", kind: "method", path: "src/client/api.ts", via: "identifier in issue" as const },
  ];

  it("boosts starts without overturning a clear lexical lead", () => {
    const ranked = rankIssueFiles({
      starts,
      bm25: [
        { path: "src/cli/commands/inventory.ts", score: 9 },
        { path: "src/client/api.ts", score: 5 },
        { path: "src/cli/commands/rank.ts", score: 4 },
      ],
      near: new Map(),
    });
    expect(ranked.map((r) => r.path)).toEqual([
      "src/cli/commands/inventory.ts", "src/client/api.ts", "src/cli/commands/rank.ts",
    ]);
    expect(ranked[1].reason).toContain("starting point");
    expect(ranked[0].reason).toContain("bm25");
  });

  it("uses graph closeness to break ties and nudge, never to overturn a clear lexical lead", () => {
    const ranked = rankIssueFiles({
      starts,
      bm25: [
        { path: "src/far-strong.ts", score: 10 },
        { path: "src/far-tie.ts", score: 4 },
        { path: "src/near-tie.ts", score: 4 },
        { path: "src/near-weak.ts", score: 1 },
      ],
      near: new Map([
        ["src/near-tie.ts", { weight: 1, reason: "one hop from listByKind" }],
        ["src/near-weak.ts", { weight: 1, reason: "one hop from listByKind" }],
        ["src/near-only.ts", { weight: 0.5, reason: "related to listByKind" }],
        ["src/near-test.test.ts", { weight: 1, reason: "one hop from listByKind" }],
      ]),
    });
    expect(ranked.map((r) => r.path)).toEqual([
      "src/far-strong.ts", "src/near-tie.ts", "src/far-tie.ts",
      "src/near-weak.ts", "src/client/api.ts", "src/near-only.ts",
    ]);
    expect(ranked.find((r) => r.path === "src/near-tie.ts")?.reason).toContain("one hop from listByKind");
  });
});

describe("issue localization regressions", () => {
  const search = async (name: string) => [hit(name, "class", `src/${name}.py`)];

  it("keeps a prose-named failure ahead of snippet-defined and snippet-used names", async () => {
    const text = [
      "```python", "class DemoModel(ModelBase):", "    field = ModelField()", "```",
      "The decode_payload function corrupts escaped payload values.",
    ].join("\n");
    const repo = memoryRepo({
      "src/DemoModel.py": "class DemoModel: pass",
      "src/ModelBase.py": "class ModelBase: pass",
      "src/ModelField.py": "class ModelField: pass",
      "src/decode_payload.py": "def decode_payload(payload): # corrupts escaped payload values\n    return payload",
    });
    const plan = await planIssue(text, { repo, search });
    expect(plan.starts[0].token).toBe("decode_payload");
    expect(rankIssueFiles({ ...plan, near: new Map() })[0].path).toBe("src/decode_payload.py");
  });

  it("caps a weak start boost below much stronger lexical hits", () => {
    const ranked = rankIssueFiles({
      starts: [{ token: "ModelBase", name: "ModelBase", kind: "class", path: "src/base.py", via: "identifier in issue" }],
      bm25: [
        { path: "src/messages_pb2.py", score: 1000 },
        { path: "src/parser.py", score: 30 }, { path: "src/decoder.py", score: 20 }, { path: "src/base.py", score: 1 },
      ],
      near: new Map(),
    });
    expect(ranked.map((f) => f.path)).toEqual(["src/parser.py", "src/decoder.py", "src/base.py"]);
    expect(ranked[2].reason).toContain("starting point");
    expect(ranked[2].reason).toContain("bm25");
    expect(Object.keys(ranked[0]).sort()).toEqual(["path", "reason", "score"]);
  });

  it("uses a start to break a close lexical race, but gives snippet-only names no boost", async () => {
    const plan = await planIssue("```python\nclass DemoModel(ModelBase):\n    field = ModelField()\n```", {
      // The graph knows only ModelBase: a hit in a file the listing lacks still counts.
      search: async (name) => name === "ModelBase" ? search(name) : [],
      repo: memoryRepo({ "src/ModelBase.py": "class ModelBase: pass" }),
    });
    expect(plan.starts[0]).toMatchObject({ token: "ModelBase", snippet: true });
    expect(issueConfidence(plan).confident).toBe(false);
    const input = {
      starts: [{ ...plan.starts[0], path: "src/base.py" }],
      bm25: [{ path: "src/other.py", score: 10 }, { path: "src/base.py", score: 9.5 }],
      near: new Map(),
    };
    expect(rankIssueFiles(input)[0].path).toBe("src/other.py");
    const ranked = rankIssueFiles({ ...input, starts: [{ ...input.starts[0], snippet: false }] });
    expect(ranked[0].path).toBe("src/base.py");
    expect(ranked[0].score).toBe(10.5);
  });

  it("prefers a prose mention over an inline call or an indented definition", () => {
    const { identifiers, snippetIdentifiers } = extractCandidates([
      "Calling `ModelField(value)` reproduces this.",
      "    class DemoModel(ModelBase): pass",
      "decode_payload fails to unescape values.",
    ].join("\n"));
    // The inline call ranks after the plain mention but stays evidence.
    expect(identifiers.slice(0, 2)).toEqual(["decode_payload", "ModelField"]);
    expect(snippetIdentifiers).toEqual(["DemoModel", "ModelBase"]);
    expect(extractCandidates("`ModelField(value)` reproduces it; `ModelField` drops values.").snippetIdentifiers)
      .toBeUndefined();
    expect(extractCandidates("class DemoModel(ModelBase):\nfield = ModelField()\ndecode_payload fails").identifiers[0])
      .toBe("decode_payload");
  });

  it("takes one innermost eligible frame per traceback, skipping runtime and wrapper frames", async () => {
    const text = [
      "Traceback (most recent call last):",
      '  File "/project/src/outer.py", line 1, in run',
      '  File "/project/src/inner.py", line 2, in decode',
      '  File "/project/manage.py", line 3, in main',
      '  File "/project/.venv/lib/python3.12/site-packages/lib/worker.py", line 4, in call',
      '  File "/usr/lib/python3.12/json/decoder.py", line 5, in decode',
      "ValueError: invalid payload",
      "Traceback (most recent call last):",
      '  File "/project/src/outer.py", line 1, in run',
      '  File "/project/src/final.py", line 8, in decode',
      "    outer_helper()",
      "ValueError: final failure",
    ].join("\n");
    const out = await pickStartingPoints(text, {
      files: ["src/outer.py", "src/inner.py", "src/final.py", "src/helper.py", "manage.py", "lib/worker.py", "json/decoder.py"],
      search: async (name) => name === "outer_helper" ? [hit(name, "function", "src/helper.py")] : [],
    });
    expect(out.starts.map((s) => s.path)).toEqual(["src/inner.py", "src/final.py"]);
    expect(rankIssueFiles({ starts: out.starts, bm25: [], near: new Map() })[0].reason).toContain("traceback");
  });

  it("keeps JavaScript's innermost-first frame order and skips dependency frames", async () => {
    const out = await pickStartingPoints([
      "TypeError: invalid payload",
      "    at parse (/project/node_modules/tool/parser.ts:1:2)",
      "    at decode (/project/src/decoder.ts:4:8)",
      "    at run (/project/src/runner.ts:9:3)",
    ].join("\n"), { files: ["src/decoder.ts", "src/runner.ts", "tool/parser.ts"], search: async () => [] });
    expect(out.starts.map((s) => s.path)).toEqual(["src/decoder.ts"]);
  });

  it("tries an outer frame when the innermost frame is untracked", async () => {
    const out = await pickStartingPoints([
      "Traceback (most recent call last):",
      '  File "/project/src/outer.py", line 1, in run',
      '  File "/project/missing.py", line 2, in decode',
    ].join("\n"), { files: ["src/outer.py"], search: async () => [] });
    expect(out.starts.map((s) => s.path)).toEqual(["src/outer.py"]);
  });

  it("starts from a project's own env/ directory, and still skips a virtualenv named env", async () => {
    const out = await pickStartingPoints([
      "Traceback (most recent call last):",
      '  File "/home/u/proj/src/app/models.py", line 1, in load',
      '  File "/home/u/proj/src/app/env/settings.py", line 2, in get',
      '  File "/home/u/proj/env/lib/python3.12/os.py", line 3, in __getitem__',
      "KeyError: 'APP_KEY'",
    ].join("\n"), {
      files: ["src/app/__init__.py", "src/app/models.py", "src/app/env/__init__.py", "src/app/env/settings.py", "os.py"],
      search: async () => [],
    });
    expect(out.starts.map((s) => s.path)).toEqual(["src/app/env/settings.py"]);
    expect(out.unresolved).toContain("/home/u/proj/env/lib/python3.12/os.py");
  });

  it("takes a graph hit or neighbour in a file the listing does not have, judged by its path", async () => {
    const repo = memoryRepo({ "src/app/model.py": "def save_model(): pass", "src/app/listed_pb2.py": "x = 1" });
    const plan = await planIssue("`save_model` calls `newHelperFn` and `decode_msg`", {
      repo,
      search: async (name) => ({
        save_model: [hit(name, "function", "src/app/model.py")],
        newHelperFn: [hit(name, "function", "src/app/new_helper.py")],
        decode_msg: [hit(name, "function", "src/app/unlisted_pb2.py")],
      })[name] ?? [],
    });
    expect(plan.starts.map((s) => s.path)).toEqual(["src/app/model.py", "src/app/new_helper.py"]);
    expect(plan.unresolved).toEqual(["decode_msg"]);
    expect(plan.sourcePaths!.has("src/app/listed_pb2.py")).toBe(false);
    expect(plan.sourcePaths!.has("docs/unlisted.py")).toBe(false);
    const near = new Map([["src/app/other_new.py", { weight: 1, reason: "calls save_model" }]]);
    expect(rankIssueFiles({ ...plan, near }).map((f) => f.path)).toContain("src/app/other_new.py");
  });

  it.each([
    ["setup.py", 'from setuptools import setup\nsetup(packages=["docs.plugin"])'],
    ["setup.cfg", "[options]\npackages = docs.plugin"],
    ["pyproject.toml", '[tool.setuptools]\npackages = ["docs.plugin"]'],
  ])("recognizes a namespace package declared in %s", async (config, text) => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({ [config]: text, "docs/plugin/decoder.py": "decode_payload", "docs/tutorial.py": "decode_payload" }),
    });
    expect(plan.bm25.map((h) => h.path)).toEqual(["docs/plugin/decoder.py"]);
  });

  it("excludes multiline generated headers but keeps handwritten code mentioning generation", async () => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({
        "src/block.ts": "/**\nThis file is generated.\n*/\nconst decode_payload = 1;",
        "src/module.py": '"""\nDO NOT EDIT\n"""\ndef decode_payload(): pass',
        "src/manual.py": 'def decode_payload():\n    return "generated"',
      }),
    });
    expect(plan.bm25.filter((h) => plan.sourcePaths!.has(h.path)).map((h) => h.path)).toEqual(["src/manual.py"]);
    expect(rankIssueFiles({ ...plan, near: new Map() }).map((f) => f.path)).toEqual(["src/manual.py"]);
  });

  it("retains importable docs, examples and site packages but excludes generated files everywhere", async () => {
    const repo = memoryRepo({
      "docs/__init__.py": "",
      "docs/parser.py": "decode_payload escaped values",
      "examples/plugin/__init__.py": "",
      "examples/plugin/decoder.py": "decode_payload escaped values",
      "site/runtime/decoder.py": "decode_payload escaped values",
      "pyproject.toml": '[tool.setuptools.packages.find]\ninclude = ["site.runtime*"]',
      "docs/tutorial.py": "# DO NOT EDIT\ndecode_payload escaped values",
      "src/migrations/0001_initial.py": "# Generated by a migration tool\ndecode_payload escaped values",
      "src/migrations/manual.py": "# Handwritten data migration\ndecode_payload escaped values",
      "src/messages_pb2.py": "decode_payload escaped values",
      "src/messages_pb2_grpc.py": "decode_payload escaped values",
      "src/generated.ts": "// AUTO-GENERATED. DO NOT EDIT\nconst decode_payload = 1;",
      "src/__init__.py": "",
      "src/docs/tutorial.py": "decode_payload escaped values",
      "examples/demo.py": "decode_payload escaped values",
    });
    const plan = await planIssue("decode_payload escaped values migrations/0001_initial.py", {
      repo, search: async () => [hit("decode_payload", "function", "src/generated.ts")],
    });
    const expected = ["docs/parser.py", "examples/plugin/decoder.py", "site/runtime/decoder.py", "src/migrations/manual.py"];
    expect(plan.bm25.filter((h) => plan.sourcePaths!.has(h.path)).map((h) => h.path).sort()).toEqual(expected.sort());
    const near = new Map(repo.files().map((path) => [path, { weight: 1, reason: "one hop" }]));
    const ranked = rankIssueFiles({ ...plan, near }).map((f) => f.path);
    for (const path of expected) expect(ranked).toContain(path);
    for (const path of ["src/migrations/0001_initial.py", "src/messages_pb2.py", "src/messages_pb2_grpc.py", "src/generated.ts", "docs/tutorial.py", "examples/demo.py", "src/docs/tutorial.py"]) {
      expect(ranked).not.toContain(path);
      expect(plan.starts.map((s) => s.path)).not.toContain(path);
    }
  });

  it("keeps a call the issue writes in its own words as a confident start", async () => {
    const text = "Calling `saveModel()` raises a KeyError.";
    // Not snippet-only: after the prose mention, but evidence all the same.
    expect(extractCandidates(text)).toEqual({ paths: [], identifiers: ["KeyError", "saveModel"] });
    const plan = await planIssue(text, {
      // KeyError is a builtin: nothing in the repository defines it.
      search: async (name) => name === "saveModel" ? [hit(name, "function", "src/saving.py")] : [],
      repo: memoryRepo({ "src/saving.py": "def saveModel(): raise KeyError" }),
    });
    expect(plan.starts[0]).toMatchObject({ token: "saveModel", path: "src/saving.py" });
    expect(plan.starts[0].snippet).toBeUndefined();
    expect(issueConfidence(plan).confident).toBe(true);
    expect(leanIssueView(plan).startingPoints.map((s) => s.token)).toEqual(["saveModel"]);
    // A line that is only a call is a reproduction step, not a snippet-only hint.
    const bare = extractCandidates("Steps:\nmodel.save_weights(path)\nraises a KeyError");
    expect(bare.identifiers).toEqual(["KeyError", "save_weights"]);
    expect(bare.snippetIdentifiers).toBeUndefined();
  });

  it.each([
    ["setup.py", 'setup(packages=find_packages(include=["docs.plugin*"], exclude=["docs", "examples", "tests"]))'],
    ["setup.py", 'setup(packages=find_packages(exclude=("docs", "examples")), package_data={"docs.plugin": ["*.txt"]})'],
    ["pyproject.toml", '[tool.setuptools.packages.find]\nwhere = ["."]\nexclude = [\n  "docs*",\n  "examples*",\n]'],
    ["setup.cfg", "[options]\npackages = find:\n\n[options.packages.find]\nexclude =\n    docs\n    examples\n    tests"],
  ])("does not treat docs or examples an exclude list names in %s as packages", async (config, text) => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({
        [config]: text, "docs/conf.py": "decode_payload", "examples/demo.py": "decode_payload",
        "src/decoder.py": "decode_payload",
      }),
    });
    expect(plan.sourcePaths!.has("docs/conf.py")).toBe(false);
    expect(plan.sourcePaths!.has("examples/demo.py")).toBe(false);
    expect(plan.bm25.map((h) => h.path)).not.toContain("docs/conf.py");
    expect(plan.sourcePaths!.has("src/decoder.py")).toBe(true);
  });

  it("still reads an include next to an exclude", async () => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({
        "setup.py": 'setup(packages=find_packages(include=["docs.plugin"], exclude=["docs"]))',
        "docs/plugin/decoder.py": "decode_payload", "docs/conf.py": "decode_payload",
      }),
    });
    expect(plan.bm25.map((h) => h.path)).toEqual(["docs/plugin/decoder.py"]);
  });

  it.each([
    "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage pb",
    "# Generated by Django 4.2 on 2024-01-01 10:00\nfrom django.db import migrations",
    "/**\n * @generated SignedSource<<abc>>\n */\nexport const a = 1;",
    "// AUTO-GENERATED FILE\nexport const a = 1;",
    '"""This file was automatically generated."""\nimport os',
    "# DO NOT EDIT THIS FILE - it is machine generated\nimport os",
    "/* DO NOT EDIT */\nexport const a = 1;",
    "// DO NOT EDIT: regenerate with `make proto`.\nexport const a = 1;",
  ])("drops a generated header: %s", (header) => {
    expect(isSourcePath("src/a.ts", { importable: true, header })).toBe(false);
  });

  it.each([
    "// Validates generated request IDs before they reach the store.\nexport const a = 1;",
    '"""Parse the generated protobuf descriptors."""\nimport os',
    "/**\n * Classify a candidate: a definition, an import, or generated output.\n */\nexport const a = 1;",
    "/** docs/api/README.md claims the reference is generated from the client source. */\nexport const a = 1;",
    "// Do not edit the order of these entries without updating the parser.\nexport const a = 1;",
    "// Do not modify: callers depend on order.\nexport const a = 1;",
    "# Do not edit (see CONTRIBUTING); the order matters.\nimport os",
  ])("keeps a handwritten module whose doc mentions generation: %s", (header) => {
    expect(isSourcePath("src/a.ts", { importable: true, header })).toBe(true);
  });

  it.each([
    '"""Wrapper around the auto-generated OpenAPI client.\n\nHandwritten."""\nimport os',
    "// Thin layer over the machine-generated bindings; edit freely.\nexport const a = 1;",
  ])("keeps a handwritten module that wraps generated code: %s", (header) => {
    expect(isSourcePath("src/a.py", { importable: true, header })).toBe(true);
  });

  it.each([
    "# This file is autogenerated by pip-compile\nimport os",
    "/* auto-generated by NAPI-RS */\nexport const a = 1;",
  ])("still drops a header that says the file is auto-generated: %s", (header) => {
    expect(isSourcePath("src/a.ts", { importable: true, header })).toBe(false);
  });

  it("starts from a named file whose header is a handwritten do-not-modify warning", async () => {
    const plan = await planIssue("see src/listing.ts", {
      search: async () => [],
      repo: memoryRepo({
        "src/listing.ts": "// Do not modify: callers depend on order.\nexport const order = [];",
        "src/app/__init__.py": "see listing",
      }),
    });
    expect(plan.starts.map((s) => s.path)).toEqual(["src/listing.ts"]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.fallback).toBe(false);
  });

  it("starts from a handwritten client.py whose docstring mentions auto-generated code", async () => {
    const plan = await planIssue("parse_header breaks in client.py", {
      search: async (name) => name === "parse_header" ? [hit(name, "function", "src/x/client.py")] : [],
      repo: memoryRepo({
        "src/x/client.py": '"""Wrapper around the auto-generated OpenAPI client.\n\nHandwritten.\n"""\ndef parse_header(): pass',
        "src/x/other.py": "def other(): pass",
        "docs/conf.py": "project = 'x'",
      }),
    });
    expect(plan.starts.map((s) => s.path)).toContain("src/x/client.py");
    expect(plan.unresolved).toEqual([]);
    expect(plan.sourcePaths!.has("src/x/client.py")).toBe(true);
  });

  it.each([
    ["pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = ["docs"]'],
    ["pyproject.toml", '[tool.coverage.run]\nsource = ["docs"]\n[tool.hatch.build.targets.sdist]\ninclude = ["docs"]'],
    ["setup.py", 'setup(name="x", data_files=[("share", ["docs"])], command_options={"build_sphinx": {"source_dir": ("setup.py", "docs")}})'],
    ["setup.cfg", "[tool:pytest]\ntestpaths =\n    docs"],
  ])("does not treat a non-packaging docs setting in %s as a package", async (config, text) => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({ [config]: text, "docs/conf.py": "decode_payload", "src/decoder.py": "decode_payload" }),
    });
    expect(plan.sourcePaths!.has("docs/conf.py")).toBe(false);
    expect(plan.bm25.map((h) => h.path)).toEqual(["src/decoder.py"]);
  });

  it.each([
    ["pyproject.toml", '[tool.poetry]\npackages = [{ include = "docs" }]'],
    ["pyproject.toml", '[tool.hatch.build.targets.wheel]\npackages = ["docs"]'],
    ["setup.py", 'setup(name="x", packages=find_packages(where="docs"), include_package_data=True)'],
  ])("reads the packaging keys of %s", async (config, text) => {
    const plan = await planIssue("decode_payload", {
      search: async () => [],
      repo: memoryRepo({ [config]: text, "docs/conf.py": "decode_payload" }),
    });
    expect(plan.sourcePaths!.has("docs/conf.py")).toBe(true);
  });

  it("reads a fenced Python traceback's exception line as evidence, not a snippet", () => {
    const out = extractCandidates([
      "Saving fails:", "```", "Traceback (most recent call last):",
      '  File "/app/pkg/store.py", line 3, in save', "    dump(obj)",
      "pkg.errors.SerializationError: cannot save", "```",
    ].join("\n"));
    expect(out.identifiers[0]).toBe("SerializationError");
    expect(out.snippetIdentifiers ?? []).not.toContain("SerializationError");
    expect(out.tracebacks).toEqual([["/app/pkg/store.py"]]);
  });

  it("does not take a sentence that starts with `function` or `class` for a code line", () => {
    for (const text of ["function names with digits break `parseHeader` here", "class names with digits break `parseHeader` here"]) {
      const out = extractCandidates(text);
      expect(out.identifiers).toContain("parseHeader");
      expect(out.snippetIdentifiers ?? []).not.toContain("parseHeader");
    }
    for (const line of ["def parse_header(raw):", "class HeaderParser(Base):", "function parseHeader(raw) {", "class HeaderParser extends Base {"]) {
      expect(extractCandidates(`${line}\nboom`).snippetIdentifiers).toBeDefined();
    }
  });

  it("reads Node ESM file:// frames as a traceback", () => {
    const out = extractCandidates([
      "Error: boom",
      "    at Object.<anonymous> (file:///app/src/inner.mjs:10:5)",
      "    at run (file:///app/src/outer.mjs:3:1)",
      "    at main (file:///C:/app/src/win.mjs:1:1)",
    ].join("\n"));
    expect(out.tracebacks).toEqual([["/app/src/inner.mjs", "/app/src/outer.mjs", "C:/app/src/win.mjs"]]);
    expect(out.paths).toEqual([]);
    expect(out.snippetIdentifiers ?? []).not.toContain("anonymous");
  });

  it("opens only the files it surfaces, not every source file, when BM25 has an index", async () => {
    const files: Record<string, string> = { "src/generated_top.py": "# Generated by a tool\ndecode_payload" };
    for (let i = 0; i < 60; i++) files[`src/f${String(i).padStart(2, "0")}.py`] = "decode_payload value";
    const reads = new Set<string>();
    const repo = { ...memoryRepo(files), read: (path: string) => { reads.add(path); return files[path]; } };
    // A ranker that answers from its index, as cachedBm25Ranker does on a warm HEAD.
    const rank = (_repo: RepoAccess, paths: string[]) =>
      paths.map((path, i) => ({ path, score: path === "src/generated_top.py" ? 100 : 60 - i })).sort((a, b) => b.score - a.score);
    const plan = await planIssue("nothing named here", { repo, search: async () => [], rank });
    // The fallback skips the generated top hit after reading only its header and the next one.
    expect(plan.starts[0]).toMatchObject({ via: "bm25 fallback", path: "src/f00.py" });
    expect([...reads].sort()).toEqual(["src/f00.py", "src/generated_top.py"]);
    const ranked = rankIssueFiles({ ...plan, near: new Map() }, 5);
    expect(ranked.map((f) => f.path)).toEqual(["src/f00.py", "src/f01.py", "src/f02.py", "src/f03.py", "src/f04.py"]);
    expect(reads.size).toBe(6);
    const { centre } = await chooseCentre([], plan.bm25, async (path) => path, 10, plan.sourcePaths);
    expect(centre?.path).toBe("src/f00.py");
  });
});
