// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { collectExcludePatterns, tryGitLsFiles, walkFiles } from "../commands/ingest.js";
import { createIgnoreMatcher } from "../ignore-globs.js";

/**
 * A fixture-heavy repository shape: real source, a test tree, and a playground.
 * `IGNORE_DIRS` covers `tests/` on the filesystem walk and nowhere else —
 * `git ls-files`, the discovery path in any git repository, never saw it.
 */
describe("ingest --exclude and .ixignore", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ix-exclude-"));
    for (const dir of ["src", "packages/playground/src", "docs/generated"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "src", "a.test.ts"), "export const t = 1;\n");
    writeFileSync(join(root, "packages/playground/src", "main.ts"), "export const p = 1;\n");
    writeFileSync(join(root, "docs/generated", "api.ts"), "export const d = 1;\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function walked(patterns: string[] = []): string[] {
    const matcher = createIgnoreMatcher(collectExcludePatterns(root, patterns));
    const exclude = matcher.size > 0 ? { matcher, root } : undefined;
    return [...walkFiles(root, true, exclude)]
      .map((p) => relative(root, p).split(sep).join("/"))
      .sort();
  }

  it("walks everything when nothing is excluded", () => {
    expect(walked()).toEqual([
      "docs/generated/api.ts",
      "packages/playground/src/main.ts",
      "src/a.test.ts",
      "src/a.ts",
    ]);
  });

  it("takes patterns from --exclude", () => {
    expect(walked(["playground", "*.test.ts"])).toEqual([
      "docs/generated/api.ts",
      "src/a.ts",
    ]);
  });

  it("takes patterns from .ixignore at the root", () => {
    writeFileSync(join(root, ".ixignore"), "# generated API surface\ndocs/generated/\n*.test.ts\n");
    expect(walked()).toEqual([
      "packages/playground/src/main.ts",
      "src/a.ts",
    ]);
  });

  it("counts what it skipped, so an exclusion is not mistaken for a miss", () => {
    const matcher = createIgnoreMatcher(collectExcludePatterns(root, ["playground"]));
    let skipped = 0;
    void [...walkFiles(root, true, { matcher, root, onSkip: () => { skipped += 1; } })].length;
    // One skip for the excluded directory, not one per file inside it.
    expect(skipped).toBe(1);
  });

  it("applies to git ls-files too, which is the real discovery path", () => {
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    } catch {
      return; // no git on this machine; the walk path above still covers it
    }
    const matcher = createIgnoreMatcher(collectExcludePatterns(root, ["playground", "docs/"]));
    const files = tryGitLsFiles(root, true, { matcher, root })!;
    // Against the canonical root, resolved the same way the code resolves the
    // files: `tryGitLsFiles` returns `realpathSync.native` paths (the
    // symlink-containment guard), so relativising against the raw root yields
    // a `../../..` chain on both platforms where the two disagree — macOS
    // resolves `/var` to `/private/var`, and Windows expands the `RUNNER~1`
    // 8.3 short name that `os.tmpdir()` hands back. `.native` matters: the JS
    // `realpathSync` follows links but leaves a short name alone.
    // `discoverIngestFilePaths` canonicalises the root for exactly this
    // reason; the test has to as well.
    const canonicalRoot = realpathSync.native(root);
    const rel = files.map((p) => relative(canonicalRoot, p).split(sep).join("/")).sort();
    expect(rel).toEqual(["src/a.test.ts", "src/a.ts"]);
  });

  it("has no patterns, and so no cost, when neither source has any", () => {
    expect(collectExcludePatterns(root, [])).toEqual([]);
  });
});
