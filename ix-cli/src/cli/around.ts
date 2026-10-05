// Copyright 2026 Ix Infrastructure Inc.

import * as path from "node:path";
import type { IxClient } from "../client/api.js";
import { activeReadScope, ensureReadScope } from "./resolve.js";
import {
  SourceFiles, anchorSpan, bareName, findEdgeSite, findImports, findUses, importKeys, type EdgeSite,
} from "./edge-sites.js";
import { rowLocation } from "./format.js";
import { checkGraphHealth, isUnhealthy, type GraphHealth } from "./graph-health.js";
import { isTestPath } from "./explain/related-files.js";

/**
 * `ix around`: who depends on the code at a place in a file.
 *
 * Built for the moment right after an agent edits code. The edit is local; the
 * places a multi-file fix also has to touch are not, and they are exactly what
 * grep cannot list cheaply: the callers of the function just changed, the
 * files that import it, and the tests that reach it. The graph has those, so
 * this answers with them, located (`path:line` and the line itself), and small
 * enough to land in an agent's context after every edit.
 *
 * The file may be newer than the graph -- it was just edited -- so the graph's
 * spans are re-anchored to the declarations in the text the edit's lines index
 * into (see {@link placeDefs}) before any span is compared with a line.
 */

/** 1-based inclusive line range. */
export interface LineRange {
  start: number;
  end: number;
  /**
   * A pure insertion between `start` and `end` (two adjacent lines). Only a
   * definition that holds both neighbours was edited; one that merely ends on
   * `start` had a new sibling added after it.
   */
  insertion?: boolean;
}

/** A definition the graph has in the file, with its span as recorded. */
export interface FileDef {
  id: string;
  name: string;
  kind: string;
  lineStart: number;
  lineEnd: number;
  /** Contained by the file itself rather than by a class in it. */
  topLevel: boolean;
  /** The class (or other container) holding it, when it is not top-level. */
  container?: string;
}

/** A definition placed on a text: where it is in those lines now. */
export interface PlacedDef extends FileDef {
  start: number;
  end: number;
}

export interface AroundRef {
  /** Workspace-relative path of the file the dependent site is in. */
  path: string;
  line?: number;
  snippet?: string;
  /** The entity at that site (the caller), when there is one. */
  name?: string;
  /** For a test reached in two hops: the caller it calls. */
  via?: string;
}

export interface AroundSection {
  /** How many there are. `rows` is the shown prefix of them. */
  total: number;
  rows: AroundRef[];
}

export interface AroundSymbol {
  id: string;
  name: string;
  kind: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  /** Where the graph last recorded it, when the file has moved under it. */
  movedFrom?: number;
  /** Non-test callers, cross-file first, each at its call site. */
  callers: AroundSection;
  /** Files that import this file, name the symbol, and use it -- at the use. */
  users: AroundSection;
  /** Test files that call it, call a caller of it, or import and use it. */
  tests: AroundSection;
  /** Other definitions in the same file with the same name. */
  sameName: Array<{ kind: string; lineStart: number; lineEnd: number }>;
  /**
   * Set when the edit is inside a class-like container but outside every
   * member the graph has: a field, an annotation, a declaration line. Such a
   * container's "callers" are mostly references to the type, so they are
   * counted, not listed.
   */
  declarations?: { lineStart: number; lineEnd: number };
}

/** Definitions whose "callers" are references to a type rather than calls. */
export const CONTAINER_KINDS = new Set([
  "class", "interface", "enum", "struct", "trait", "object", "module", "record",
  "annotation", "union", "namespace", "impl", "type",
]);

/**
 * The edited lines inside container `d` that no member of it covers -- its
 * fields and declarations, which the graph does not index as definitions
 * (Java and TypeScript fields are not) -- or undefined when every edited line
 * is inside a member.
 */
export function declarationLines(
  d: PlacedDef, placed: PlacedDef[], ranges: LineRange[],
): { start: number; end: number } | undefined {
  if (!CONTAINER_KINDS.has(d.kind.toLowerCase())) return undefined;
  const members = placed.filter((o) => o.id !== d.id && o.start >= d.start && o.end <= d.end
    && (o.end - o.start) < (d.end - d.start));
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of ranges) {
    if (r.insertion) {
      if (r.start >= d.start && r.start <= d.end && !members.some((m) => m.start <= r.start && m.end >= r.end)) {
        lo = Math.min(lo, r.start); hi = Math.max(hi, r.start);
      }
      continue;
    }
    for (let l = Math.max(r.start, d.start); l <= Math.min(r.end, d.end); l++) {
      if (!members.some((m) => l >= m.start && l <= m.end)) { lo = Math.min(lo, l); hi = Math.max(hi, l); }
    }
  }
  return lo <= hi ? { start: lo, end: hi } : undefined;
}

export interface AroundResult {
  path: string;
  /** The lines asked about, in the file's current coordinates; absent for the whole file. */
  lines?: { start: number; end: number };
  graph?: GraphHealth;
  symbols: AroundSymbol[];
  /** Every importer of the file, at its import line. */
  importers: AroundSection & { tests: number };
  /**
   * Edited definitions left out because the request excluded them (the hook's
   * "already told"); absent when none were. Lets the hook's log tell an edit
   * outside every definition from one inside a definition it already reported.
   */
  excluded?: number;
}

export interface AroundCaps {
  symbols: number;
  callers: number;
  users: number;
  tests: number;
  importers: number;
}

export const DEFAULT_CAPS: AroundCaps = { symbols: 3, callers: 8, users: 5, tests: 5, importers: 5 };

/**
 * How close `other` is to `edited`, smaller first: 0 for the same directory,
 * then one more for each directory you climb from `edited` to a shared one.
 *
 * Measured on 93 hook runs over SWE-PolyBench multi-file issues: a caller in
 * the edited file's own directory was a file the fix changed 10 times in 16,
 * one elsewhere 19 in 96; for importers that use the name, 5 in 10 against 3
 * in 31.
 */
export function localityRank(edited: string, other: string): number {
  const a = edited.split("/").slice(0, -1);
  const b = other.split("/").slice(0, -1);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  // Directories climbed from the edited file, plus one if `other` then goes down another.
  return (a.length - shared) + (b.length > shared ? 1 : 0);
}

/** The default token budget for rendered output: it lands in an agent's context after every edit. */
export const DEFAULT_TOKEN_BUDGET = 300;

/** Whole-file questions rank at most this many top-level definitions by caller count. */
const WHOLE_FILE_CANDIDATES = 12;
/** How far up and down an import statement is followed across lines. */
const IMPORT_STATEMENT_LINES = 40;

export class AroundError extends Error {
  constructor(readonly code: "file_not_in_graph" | "file_not_found" | "no_definitions", message: string) {
    super(message);
    this.name = "AroundError";
  }
}

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * `path`, `path:12` or `path:12-20`. A Windows drive letter is part of the
 * path, not a line.
 */
export function parseAroundTarget(target: string): { file: string; range?: LineRange } | undefined {
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(target);
  if (!m || /^[A-Za-z]$/.test(m[1])) return target ? { file: target } : undefined;
  const start = Number(m[2]);
  const end = m[3] !== undefined ? Number(m[3]) : start;
  if (!m[1] || start < 1 || end < start) return undefined;
  return { file: m[1], range: { start, end } };
}

/**
 * A test file, across the languages the benchmark repositories use.
 *
 * `isTestPath` knows `__tests__/` and `*.test.*`; a Python suite lives in
 * `tests/test_*.py`, a Java one in `src/test/` as `FooTest.java`. Fixtures are
 * test *data*, not tests that exercise the code, so they are left out here.
 */
export function isTestFile(file: string): boolean {
  const p = file.replace(/\\/g, "/");
  if (/(^|\/)(__fixtures__|(test-)?fixtures)\//.test(p)) return false;
  return isTestPath(p)
    || /(^|\/)(tests?|__tests__|spec|specs|src\/test)\//.test(p)
    || /(^|\/)test_[^/]+\.py$/.test(p)
    || /_test\.(py|go|rb)$/.test(p)
    || /(Test|Tests|IT|Spec)\.(java|kt|kts|scala|cs|groovy)$/.test(p);
}

// ── Placing definitions on the text ──────────────────────────────────────────

/**
 * Where each definition is in `lines` now.
 *
 * The start is re-anchored to the nearest declaration of the name
 * ({@link anchorSpan}, the step `ix read` and the edge sites use). The end
 * cannot be found that way, and shifting it by the start's delta is wrong for
 * the one definition that matters most -- the one just edited, which grew or
 * shrank. So the end keeps its distance to the next definition that started
 * after it in the graph: if `parseFoo` ended two lines before `parseBar`
 * began, it still does. The last definition in the file, with nothing after
 * it, is shifted.
 */
export function placeDefs(defs: FileDef[], lines: string[]): PlacedDef[] {
  const anchored = new Map<string, { start: number; end: number; anchored: boolean }>();
  for (const d of defs) anchored.set(d.id, anchorSpan(lines, bareName(d.name), d.lineStart, d.lineEnd));
  const byStart = [...defs].sort((a, b) => a.lineStart - b.lineStart);
  return defs.map((d) => {
    const a = anchored.get(d.id)!;
    let end = a.end;
    const next = byStart.find((o) => o.lineStart > d.lineEnd);
    const nextAnchor = next ? anchored.get(next.id) : undefined;
    if (next && nextAnchor?.anchored && a.anchored) {
      const gap = next.lineStart - d.lineEnd;
      const estimated = nextAnchor.start - gap;
      if (estimated >= a.start) end = estimated;
    }
    return { ...d, start: a.start, end: Math.max(a.start, Math.min(end, lines.length || end)) };
  });
}

function spanOverlaps(d: PlacedDef, r: LineRange): boolean {
  if (r.insertion) return d.start <= r.start && d.end >= r.end;
  return d.start <= r.end && d.end >= r.start;
}

/**
 * The definitions an edit touched, innermost first: a method before its
 * class, a nested helper before the function around it. Ties go to the one
 * that starts first.
 *
 * A definition around one already chosen is left out unless the edit also
 * touched it outside that one: changing a method's body is not a change to
 * every user of its class, and `IxClient` has 65 of them.
 */
export function selectEdited(placed: PlacedDef[], ranges: LineRange[], cap: number): PlacedDef[] {
  const candidates = placed
    .filter((d) => ranges.some((r) => spanOverlaps(d, r)))
    .sort((a, b) => (a.end - a.start) - (b.end - b.start) || a.start - b.start);
  const chosen: PlacedDef[] = [];
  for (const d of candidates) {
    if (chosen.length >= cap) break;
    const inner = chosen.filter((c) => c.start >= d.start && c.end <= d.end);
    if (inner.length > 0 && !touchedOutside(d, ranges, inner)) continue;
    chosen.push(d);
  }
  return chosen;
}

/** Whether an edited line inside `d` falls outside every one of `inner`. */
function touchedOutside(d: PlacedDef, ranges: LineRange[], inner: PlacedDef[]): boolean {
  for (const r of ranges) {
    if (r.insertion) {
      if (spanOverlaps(d, r) && !inner.some((c) => c.start <= r.start && c.end >= r.end)) return true;
      continue;
    }
    for (let l = Math.max(r.start, d.start); l <= Math.min(r.end, d.end); l++) {
      if (!inner.some((c) => l >= c.start && l <= c.end)) return true;
    }
  }
  return false;
}

/** Top-level definitions not nested inside another one, in file order. */
export function outermostDefs(placed: PlacedDef[]): PlacedDef[] {
  return placed
    .filter((d) => d.topLevel)
    .filter((d) => !placed.some((o) => o.id !== d.id && o.start <= d.start && o.end >= d.end
      && (o.end - o.start) > (d.end - d.start)))
    .sort((a, b) => a.start - b.start);
}

// ── Import statements ───────────────────────────────────────────────────────

const STATEMENT_START = /^\s*(?:import\b|from\s|export\b|use\s|using\s|#\s*include|require\b|package\b)/;

/**
 * The whole import statement around one of its lines: `import {\n a,\n b\n}
 * from "./x.js"` matches its key on the last line and names what it imports
 * on the lines above it; Python's `from x import (\n a,\n)` the other way.
 */
export function importStatementText(lines: string[], line: number): { text: string; start: number; end: number } {
  let start = line;
  while (start > 1 && line - start < IMPORT_STATEMENT_LINES && !STATEMENT_START.test(lines[start - 1] ?? "")) start--;
  if (!STATEMENT_START.test(lines[start - 1] ?? "")) start = line;
  let end = line;
  let depth = 0;
  for (let l = start; l <= end; l++) depth += delimiterDepth(lines[l - 1] ?? "");
  while (depth > 0 && end < lines.length && end - line < IMPORT_STATEMENT_LINES) {
    end++;
    depth += delimiterDepth(lines[end - 1] ?? "");
  }
  return { text: lines.slice(start - 1, end).join(" "), start, end };
}

function delimiterDepth(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
  }
  return depth;
}

function wordIn(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${n}(?![\\w$])`).test(text);
}

/**
 * Where an importing file uses the symbol, or undefined when it does not.
 *
 * An importer of the file is a user of the symbol only when its import names
 * the symbol (or, for a member, the class holding it) *and* the rest of the
 * file uses the name. Both, because each alone is noise: `options.ts` is
 * imported by seventeen files, of which one uses `parseBudgetOption`, and a
 * common method name appears in files that never import its class. This is
 * also how a use the graph has no edge for is found -- a function handed to
 * a framework by name (`.option("--pick <n>", "...", parsePickOption)`).
 */
export function findUseInImporter(
  lines: string[], importLines: number[], symbol: { name: string; container?: string },
): number | undefined {
  const bare = bareName(symbol.name);
  const statements = importLines.map((l) => importStatementText(lines, l));
  const namesSymbol = statements.some((s) => wordIn(s.text, bare));
  const namesContainer = !!symbol.container && statements.some((s) => wordIn(s.text, bareName(symbol.container!)));
  if (!namesSymbol && !namesContainer) return undefined;
  const inImport = (l: number) => statements.some((s) => l >= s.start && l <= s.end);
  // Through its class only a call counts: `expand: true` in an object, or the
  // word in a help string, is not a use of `IxClient.expand`.
  const call = callPattern(bare);
  return findUses(lines, bare, 1, lines.length)
    .find((l) => !inImport(l) && (namesSymbol || call.test(lines[l - 1])));
}

function callPattern(name: string): RegExp {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${n}\\s*(?:<[^()]*>)?\\s*\\(`);
}

// ── Gathering ───────────────────────────────────────────────────────────────

export interface AroundRequest {
  /** Workspace-relative path of the file, as the graph spells its source_uri. */
  relPath: string;
  /** The lines asked about, in the coordinates of `anchorLines`. None: the whole file. */
  ranges?: LineRange[];
  /**
   * The text `ranges` index into. For a pre-edit range (the old side of a
   * patch) this is the file before the edit; otherwise the file as it is now.
   */
  anchorLines: string[];
  /** The file as it is now, for the locations reported. Defaults to `anchorLines`. */
  currentLines?: string[];
  /** Reads the dependents' files for their sites. */
  files: SourceFiles;
  caps?: Partial<AroundCaps>;
  /**
   * Ids of definitions not to report: the post-edit hook's "already told this
   * session". Applied after innermost selection, so a class whose method was
   * reported earlier does not take that method's place.
   */
  exclude?: Set<string>;
}

type AroundClient = Pick<IxClient, "search" | "expand" | "workspaceSystem" | "currentRevision" | "stats"> & { endpoint?: string };

function nodeUri(n: any): string {
  return String(n?.provenance?.sourceUri ?? n?.provenance?.source_uri ?? "").replace(/\\/g, "/");
}

/** The graph's file node for a workspace-relative path: exact, else a unique suffix match. */
export async function findFileNode(client: Pick<IxClient, "search">, relPath: string): Promise<any | undefined> {
  const want = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const { workspaceId, systemId } = activeReadScope();
  const nodes = await client.search(path.posix.basename(want), {
    kind: "file", nameOnly: true, limit: 50, workspaceId, systemId, scope: want,
  });
  const files = (nodes as any[]).filter((n) => String(n.kind).toLowerCase() === "file");
  const exact = files.find((n) => nodeUri(n) === want);
  if (exact) return exact;
  const suffix = files.filter((n) => {
    const uri = nodeUri(n);
    return uri.endsWith(`/${want}`) || want.endsWith(`/${uri}`);
  });
  return suffix.length === 1 ? suffix[0] : undefined;
}

function toDef(n: any, topLevel: boolean, container?: string): FileDef | undefined {
  const loc = rowLocation(n);
  if (loc.lineStart === undefined) return undefined;
  return {
    id: n.id, name: String(n.name ?? ""), kind: String(n.kind ?? ""),
    lineStart: loc.lineStart, lineEnd: loc.lineEnd ?? loc.lineStart, topLevel, container,
  };
}

/** The file's definitions, two levels deep (file -> class -> method). */
export function defsFromContains(fileId: string, expansion: { nodes: any[]; edges: any[] }): FileDef[] {
  const byId = new Map(expansion.nodes.map((n) => [n.id, n]));
  const parent = new Map<string, string>();
  for (const e of expansion.edges ?? []) {
    if (e?.predicate === "CONTAINS" && !parent.has(e.dst)) parent.set(e.dst, e.src);
  }
  const defs: FileDef[] = [];
  for (const n of expansion.nodes) {
    if (String(n.kind).toLowerCase() === "file" || n.id === fileId) continue;
    const p = parent.get(n.id);
    const topLevel = p === undefined || p === fileId;
    const def = toDef(n, topLevel, topLevel ? undefined : byId.get(p!)?.name);
    if (def && def.name) defs.push(def);
  }
  return defs;
}

interface CallerSets {
  hop1: any[];
  hop2: { nodes: any[]; edges: any[] };
}

/** Callers one hop back (unless already fetched), and two hops back for the tests. */
async function callerSets(client: AroundClient, id: string, hop1Known?: any[]): Promise<CallerSets> {
  const predicates = ["CALLS", "REFERENCES"];
  const [hop1, hop2] = await Promise.all([
    hop1Known ?? client.expand(id, { direction: "in", predicates }).then((r) => r.nodes),
    client.expand(id, { direction: "in", predicates, hops: 2 }),
  ]);
  return { hop1: hop1.filter((n: any) => n.id !== id), hop2 };
}

function siteRef(row: any, site: EdgeSite | undefined, extra: Partial<AroundRef> = {}): AroundRef {
  const loc = rowLocation(row);
  return {
    path: site?.path ?? loc.path ?? "",
    line: site?.line ?? loc.lineStart,
    snippet: site?.snippet,
    name: String(row?.kind ?? "").toLowerCase() === "file" ? undefined : row?.name,
    ...extra,
  };
}

/**
 * Everything `ix around` reports. Throws `WorkspaceNotMappedError` outside a
 * mapped workspace and {@link AroundError} for a file the graph does not hold.
 */
export async function gatherAround(client: AroundClient, req: AroundRequest): Promise<AroundResult> {
  const caps: AroundCaps = { ...DEFAULT_CAPS, ...req.caps };
  await ensureReadScope(client);
  const healthP = checkGraphHealth(client, activeReadScope());
  // Never let the health probe reject past a caller that stopped waiting.
  healthP.catch(() => undefined);

  const file = await findFileNode(client, req.relPath);
  if (!file) throw new AroundError("file_not_in_graph", `${req.relPath} is not in the graph.`);
  const relPath = nodeUri(file) || req.relPath;

  const [contains, imported] = await Promise.all([
    client.expand(file.id, { direction: "out", predicates: ["CONTAINS"], hops: 2 }),
    client.expand(file.id, { direction: "in", predicates: ["IMPORTS"] }),
  ]);
  const defs = defsFromContains(file.id, contains);
  const anchorPlaced = placeDefs(defs, req.anchorLines);
  const current = req.currentLines && req.currentLines !== req.anchorLines
    ? new Map(placeDefs(defs, req.currentLines).map((d) => [d.id, d]))
    : new Map(anchorPlaced.map((d) => [d.id, d]));

  // Which definitions to report on.
  let chosen: PlacedDef[];
  const preloaded = new Map<string, any[]>();
  let alreadyReported = 0;
  if (req.ranges && req.ranges.length > 0) {
    const edited = selectEdited(anchorPlaced, req.ranges, Number.MAX_SAFE_INTEGER);
    const fresh = edited.filter((d) => !req.exclude?.has(d.id));
    alreadyReported = edited.length - fresh.length;
    chosen = fresh.slice(0, caps.symbols);
  } else {
    // The whole file: its outermost definitions, the most-called first, so a
    // capped answer keeps the ones with dependents.
    const candidates = outermostDefs(anchorPlaced)
      .filter((d) => !req.exclude?.has(d.id))
      .slice(0, WHOLE_FILE_CANDIDATES);
    const counts = await Promise.all(candidates.map(async (d) => {
      const r = await client.expand(d.id, { direction: "in", predicates: ["CALLS", "REFERENCES"] });
      preloaded.set(d.id, r.nodes.filter((n: any) => n.id !== d.id));
      return r.nodes.length;
    }));
    chosen = candidates
      .map((d, i) => ({ d, i, c: counts[i] }))
      .sort((a, b) => b.c - a.c || a.i - b.i)
      .slice(0, caps.symbols)
      .map(({ d }) => d);
  }

  // Importers of the file, each at its import line(s).
  const fileKeys = importKeys(path.posix.basename(relPath), "file", relPath);
  const importerRows = imported.nodes.filter((n: any) => n.id !== file.id);
  const importerLines = new Map<string, { row: any; path: string; lines: number[] }>();
  for (const row of importerRows) {
    const p = rowLocation(row).path;
    if (!p) continue;
    const lines = req.files.lines(p);
    importerLines.set(row.id, { row, path: p, lines: lines ? findImports(lines, fileKeys) : [] });
  }

  const symbols = await Promise.all(chosen.map(async (d): Promise<AroundSymbol> => {
    const sets = await callerSets(client, d.id, preloaded.get(d.id));
    const hop1 = sets.hop1;
    const target = { name: d.name, kind: d.kind, path: relPath };

    const nonTest = hop1.filter((r) => !isTestFile(rowLocation(r).path ?? ""));
    // Other files first (the agent has this one open), the nearest first.
    const near = (r: any) => localityRank(relPath, rowLocation(r).path ?? "");
    const crossFirst = [...nonTest].sort((a, b) =>
      Number(rowLocation(a).path === relPath) - Number(rowLocation(b).path === relPath) || near(a) - near(b));
    const callers = crossFirst.slice(0, caps.callers)
      .map((row) => siteRef(row, safeSite("callers", row, target, req.files)));
    const callerPaths = new Set(hop1.map((r) => rowLocation(r).path));

    // Tests: callers that are tests, then tests calling a caller, then test
    // files that import the file and use the symbol. One row per test file.
    const tests = new Map<string, AroundRef>();
    for (const row of hop1) {
      const p = rowLocation(row).path ?? "";
      if (isTestFile(p) && !tests.has(p)) tests.set(p, siteRef(row, safeSite("callers", row, target, req.files)));
    }
    const hop1Ids = new Map(hop1.map((r) => [r.id, r]));
    const hop2ById = new Map(sets.hop2.nodes.map((n: any) => [n.id, n]));
    for (const e of sets.hop2.edges ?? []) {
      const via = hop1Ids.get(e?.dst);
      const row = hop2ById.get(e?.src);
      if (!via || !row || row.id === d.id) continue;
      const p = rowLocation(row).path ?? "";
      if (!isTestFile(p) || tests.has(p)) continue;
      const viaTarget = { name: via.name, kind: via.kind, path: rowLocation(via).path };
      tests.set(p, siteRef(row, safeSite("callers", row, viaTarget, req.files), { via: via.name }));
    }

    const users: AroundRef[] = [];
    for (const { path: p, lines } of importerLines.values()) {
      if (callerPaths.has(p) && !isTestFile(p)) continue;
      const text = req.files.lines(p);
      if (!text || lines.length === 0) continue;
      const use = findUseInImporter(text, lines, d);
      if (use === undefined) continue;
      const ref: AroundRef = { path: p, line: use, snippet: text[use - 1].trim() };
      if (isTestFile(p)) { if (!tests.has(p)) tests.set(p, ref); } else users.push(ref);
    }

    const here = current.get(d.id) ?? d;
    const sameName = defs
      .filter((o) => o.id !== d.id && bareName(o.name) === bareName(d.name))
      .map((o) => {
        const c = current.get(o.id);
        return { kind: o.kind, lineStart: c?.start ?? o.lineStart, lineEnd: c?.end ?? o.lineEnd };
      });
    const testRows = [...tests.values()];
    const decl = req.ranges && req.ranges.length > 0 ? declarationLines(d, anchorPlaced, req.ranges) : undefined;
    // In the current file's coordinates, like the symbol's own span.
    const shift = here.start - d.start;
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      path: relPath,
      lineStart: here.start,
      lineEnd: here.end,
      movedFrom: here.start !== d.lineStart ? d.lineStart : undefined,
      callers: { total: nonTest.length, rows: callers },
      users: {
        total: users.length,
        rows: [...users].sort((x, y) => localityRank(relPath, x.path) - localityRank(relPath, y.path)).slice(0, caps.users),
      },
      tests: { total: testRows.length, rows: testRows.slice(0, caps.tests) },
      sameName,
      ...(decl ? { declarations: { lineStart: decl.start + shift, lineEnd: decl.end + shift } } : {}),
    };
  }));

  const importerList = [...importerLines.values()];
  const importers = {
    total: importerList.length,
    tests: importerList.filter((i) => isTestFile(i.path)).length,
    rows: importerList
      .filter((i) => !isTestFile(i.path))
      .slice(0, caps.importers)
      .map((i) => {
        const text = req.files.lines(i.path);
        const line = i.lines[0];
        return { path: i.path, line, snippet: line && text ? text[line - 1].trim() : undefined };
      }),
  };

  const health = await healthP.catch(() => undefined);
  return {
    path: relPath,
    graph: isUnhealthy(health) ? health : undefined,
    symbols,
    importers,
    ...(alreadyReported > 0 ? { excluded: alreadyReported } : {}),
  };
}

function safeSite(relation: "callers", row: any, target: { name: string; kind?: string; path?: string }, files: SourceFiles): EdgeSite | undefined {
  try { return findEdgeSite(relation, row, target, files); } catch { return undefined; }
}

// ── Sizing ──────────────────────────────────────────────────────────────────

/** The estimate the budget is held to: four characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Any dependents at all: nothing to say otherwise. */
export function hasDependents(result: AroundResult): boolean {
  return result.symbols.some((s) => s.callers.total + s.users.total + s.tests.total > 0);
}

function withCaps(result: AroundResult, caps: AroundCaps, snippetChars: number): AroundResult {
  const trimRef = (r: AroundRef): AroundRef => ({
    ...r,
    snippet: r.snippet && r.snippet.length > snippetChars ? `${r.snippet.slice(0, snippetChars - 1)}…` : r.snippet,
  });
  return {
    ...result,
    symbols: result.symbols.slice(0, caps.symbols).map((s) => ({
      ...s,
      callers: { total: s.callers.total, rows: s.callers.rows.slice(0, caps.callers).map(trimRef) },
      users: { total: s.users.total, rows: s.users.rows.slice(0, caps.users).map(trimRef) },
      tests: { total: s.tests.total, rows: s.tests.rows.slice(0, caps.tests).map(trimRef) },
    })),
    importers: { ...result.importers, rows: result.importers.rows.slice(0, caps.importers).map(trimRef) },
  };
}

/**
 * Cut the answer until its rendering fits `budget` tokens, least useful first:
 * the file-level importer rows (the count stays), then long snippets, then
 * rows from each list down to a floor, then symbols, then everything down to
 * one row. Totals are kept, so what was cut reads as "N of M", never as
 * absence.
 */
export function fitToBudget(
  result: AroundResult,
  render: (r: AroundResult) => string,
  budget: number,
  start: Partial<AroundCaps> = {},
): AroundResult {
  const caps: AroundCaps = { ...DEFAULT_CAPS, ...start };
  let snippet = 100;
  const fits = () => {
    const fitted = withCaps(result, caps, snippet);
    return estimateTokens(render(fitted)) <= budget ? fitted : undefined;
  };
  const shrink = (keys: Array<keyof AroundCaps>, floor: number): AroundResult | undefined => {
    for (;;) {
      const key = keys.filter((k) => caps[k] > floor).sort((a, b) => caps[b] - caps[a])[0];
      if (!key) return undefined;
      caps[key]--;
      const fitted = fits();
      if (fitted) return fitted;
    }
  };
  const steps: Array<() => AroundResult | undefined> = [
    fits,
    () => shrink(["importers"], 0),
    () => { snippet = 70; return fits(); },
    () => shrink(["callers", "users", "tests"], 3),
    () => shrink(["callers", "users", "tests"], 2),
    () => { while (caps.symbols > 1) { caps.symbols--; const f = fits(); if (f) return f; } return undefined; },
    () => shrink(["callers", "users", "tests"], 1),
    () => { snippet = 40; return fits(); },
  ];
  for (const step of steps) {
    const fitted = step();
    if (fitted) return fitted;
  }
  return withCaps(result, caps, snippet);
}
