// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectProblems,
  documentedFormats,
  languageLists,
  readFiles,
  regenerate,
} from "./check-language-docs.mjs";

const repo = readFiles();

/** A copy of the repo's files with one of them edited. */
const withEdit = (key, edit) => {
  const edited = edit(repo[key]);
  expect(edited).not.toBe(repo[key]); // the edit must have hit something
  return { ...repo, [key]: edited };
};

describe("language docs parity (#969)", () => {
  // This is the gate: it runs in `npm run test:unit`, so a change to
  // SupportedLanguages or HAND_PARSERS without a docs update fails CI.
  it("the README, CLAUDE.md and docs pages match SupportedLanguages", () => {
    expect(collectProblems(repo)).toEqual([]);
  });

  it("splits the enum into grammar languages and hand-parsed formats", () => {
    const { code, formats, unlabelled } = languageLists(repo.languagesTs, repo.indexTs);
    expect(unlabelled).toEqual([]);
    expect(code).toEqual(expect.arrayContaining(["TypeScript", "C++", "HCL / Terraform"]));
    expect(formats).toEqual(
      expect.arrayContaining(["YAML", "JSON", "SQL", "Markdown", "LaTeX", "Protocol Buffers"]),
    );
    expect(code.filter((l) => formats.includes(l))).toEqual([]);
  });

  it("the docs page has one format row per hand-parsed format", () => {
    const { formats } = languageLists(repo.languagesTs, repo.indexTs);
    expect([...documentedFormats(repo.languagesDoc)].sort()).toEqual([...formats].sort());
  });

  it("fails when a language is dropped from the enum but still documented", () => {
    const files = withEdit("languagesTs", (t) => t.replace(/^\s*Zig = 'zig',\n/m, ""));
    const problems = collectProblems(files);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/README\.md: the languages:code block differs/),
        expect.stringMatching(/languages\.md: the languages:code block differs/),
        expect.stringMatching(/CLAUDE\.md: says "27 languages", the parser has 26/),
        expect.stringMatching(/how-it-works\.md: says "27 languages"/),
      ]),
    );
  });

  it("fails when the documented list is edited by hand", () => {
    const files = withEdit("readme", (t) => t.replace("`Zig` ", ""));
    expect(collectProblems(files)).toEqual([
      expect.stringMatching(/README\.md: the languages:code block differs/),
    ]);
  });

  it("names an enum member that has no display label", () => {
    const files = withEdit("languagesTs", (t) =>
      t.replace("  Proto = 'proto',\n", "  Proto = 'proto',\n  Dart = 'dart',\n"),
    );
    expect(collectProblems(files)).toContain(
      "SupportedLanguages.Dart ('dart') has no display label: " +
        "add it to LABELS in ix-cli/scripts/check-language-docs.mjs",
    );
  });

  it("fails when a hand-parsed format has no row in the format table", () => {
    const files = withEdit("languagesDoc", (t) => t.replace(/^\| \*\*SQL\*\* \|.*\n/m, ""));
    expect(collectProblems(files)).toEqual([
      "docs-site/src/content/docs/reference/languages.md: format table has no row for **SQL**",
    ]);
  });

  it("fails on a format row the parser does not have", () => {
    const files = withEdit("languagesDoc", (t) =>
      t.replace("| **YAML** |", "| **INI** | Sections. |\n| **YAML** |"),
    );
    expect(collectProblems(files)).toEqual([
      "docs-site/src/content/docs/reference/languages.md: format table row **INI** is not a hand-parsed format",
    ]);
  });

  it("reports a generated block whose markers were removed", () => {
    const files = withEdit("readme", (t) => t.replace(/<!-- languages:formats:end -->/, ""));
    expect(collectProblems(files)).toEqual([
      "README.md: missing <!-- languages:formats:start --> / <!-- languages:formats:end --> block",
    ]);
  });

  it("--write brings every copy back in line", () => {
    const files = withEdit("languagesTs", (t) => t.replace(/^\s*Zig = 'zig',\n/m, ""));
    const fixed = regenerate(files);
    expect(collectProblems(fixed)).toEqual([]);
    expect(fixed.readme).toContain("**26 languages**");
    expect(fixed.readme).not.toContain("`Zig`");
    expect(fixed.languagesDoc).not.toMatch(/\| Zig \|/);
    expect(fixed.claude).toContain("(26 languages;");
    // Regenerating an up-to-date tree changes nothing.
    expect(regenerate(repo)).toEqual(repo);
  });

  it("exits 0 on this repository from the command line", () => {
    const script = fileURLToPath(new URL("./check-language-docs.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(run.stdout).toMatch(/docs match SupportedLanguages/);
    expect(run.status).toBe(0);
  });
});
