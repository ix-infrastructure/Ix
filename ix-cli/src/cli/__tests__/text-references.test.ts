// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectTextReferences,
  gitRepoAccess,
  resolveToken,
  type RepoAccess,
} from "../explain/text-references.js";

/**
 * Links between files that exist only in text: a build path in a string, a
 * file named in a comment, a test that reads a file by path. Each case below
 * is one the ix-bench bundles could not reach through the graph.
 */

function memoryRepo(files: Record<string, string>): RepoAccess {
  return {
    files: () => Object.keys(files),
    read: (path) => files[path],
    grep: (needle) =>
      Object.entries(files).flatMap(([path, text]) =>
        text.split("\n").filter((line) => line.includes(needle)).map((line) => ({ path, line }))),
  };
}

const index = (files: string[]) => {
  const byBasename = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split("/").pop()!;
    byBasename.set(base, [...(byBasename.get(base) ?? []), f]);
  }
  return { tracked: new Set(files), byBasename };
};

describe("resolveToken", () => {
  const files = [
    "core-ingestion/src/languages.ts",
    "core-ingestion/src/index.ts",
    "ix-cli/src/cli/supported-extensions.ts",
    "ix-cli/src/cli/commands/ingestion-loader.ts",
    "ix-cli/src/cli/index.ts",
  ];
  const { tracked, byBasename } = index(files);

  it("maps a build path back to its source", () => {
    expect(resolveToken("../../../../core-ingestion/dist/languages.js",
      "ix-cli/src/cli/commands/ingestion-loader.ts", tracked, byBasename))
      .toBe("core-ingestion/src/languages.ts");
  });

  it("resolves a relative path from the file it appears in", () => {
    expect(resolveToken("../../../ix-cli/src/cli/supported-extensions.ts",
      "core-ingestion/src/__tests__/extension-parity.test.ts", tracked, byBasename))
      .toBe("ix-cli/src/cli/supported-extensions.ts");
  });

  it("resolves a unique basename, and refuses an ambiguous one", () => {
    expect(resolveToken("languages.ts", "x/y.ts", tracked, byBasename)).toBe("core-ingestion/src/languages.ts");
    expect(resolveToken("index.ts", "x/y.ts", tracked, byBasename)).toBeUndefined();
  });

  it("resolves a unique path suffix", () => {
    expect(resolveToken("cli/supported-extensions.ts", "x/y.ts", tracked, byBasename))
      .toBe("ix-cli/src/cli/supported-extensions.ts");
  });

  it("does not resolve a path that climbs out of the repository", () => {
    expect(resolveToken("../../../../languages.ts", "a/b.ts", tracked, byBasename)).toBeUndefined();
  });
});

describe("collectTextReferences", () => {
  it("finds a file named in a comment of an imported file", () => {
    const repo = memoryRepo({
      "ix-cli/src/cli/commands/watch.ts": `import { SUPPORTED_EXTENSIONS } from "../supported-extensions.js";\n`,
      "ix-cli/src/cli/supported-extensions.ts":
        "// This MUST stay in sync with core-ingestion's EXT_MAP (languages.ts).\nexport const SUPPORTED_EXTENSIONS = new Set();\n",
      "core-ingestion/src/languages.ts": "export const EXT_MAP = {};\n",
    });
    const refs = collectTextReferences(repo, [
      { path: "ix-cli/src/cli/commands/watch.ts", role: "target" },
      { path: "ix-cli/src/cli/supported-extensions.ts", role: "import" },
    ], new Set());
    expect(refs).toEqual([
      { path: "core-ingestion/src/languages.ts", score: 0.6, reason: "named in supported-extensions.ts" },
    ]);
  });

  it("finds a test that reads a file by path, but not the files that import it", () => {
    const repo = memoryRepo({
      "ix-cli/src/cli/supported-extensions.ts": "export const SUPPORTED_EXTENSIONS = new Set();\n",
      "core-ingestion/src/__tests__/extension-parity.test.ts":
        "const walked = read('../../../ix-cli/src/cli/supported-extensions.ts');\n",
      "ix-cli/src/cli/commands/watch.ts": `import { SUPPORTED_EXTENSIONS } from "../supported-extensions.js";\n`,
    });
    const refs = collectTextReferences(repo, [
      { path: "ix-cli/src/cli/supported-extensions.ts", role: "target" },
    ], new Set());
    expect(refs.map((r) => r.path)).toEqual(["core-ingestion/src/__tests__/extension-parity.test.ts"]);
    expect(refs[0].reason).toBe("names supported-extensions.ts in its text");
  });

  it("reads a dynamic import's argument, which the graph often cannot resolve", () => {
    const repo = memoryRepo({
      "a/loader.ts": `const m = await import("../b/dist/parser.js");\n`,
      "b/src/parser.ts": "export {};\n",
    });
    expect(collectTextReferences(repo, [{ path: "a/loader.ts", role: "target" }], new Set())
      .map((r) => r.path)).toEqual(["b/src/parser.ts"]);
  });

  it("ignores a name everyone mentions, prose, and files the bundle already has", () => {
    const files: Record<string, string> = {
      "src/target.ts": "// see helper.ts and known.ts\n",
      "src/helper.ts": "export {};\n",
      "src/known.ts": "export {};\n",
      "README.md": "target.ts is the entry point\n",
    };
    for (let i = 0; i < 8; i++) files[`src/user${i}.ts`] = "// calls into target.ts\n";
    const refs = collectTextReferences(memoryRepo(files),
      [{ path: "src/target.ts", role: "target" }], new Set(["src/known.ts"]));
    expect(refs.map((r) => r.path)).toEqual(["src/helper.ts"]);
  });
});

describe("gitRepoAccess", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("lists, reads and greps a real checkout, and declines a directory that is not one", () => {
    dir = mkdtempSync(join(tmpdir(), "ix-text-refs-"));
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(dir!, path)), { recursive: true });
      writeFileSync(join(dir!, path), text);
    };
    expect(gitRepoAccess(dir)).toBeUndefined();

    execFileSync("git", ["init", "-q"], { cwd: dir });
    write("src/a.ts", "// see b.ts\n");
    write("src/b.ts", "export {};\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const repo = gitRepoAccess(dir)!;
    expect(repo.files().sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(repo.read("src/a.ts")).toContain("b.ts");
    expect(repo.read("src/missing.ts")).toBeUndefined();
    write("src/big.ts", "x".repeat(300 * 1024));
    expect(repo.read("src/big.ts")).toBeUndefined();
    expect(repo.grep("b.ts")).toEqual([{ path: "src/a.ts", line: "// see b.ts" }]);
    expect(repo.grep("nothing-matches")).toEqual([]);
  });
});
