// Copyright 2026 Ix Infrastructure Inc.

/**
 * Cutting a ranked list to `--limit`/`--offset` and saying what was left out.
 */

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
export function isRawIdName(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value) || /^[0-9a-f]{32,}$/i.test(value);
}

function edgeRowPriority(node: any): number {
  // A dispatch row (`ix callers` through a supertype) follows every direct one.
  const dispatch = typeof node.dispatchVia === "string" ? 3 : 0;
  const name = node.name || node.attrs?.name || "";
  const resolved = !!name && !isRawIdName(name);
  if (!resolved) return dispatch + 2;
  const path = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? node.attrs?.path;
  return dispatch + (path ? 0 : 1);
}

/** The supertype member a dispatch row's call targets (`via`), absent on a direct row. */
export function dispatchVia(node: any): string | undefined {
  return typeof node.dispatchVia === "string" ? node.dispatchVia : undefined;
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
export function pageRange(slice: Slice<unknown>): string {
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
export function pastEndMessage(slice: Slice<unknown>, relation: string): string {
  return `${slice.total} ${relation}; --offset ${slice.offset ?? 0} is past the end.`;
}

export function isPastEnd(slice: Slice<unknown>): boolean {
  // A capped list has no known end, so no offset is known to be past it.
  return !slice.capped && slice.total > 0 && (slice.offset ?? 0) >= slice.total;
}
