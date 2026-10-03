// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestSymbolsPath } from "../config.js";
import { loadIngestSymbols, saveIngestSymbols, type SymbolEntry } from "../ingest-symbols.js";

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
});
