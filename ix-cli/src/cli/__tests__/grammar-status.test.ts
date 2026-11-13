// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from "vitest";

import { describeUnavailableGrammars, readGrammarStatus, unavailableGrammarFiles, type GrammarStatus } from "../grammar-status.js";
import { describeGrammarSkips } from "../commands/map.js";
import { assessGrammars, grammarLines } from "../commands/doctor.js";

// #967: a grammar that did not load has to be named, with why, by `ix map`,
// `ix ingest` and `ix doctor`. These cover the pieces each one prints from.

const byExt = (fp: string): string | null =>
  ({ ts: "typescript", tsx: "typescript", kt: "kotlin", kts: "kotlin", sas: "sas", swift: "swift" } as Record<string, string>)[
    fp.split(".").pop() ?? ""
  ] ?? null;

const STATUS: GrammarStatus[] = [
  { language: "kotlin", loaded: false, package: "tree-sitter-kotlin", reason: "Cannot find module 'tree-sitter-kotlin'" },
  { language: "sas", loaded: false, package: "tree-sitter-sas", reason: "No native build was found for platform=win32" },
  { language: "swift", loaded: false, package: "tree-sitter-swift", reason: "boom" },
  { language: "typescript", loaded: true },
];

describe("unavailableGrammarFiles", () => {
  it("counts discovered files per language whose grammar did not load", () => {
    const files = ["a.ts", "b.tsx", "A.kt", "B.kt", "build.kts", "x.sas", "README"];
    expect(unavailableGrammarFiles(files, STATUS, byExt)).toEqual([
      { language: "kotlin", files: 3, package: "tree-sitter-kotlin", reason: "Cannot find module 'tree-sitter-kotlin'" },
      { language: "sas", files: 1, package: "tree-sitter-sas", reason: "No native build was found for platform=win32" },
    ]);
  });

  it("leaves out a missing grammar the repo has no files for", () => {
    expect(unavailableGrammarFiles(["a.ts"], STATUS, byExt)).toEqual([]);
  });

  it("is empty when every grammar loaded", () => {
    expect(unavailableGrammarFiles(["A.kt"], [{ language: "kotlin", loaded: true }], byExt)).toEqual([]);
  });
});

describe("describeUnavailableGrammars", () => {
  it("prints one line per language with the count and the reason", () => {
    expect(describeUnavailableGrammars([
      { language: "kotlin", files: 3, package: "tree-sitter-kotlin", reason: "Cannot find module 'tree-sitter-kotlin'" },
      { language: "sas", files: 1 },
    ])).toEqual([
      "kotlin: 3 files not parsed — grammar tree-sitter-kotlin did not load (Cannot find module 'tree-sitter-kotlin')",
      "sas: 1 file not parsed — grammar did not load",
    ]);
  });
});

describe("readGrammarStatus", () => {
  it("answers nothing for a core-ingestion build without the export", () => {
    expect(readGrammarStatus({})).toEqual([]);
  });
  it("answers nothing rather than failing the run when the export throws", () => {
    expect(readGrammarStatus({ grammarStatus: () => { throw new Error("x"); } })).toEqual([]);
  });
  it("passes the export's answer through", () => {
    expect(readGrammarStatus({ grammarStatus: () => STATUS })).toBe(STATUS);
  });
});

describe("ix map: describeGrammarSkips", () => {
  it("names each skipped language", () => {
    expect(describeGrammarSkips({ grammarUnavailable: [{ language: "swift", files: 2, package: "tree-sitter-swift", reason: "boom" }] }))
      .toEqual(["grammar unavailable: swift: 2 files not parsed — grammar tree-sitter-swift did not load (boom)"]);
  });
  it("says nothing without an ingest or without missing grammars", () => {
    expect(describeGrammarSkips(undefined)).toEqual([]);
    expect(describeGrammarSkips({})).toEqual([]);
    expect(describeGrammarSkips({ grammarUnavailable: [] })).toEqual([]);
  });
});

describe("ix doctor: grammar check", () => {
  it("lists every unavailable grammar with its reason, and never fails or warns", () => {
    const r = assessGrammars(STATUS);
    expect(r).toEqual({
      ok: true,
      detail: "1 of 4 loaded; unavailable: kotlin (Cannot find module 'tree-sitter-kotlin'), " +
        "sas (No native build was found for platform=win32), swift (boom) — files in those languages are not parsed",
    });
  });
  it("says all loaded when they did", () => {
    expect(assessGrammars([{ language: "c", loaded: true }, { language: "go", loaded: true }]))
      .toEqual({ ok: true, detail: "all 2 loaded" });
  });
  it("is not checked when the parser reported nothing", () => {
    expect(assessGrammars([])).toEqual({ ok: true, detail: "not checked: the parser reported no grammars" });
  });
  it("lists loaded grammars, then each missing one with package and reason, for text output", () => {
    expect(grammarLines(STATUS)).toEqual([
      { loaded: true, text: "loaded: typescript" },
      { loaded: false, text: "unavailable: kotlin (tree-sitter-kotlin) — Cannot find module 'tree-sitter-kotlin'" },
      { loaded: false, text: "unavailable: sas (tree-sitter-sas) — No native build was found for platform=win32" },
      { loaded: false, text: "unavailable: swift (tree-sitter-swift) — boom" },
    ]);
  });
});
