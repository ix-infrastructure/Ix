// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { ingestSymbolsPath } from "./config.js";

/**
 * The symbol table an incremental `ix map` resolves against.
 *
 * Resolving a changed file needs to know what every OTHER file defines,
 * exports and imports. Without a record of that, every run re-read and
 * re-parsed the whole repository's JS/TS, PHP, R and SAS just to build the
 * index -- and knew nothing at all about Python, Java and the rest, so an edit
 * to one of those resolved its calls against itself alone and lost its
 * cross-file edges. This keeps one `FileSummary` (core-ingestion's
 * `summarizeParseResult`) per file, keyed by workspace-relative path, beside
 * the ingest baseline.
 *
 * An entry is usable when its file is unchanged since the last run (mtime-clean
 * in the baseline) or its content hash matches, and only for the extractor that
 * wrote it.
 */

/** Bump when the stored shape changes; an older table is ignored, not migrated. */
const TABLE_VERSION = 1;

/** What core-ingestion's `FileSummary` looks like from here: opaque except for the path. */
export interface StoredSummary {
  filePath: string;
  [key: string]: unknown;
}

export interface SymbolEntry {
  /** sha256 of the file the summary describes. */
  hash: string;
  summary: StoredSummary;
}

interface SerializedSymbolTable {
  version: number;
  root: string;
  extractor: string;
  files: Record<string, SymbolEntry>;
}

/** The table for `projectRoot` and `extractor`, or an empty one. */
export function loadIngestSymbols(projectRoot: string, extractor: string): Map<string, SymbolEntry> {
  try {
    const data = JSON.parse(fs.readFileSync(ingestSymbolsPath(projectRoot), "utf-8")) as SerializedSymbolTable;
    if (data.version !== TABLE_VERSION || data.root !== projectRoot || data.extractor !== extractor) return new Map();
    if (!data.files || typeof data.files !== "object") return new Map();
    const table = new Map<string, SymbolEntry>();
    for (const [rel, entry] of Object.entries(data.files)) {
      if (typeof entry?.hash === "string" && entry.summary && typeof entry.summary.filePath === "string") {
        table.set(rel, entry);
      }
    }
    return table;
  } catch {
    return new Map();
  }
}

/**
 * Write the table via a temp file and a rename, so a process killed mid-write
 * leaves the previous table rather than a truncated one.
 */
export function saveIngestSymbols(projectRoot: string, extractor: string, table: Map<string, SymbolEntry>): void {
  try {
    const target = ingestSymbolsPath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data: SerializedSymbolTable = {
      version: TABLE_VERSION,
      root: projectRoot,
      extractor,
      files: Object.fromEntries(table),
    };
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, target);
  } catch {
    // An optimization: losing it costs the next run a parse of what it lacks.
  }
}
