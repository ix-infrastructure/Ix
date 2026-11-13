// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmShortId } from "../llm.js";
import { requestedFields } from "../output-shape.js";
import type { EdgeSite } from "../edge-sites.js";

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
