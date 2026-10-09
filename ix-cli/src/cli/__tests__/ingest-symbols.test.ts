// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestSymbolsPath } from "../config.js";
import {
  changedNames, definedNames, findDependents, importsChanged, loadIngestSymbols, resolutionHash, saveIngestSymbols, type SymbolEntry,
} from "../ingest-symbols.js";

describe("ingest symbol table", () => {
  let home: string;
  const root = "/work/repo";
  const entry = (filePath: string): SymbolEntry => ({ hash: "h1", summary: { filePath, qkeys: [["f", "f"]] } });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ix-symbols-"));
    process.env.IX_HOME = home;
  });
  afterEach(() => {
    delete process.env.IX_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips, and leaves no temp file behind", () => {
    saveIngestSymbols(root, "tree-sitter/1.29", new Map([["a.py", entry("a.py")]]));
    expect(loadIngestSymbols(root, "tree-sitter/1.29").get("a.py")).toEqual(entry("a.py"));
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("is empty for another extractor or another root", () => {
    saveIngestSymbols(root, "tree-sitter/1.29", new Map([["a.py", entry("a.py")]]));
    expect(loadIngestSymbols(root, "tree-sitter/1.30").size).toBe(0);
    writeFileSync(ingestSymbolsPath("/other"), JSON.stringify({ version: 1, root, extractor: "tree-sitter/1.29", files: {} }));
    expect(loadIngestSymbols("/other", "tree-sitter/1.29").size).toBe(0);
  });

  it("is empty when missing or unreadable, and drops malformed entries", () => {
    expect(loadIngestSymbols(root, "x").size).toBe(0);
    writeFileSync(ingestSymbolsPath(root), "{not json");
    expect(loadIngestSymbols(root, "x").size).toBe(0);
    writeFileSync(ingestSymbolsPath(root), JSON.stringify({
      version: 1, root, extractor: "x", files: { "a.py": entry("a.py"), "b.py": { hash: 3 }, "c.py": { hash: "h", summary: {} } },
    }));
    expect([...loadIngestSymbols(root, "x").keys()]).toEqual(["a.py"]);
    expect(existsSync(ingestSymbolsPath(root))).toBe(true);
  });

  it("keeps a resolution hash across a save", () => {
    saveIngestSymbols(root, "x", new Map([["a.py", { ...entry("a.py"), res: "r1" }]]));
    expect(loadIngestSymbols(root, "x").get("a.py")?.res).toBe("r1");
  });
});

describe("dependents (IN-11)", () => {
  const summary = (filePath: string, fields: Record<string, unknown>) => ({ filePath, ...fields });
  const entry = (s: ReturnType<typeof summary>): SymbolEntry => ({ hash: "h", summary: s });

  it("changes no names when the signature is the same, and the symmetric difference otherwise", () => {
    const before = summary("m.ts", { sig: "s1", qkeys: [["add", "add"], ["sub", "sub"]] });
    expect(changedNames(before, summary("m.ts", { sig: "s1", qkeys: [["add", "add"], ["sub", "sub"]] }))).toEqual(new Set());
    const after = summary("m.ts", { sig: "s2", qkeys: [["add", "add"], ["minus", "minus"]], exportPublicNames: [["default", "add"]] });
    expect(changedNames(before, after)).toEqual(new Set(["sub", "minus", "default"]));
    // Added or deleted: every name it defines.
    expect(changedNames(undefined, before)).toEqual(new Set(["add", "sub"]));
    expect(changedNames(before, undefined)).toEqual(new Set(["add", "sub"]));
    expect(definedNames(summary("p.php", { phpTypes: [["App\\Foo", "Foo"]] }))).toEqual(new Set(["App\\Foo", "Foo"]));
  });

  it("finds files that refer to a changed name, by whole name or by segment, or import a path that came or went", () => {
    const table = new Map<string, SymbolEntry>([
      ["main.ts", entry(summary("main.ts", { refs: ["sub"], imports: [{ dstName: "./math", importRaw: "./math" }] }))],
      ["obj.ts", entry(summary("obj.ts", { refs: ["calc.sub"] }))],
      ["mod.py", entry(summary("mod.py", { refs: ["Mod::sub"] }))],
      ["other.ts", entry(summary("other.ts", { refs: ["mul"], imports: [{ dstName: "./util" }] }))],
      ["uses-new.ts", entry(summary("uses-new.ts", { refs: [], imports: [{ dstName: "./added", importRaw: "./added" }] }))],
      ["math.ts", entry(summary("math.ts", { refs: ["sub"] }))],
    ]);
    expect(findDependents(table, new Set(["sub"]), [], new Set(["math.ts"]))).toEqual(["main.ts", "mod.py", "obj.ts"]);
    expect(findDependents(table, new Set(), ["web/added.ts"], new Set())).toEqual(["uses-new.ts"]);
    expect(findDependents(table, new Set(), ["pkg/util/index.ts"], new Set())).toEqual(["other.ts"]);
    expect(findDependents(table, new Set(), [], new Set())).toEqual([]);
  });

  it("counts a name whose binding moved, and an import change, though no name came or went", () => {
    const was = summary("b.ts", { sig: "s1", exportPublicNames: [["foo", "a"]], imports: [{ dstName: "x", importRaw: "./x" }] });
    const now = summary("b.ts", { sig: "s2", exportPublicNames: [["foo", "b"]], imports: [{ dstName: "y", importRaw: "./y" }] });
    expect(changedNames(was, now)).toEqual(new Set(["foo"]));
    expect(importsChanged(was, now)).toBe(true);
    expect(importsChanged(was, { ...was })).toBe(false);
    // An added or deleted file is a changed path already.
    expect(importsChanged(undefined, now)).toBe(false);
  });

  it("matches an import by path segment, not by substring", () => {
    const table = new Map<string, SymbolEntry>([
      ["uses-a.ts", entry(summary("uses-a.ts", { refs: [], imports: [{ importRaw: "./a.js" }] }))],
      ["uses-data.ts", entry(summary("uses-data.ts", { refs: [], imports: [{ importRaw: "./data" }] }))],
      ["uses-pkg-a.py", entry(summary("uses-pkg-a.py", { refs: [], imports: [{ importRaw: "pkg.a" }] }))],
    ]);
    expect(findDependents(table, new Set(), ["web/a.ts"], new Set())).toEqual(["uses-a.ts", "uses-pkg-a.py"]);
  });

  it("hashes a patch's edges and their targets, in any order, and nothing else", () => {
    const a = { type: "UpsertEdge", id: "e1", dst: "n1" };
    const b = { type: "UpsertEdge", id: "e2", dst: "n2" };
    const node = { type: "UpsertNode", id: "n9" };
    expect(resolutionHash([a, b, node])).toBe(resolutionHash([b, a]));
    expect(resolutionHash([a, b])).not.toBe(resolutionHash([a, { ...b, dst: "n3" }]));
  });
});
