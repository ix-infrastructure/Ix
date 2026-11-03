// Copyright 2026 Ix Infrastructure Inc.

/**
 * The "used in" line of `ix context --from-issue --lean`: for the first few
 * symbols the issue names, the files outside the symbol's own file that call,
 * import or reference it. An agent handed an issue spends its first greps
 * finding exactly that; this answers it before it starts looking.
 *
 * It has to stay small and cheap, or it is the bundle the lean view replaced:
 * at most `USED_IN_SYMBOLS` symbols, `USED_IN_LISTED` files each, one graph
 * request for all of them, bounded by `USED_IN_TIMEOUT_MS`. Anything that goes
 * wrong -- a timeout, an error, a backend without the route -- leaves the view
 * exactly as it was, so the output is today's, byte for byte.
 */

import type { IxClient } from "../../client/api.js";
import type { StructuredContext } from "../../client/types.js";
import { isTestFile } from "../around.js";
import { relativePath } from "../format.js";
import type { LeanIssueView, LeanStart, StartingPoint, UsedIn } from "./issue.js";

/** Symbol starts that get a line: the first ones, in the view's order. */
export const USED_IN_SYMBOLS = 2;
/** Files listed per symbol; the rest are counted. */
export const USED_IN_LISTED = 5;
/** Above this many files a list is noise: say "widely" and the count. */
export const USED_IN_WIDELY = 25;
/** The whole lookup's bound. The plugin briefing gives the lean call 6 s. */
export const USED_IN_TIMEOUT_MS = 1500;

/** The edges `ix callers` and `ix imported-by` follow inwards. */
const USE_PREDICATES = new Set(["CALLS", "IMPORTS", "REFERENCES"]);

/** Per looked-up node id: each file with a use of it, and how many uses. */
export type UsesById = Map<string, Map<string, number>>;

/** A trusted start that names a code symbol rather than a file. */
function isSymbolStart(s: StartingPoint): boolean {
  return s.via !== "path in issue" && s.kind !== "file";
}

/** The starts a "used in" line is looked up for. */
export function usedInStarts(view: LeanIssueView): StartingPoint[] {
  if (view.confidence !== "high") return [];
  return view.startingPoints.filter(isSymbolStart).slice(0, USED_IN_SYMBOLS);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The files using each of `ids`, from one context response: the incoming
 * CALLS, IMPORTS and REFERENCES edges of each id, each mapped to the file its
 * other end was parsed from. Whole nodes (provenance) or summaries (`path`),
 * whichever the backend sent. An edge whose far end has no file is skipped.
 */
export function usesFromContext(ctx: StructuredContext, ids: string[]): UsesById {
  const pathOf = new Map<string, string>();
  if (Array.isArray(ctx.nodes) && ctx.nodes.length > 0) {
    for (const n of ctx.nodes) {
      const p = relativePath(str(n?.provenance?.sourceUri) ?? str((n?.provenance as { source_uri?: unknown })?.source_uri));
      if (n?.id && p) pathOf.set(n.id, p);
    }
  } else {
    for (const n of ctx.nodeSummaries ?? []) {
      const p = relativePath(str(n?.path));
      if (n?.id && p) pathOf.set(n.id, p);
    }
  }
  const edges: Array<{ id?: string; src: string; dst: string; predicate: string }> =
    Array.isArray(ctx.edges) && ctx.edges.length > 0 ? ctx.edges : (ctx.edgeSummaries ?? []);
  const wanted = new Set(ids);
  const seen = new Set<string>();
  const uses: UsesById = new Map();
  for (const e of edges) {
    if (!e || !wanted.has(e.dst) || e.src === e.dst) continue;
    if (!USE_PREDICATES.has(String(e.predicate).toUpperCase())) continue;
    const key = `${e.src}\u0000${e.dst}\u0000${String(e.predicate).toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const path = pathOf.get(e.src);
    if (!path) continue;
    let files = uses.get(e.dst);
    if (!files) uses.set(e.dst, (files = new Map()));
    files.set(path, (files.get(path) ?? 0) + 1);
  }
  return uses;
}

/**
 * One start's line, or none: its own file and tests dropped, the rest ordered
 * by number of uses, then path.
 */
export function usedInFor(start: StartingPoint, files: Map<string, number> | undefined): UsedIn | undefined {
  if (!files) return undefined;
  const outside = [...files]
    .filter(([path]) => path !== start.path && !isTestFile(path))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = outside.length;
  if (total === 0) return undefined;
  if (total > USED_IN_WIDELY) return { files: [], total, widely: true };
  return { files: outside.slice(0, USED_IN_LISTED).map(([path]) => path), total };
}

/** The view with each looked-up start's line attached. Pure. */
export function withUsedIn(view: LeanIssueView, uses: UsesById): LeanIssueView {
  const targets = new Set(usedInStarts(view));
  let changed = false;
  const startingPoints = view.startingPoints.map((s): LeanStart => {
    if (!targets.has(s) || !s.id) return s;
    const usedIn = usedInFor(s, uses.get(s.id));
    if (!usedIn) return s;
    changed = true;
    return { ...s, usedIn };
  });
  return changed ? { ...view, startingPoints } : view;
}

/**
 * The view with "used in" lines, from one bounded request; on a timeout, an
 * error, a backend that does not answer the route, or a response it cannot
 * read, the view unchanged.
 */
export async function addUsedIn(
  client: Pick<IxClient, "contextForNodes">,
  view: LeanIssueView,
  timeoutMs = USED_IN_TIMEOUT_MS,
): Promise<LeanIssueView> {
  const ids = [...new Set(usedInStarts(view).flatMap((s) => (s.id ? [s.id] : [])))];
  if (ids.length === 0) return view;
  try {
    // Whole nodes: their provenance names the file on every backend, where a
    // summary carries a path only on newer ones.
    const ctx = await client.contextForNodes(ids, { depth: "full", signal: AbortSignal.timeout(timeoutMs) });
    return withUsedIn(view, usesFromContext(ctx, ids));
  } catch {
    return view;
  }
}
