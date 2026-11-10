// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncLanguageDocs } from "../scripts/sync-language-docs.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const docs = ["README.md", "docs-site/src/content/docs/reference/languages.md", "CLAUDE.md"];
const enumPath = "core-ingestion/src/languages.ts";
const temporaryRoots = [];

function fixture() {
  // Keep all test writes inside this worktree, including on developer machines.
  const root = mkdtempSync(resolve(repoRoot, ".language-docs-test-"));
  temporaryRoots.push(root);
  for (const path of [...docs, enumPath]) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), readFileSync(resolve(repoRoot, path)));
  }
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("language documentation parity", () => {
  it("keeps every committed inventory in sync with the source enum", () => {
    expect(syncLanguageDocs()).toEqual([]);
  });

  it.each([
    ["addition", (source) => source.replace("\n}", "\n  Example = 'example',\n}")],
    ["removal", (source) => source.replace("  Proto = 'proto',\n", "")],
  ])("rejects an enum %s until all inventories are regenerated", (_, change) => {
    const root = fixture();
    writeFileSync(resolve(root, enumPath), change(readFileSync(resolve(root, enumPath), "utf8")));
    expect(syncLanguageDocs(root)).toEqual(docs);
    expect(syncLanguageDocs(root, true)).toEqual(docs);
    expect(syncLanguageDocs(root)).toEqual([]);
  });

  it.each(docs)("rejects stale documentation in %s", (path) => {
    const root = fixture();
    const fullPath = resolve(root, path);
    const source = readFileSync(fullPath, "utf8");
    writeFileSync(fullPath, path === "CLAUDE.md"
      ? source.replace(/\d+ languages and formats/, "0 languages and formats")
      : source.replace("| JavaScript |", "| MissingLanguage |"));
    expect(syncLanguageDocs(root)).toEqual([path]);
  });

  it("fails closed when a generated block is removed", () => {
    const root = fixture();
    writeFileSync(resolve(root, "README.md"), "# No language inventory\n");
    expect(() => syncLanguageDocs(root)).toThrow("expected one ordered");
  });

  it("preserves surrounding prose and CRLF and is idempotent", () => {
    const root = fixture();
    const path = resolve(root, "README.md");
    const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    writeFileSync(path, `Intro\n${source}\nOutro\n`.replace(/\n/g, "\r\n"));
    expect(syncLanguageDocs(root, true)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(`Intro\n${source}\nOutro\n`.replace(/\n/g, "\r\n"));
  });
});
