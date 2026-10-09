// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearIngestMtimeCache, ingestSymbolsJournalPath, ingestSymbolsPath } from "../config.js";
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
    writeFileSync(ingestSymbolsPath("/other"), JSON.stringify({ version: 2, root, extractor: "tree-sitter/1.29", files: {} }));
    expect(loadIngestSymbols("/other", "tree-sitter/1.29").size).toBe(0);
  });

  it("ignores a version-1 table, which a journal-unaware CLI would have read alone", () => {
    writeFileSync(
      ingestSymbolsPath(root),
      JSON.stringify({ version: 1, root, extractor: "tree-sitter/1.29", files: { "a.py": entry("a.py") } }),
    );
    expect(loadIngestSymbols(root, "tree-sitter/1.29").size).toBe(0);
  });

  it("is empty when missing or unreadable, and drops malformed entries", () => {
    expect(loadIngestSymbols(root, "x").size).toBe(0);
    writeFileSync(ingestSymbolsPath(root), "{not json");
    expect(loadIngestSymbols(root, "x").size).toBe(0);
    writeFileSync(ingestSymbolsPath(root), JSON.stringify({
      version: 2, root, extractor: "x", files: { "a.py": entry("a.py"), "b.py": { hash: 3 }, "c.py": { hash: "h", summary: {} } },
    }));
    expect([...loadIngestSymbols(root, "x").keys()]).toEqual(["a.py"]);
    expect(existsSync(ingestSymbolsPath(root))).toBe(true);
  });

  it("keeps a resolution hash across a save", () => {
    saveIngestSymbols(root, "x", new Map([["a.py", { ...entry("a.py"), res: "r1" }]]));
    expect(loadIngestSymbols(root, "x").get("a.py")?.res).toBe("r1");
  });

  describe("writing only what changed", () => {
    const tablePath = () => ingestSymbolsPath(root);
    const journalPath = () => ingestSymbolsJournalPath(root);
    /** A table of `n` entries on disk, written in full. */
    const seed = (n: number) => {
      const t = new Map<string, SymbolEntry>();
      for (let i = 0; i < n; i++) t.set(`f${i}.py`, entry(`f${i}.py`));
      saveIngestSymbols(root, "x", t);
    };

    it("writes nothing when no entry changed", () => {
      seed(10);
      const before = readFileSync(tablePath(), "utf8");
      saveIngestSymbols(root, "x", loadIngestSymbols(root, "x"), new Set());
      expect(readFileSync(tablePath(), "utf8")).toBe(before);
      expect(existsSync(journalPath())).toBe(false);
      // And nothing at all when there was no table.
      rmSync(tablePath());
      saveIngestSymbols(root, "x", new Map([["a.py", entry("a.py")]]), new Set());
      expect(existsSync(tablePath())).toBe(false);
    });

    it("appends a few changes to the journal, leaves the table, and loads them back", () => {
      seed(10);
      const before = readFileSync(tablePath(), "utf8");
      const t = loadIngestSymbols(root, "x");
      t.set("f3.py", { ...entry("f3.py"), hash: "h2", res: "r" });
      t.delete("f4.py");
      saveIngestSymbols(root, "x", t, new Set(["f3.py", "f4.py"]));
      expect(readFileSync(tablePath(), "utf8")).toBe(before);
      expect(readFileSync(journalPath(), "utf8").trim().split("\n")).toHaveLength(3);

      const again = loadIngestSymbols(root, "x");
      expect(again.size).toBe(9);
      expect(again.get("f3.py")).toEqual({ ...entry("f3.py"), hash: "h2", res: "r" });
      expect(again.has("f4.py")).toBe(false);

      // A second run appends to the same journal.
      again.set("f5.py", { ...entry("f5.py"), mtime: 7 });
      saveIngestSymbols(root, "x", again, new Set(["f5.py"]));
      expect(readFileSync(journalPath(), "utf8").trim().split("\n")).toHaveLength(4);
      expect(loadIngestSymbols(root, "x").get("f5.py")?.mtime).toBe(7);
      expect(readFileSync(tablePath(), "utf8")).toBe(before);
    });

    it("keeps the table readable without the journal: version 1, every field it had", () => {
      seed(3);
      const data = JSON.parse(readFileSync(tablePath(), "utf8")) as Record<string, unknown>;
      expect(data).toMatchObject({ version: 2, root, extractor: "x" });
      expect(Object.keys(data.files as object)).toEqual(["f0.py", "f1.py", "f2.py"]);
    });

    it("rewrites the table in full once the journal would pass half its size", () => {
      seed(4);
      const t = loadIngestSymbols(root, "x");
      for (const k of t.keys()) t.set(k, { ...entry(k), hash: "h9" });
      saveIngestSymbols(root, "x", t, new Set(t.keys()));
      expect(existsSync(journalPath())).toBe(false);
      const data = JSON.parse(readFileSync(tablePath(), "utf8")) as { files: Record<string, SymbolEntry> };
      expect(Object.values(data.files).map(e => e.hash)).toEqual(["h9", "h9", "h9", "h9"]);
    });

    it("applies the intact lines of a torn journal, and rewrites the table on the next save", () => {
      seed(10);
      const t = loadIngestSymbols(root, "x");
      t.set("f1.py", { ...entry("f1.py"), hash: "h2" });
      saveIngestSymbols(root, "x", t, new Set(["f1.py"]));
      appendFileSync(journalPath(), '{"k":"f2.py","e":{"hash":"cut'); // killed mid-append

      const loaded = loadIngestSymbols(root, "x");
      expect(loaded.get("f1.py")?.hash).toBe("h2");
      expect(loaded.get("f2.py")?.hash).toBe("h1");
      loaded.set("f6.py", { ...entry("f6.py"), hash: "h3" });
      saveIngestSymbols(root, "x", loaded, new Set(["f6.py"]));
      expect(existsSync(journalPath())).toBe(false);
      const after = loadIngestSymbols(root, "x");
      expect(after.get("f1.py")?.hash).toBe("h2");
      expect(after.get("f6.py")?.hash).toBe("h3");
    });

    it("ignores a journal written against another table", () => {
      seed(10);
      const t = loadIngestSymbols(root, "x");
      t.set("f1.py", { ...entry("f1.py"), hash: "h2" });
      saveIngestSymbols(root, "x", t, new Set(["f1.py"]));
      // A CLI that does not know the journal rewrites the table without a generation.
      writeFileSync(tablePath(), JSON.stringify({ version: 2, root, extractor: "x", files: { "f1.py": entry("f1.py") } }));
      const loaded = loadIngestSymbols(root, "x");
      expect(loaded.get("f1.py")?.hash).toBe("h1");
      // And the save after that replaces it rather than appending to it.
      loaded.set("f1.py", { ...entry("f1.py"), hash: "h4" });
      saveIngestSymbols(root, "x", loaded, new Set(["f1.py"]));
      expect(existsSync(journalPath())).toBe(false);
      expect(loadIngestSymbols(root, "x").get("f1.py")?.hash).toBe("h4");
    });

    it("does not append when another process rewrote the table since this one loaded it", () => {
      seed(10);
      const mine = loadIngestSymbols(root, "x");
      const theirs = loadIngestSymbols(root, "x");
      for (const k of theirs.keys()) theirs.set(k, { ...entry(k), hash: "t" });
      saveIngestSymbols(root, "x", theirs, new Set(theirs.keys())); // rewritten in full
      mine.set("f1.py", { ...entry("f1.py"), hash: "m" });
      saveIngestSymbols(root, "x", mine, new Set(["f1.py"]));
      // Mine was written in full over theirs, never as a journal against their table.
      expect(existsSync(journalPath())).toBe(false);
      expect(loadIngestSymbols(root, "x").get("f1.py")?.hash).toBe("m");
    });

    it("is cleared with the mtime cache, journal and all", () => {
      seed(10);
      const t = loadIngestSymbols(root, "x");
      t.set("f1.py", { ...entry("f1.py"), hash: "h2" });
      saveIngestSymbols(root, "x", t, new Set(["f1.py"]));
      expect(existsSync(journalPath())).toBe(true);
      clearIngestMtimeCache(root);
      expect(existsSync(tablePath())).toBe(false);
      expect(existsSync(journalPath())).toBe(false);
    });
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
