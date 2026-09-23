// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../../client/api.js";
import { relativePath } from "../format.js";
import type { EntityLocation } from "./facts.js";

/**
 * Files two steps from a context target, ranked.
 *
 * The facts collector reads one hop: what the target imports, calls, and is
 * called or imported by. On the ix-bench task set, every expected file a bundle
 * missed was one step further out, in one of two shapes:
 *
 *  - **a neighbour's import.** `reset.ts` calls the target and imports
 *    `client/api.ts`, where the fix lives; `context.ts` calls
 *    `parseBudgetOption` and imports the schema the new flag has to join.
 *  - **a sibling.** A file that depends on what the target depends on:
 *    `main.ts` imports the same two registration modules as `mcp/runner.ts`,
 *    and `rank.ts` calls the same listing helpers as `inventory.ts`.
 *
 * Both are two-hop paths in the graph, so one bounded walk finds both. The
 * work is in the ranking, because two hops from anything reaches most of a
 * repository: `config.ts`, `format.ts` and the command registry are two steps
 * from every command. Three things keep them from crowding out the answer:
 *
 *  1. a path is worth `1/degree` of the node it runs through, and less again
 *     for a busy node at its far end. Sharing `listByKind` with the target
 *     (five callers) is evidence; sharing `resolveWorkspaceId` (forty) is not,
 *     and a logarithmic discount left `rank.ts` twelfth behind every command
 *     that shares only the common helpers. With `1/degree` it is second;
 *  2. a candidate file is divided by `log2(2 + its import degree)`, measured
 *     on the whole graph, so a module everything imports -- or one that
 *     imports everything -- has to be reached many ways to rank;
 *  3. test files, and paths that run through them, count a fifth: a test
 *     imports the target and everything around it, which makes it a bridge
 *     to everywhere rather than evidence of anything. A test target is exempt.
 *
 * Files the bundle already names one step out -- imports, callers, callees,
 * dependents, neighbours -- are skipped: the eight slots are for files a
 * one-hop bundle cannot reach, and on the benchmark set most of the top-ranked
 * candidates were the target's own imports.
 */

export interface RelatedRef extends EntityLocation {
  /** Higher is closer. Comparable within one target only. */
  score: number;
  /** Why this file is here, for the evidence row. */
  reason: string;
  /** The names it was reached through, most weight first; empty when direct. */
  via: string[];
  /** Set when the link is textual rather than a graph edge: `named in watch.ts`. */
  named?: string;
}

/** How many related files a bundle carries. */
export const MAX_RELATED = 8;

const WALK_PREDICATES = ["IMPORTS", "CALLS", "REFERENCES"];
/** A file target's members that seed the walk, most-used first. */
const MAX_MEMBER_SEEDS = 40;
/** A symbol target's direct neighbours whose files also seed the walk. */
const MAX_NEIGHBOUR_SEEDS = 6;
/** A second-hop path's weight relative to a direct link. */
const SECOND_HOP_WEIGHT = 0.5;
/** Weight of a test file, or of a path that runs through one. */
const TEST_WEIGHT = 0.2;
/** Leading candidates whose import degree is measured before the final rank. */
const DEGREE_POOL = 40;
const CONCURRENCY = 8;

interface GraphNodeLike {
  id: string;
  kind?: string;
  name?: string;
  attrs?: Record<string, unknown>;
  provenance?: { sourceUri?: string | null; source_uri?: string | null } | null;
}

interface GraphEdgeLike {
  src: string;
  dst: string;
}

/**
 * A test, or test data: a `__tests__/` or fixtures directory, or a `*.test.*`
 * / `*.spec.*` file. Fixtures are here because they are a bridge in the same
 * way: calls to vitest's global `describe` resolve to a fixture method of that
 * name, which linked `test-fixtures/typescript/sample-command.ts` to every test
 * in the repository.
 */
export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|__fixtures__|(test-)?fixtures)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);
}

export async function collectRelatedFiles(
  client: Pick<IxClient, "expand">,
  target: { id: string; kind: string },
  facts: {
    path?: string;
    memberRefs?: EntityLocation[];
    calleeRefs?: EntityLocation[];
    topCallerRefs?: EntityLocation[];
    topDependentRefs?: EntityLocation[];
    importRefs?: EntityLocation[];
    neighbourRefs?: EntityLocation[];
  },
  limit = MAX_RELATED,
): Promise<RelatedRef[]> {
  const targetPath = facts.path;
  const targetIsTest = targetPath ? isTestPath(targetPath) : false;

  // Seeds. A file's own edges are few -- its imports -- and its members carry
  // the calls, so a file is walked from its members too. A symbol is walked
  // from itself, its file, and the files of its direct neighbours: the
  // neighbour-import shape runs symbol -> caller -> caller's FILE -> import,
  // which is a CONTAINS step the walk's predicates do not take.
  const nodes = new Map<string, GraphNodeLike>();
  const seeds = [target.id];
  if (target.kind === "file") {
    for (const ref of (facts.memberRefs ?? []).slice(0, MAX_MEMBER_SEEDS)) seeds.push(ref.id);
  }
  // The target and its own members. A file one step from these is linked to
  // the target; one step from a neighbour's file is reached through it.
  const ownSeeds = new Set(seeds);
  if (target.kind !== "file") {
    const near = [
      target.id,
      ...[...(facts.topCallerRefs ?? []), ...(facts.topDependentRefs ?? []), ...(facts.calleeRefs ?? [])]
        .slice(0, MAX_NEIGHBOUR_SEEDS)
        .map((ref) => ref.id),
    ];
    const containers = await mapLimit(near, (id) =>
      client.expand(id, { direction: "in", predicates: ["CONTAINS"], hops: 2 }).catch(() => EMPTY));
    for (const result of containers) {
      for (const node of result.nodes as GraphNodeLike[]) {
        if (node.kind === "file" && !seeds.includes(node.id)) {
          seeds.push(node.id);
          nodes.set(node.id, node);
        }
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a)!.add(b);
  };
  const walks = await mapLimit(seeds, (id) =>
    client.expand(id, { direction: "both", predicates: WALK_PREDICATES, hops: 2 }).catch(() => EMPTY));
  for (const walk of walks) {
    for (const node of walk.nodes as GraphNodeLike[]) nodes.set(node.id, node);
    for (const edge of walk.edges as GraphEdgeLike[]) {
      link(edge.src, edge.dst);
      link(edge.dst, edge.src);
    }
  }

  const pathOf = (id: string): string | undefined => {
    const node = nodes.get(id);
    return relativePath(node?.provenance?.sourceUri ?? node?.provenance?.source_uri ?? undefined);
  };
  const degree = (id: string) => adjacency.get(id)?.size ?? 0;
  const seedSet = new Set(seeds);

  // Score per file, remembering the heaviest node reached in it (the entity to
  // show when the file itself has no node in the walk) and the nodes it was
  // reached through (the reason).
  type Candidate = { score: number; direct: boolean; best?: { id: string; weight: number }; via: Map<string, number> };
  const candidates = new Map<string, Candidate>();
  const credit = (path: string, weight: number, reached: string, via: string | undefined, direct: boolean) => {
    let c = candidates.get(path);
    if (!c) candidates.set(path, (c = { score: 0, direct: false, via: new Map() }));
    c.score += weight;
    c.direct ||= direct;
    if (!c.best || weight > c.best.weight) c.best = { id: reached, weight };
    if (via) c.via.set(via, (c.via.get(via) ?? 0) + weight);
  };

  for (const seed of seeds) {
    for (const mid of adjacency.get(seed) ?? []) {
      if (seedSet.has(mid)) continue;
      const midPath = pathOf(mid);
      if (!midPath) continue;
      if (midPath !== targetPath) {
        const own = ownSeeds.has(seed);
        credit(midPath, 1, mid, own ? undefined : seed, own);
      }
      const throughTest = !targetIsTest && isTestPath(midPath);
      const midWeight = SECOND_HOP_WEIGHT / Math.max(1, degree(mid)) * (throughTest ? TEST_WEIGHT : 1);
      for (const far of adjacency.get(mid) ?? []) {
        if (far === seed || seedSet.has(far)) continue;
        const farPath = pathOf(far);
        if (!farPath || farPath === targetPath) continue;
        credit(farPath, midWeight / Math.log2(2 + degree(far)), far, mid, false);
      }
    }
  }
  if (targetPath) candidates.delete(targetPath);
  for (const ref of [
    ...(facts.importRefs ?? []), ...(facts.calleeRefs ?? []), ...(facts.topCallerRefs ?? []),
    ...(facts.topDependentRefs ?? []), ...(facts.neighbourRefs ?? []), ...(facts.memberRefs ?? []),
  ]) {
    if (ref.path) candidates.delete(ref.path);
  }

  for (const [path, c] of candidates) {
    if (!targetIsTest && isTestPath(path)) c.score *= TEST_WEIGHT;
  }

  // File nodes seen in the walk, by path: the entity a related file is shown
  // as, and the node its import degree is read from.
  const fileNodes = new Map<string, GraphNodeLike>();
  for (const node of nodes.values()) {
    const path = node.kind === "file" ? pathOf(node.id) : undefined;
    if (path) fileNodes.set(path, node);
  }

  const pool = [...candidates.entries()]
    .sort((a, b) => b[1].score - a[1].score || cmp(a[0], b[0]))
    .slice(0, DEGREE_POOL);
  const degrees = await mapLimit(pool, async ([path, c]) => {
    // A file reached only through a call has no node of its own in the walk,
    // and an unmeasured file escaped the penalty entirely: `format.ts`,
    // imported by thirty commands, ranked as if nothing imported it. Its node
    // is one CONTAINS step above whatever was reached in it.
    if (!fileNodes.has(path) && c.best) {
      const up = await client.expand(c.best.id, { direction: "in", predicates: ["CONTAINS"], hops: 2 }).catch(() => EMPTY);
      const file = (up.nodes as GraphNodeLike[]).find((n) => n.kind === "file");
      if (file) fileNodes.set(path, file);
    }
    const file = fileNodes.get(path);
    if (!file) return undefined;
    const result = await client.expand(file.id, { direction: "both", predicates: ["IMPORTS"] }).catch(() => undefined);
    return result?.nodes.length;
  });

  const ranked = pool.map(([path, c], index) => {
    // A file with no node in the walk cannot be measured; the busiest node
    // reached in it stands in, so an unmeasured file is not the only one
    // spared the penalty.
    const measured = degrees[index] ?? (c.best ? degree(c.best.id) : 0);
    return { path, c, score: c.score / Math.log2(2 + measured) };
  }).sort((a, b) => b.score - a.score || cmp(a.path, b.path));

  return ranked.slice(0, limit).map(({ path, c, score }) => {
    const file = fileNodes.get(path);
    const shown = file ?? (c.best ? nodes.get(c.best.id) : undefined);
    const via = [...c.via.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => nodes.get(id)?.name)
      .filter((name): name is string => !!name && name !== path.split("/").pop());
    const through = [...new Set(via)].slice(0, 3);
    const reason = c.direct
      ? "linked to the target directly"
      : through.length > 0
        ? `two steps from the target, through ${through.join(", ")}`
        : "two steps from the target";
    return {
      id: shown?.id ?? path,
      name: file ? (file.name ?? path.split("/").pop()!) : (shown?.name ?? path.split("/").pop()!),
      kind: file ? "file" : (shown?.kind ?? "file"),
      path,
      score: Math.round(score * 1000) / 1000,
      reason,
      via: c.direct ? [] : through,
    };
  });
}

const EMPTY = { nodes: [] as unknown[], edges: [] as unknown[] };

async function mapLimit<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
