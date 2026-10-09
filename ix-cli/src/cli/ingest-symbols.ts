// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from "node:crypto";
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
  /**
   * The file's mtime when it was read for this summary, stat'd before the read.
   * An entry is trusted without reading its file only while the file still has
   * this mtime: the baseline's mtimes say nothing about this table, which is
   * saved separately and can be older, and a scoped run never stats the files
   * outside its scope.
   */
  mtime?: number;
  summary: StoredSummary;
  /**
   * What the file's patch resolved its edges to, recorded when the patch is
   * built from these bytes: a hash of its edge ids and their targets
   * (`resolutionHash`). A re-resolution's re-send records it only once it lands. An unchanged file is
   * re-sent when names it uses change elsewhere, and only if this differs.
   */
  res?: string;
  /**
   * Picked for re-resolution (a name it uses changed) and not yet sent. Set
   * before the re-send and cleared when it lands or turns out unneeded, so a
   * failed re-send is retried by the next run rather than forgotten: by then
   * nothing it depends on looks changed any more.
   */
  pending?: true;
}

/**
 * A hash of a patch's edges and where they point. Same bytes resolved against
 * the same names gives the same value, so it changes exactly when something
 * the file refers to moved, appeared or went away.
 */
export function resolutionHash(ops: ReadonlyArray<{ type?: unknown; id?: unknown; dst?: unknown }>): string {
  const pairs = ops
    .filter(op => op.type === "UpsertEdge")
    .map(op => `${String(op.id)}>${String(op.dst)}`)
    .sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
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

// ── Dependents (IN-11) ──────────────────────────────────────────────────
// A file that did not change can still need re-sending: a call it makes may
// now resolve somewhere else, or nowhere, because a name it uses was added,
// renamed or removed in another file. The table knows what every file defines
// and refers to, so the run can find those files without reading the rest.

type SummaryFields = {
  qkeys?: Array<[string, string]>;
  exportPublicNames?: Array<[string, string]>;
  phpTypes?: Array<[string, string]>;
  refs?: string[];
  imports?: Array<{ dstName?: string; importRaw?: string }>;
  sig?: string;
};

/** The names other files can resolve to in a summary. */
export function definedNames(summary: StoredSummary | undefined): Set<string> {
  const names = new Set<string>();
  if (!summary) return names;
  const s = summary as SummaryFields;
  for (const [name, qkey] of s.qkeys ?? []) { names.add(name); names.add(qkey); }
  for (const [publicName] of s.exportPublicNames ?? []) names.add(publicName);
  for (const [fqcn, typeName] of s.phpTypes ?? []) { names.add(fqcn); names.add(typeName); }
  return names;
}

/**
 * What other files can bind to in a summary, as `key -> name`: one key per
 * entity name and qualified key, per `[public, local]` export pair and per PHP
 * type. The key carries what the name resolves to, so `export { a as foo }`
 * becoming `export { b as foo }` changes a key although no name came or went.
 */
function bindings(summary: StoredSummary | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!summary) return out;
  const s = summary as SummaryFields;
  for (const [name, qkey] of s.qkeys ?? []) out.set(`q\0${name}\0${qkey}`, [name, qkey]);
  for (const [publicName, local] of s.exportPublicNames ?? []) out.set(`e\0${publicName}\0${local}`, [publicName]);
  for (const [fqcn, typeName] of s.phpTypes ?? []) out.set(`p\0${fqcn}\0${typeName}`, [fqcn, typeName]);
  return out;
}

/**
 * Names whose binding differs before and after: defined in one but not the
 * other, or now pointing at something else. None when the signature is the same.
 */
export function changedNames(before: StoredSummary | undefined, after: StoredSummary | undefined): Set<string> {
  const b = before as SummaryFields | undefined;
  const a = after as SummaryFields | undefined;
  if (b?.sig !== undefined && b.sig === a?.sig) return new Set();
  const was = bindings(before);
  const now = bindings(after);
  const out = new Set<string>();
  for (const [key, names] of was) if (!now.has(key)) for (const n of names) out.add(n);
  for (const [key, names] of now) if (!was.has(key)) for (const n of names) out.add(n);
  return out;
}

/**
 * Whether a file's imports differ before and after. A file that re-exports
 * (`export { foo } from './x'`, a Python `__init__`) passes names through its
 * imports, which its signature does not cover: when they change, files that
 * import it may resolve differently, so it counts as a path that changed.
 */
export function importsChanged(before: StoredSummary | undefined, after: StoredSummary | undefined): boolean {
  if (!before || !after) return false;
  const key = (s: StoredSummary) =>
    JSON.stringify(((s as SummaryFields).imports ?? []).map(i => `${i.dstName ?? ""}\0${i.importRaw ?? ""}`).sort());
  return key(before) !== key(after);
}

/** The stem an import of `relPath` would name: `math` for `web/math.ts`, `web` for `web/index.ts`. */
function importStem(relPath: string): string {
  const posix = relPath.replace(/\\/g, "/");
  const stem = path.posix.basename(posix).replace(/\.[^.]+$/, "");
  if (stem === "index" || stem === "__init__" || stem === "mod") return path.posix.basename(path.posix.dirname(posix));
  return stem;
}

const REF_SEPARATOR = /::|->|[.#\\]/;

/** The segments of an import specifier: `./math.js` -> `math`, `js`; `pkg.util` -> `pkg`, `util`. */
function importSegments(spec: string): string[] {
  return spec.split(/[/\\.:]+/).filter(Boolean);
}

/**
 * Files in `table` that may resolve differently now: a name they refer to is in
 * `names` (also by its first or last segment, for `obj.method` and `Mod::f`), or
 * an import of theirs names the stem of a path in `paths` (a file that appeared,
 * went away, or changed what it imports). Files in `exclude` -- the ones the
 * run already sent -- are left out. Over-matching costs a parse; the resolution hash then decides whether
 * anything is sent.
 */
export function findDependents(
  table: ReadonlyMap<string, SymbolEntry>,
  names: ReadonlySet<string>,
  paths: Iterable<string>,
  exclude: ReadonlySet<string>,
): string[] {
  const stems = new Set<string>();
  for (const p of paths) {
    const stem = importStem(p);
    if (stem.length > 0 && stem !== ".") stems.add(stem);
  }
  if (names.size === 0 && stems.size === 0) return [];
  const out: string[] = [];
  for (const [rel, entry] of table) {
    if (exclude.has(rel)) continue;
    const s = entry.summary as SummaryFields;
    const byName = names.size > 0 && (s.refs ?? []).some(ref => {
      if (names.has(ref)) return true;
      // Most refs are plain names; splitting each costs more than the rest of the scan.
      if (!REF_SEPARATOR.test(ref)) return false;
      const parts = ref.split(/::|->|\.|#|\\/).filter(Boolean);
      return parts.length > 1 && (names.has(parts[0]) || names.has(parts[parts.length - 1]));
    });
    // By path segment, not substring: an added `a.ts` must not match every
    // import with an "a" in it.
    const byImport = !byName && stems.size > 0 && (s.imports ?? []).some(imp => {
      const spec = imp.importRaw ?? imp.dstName ?? "";
      for (const stem of stems) {
        if (spec.includes(stem) && importSegments(spec).includes(stem)) return true;
      }
      return false;
    });
    if (byName || byImport) out.push(rel);
  }
  return out.sort();
}
