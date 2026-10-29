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

  it("propagates changed superclass bindings to transitive subclass callers", () => {
    const before = summary("mid.scala", { receiverHeritage: [["Mid", "A"]] });
    const after = summary("mid.scala", { receiverHeritage: [["Mid", "B"]] });
    const table = new Map([
      ["mid.scala", entry(after)],
      ["child.scala", entry(summary("child.scala", { receiverHeritage: [["Child", "Mid"]], refs: ["Mid"] }))],
      ["leaf.scala", entry(summary("leaf.scala", { receiverHeritage: [["Leaf", "Child"]], refs: ["Child"] }))],
      ["use.scala", entry(summary("use.scala", { refs: ["Leaf.run"] }))],
      ["unrelated.scala", entry(summary("unrelated.scala", { refs: ["Other.run"] }))],
    ]);
    expect(findDependents(table, changedNames(before, after), [], new Set(["mid.scala"])))
      .toEqual(["child.scala", "leaf.scala", "use.scala"]);
  });

  it("propagates inheritance through excluded files and terminates on cycles", () => {
    const table = new Map([
      ["a.scala", entry(summary("a.scala", { receiverHeritage: [["A", "B"]], refs: ["B"] }))],
      ["b.scala", entry(summary("b.scala", { receiverHeritage: [["B", "A"]], refs: ["A"] }))],
      ["use.scala", entry(summary("use.scala", { refs: ["B.run"] }))],
    ]);
    const names = new Set(["A"]);
    expect(findDependents(table, names, [], new Set(["a.scala", "b.scala"]))).toEqual(["use.scala"]);
    expect(names).toEqual(new Set(["A"]));
  });

  it.each(["receiverFactories", "receiverHeritage"])("invalidates dependents when %s changes", (field) => {
    const before = summary("target", { sig: "before", [field]: [["Target", "Base"]] });
    const after = summary("target", { sig: "after", [field]: [["Target", "Other"]] });
    expect(changedNames(before, after)).toEqual(new Set(["Target"]));
  });

  it("invalidates a Java chained caller when a method's declared result changes, inherited or not", () => {
    // `i.getUrl().get()` where Invoker inherits getUrl from Base: the caller
    // names `getUrl`, never `Base.getUrl`.
    const before = summary("Base.java", { language: "java", sig: "before", receiverFactories: [["Base.getUrl", "URL"]] });
    const after = summary("Base.java", { language: "java", sig: "after", receiverFactories: [["Base.getUrl", "URI"]] });
    expect(changedNames(before, after)).toEqual(new Set(["Base.getUrl", "getUrl"]));
    const table = new Map([
      ["Base.java", entry(after)],
      ["Use.java", entry(summary("Use.java", { language: "java", refs: ["Invoker", "Invoker.getUrl", "Invoker.getUrl().get", "get", "getUrl"] }))],
      ["Other.java", entry(summary("Other.java", { language: "java", refs: ["Other.run"] }))],
    ]);
    expect(findDependents(table, changedNames(before, after), [], new Set(["Base.java"]))).toEqual(["Use.java"]);
    // A changed class reaches callers chained through a method returning it.
    const holder = new Map([
      ["Invoker.java", entry(summary("Invoker.java", { language: "java", receiverFactories: [["Invoker.getUrl", "URL"]] }))],
      ["Use.java", entry(summary("Use.java", { language: "java", refs: ["getUrl", "get"] }))],
    ]);
    expect(findDependents(holder, new Set(["URL"]), [], new Set())).toEqual(["Use.java"]);
    // Scala factories keep naming the factory only.
    const scala = summary("Mk.scala", { language: "scala", sig: "a", receiverFactories: [["Mk.apply", "T"]] });
    expect(changedNames(scala, { ...scala, sig: "b", receiverFactories: [["Mk.apply", "U"]] })).toEqual(new Set(["Mk.apply"]));
  });

  it("invalidates a subclass when only its file's imports pick a different superclass", () => {
    const before = summary("child.scala", { sig: "before", receiverHeritage: [["Child", "Parent"]], imports: [{ dstName: "p1.Parent" }] });
    const after = summary("child.scala", { sig: "after", receiverHeritage: [["Child", "Parent"]], imports: [{ dstName: "p2.Parent" }] });
    expect(changedNames(before, after)).toEqual(new Set(["Child"]));
  });

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

  it("counts adding or dropping a Python import alias as an import change", () => {
    const plain = summary("m.py", { imports: [{ dstName: "torch.nn", importRaw: "torch.nn" }] });
    const aliased = summary("m.py", { imports: [{ dstName: "torch.nn", importRaw: "torch.nn", importAliased: true }] });
    expect(importsChanged(plain, aliased)).toBe(true);
    expect(importsChanged(aliased, plain)).toBe(true);
    expect(importsChanged(aliased, { ...aliased })).toBe(false);
  });

  it("matches an import by path segment, not by substring", () => {
    const table = new Map<string, SymbolEntry>([
      ["uses-a.ts", entry(summary("uses-a.ts", { refs: [], imports: [{ importRaw: "./a.js" }] }))],
      ["uses-data.ts", entry(summary("uses-data.ts", { refs: [], imports: [{ importRaw: "./data" }] }))],
      ["uses-pkg-a.py", entry(summary("uses-pkg-a.py", { refs: [], imports: [{ importRaw: "pkg.a" }] }))],
    ]);
    expect(findDependents(table, new Set(), ["web/a.ts"], new Set())).toEqual(["uses-a.ts", "uses-pkg-a.py"]);
  });

  it("re-resolves the Python files below a __init__.py that came or went, whatever they import", () => {
    const py = (filePath: string, imports: Array<{ dstName: string; importRaw?: string }>) =>
      entry(summary(filePath, { language: "python", refs: [], imports }));
    const table = new Map<string, SymbolEntry>([
      ["tools/main.py", py("tools/main.py", [{ dstName: "helpers", importRaw: "helpers" }])],
      ["tools/deep/run.py", py("tools/deep/run.py", [{ dstName: "json", importRaw: "json" }])],
      ["tools/plain.py", py("tools/plain.py", [])],
      ["tools/main.ts", entry(summary("tools/main.ts", { language: "typescript", refs: [], imports: [{ dstName: "./x", importRaw: "./x" }] }))],
      ["toolsx/main.py", py("toolsx/main.py", [{ dstName: "helpers", importRaw: "helpers" }])],
      ["top.py", py("top.py", [{ dstName: "helpers", importRaw: "helpers" }])],
    ]);
    expect(findDependents(table, new Set(), ["tools/__init__.py"], new Set(), ["tools/__init__.py"]))
      .toEqual(["tools/deep/run.py", "tools/main.py"]);
    expect(findDependents(table, new Set(), [], new Set(["tools/main.py"]), ["tools\\__init__.py"])).toEqual(["tools/deep/run.py"]);
    // A root-level __init__.py covers every Python file with imports.
    expect(findDependents(table, new Set(), [], new Set(), ["__init__.py"]))
      .toEqual(["tools/deep/run.py", "tools/main.py", "toolsx/main.py", "top.py"]);
    // Only an __init__.py counts, and only when passed as one that came or went.
    expect(findDependents(table, new Set(), [], new Set(), ["tools/helpers.py"])).toEqual([]);
    expect(findDependents(table, new Set(), ["tools/__init__.py"], new Set())).toEqual([]);
  });

  it("hashes a patch's edges and their targets, in any order, and no other op", () => {
    const a = { type: "UpsertEdge", id: "e1", dst: "n1" };
    const b = { type: "UpsertEdge", id: "e2", dst: "n2" };
    const node = { type: "UpsertNode", id: "n9" };
    expect(resolutionHash([a, b, node])).toBe(resolutionHash([b, a]));
    expect(resolutionHash([a, b])).not.toBe(resolutionHash([a, { ...b, dst: "n3" }]));
  });

  it("hashes an edge's tier and confidence, so a re-tiered edge with the same id and target counts", () => {
    const typed = { type: "UpsertEdge", id: "e1", dst: "n1", attrs: { confidence: 0.95, tier: "type" } };
    const global = { ...typed, attrs: { confidence: 0.5, tier: "global" } };
    expect(resolutionHash([typed])).not.toBe(resolutionHash([global]));
    expect(resolutionHash([typed])).toBe(resolutionHash([{ ...typed, attrs: { tier: "type", confidence: 0.95, other: 1 } }]));
    // An edge with no resolution attrs hashes as it always has.
    expect(resolutionHash([{ type: "UpsertEdge", id: "e1", dst: "n1", attrs: {} }]))
      .toBe(resolutionHash([{ type: "UpsertEdge", id: "e1", dst: "n1" }]));
  });
});
