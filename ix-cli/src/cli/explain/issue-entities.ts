// Copyright 2026 Ix Infrastructure Inc.

import type { IxClient } from "../../client/api.js";
import { relativePath } from "../format.js";
import type { EntityLocation } from "./facts.js";
import {
  bm25Doc, bm25QueryWeights, bm25Score, CLOSENESS_BOOST, extractCandidates,
  MAX_BM25_BYTES, MAX_RANKED_FILES,
  type Bm25Doc, type RankedFile, type StartingPoint,
} from "./issue.js";
import type { RepoAccess } from "./text-references.js";

/** Two listings per file, never a request per definition. */
export const ISSUE_ENTITIES_PER_KIND = 256;
/**
 * Only the best-ranked files are listed: two requests each, on every
 * `--from-issue` run, so this bounds the added backend cost.
 */
export const ISSUE_ENTITY_FILES = 5;

/** Include definitions in lexically ranked files even when no start reaches them. */
export async function collectIssueEntities(
  client: Pick<IxClient, "listByKind">,
  files: RankedFile[],
  scope: { workspaceId?: string; systemId?: string },
): Promise<EntityLocation[]> {
  const found = await Promise.all(files.slice(0, ISSUE_ENTITY_FILES).flatMap(({ path }) =>
    ["function", "method"].map(async kind => {
      const nodes = await client.listByKind(kind, {
        ...scope, scope: path, limit: ISSUE_ENTITIES_PER_KIND,
      }).catch(() => []);
      // Older backends may ignore scope. Never let their unrelated prefix into
      // this file's candidate pool, or read a path supplied by such a node.
      return nodes.slice(0, ISSUE_ENTITIES_PER_KIND)
        .filter(n => n.kind === kind && relativePath(n.provenance?.sourceUri) === path)
        .map(n => ({
          id: n.id, name: n.name, kind, path,
          lineStart: positiveLine(n.attrs?.line_start),
          lineEnd: positiveLine(n.attrs?.line_end),
        }));
    })));
  return [...new Map(found.flat().map(n => [n.id, n])).values()];
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface IssueEntityRanking {
  query: string;
  repo?: Pick<RepoAccess, "read">;
  rankedFiles: RankedFile[];
  startingPoints: StartingPoint[];
  /** Direct graph distances established by the already collected facts. */
  distances?: ReadonlyMap<string, number>;
  /**
   * Definitions only the file listing found. They score only when they match
   * an issue word that singles them out: see {@link isDistinctive}.
   */
  listedOnly?: ReadonlySet<string>;
}

/**
 * Whether a query word found in `df` of `n` scored definitions tells them
 * apart: it is in at most half of them, which is where its BM25 IDF reaches
 * log 2. A word in most of them (`return`, `value`, `data` in a body) has an
 * IDF near zero but still a positive score, and on its own let hundreds of
 * unrelated listed helpers into the bundle's reserved match budget. A pool of
 * one definition cannot tell, so its one match counts.
 */
function isDistinctive(df: number, n: number): boolean {
  return df <= Math.max(1, n / 2);
}

/** BM25 dominates; bounded boosts refine it without promoting a zero match. */
export function rankIssueEntities<T extends EntityLocation>(
  entities: T[],
  issue: IssueEntityRanking,
  edges: ReadonlyArray<{ src: string; dst: string }>,
): Array<T & { score: number }> {
  const paths = new Set(issue.rankedFiles.slice(0, MAX_RANKED_FILES).map(f => f.path));
  const lines = new Map<string, string[] | undefined>();
  const weights = bm25QueryWeights(issue.query);
  const wanted = new Set(weights.keys());
  const identifiers = new Set(extractCandidates(issue.query).identifiers);
  const docs = new Map<string, Bm25Doc>();
  const exact = new Map<string, number>();
  for (const entity of entities) {
    if (!paths.has(entity.path ?? "") || !["function", "method"].includes(entity.kind)) continue;
    const path = entity.path!;
    if (!lines.has(path)) {
      const text = issue.repo?.read(path);
      lines.set(path, text !== undefined && Buffer.byteLength(text, "utf8") <= MAX_BM25_BYTES
        ? text.split(/\r?\n/) : undefined);
    }
    const source = lines.get(path);
    const start = positiveLine(entity.lineStart);
    const end = positiveLine(entity.lineEnd);
    // A missing/stale span gets the name only, never the surrounding file's
    // unrelated words. The span includes the signature and Python docstring.
    // The file is the working tree and the span is from the last map, so a
    // span whose opening lines no longer name the definition is stale.
    const body = source && start && end && end >= start && end <= source.length
      && namesDefinition(source, start, end, entity.name)
      ? definitionText(source, start, end) : "";
    const text = `${entity.name}\n${body}`;
    const doc = bm25Doc("", text, wanted);
    if (doc) docs.set(entity.id, doc);
    const hits = new Set([...text.matchAll(/[A-Za-z_$][\w$]*/g)]
      .map(m => m[0]).filter(token => identifiers.has(token)));
    exact.set(entity.id, hits.size);
  }
  const lexical = new Map(bm25Score(docs, weights).map(h => [h.path, h.score]));
  if (issue.listedOnly?.size) {
    const df = new Map<string, number>();
    for (const doc of docs.values()) for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    for (const id of issue.listedOnly) {
      const terms = docs.get(id)?.tf.keys() ?? [];
      if (![...terms].some(t => isDistinctive(df.get(t)!, docs.size))) lexical.delete(id);
    }
  }
  const distances = graphDistances(issue.startingPoints, edges, issue.distances);
  const distance = (id: string) => distances.get(id) ?? Infinity;
  return entities.map((entity, index) => ({
    entity,
    score: (lexical.get(entity.id) ?? 0) * (1
      + CLOSENESS_BOOST / (1 + distance(entity.id))
      + 0.2 * Math.min(exact.get(entity.id) ?? 0, 3)),
    index,
  })).sort((a, b) => b.score - a.score || distance(a.entity.id) - distance(b.entity.id) || a.index - b.index)
    .map(({ entity, score }) => ({ ...entity, score }));
}

/**
 * Order a ranked bundle for the entity budget. The pinned entities (the target
 * and the other starting points) stay first, the best issue matches take at
 * most half of what is left, and everything else keeps its deterministic
 * order. Sorting the whole list by match score instead put every non-function
 * (the target, its imports, its files) behind hundreds of candidates, so the
 * budget cut them and their relationships with them.
 */
export function placeIssueMatches<T extends { id: string }>(
  original: T[],
  ranked: Array<T & { score: number }>,
  pinned: ReadonlySet<string>,
  limit: number,
): Array<T & { score: number }> {
  const scores = new Map(ranked.map(e => [e.id, e.score]));
  const head = original.filter(e => pinned.has(e.id));
  const slots = Math.max(0, Math.ceil((limit - head.length) / 2));
  const matches = ranked.filter(e => e.score > 0 && !pinned.has(e.id)).slice(0, slots);
  const placed = new Set([...head, ...matches].map(e => e.id));
  return [...head, ...matches, ...original.filter(e => !placed.has(e.id))]
    .map(e => ({ ...e, score: scores.get(e.id) ?? 0 }));
}

/** Lines a signature may span after decorators or annotations. */
const SIGNATURE_LINES = 5;

/** Whether the span's opening lines still contain the definition's name. */
function namesDefinition(lines: string[], start: number, end: number, name: string): boolean {
  const own = name.split(/[.#:]/).pop() ?? name;
  const head = lines.slice(start - 1, Math.min(end, start - 1 + SIGNATURE_LINES)).join("\n");
  return [...head.matchAll(/[A-Za-z_$][\w$]*/g)].some(m => m[0] === own);
}

/** Include an adjacent JS/TS doc comment, outside the parser's definition span. */
function definitionText(lines: string[], start: number, end: number): string {
  let first = start - 1;
  if (first > 0 && lines[first - 1].trimEnd().endsWith("*/")) {
    for (let i = first - 1; i >= Math.max(0, first - 64); i--) {
      if (lines[i].trimStart().startsWith("/**")) {
        first = i;
        break;
      }
      if (i < first - 1 && lines[i].includes("*/")) break;
    }
  }
  return lines.slice(first, end).join("\n");
}

/** Undirected multi-source BFS over the graph already returned for the bundle. */
function graphDistances(
  starts: StartingPoint[], edges: ReadonlyArray<{ src: string; dst: string }>,
  known?: ReadonlyMap<string, number>,
): Map<string, number> {
  const adjacent = new Map<string, string[]>();
  for (const { src, dst } of edges) {
    if (!adjacent.has(src)) adjacent.set(src, []);
    if (!adjacent.has(dst)) adjacent.set(dst, []);
    adjacent.get(src)!.push(dst);
    adjacent.get(dst)!.push(src);
  }
  const distances = new Map(known);
  for (const start of starts) if (start.id) distances.set(start.id, 0);
  const queue = [...distances.keys()].sort((a, b) => distances.get(a)! - distances.get(b)!);
  for (let i = 0; i < queue.length; i++) {
    for (const id of adjacent.get(queue[i]) ?? []) {
      const next = distances.get(queue[i])! + 1;
      if ((distances.get(id) ?? Infinity) <= next) continue;
      distances.set(id, next);
      queue.push(id);
    }
  }
  return distances;
}
