// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REPO_ROOT,
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

/**
 * The native-binding facts the release and the docs rely on (#981). The
 * tree-sitter runtime and most grammars ship node-gyp-build prebuilds for every
 * platform below, so `npm ci` compiles nothing for them. The packages in
 * PREBUILD_GAPS are the exceptions: on a platform they have no prebuild for,
 * npm compiles them at install time or, when that fails, drops them (they are
 * optional). A grammar upgrade that changes this list fails here, so the docs
 * and the grammar test helpers get revisited with it.
 */
const PREBUILD_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
const PREBUILD_GAPS = {
  "tree-sitter-kotlin": [],
  "tree-sitter-sas": ["darwin-arm64", "darwin-x64", "linux-x64"],
};

describe("native binding assumptions (#981)", () => {
  const ingestion = join(REPO_ROOT, "core-ingestion");
  const modules = join(ingestion, "node_modules");
  const pkg = JSON.parse(readFileSync(join(ingestion, "package.json"), "utf8"));
  const natives = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]
    .filter((name) => /(^|\/)tree-sitter(-|$)/.test(name));

  it("lists every recorded gap among core-ingestion's dependencies", () => {
    expect(natives).toEqual(expect.arrayContaining(Object.keys(PREBUILD_GAPS)));
  });

  // Needs core-ingestion's node_modules (`npm test` installs it); without
  // them there is nothing to inspect.
  it.skipIf(!existsSync(join(modules, "tree-sitter", "package.json")))(
    "the runtime and every grammar ship prebuilds for all platforms, except the recorded gaps",
    () => {
      const shipped = {};
      for (const name of natives) {
        const dir = join(modules, name);
        // An optional grammar npm dropped (its compile failed) has nothing to check.
        if (!existsSync(join(dir, "package.json"))) {
          expect(pkg.optionalDependencies, `${name} is a required dependency but is not installed`).toHaveProperty([name]);
          continue;
        }
        const prebuilds = join(dir, "prebuilds");
        shipped[name] = existsSync(prebuilds)
          ? readdirSync(prebuilds).filter((d) => PREBUILD_PLATFORMS.includes(d)).sort()
          : [];
      }
      const expected = Object.fromEntries(
        Object.keys(shipped).map((name) => [name, PREBUILD_GAPS[name] ?? PREBUILD_PLATFORMS]),
      );
      expect(shipped).toEqual(expected);
    },
  );

  it("docs/architecture.md describes prebuilds and names each gap", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "architecture.md"), "utf8");
    expect(doc).not.toMatch(/bindings are compiled from source/);
    expect(doc).toMatch(/prebuil/);
    for (const name of Object.keys(PREBUILD_GAPS)) expect(doc).toContain(`\`${name}\``);
  });
});
