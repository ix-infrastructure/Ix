// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { createIgnoreMatcher, parseIgnoreFile, parseIgnorePattern } from "../ignore-globs.js";

function matcher(...lines: string[]) {
  return createIgnoreMatcher(parseIgnoreFile(lines.join("\n")));
}

describe("parsing", () => {
  it("drops comments, blank lines and whitespace", () => {
    expect(parseIgnoreFile("# a comment\n\n  fixtures/  \n").map((p) => p.source)).toEqual(["fixtures/"]);
  });

  it("drops a negation rather than pretending to honour it", () => {
    expect(parseIgnorePattern("!keep.ts")).toBeNull();
  });

  it("drops a line too long to be a glob", () => {
    expect(parseIgnorePattern("a".repeat(2000))).toBeNull();
  });

  it("records anchoring and directory-only", () => {
    expect(parseIgnorePattern("/docs/")).toMatchObject({ anchored: true, directoryOnly: true, segments: ["docs"] });
    expect(parseIgnorePattern("docs")).toMatchObject({ anchored: false, directoryOnly: false });
  });
});

describe("matching", () => {
  it("matches a bare name at any depth, as .gitignore does", () => {
    const m = matcher("fixtures/");
    expect(m.matches("tests/fixtures", true)).toBe(true);
    expect(m.matches("tests/fixtures/big.json")).toBe(true);
    expect(m.matches("src/fixtures/a.ts")).toBe(true);
    expect(m.matches("src/fixture-helpers.ts")).toBe(false);
  });

  it("anchors on a leading slash", () => {
    const m = matcher("/docs/");
    expect(m.matches("docs/a.md")).toBe(true);
    expect(m.matches("packages/docs/a.md")).toBe(false);
  });

  it("stops a * at a separator and lets ** cross one", () => {
    expect(matcher("src/*.test.ts").matches("src/a.test.ts")).toBe(true);
    expect(matcher("src/*.test.ts").matches("src/deep/a.test.ts")).toBe(false);
    expect(matcher("src/**/*.test.ts").matches("src/deep/nested/a.test.ts")).toBe(true);
  });

  it("matches ? against exactly one character", () => {
    expect(matcher("a?.ts").matches("ab.ts")).toBe(true);
    expect(matcher("a?.ts").matches("abc.ts")).toBe(false);
    expect(matcher("a?.ts").matches("a/b.ts")).toBe(false);
  });

  it("excludes what is under a directory pattern, not just the entry", () => {
    const m = matcher("django/tests/");
    expect(m.matches("django/tests", true)).toBe(true);
    expect(m.matches("django/tests/models/test_a.py")).toBe(true);
    expect(m.matches("django/db/models.py")).toBe(false);
  });

  it("treats a file pattern as a directory pattern when it matches a parent", () => {
    // `--exclude playground` should take the tree, not nothing.
    expect(matcher("playground").matches("packages/playground/src/main.ts")).toBe(true);
  });

  it("is a no-op with no patterns", () => {
    const m = matcher("", "# nothing");
    expect(m.size).toBe(0);
    expect(m.matches("anything/at/all.ts")).toBe(false);
  });

  it("reads a Windows-style path the same way", () => {
    expect(matcher("fixtures/").matches("tests\\fixtures\\a.json")).toBe(true);
  });
});

describe("no catastrophic backtracking", () => {
  it("answers a pathological pattern in linear time", () => {
    // `.ixignore` comes from the repository being ingested, which is untrusted
    // input. Compiled to a regex, this shape is the classic exponential blowup;
    // matched with two pointers it is not.
    const m = matcher("**a**a**a**a**a**a**a**a**b");
    const started = Date.now();
    expect(m.matches("a/".repeat(40) + "c.ts")).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("is equally unbothered inside one segment", () => {
    const m = matcher("*a*a*a*a*a*a*a*a*a*a*b.ts");
    const started = Date.now();
    expect(m.matches("a".repeat(2000) + "c.ts")).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
