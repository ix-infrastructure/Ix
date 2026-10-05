// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { collectTextReferences, gitRepoAccess, type RepoAccess } from "../explain/text-references.js";

let dir: string;

function write(path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ix-text-refs-batch-"));
  write("src/languages.ts", "export const languages = [];\n");
  write("src/parser.ts", "export function parse() {}\n");
  write("src/registry.ts", "// loads languages.ts at runtime\nconst table = load('languages.ts');\n");
  write("scripts/build.ts", "run('src/parser.ts'); run('languages.ts');\n");
  write("docs/notes.md", "parser.ts and languages.ts are documented here\n");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "."], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("collectTextReferences with one batched git grep", () => {
  it("finds the same references as one grep per name", () => {
    const batched = gitRepoAccess(dir)!;
    expect(batched.grepAll).toBeTypeOf("function");
    let greps = 0;
    const perName: RepoAccess = {
      files: () => batched.files(),
      read: (p) => batched.read(p),
      grep: (needle) => { greps++; return batched.grep(needle); },
    };
    const sources = [
      { path: "src/languages.ts", role: "target" as const },
      { path: "src/parser.ts", role: "import" as const },
    ];

    const one = collectTextReferences(batched, sources, new Set(), 10);
    const many = collectTextReferences(perName, sources, new Set(), 10);

    expect(one).toEqual(many);
    expect(one.map((r) => r.path)).toEqual(expect.arrayContaining(["src/registry.ts", "scripts/build.ts"]));
    expect(greps).toBe(2);
  });
});
