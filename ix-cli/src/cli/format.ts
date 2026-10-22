// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine, llmShortId, type LlmValue } from "./llm.js";
import { projectRow, requestedFields } from "./output-shape.js";
import type { EdgeSite } from "./edge-sites.js";

export type ResultSource = "graph" | "text" | "graph+text" | "heuristic";

// ── JSON output shape ──────────────────────────────────────────────────────

/**
 * Whether the caller explicitly asked for indented JSON.
 *
 * False means nobody asked, and the shape then follows the destination:
 * indented for a terminal, compact for anything else. Two spaces of indent per
 * level is roughly a fifth of a JSON payload, and the only reader that gains
 * anything from it is a human looking at a screen. Every other reader — a pipe
 * into `jq`, an agent's tool result, the MCP child process — pays tokens for
 * whitespace it discards.
 */
let prettyJsonRequested = false;

/** Record `--pretty`. Called once from the root `preAction` hook. */
export function setPrettyJson(pretty: boolean): void {
  prettyJsonRequested = pretty;
}

/**
 * The indent `JSON.stringify` should use, read at print time.
 *
 * Deliberately not cached: `process.stdout.isTTY` is what makes this decision,
 * and a test that redirects stdout would otherwise get the shape from whatever
 * the process looked like at import time.
 */
function jsonIndent(): number | undefined {
  if (prettyJsonRequested) return 2;
  return process.stdout.isTTY ? 2 : undefined;
}

// ── Resolution notices ─────────────────────────────────────────────────────

/**
 * Notices about a guessed target (`ambiguous_target`, `fuzzy_match`) waiting for
 * the command's own json object. Module state: `ix mcp` runs commands in this
 * process by default (see mcp/runner.ts), so its runner calls
 * `resetResolutionNotices` before each command, and so should tests that call a
 * command in-process.
 */
let pendingResolutionNotices: unknown[] = [];

/** Queue notices for the next `printJson`. */
export function noteResolutionNotices(list: readonly unknown[]): void {
  pendingResolutionNotices.push(...list);
}

export function takeResolutionNotices(): unknown[] {
  const taken = pendingResolutionNotices;
  pendingResolutionNotices = [];
  return taken;
}

export function resetResolutionNotices(): void {
  pendingResolutionNotices = [];
}

/**
 * Merge pending notices into a plain object that is not an error record.
 * Anything else (an array, a scalar, an `{error}`) is printed untouched and the
 * notices are dropped: an error is its own answer, and the exit code is the same.
 */
function withResolutionNotices(value: unknown): unknown {
  const notices = takeResolutionNotices();
  if (notices.length === 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.error === "string") return value;
  const fuzzy = notices.some((n) => (n as { code?: string })?.code === "fuzzy_match");
  return {
    ...obj,
    ...(fuzzy && obj.resolutionMode === undefined ? { resolutionMode: "fuzzy" } : {}),
    resolutionNotices: notices,
  };
}

/** Set while {@link captureJson} runs: payloads are collected instead of printed. */
let jsonSink: unknown[] | undefined;

/** Print a JSON payload on stdout, indented only when that helps someone. */
export function printJson(value: unknown): void {
  const payload = withResolutionNotices(value);
  if (jsonSink) {
    jsonSink.push(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, jsonIndent()));
}

/**
 * Run `fn` and return the payloads it passed to `printJson`, unprinted. A
 * multi-target command runs its one-target body per target and prints one
 * object grouping them, rather than several JSON documents on one stream.
 */
export async function captureJson(fn: () => Promise<void>): Promise<unknown[]> {
  const previous = jsonSink;
  const sink: unknown[] = [];
  jsonSink = sink;
  try {
    await fn();
  } finally {
    jsonSink = previous;
  }
  return sink;
}

// ── JSON optimization helpers ──────────────────────────────────────────────

/**
 * Strip the cwd prefix from absolute paths to save tokens in JSON output.
 *
 * Under the client-agnostic backend design, source_uri values are already
 * workspace-relative. For those we return the input unchanged. Legacy absolute
 * paths (e.g. from older graphs) are still handled the old way.
 */
export function relativePath(absPath: string | undefined | null): string | undefined {
  if (!absPath) return undefined;
  // Already relative (workspace-relative path from post-migration graphs).
  if (!absPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(absPath)) return absPath;
  const cwd = process.cwd();
  if (absPath.startsWith(cwd + "/")) return absPath.slice(cwd.length + 1);
  // Also handle /Users/.../project/ style without trailing slash match
  const home = process.env.HOME;
  if (home && absPath.startsWith(home)) {
    return "~" + absPath.slice(home.length);
  }
  return absPath;
}

/** Round a number to N decimal places (default 2). */
export function roundFloat(n: number, decimals: number = 2): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/** Remove keys with null/undefined values from an object (shallow). */
export function stripNulls<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) result[k] = v;
  }
  return result as Partial<T>;
}

/** Compact a tree node for JSON output — drops UUIDs, resolved:true, sourceEdge, uses relative paths. */
export function compactTreeNode(node: any): any {
  const out: any = { name: node.name, kind: node.kind };
  if (node.relation) out.rel = node.relation;
  if (node.path) out.path = relativePath(node.path);
  if (node.cycle) out.cycle = true;
  if (node.resolved === false) out.resolved = false;
  if (node.children?.length > 0) {
    out.children = node.children.map(compactTreeNode);
  }
  return out;
}

// ── Bounded lists ──────────────────────────────────────────────────────────

/** A list that was cut to `--limit`, and what it left behind. */
export interface Slice<T> {
  /** The rows to print. */
  rows: T[];
  /** How many rows are printed. */
  shown: number;
  /** How many there were before the cut. */
  total: number;
  truncated: boolean;
  /** How many ranked rows were skipped before `rows` (paging); absent means 0. */
  offset?: number;
  /** The `--offset` of the next page; set only when rows remain. */
  nextOffset?: number;
  /** The command that prints the next page, when the caller can build one. */
  next?: string;
  /**
   * The server cut the list before this layer saw it, so `total` is a lower
   * bound: more rows may exist past it, and no `--offset` can reach them.
   */
  capped?: boolean;
}

/**
 * Rank, then cut, then report both numbers.
 *
 * Every one of these commands used to slice first and then report the length of
 * the slice as `total`, so `ix callers` on a symbol with 212 callers answered
 * `total=50` — a number an agent has no reason to disbelieve, and which reads
 * as "this symbol has 50 callers". The order matters as much as the count: a
 * cut applied to an unranked list keeps whichever rows the graph happened to
 * return first.
 *
 * `priority` is a small integer, low first, and the sort is stable, so rows
 * that rank equally keep the order the backend gave them. It is not a general
 * re-sort: the backend order carries information this layer cannot reconstruct,
 * and the only claim made here is that rows the caller can act on should
 * survive the cut before rows it cannot.
 */
export function sliceRanked<T>(all: T[], limit: number, priority?: (item: T) => number, offset = 0): Slice<T> {
  const ranked = priority ? [...all].sort((a, b) => priority(a) - priority(b)) : all;
  const rows = Number.isFinite(limit) ? ranked.slice(offset, offset + limit) : ranked.slice(offset);
  const truncated = offset + rows.length < all.length;
  const slice: Slice<T> = { rows, shown: rows.length, total: all.length, truncated };
  if (offset > 0) slice.offset = offset;
  // A page that printed nothing (`--limit 0`) has no next page to point at:
  // `next_offset` would equal this offset and a caller following it would loop.
  if (truncated && rows.length > 0) slice.nextOffset = offset + rows.length;
  return slice;
}

/**
 * A name the extractor could not resolve to an entity — a raw id standing in
 * for a call target that was never ingested.
 */
function isRawIdName(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || /^[0-9a-f]{32,}$/i.test(value);
}

function edgeRowPriority(node: any): number {
  const name = node.name || node.attrs?.name || "";
  const resolved = !!name && !isRawIdName(name);
  if (!resolved) return 2;
  const path = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? node.attrs?.path;
  return path ? 0 : 1;
}

/**
 * Cut an edge expansion to `--limit`, keeping the rows a caller can follow.
 *
 * A row whose name is a raw id is a dangling reference: `explain`, `read` and
 * `callers` can all do nothing with it. A named row with no path costs the
 * caller a `locate` before it can be read. Neither should displace a row that
 * carries both.
 */
export function sliceEdgeResults(nodes: any[], limit: number, offset = 0, capped = false): Slice<any> {
  const slice = sliceRanked(nodes, limit, edgeRowPriority, offset);
  if (capped) {
    slice.capped = true;
    // The list is not known to end here, whatever this page holds.
    slice.truncated = true;
  }
  return slice;
}

/**
 * The most edges one /v1/expand call returns. The backend clamps the request's
 * `limit` to this (Ix-memory ArangoGraphQueryApi.expand / expandWith:
 * `maxEdges = min(limit, 1000)`, and ExpandRoutes defaults `limit` to 1000).
 */
export const EXPAND_MAX_EDGES = 1000;

/**
 * Whether an expand result may have been cut by the server's edge cap. The
 * server says so in `truncated` when it is new enough to; an older one only
 * shows it by returning a full cap's worth of edges or nodes.
 */
export function expandCapped(result: { nodes?: unknown[]; edges?: unknown[]; truncated?: unknown }): boolean {
  return result.truncated === true
    || (result.edges?.length ?? 0) >= EXPAND_MAX_EDGES
    || (result.nodes?.length ?? 0) >= EXPAND_MAX_EDGES;
}

/**
 * Which rows a page printed: `51-100` past the first page, the bare count on
 * it. A page that printed nothing is `0` — with `--limit 0 --offset 50` the
 * range form would read `51-50`.
 */
function pageRange(slice: Slice<unknown>): string {
  const offset = slice.offset ?? 0;
  return offset > 0 && slice.shown > 0 ? `${offset + 1}-${offset + slice.shown}` : `${slice.shown}`;
}

/**
 * What was left out, and the one flag that gets it.
 *
 * `next:` is printed only when the caller set `slice.next`: that is how a
 * command says it takes `--offset`. `sliceRanked` sets `nextOffset` on every
 * truncated slice, including slices cut by commands with no `--offset` (`ix
 * impact`'s leaf rows), and pointing those at a flag they reject would send the
 * reader into an unknown-option error.
 */
export function truncationHint(slice: Slice<unknown>, relation: string): string {
  if (slice.capped) return cappedHint(slice, relation);
  const range = pageRange(slice);
  if (slice.nextOffset === undefined || slice.next === undefined) return `${slice.total} ${relation}; showing ${range}. Raise --limit to see them.`;
  return `${slice.total} ${relation}; showing ${range}. next: ${slice.next}`;
}

/**
 * The hint for a list the server cut at EXPAND_MAX_EDGES: the count is a
 * floor, and paging stops where the server's rows do.
 */
function cappedHint(slice: Slice<unknown>, relation: string): string {
  const offset = slice.offset ?? 0;
  const head = `At least ${slice.total} ${relation} (the server returns at most ${EXPAND_MAX_EDGES} edges)`;
  if (slice.nextOffset !== undefined) {
    if (slice.next !== undefined) return `${head}; showing ${pageRange(slice)}. next: ${slice.next}`;
    return `${head}; showing ${pageRange(slice)}. Raise --limit, or narrow the target with --kind or --path, to see the rest.`;
  }
  const where = slice.shown > 0
    ? `showing ${pageRange(slice)}, the end of what it returned`
    : offset > 0 ? `--offset ${offset} is beyond the rows it returned` : "showing 0";
  return `${head}; ${where}. Narrow the target with --kind or --path to see the rest.`;
}

/** The message for a page that starts at or past the end of the list. */
function pastEndMessage(slice: Slice<unknown>, relation: string): string {
  return `${slice.total} ${relation}; --offset ${slice.offset ?? 0} is past the end.`;
}

function isPastEnd(slice: Slice<unknown>): boolean {
  // A capped list has no known end, so no offset is known to be past it.
  return !slice.capped && slice.total > 0 && (slice.offset ?? 0) >= slice.total;
}

// ── Row locations ──────────────────────────────────────────────────────────

function lineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Where a row's entity is, read off the graph node the row was built from.
 *
 * Every one of these rows already had the node in hand and printed a name from
 * it. A bare name costs the reader a `locate` before it can do anything, which
 * is a whole turn — around 30k tokens — against the ~30 bytes a path and a span
 * cost here.
 *
 * A file gets no span: its range is the whole file, which says nothing its path
 * does not. Same rule the context bundle's `toLocation` uses.
 */
export function rowLocation(node: any): { path?: string; lineStart?: number; lineEnd?: number } {
  const path = relativePath(
    node?.provenance?.source_uri ?? node?.provenance?.sourceUri ?? node?.attrs?.path ?? undefined,
  );
  if (String(node?.kind ?? "").toLowerCase() === "file") return { path };
  const lineStart = lineNumber(node?.attrs?.line_start);
  const lineEnd = lineNumber(node?.attrs?.line_end);
  return { path, lineStart, lineEnd };
}

/** `17-145`, or `17` when the entity is one line, or nothing when unknown. */
export function lineSpan(loc: { lineStart?: number; lineEnd?: number }): string | undefined {
  if (loc.lineStart === undefined) return undefined;
  return loc.lineEnd !== undefined && loc.lineEnd !== loc.lineStart
    ? `${loc.lineStart}-${loc.lineEnd}`
    : `${loc.lineStart}`;
}

/** `src/a.ts:17-145`, for a row a person reads. */
export function locationLabel(loc: { path?: string; lineStart?: number; lineEnd?: number }): string {
  if (!loc.path) return "";
  const span = lineSpan(loc);
  return span ? `${loc.path}:${span}` : loc.path;
}

/**
 * The ids a list of rows should print: only where nothing else on the row
 * tells it apart from another row in the same answer.
 *
 * Every search and edge row used to carry an 8-character id, and nothing an
 * agent does next takes one — `read`, `callers` and `explain` are all called
 * by name and narrowed with `--path`. Two rows with the same name, kind and
 * path are the exception: nothing a caller can pass tells them apart except
 * the id (every symbol command takes one), so those keep it. `lines` is not
 * part of the key because no command takes a span to pick by. A caller who
 * asks for ids with `--fields id` gets them on every row.
 */
export function disambiguatingIds<T>(
  rows: T[],
  key: (row: T) => string,
  id: (row: T) => string | undefined,
): Array<string | undefined> {
  const wanted = requestedFields()?.includes("id") ?? false;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return rows.map((row) => (wanted || (counts.get(key(row)) ?? 0) > 1 ? llmShortId(id(row)) : undefined));
}

/** `path:line`, the form an editor and every agent tool cites. */
export function siteLabel(site: EdgeSite): string {
  return `${site.path}:${site.line}`;
}

export function confidenceColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.5) return chalk.yellow;
  return chalk.red;
}

export function formatContext(result: any, format: string): void {
  if (format === "json") {
    printJson(result);
    return;
  }

  // Text format
  const { claims, conflicts, decisions, intents, metadata } = result;

  console.log(
    "\n" + chalk.bold.cyan(`--- Ix Context: "${metadata.query}" ---`)
  );
  console.log(
    chalk.dim(
      `Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`
    )
  );

  const useCompact = result.compactClaims?.length > 0;
  const displayClaims = useCompact ? result.compactClaims : (claims || []);
  const maxShow = 10;

  if (displayClaims.length > 0) {
    console.log(chalk.bold("\nClaims:"));
    displayClaims.slice(0, maxShow).forEach((c: any) => {
      if (useCompact) {
        const pct = Math.round((c.score ?? 0) * 100);
        const color = confidenceColor(c.score ?? 0);
        const loc = c.lineRange ? `:${c.lineRange[0]}-${c.lineRange[1]}` : '';
        const pathStr = c.path ? chalk.dim(` (${c.path}${loc})`) : '';
        console.log(`  ${color(`[${pct}%]`)} ${c.field}${pathStr}`);
      } else {
        const pct = Math.round((c.finalScore ?? 0) * 100);
        const color = confidenceColor(c.finalScore ?? 0);
        console.log(`  ${color(`[${pct}%]`)} ${c.claim?.statement || 'unknown'}`);
      }
    });
    if (displayClaims.length > maxShow) {
      console.log(chalk.dim(`  ... and ${displayClaims.length - maxShow} more`));
    }
  }

  if (conflicts && conflicts.length > 0) {
    console.log(`\nConflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(
        `  ${chalk.red.bold("!")} ${c.reason}: ${c.recommendation}`
      );
    }
  }

  if (decisions && decisions.length > 0) {
    console.log(`\nDecisions (${decisions.length}):`);
    for (const d of decisions) {
      console.log(`  ${chalk.blue("*")} ${d.title}: ${d.rationale}`);
    }
  }

  if (intents && intents.length > 0) {
    console.log(`\nIntents (${intents.length}):`);
    for (const i of intents) {
      console.log(
        `  ${chalk.magenta(">")} ${i.statement} [${i.status}]`
      );
    }
  }
  console.log();
}

/** Render a flat node list as llm `node` records. */
export function renderNodesLlm(nodes: any[]): string[] {
  return nodes.map((n) => {
    const loc = rowLocation(n);
    return llmLine("node", projectRow([
      ["kind", n.kind],
      ["id", llmShortId(n.id)],
      ["name", n.name || n.attrs?.name || n.attrs?.title || "(unnamed)"],
      ["path", loc.path],
      ["lines", lineSpan(loc)],
    ]));
  });
}

export function formatNodes(nodes: any[], format: string): void {
  if (format === "json") {
    printJson(nodes);
    return;
  }
  if (format === "llm") {
    for (const line of renderNodesLlm(nodes)) console.log(line);
    return;
  }
  if (nodes.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const name = n.name || n.attrs?.name || n.attrs?.title || "(unnamed)";
    if (n.kind === "decision") {
      console.log(
        `  ${chalk.blue("decision")}  ${chalk.dim(shortId)}  ${name}`
      );
    } else {
      // The path is what makes a search row a place rather than a word: a
      // graph with four `config.ts` modules in it answered `ix search config`
      // with four identical-looking rows.
      const where = locationLabel(rowLocation(n));
      console.log(
        `  ${chalk.cyan(n.kind.padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`
        + (where ? `  ${chalk.dim(where)}` : ""),
      );
    }
  }
}

export function formatDecisions(nodes: any[], format: string): void {
  if (format === "json") {
    printJson(nodes);
    return;
  }
  if (nodes.length === 0) {
    console.log("No decisions found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const rationale = n.attrs?.rationale ?? "";
    console.log(
      `  ${chalk.blue("*")} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
    if (rationale) {
      console.log(`    ${chalk.gray(rationale)}`);
    }
  }
}

const BUG_STATUS_ICONS: Record<string, string> = {
  open: "○",
  investigating: "◐",
  resolved: "●",
  closed: "✓",
};

export function formatBugs(nodes: any[], format: string): void {
  if (format === "json") {
    printJson(nodes);
    return;
  }
  if (nodes.length === 0) {
    console.log("No bugs found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const status = n.attrs?.status ?? "open";
    const severity = n.attrs?.severity ?? "medium";
    const icon = BUG_STATUS_ICONS[status] ?? "?";
    console.log(
      `  ${icon} ${chalk.dim(`[${status}]`.padEnd(16))} ${chalk.red(severity.padEnd(8))} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
  }
}

/** Render patch records as llm `patch` lines. */
export function renderPatchesLlm(patches: any[]): string[] {
  return patches.map((p) => llmLine("patch", [
    ["rev", p.rev],
    ["id", p.patch_id?.slice(0, 12)],
    ["intent", p.intent || undefined],
    ["ts", p.timestamp],
    ["source", relativePath(p.source?.uri) || undefined],
  ]));
}

export function formatPatches(patches: any[], format: string): void {
  if (format === "json") {
    const compact = patches.map(p => ({
      rev: p.rev,
      patch_id: p.patch_id?.slice(0, 12),
      intent: p.intent || undefined,
      timestamp: p.timestamp,
      source: relativePath(p.source?.uri) || undefined,
    }));
    printJson(compact);
    return;
  }
  if (format === "llm") {
    for (const line of renderPatchesLlm(patches)) console.log(line);
    return;
  }
  if (patches.length === 0) {
    console.log("No patches found.");
    return;
  }
  for (const p of patches) {
    const shortPatchId =
      p.patch_id.length > 8 ? p.patch_id.slice(0, 8) : p.patch_id;
    const intentPart = p.intent
      ? chalk.white(p.intent)
      : chalk.dim("(no intent)");
    console.log(
      `  rev ${chalk.cyan.bold(String(p.rev))}  ${chalk.dim(shortPatchId)}  ${intentPart}`
    );
  }
}

export function formatIntents(intents: any[], format: string): void {
  if (format === "json") {
    printJson(intents);
    return;
  }
  if (intents.length === 0) {
    console.log("No intents found.");
    return;
  }

  // Build parent-child map
  const childrenMap = new Map<string, any[]>();
  const roots: any[] = [];

  for (const intent of intents) {
    const parentId = intent.attrs?.parent_intent ?? intent.parentIntent;
    if (parentId) {
      const siblings = childrenMap.get(parentId) || [];
      siblings.push(intent);
      childrenMap.set(parentId, siblings);
    } else {
      roots.push(intent);
    }
  }

  function printIntent(intent: any, indent: string, isChild: boolean): void {
    const prefix = isChild
      ? `${indent}${chalk.dim("\u2514\u2500")} `
      : `${indent}${chalk.magenta(">")} `;
    const statement = intent.attrs?.statement ?? intent.statement ?? "(unknown)";
    const status = intent.attrs?.status ?? intent.status ?? "unknown";
    const conf = intent.attrs?.confidence ?? intent.confidence ?? 0;
    const pctStr = `(${(conf * 100).toFixed(0)}%)`;
    const color = confidenceColor(conf);
    console.log(
      `${prefix}${statement} [${status}] ${color(pctStr)}`
    );

    const children = childrenMap.get(intent.id) || [];
    for (const child of children) {
      printIntent(child, indent + "  ", true);
    }
  }

  for (const root of roots) {
    printIntent(root, "  ", false);
  }
}

/** Render a revision diff as llm records: a header then one `change` row per entity change. */
export function renderDiffLlm(result: any): string[] {
  const changes = result.changes ?? [];
  const lines = [llmLine("diff", [["from", result.fromRev], ["to", result.toRev], ["changes", changes.length]])];
  for (const c of changes) {
    const node = c.changeType === "removed" ? c.atFromRev : c.atToRev;
    const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
    lines.push(llmLine("change", [
      ["type", c.changeType],
      ["kind", node?.kind],
      ["name", name],
      ["summary", c.summary || undefined],
    ]));
  }
  return lines;
}

export function formatDiff(result: any, format: string): void {
  if (format === "json") {
    printJson(result);
    return;
  }
  if (format === "llm") {
    for (const line of renderDiffLlm(result)) console.log(line);
    return;
  }
  console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
  if (!result.changes?.length) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }

  const added = result.changes.filter((c: any) => c.changeType === "added");
  const modified = result.changes.filter((c: any) => c.changeType === "modified");
  const removed = result.changes.filter((c: any) => c.changeType === "removed");
  const legacy = result.changes.filter((c: any) => c.changeType === "added_or_modified");

  if (added.length > 0) {
    console.log(chalk.green.bold(`\n  Added (${added.length}):`));
    for (const c of added) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.green("+")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (modified.length > 0) {
    console.log(chalk.yellow.bold(`\n  Modified (${modified.length}):`));
    for (const c of modified) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (removed.length > 0) {
    console.log(chalk.red.bold(`\n  Removed (${removed.length}):`));
    for (const c of removed) {
      const node = c.atFromRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.red("-")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }

  if (legacy.length > 0) {
    console.log(chalk.yellow.bold(`\n  Changed (${legacy.length}):`));
    for (const c of legacy) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }
  console.log();
}

export interface TextResult {
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  engine: string;
  score: number;
  language?: string;
  symbol_hint?: string;
}

/** How `ix text` paged: whether the scan window filled before ripgrep ran out of matches. */
export interface TextPaging {
  /**
   * More matches existed than the scan window kept. Pages are cut from that
   * window, so the page that reaches its end has no next page even though the
   * search does — the caller has to narrow the search instead.
   */
  windowFull?: boolean;
}

/**
 * Whether a text page starts past the last match. Only when the scan window
 * held every match: a full window is not the end of the search, so an offset
 * beyond it is not past the end of anything the caller can know.
 */
function isTextPastEnd(slice: Slice<TextResult>, paging?: TextPaging): boolean {
  return !paging?.windowFull && isPastEnd(slice);
}

/**
 * What a text page left out, and how to get it: the next page while the scan
 * window has rows left, a narrower search once the page reached the window's
 * end. Undefined when nothing was left out.
 */
function textTruncationMessage(slice: Slice<TextResult>, paging?: TextPaging): string | undefined {
  if (isTextPastEnd(slice, paging)) return undefined;
  const range = pageRange(slice);
  if (slice.nextOffset !== undefined) {
    return `${slice.total} matches scanned; showing ${range}. next: ${slice.next ?? `--offset ${slice.nextOffset}`}`;
  }
  if (paging?.windowFull && slice.shown > 0) {
    return `${slice.total} matches scanned; showing ${range}; the scan stops at ${slice.total}. Narrow with --path or --language, or raise --limit.`;
  }
  if (paging?.windowFull && (slice.offset ?? 0) >= slice.total) {
    return `${slice.total} matches scanned; --offset ${slice.offset ?? 0} is past the scan window, which stops at ${slice.total}. Narrow with --path or --language, or raise --limit.`;
  }
  if (slice.truncated) {
    return `${slice.total} matches scanned; showing ${range}. Narrow with --path or --language, or raise --limit.`;
  }
  return undefined;
}

/**
 * Render lexical search hits as llm `match` records (one per line).
 *
 * No `lang=`: the extension on `path` already says it, and on a 20-row answer
 * the field was ~80 tokens of nothing. `--format json` keeps `language`.
 *
 * `scanned` is the size of the ranked scan window, not the number of matches
 * in the repo; pages (`--offset`) are cut from that window.
 */
export function renderTextResultsLlm(slice: Slice<TextResult>, paging?: TextPaging): string[] {
  const message = textTruncationMessage(slice, paging);
  const lines = [llmLine("text", [
    ["offset", slice.offset ? slice.offset : undefined],
    ["shown", slice.shown],
    ["scanned", slice.total],
    ["truncated", slice.truncated || message !== undefined || undefined],
  ])];
  if (message !== undefined) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["next_offset", slice.nextOffset],
      ["message", message],
    ]));
  }
  if (slice.rows.length === 0 && isTextPastEnd(slice, paging)) {
    lines.push(llmLine("diagnostic", [
      ["code", "offset_past_end"],
      ["message", pastEndMessage(slice, "matches scanned")],
    ]));
  }
  for (const r of slice.rows) {
    lines.push(llmLine("match", [
      ["path", relativePath(r.path) ?? r.path],
      ["line", r.line_start],
      ["symbol", r.symbol_hint],
      ["snippet", r.snippet.trim()],
    ]));
  }
  return lines;
}

export function formatTextResults(slice: Slice<TextResult>, format: string, paging?: TextPaging): void {
  const results = slice.rows;
  if (format === "json") {
    // A raw array on purpose: the plugin runners parse it as one. Paging state
    // stays out of it; a JSON caller's next offset is its offset plus the
    // array's length.
    const compact = results.map(r => ({
      ...r,
      path: relativePath(r.path) ?? r.path,
    }));
    printJson(compact);
    return;
  }
  if (format === "llm") {
    for (const line of renderTextResultsLlm(slice, paging)) console.log(line);
    return;
  }
  if (results.length === 0) {
    console.log(isTextPastEnd(slice, paging)
      ? pastEndMessage(slice, "matches scanned")
      : textTruncationMessage(slice, paging) ?? "No text matches found.");
    return;
  }
  for (const r of results) {
    const lang = r.language ? chalk.magenta(`[${r.language}]`) + " " : "";
    const sym = r.symbol_hint ? chalk.yellow(`(${r.symbol_hint})`) + " " : "";
    console.log(
      `  ${lang}${chalk.dim(r.path)}${chalk.cyan(":" + r.line_start)}  ${sym}${r.snippet.trim()}`
    );
  }
  const message = textTruncationMessage(slice, paging);
  if (message !== undefined) console.log(chalk.dim(`  ${message}`));
}

export interface LocateResult {
  kind: string;
  id?: string;
  name: string;
  file?: string;
  line?: number;
  source: "graph" | "ripgrep";
}

export function formatLocateResults(results: LocateResult[], format: string): void {
  if (format === "json") {
    printJson(results);
    return;
  }
  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const r of results) {
    const shortId = r.id ? chalk.dim(r.id.slice(0, 8)) + "  " : "";
    const filePart = r.file ? chalk.dim(r.file) + (r.line ? chalk.cyan(`:${r.line}`) : "") : "";
    console.log(`  ${chalk.cyan(r.kind)}  ${shortId}${chalk.bold(r.name)}`);
    if (filePart) {
      console.log(`    ${filePart}`);
    }
  }
}

/**
 * Render edge-query results (callers/callees/contains/imports/imported-by) as
 * llm records: a header line keyed by the relation, optional diagnostic lines,
 * then one `ref` row per related entity. Unresolved targets carry resolved=false.
 */
/**
 * The candidates an `--all` edge query ran over. Rows carry `candidate: <n>`,
 * numbering into this list.
 */
export interface EdgeCandidate {
  n: number;
  id: string;
  name: string;
  kind: string;
  path?: string;
}

export function renderEdgeResultsLlm(
  slice: Slice<any>, relation: string, symbol: string,
  source?: ResultSource, diagnostics?: Diagnostic[], candidates?: EdgeCandidate[],
): string[] {
  const refs = slice.rows.map((n: any) => {
    const name = n.name || n.attrs?.name || "";
    return {
      resolved: !!name && !isRawIdName(name),
      name,
      kind: n.kind ?? undefined,
      id: n.id ?? undefined,
      site: n.site as EdgeSite | undefined,
      candidate: typeof n.candidate === "number" ? n.candidate as number : undefined,
      ...rowLocation(n),
    };
  });
  const ids = disambiguatingIds(
    refs,
    (r) => `${r.name}\u0000${r.kind ?? ""}\u0000${r.path ?? ""}`,
    (r) => r.id,
  );
  const unresolved = refs.filter((r) => !r.resolved).length;
  const lines = [llmLine(relation, [
    ["target", symbol],
    ["offset", slice.offset ? slice.offset : undefined],
    ["shown", slice.shown],
    ["total", slice.total],
    ["resolved", refs.length - unresolved],
    ["unresolved", unresolved > 0 ? unresolved : undefined],
    ["source", source && source !== "graph" ? source : undefined],
    ["candidates", candidates ? candidates.length : undefined],
  ])];
  for (const c of candidates ?? []) {
    lines.push(llmLine("candidate", [
      ["n", c.n], ["name", c.name], ["kind", c.kind],
      ["path", c.path ? relativePath(c.path) ?? c.path : undefined], ["id", llmShortId(c.id)],
    ]));
  }
  if (slice.truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["next_offset", slice.nextOffset],
      ["message", truncationHint(slice, relation)],
    ]));
  }
  if (refs.length === 0 && isPastEnd(slice)) {
    lines.push(llmLine("diagnostic", [["code", "offset_past_end"], ["message", pastEndMessage(slice, relation)]]));
  } else if (refs.length === 0 && !slice.truncated && (!diagnostics || diagnostics.length === 0)) {
    lines.push(llmLine("diagnostic", [["code", "no_edges"], ["message", `No ${relation} edges found.`]]));
  }
  for (const d of diagnostics ?? []) {
    lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
  }
  refs.forEach((ref, i) => {
    // Which `--all` candidate the row belongs to. Outside projectRow: a row
    // that lost it under `--fields` could not be attributed at all.
    const tag: Array<[string, LlmValue]> = ref.candidate !== undefined ? [["candidate", ref.candidate]] : [];
    // An unresolved row has no name to go by, so its id is all there is.
    lines.push(ref.resolved
      ? llmLine("ref", [...projectRow([
          ["name", ref.name], ["kind", ref.kind], ["id", ids[i]],
          ["path", ref.path], ["lines", lineSpan(ref)],
          ["site", ref.site ? siteLabel(ref.site) : undefined],
          ["also", ref.site?.also?.join(",")],
          ["snippet", ref.site?.snippet],
        ]), ...tag])
      : llmLine("ref", [...projectRow([["kind", ref.kind], ["id", llmShortId(ref.id)], ["resolved", false]]), ...tag]));
  });
  return lines;
}

export function formatEdgeResults(
  slice: Slice<any>, relation: string, symbol: string, format: string,
  resolvedTarget?: { id: string; kind: string; name: string; resolutionMode?: string },
  source?: ResultSource,
  diagnostics?: Diagnostic[],
  candidates?: EdgeCandidate[],
): void {
  const nodes = slice.rows;

  if (format === "llm") {
    for (const line of renderEdgeResultsLlm(slice, relation, symbol, source, diagnostics, candidates)) {
      console.log(line);
    }
    return;
  }

  if (format === "json") {
    const results = nodes.map((n: any) => {
      const name = n.name || n.attrs?.name || "";
      const resolved = !!name && !isRawIdName(name);
      const ref: any = {
        name: resolved ? name : undefined,
        kind: n.kind ?? undefined,
        id: resolved ? n.id : undefined,
        ...rowLocation(n),
        ...(n.site ? { site: n.site } : {}),
        ...(typeof n.candidate === "number" ? { candidate: n.candidate } : {}),
      };
      if (!resolved) {
        ref.resolved = false;
        if (n.id) {
          ref.rawId = n.id;
          ref.diagnostic = "unresolved_call_target";
        }
      }
      return ref;
    });

    const output: any = {
      results,
      resultSource: source ?? "graph",
    };
    if (resolvedTarget) {
      output.resolvedTarget = {
        ...resolvedTarget,
        path: relativePath((resolvedTarget as any).path),
      };
      if (resolvedTarget.resolutionMode && resolvedTarget.resolutionMode !== "exact") {
        output.resolutionMode = resolvedTarget.resolutionMode;
      }
    }
    if (candidates) {
      output.resolutionMode = "all";
      output.candidates = candidates.map((c) => ({ ...c, path: relativePath(c.path) ?? c.path }));
    }
    if (nodes.length === 0) {
      output.diagnostics = isPastEnd(slice)
        ? [{ code: "offset_past_end", message: pastEndMessage(slice, relation) }]
        : diagnostics ?? (slice.truncated ? undefined : [{ code: "no_edges", message: `No ${relation} edges found for resolved entity.` }]);
    } else if (diagnostics && diagnostics.length > 0) {
      output.diagnostics = diagnostics;
    }
    if (slice.truncated) {
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        { code: "results_truncated", message: truncationHint(slice, relation) },
      ];
    }
    const unresolvedCount = results.filter((r: any) => r.resolved === false).length;
    if (unresolvedCount > 0) {
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        { code: "dangling_reference_filtered", message: `${unresolvedCount} result(s) could not be resolved to named entities.` },
      ];
    }
    output.summary = {
      shown: slice.shown,
      total: slice.total,
      resolved: results.length - unresolvedCount,
      unresolved: unresolvedCount,
      truncated: slice.truncated,
      offset: slice.offset ?? 0,
      ...(slice.nextOffset !== undefined ? { nextOffset: slice.nextOffset } : {}),
      // `total` is then a lower bound: the server stopped at its edge cap.
      ...(slice.capped ? { capped: true } : {}),
    };
    printJson(output);
    return;
  }
  if (nodes.length === 0) {
    const reason = isPastEnd(slice)
      ? pastEndMessage(slice, relation)
      : slice.truncated
        ? truncationHint(slice, relation)
        : diagnostics?.[0]?.message ?? `No ${relation} found for "${symbol}".`;
    console.log(reason);
    return;
  }
  console.log(`${chalk.bold(relation)} of ${chalk.cyan(symbol)}:`);
  if (source && source !== "graph") {
    console.log(chalk.dim(`Source: ${source}`));
  }
  for (const c of candidates ?? []) {
    const where = c.path ? ` in ${relativePath(c.path) ?? c.path}` : "";
    console.log(chalk.dim(`  [${c.n}] ${c.kind} ${c.name}${where}`));
  }
  for (const n of nodes) {
    const name = n.name || n.attrs?.name || "";
    const shortId = n.id?.slice(0, 8) ?? "";
    if (!name || isRawIdName(name)) {
      console.log(`  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.dim("(unresolved)")}`);
    } else {
      const where = locationLabel(rowLocation(n));
      console.log(
        `  ${chalk.cyan((n.kind ?? "").padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`
        + (where ? `  ${chalk.dim(where)}` : "")
        + (typeof n.candidate === "number" ? `  ${chalk.dim(`[${n.candidate}]`)}` : ""),
      );
      const site = n.site as EdgeSite | undefined;
      if (site) console.log(`      ${chalk.dim(`at ${siteLabel(site)}`)}  ${site.snippet}`);
    }
  }
  if (slice.truncated) console.log(chalk.dim(`  ${truncationHint(slice, relation)}`));
}

/** Render detected conflicts as llm `conflict` records. */
export function renderConflictsLlm(conflicts: any[]): string[] {
  const lines = [llmLine("conflicts", [["count", conflicts.length]])];
  for (const c of conflicts) {
    lines.push(llmLine("conflict", [
      ["reason", c.reason],
      ["recommendation", c.recommendation],
      ["claim_a", llmShortId(c.claimA)],
      ["claim_b", llmShortId(c.claimB)],
    ]));
  }
  return lines;
}

export function formatConflicts(conflicts: any[], format: string): void {
  if (format === "json") {
    printJson(conflicts);
    return;
  }
  if (format === "llm") {
    for (const line of renderConflictsLlm(conflicts)) console.log(line);
    return;
  }
  if (conflicts.length === 0) {
    console.log("No conflicts detected.");
    return;
  }
  for (const c of conflicts) {
    console.log(`  ${chalk.red.bold("!")} ${c.reason}`);
    console.log(`    ${chalk.yellow(c.recommendation)}`);
    console.log(`    Claims: ${c.claimA} vs ${c.claimB}`);
  }
}

/** A resolved or unresolved reference to a related entity. */
export interface EntityRef {
  name: string;
  kind?: string;
  id?: string;
  resolved: boolean;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  suggestedCommand?: string;
}

export type DiagnosticCode =
  | "unresolved_call_target"
  | "parser_gap_suspected"
  | "dangling_reference_filtered"
  | "ambiguous_resolution"
  | "no_edges"
  | "text_fallback_used"
  | "stale_source"
  | "unfiltered_search"
  | "graph_degraded"
  | "candidates_truncated";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
}

export interface ExplainResult {
  kind: string;
  name: string;
  id: string;
  file?: string;
  chunkKind?: string;
  container?: { kind: string; name: string };
  introducedRev: number;
  calledBy: number;
  calls: number;
  contains: number;
  historyLength: number;
  signature?: string;
  docstring?: string;
  callList?: EntityRef[];
  diagnostics?: Diagnostic[];
}

export function formatExplain(result: ExplainResult, format: string): void {
  if (format === "json") {
    const output: any = {
      resolvedTarget: { id: result.id, kind: result.kind, name: result.name },
      result: stripNulls({
        kind: result.kind,
        name: result.name,
        id: result.id,
        file: relativePath(result.file),
        chunkKind: result.chunkKind ?? null,
        container: result.container,
        introducedRev: result.introducedRev,
        calledBy: result.calledBy,
        calls: result.calls,
        contains: result.contains,
        historyLength: result.historyLength,
        signature: result.signature ?? null,
        docstring: result.docstring ?? null,
        callList: result.callList,
      }),
    };
    if (result.diagnostics && result.diagnostics.length > 0) {
      output.diagnostics = result.diagnostics;
    }
    printJson(output);
    return;
  }
  const shortId = result.id.slice(0, 8);
  if (result.signature) {
    console.log(`  ${chalk.green(result.signature)}`);
  } else {
    console.log(`  ${chalk.cyan(result.kind)} ${chalk.bold(result.name)} ${chalk.dim(shortId)}`);
  }
  if (result.docstring) {
    console.log(`  ${chalk.dim('"' + result.docstring + '"')}`);
  }
  if (result.container) {
    console.log(`  ${chalk.dim("in")} ${chalk.cyan(result.container.kind)} ${result.container.name}`);
  }
  if (result.file) {
    console.log(`  ${chalk.dim("file")} ${result.file}`);
  }
  if (result.chunkKind) {
    console.log(`  ${chalk.dim("chunk kind")} ${result.chunkKind}`);
  }
  console.log(`  ${chalk.dim("introduced rev")} ${result.introducedRev}`);
  if (result.calledBy > 0) console.log(`  ${chalk.dim("called by")} ${result.calledBy} methods`);
  if (result.callList && result.callList.length > 0) {
    console.log(`  ${chalk.dim("calls:")}`);
    for (const c of result.callList) {
      const label = c.resolved
        ? c.name
        : chalk.dim(`${c.name} (unresolved)`);
      console.log(`    ${label}`);
    }
  } else if (result.calls > 0) {
    console.log(`  ${chalk.dim("calls")} ${result.calls} methods`);
  }
  if (result.contains > 0) console.log(`  ${chalk.dim("contains")} ${result.contains} members`);
  if (result.historyLength > 0) console.log(`  ${chalk.dim("history")} ${result.historyLength} patches`);
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      console.log(`  ${chalk.dim(`[${d.code}]`)} ${d.message}`);
    }
  }
}
