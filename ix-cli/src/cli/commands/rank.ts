// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import { activeReadScope, ensureReadScope } from "../resolve.js";
import { llmLine } from "../llm.js";
import { normalizePathSeparators } from "../path-match.js";
import { printJson } from "../format.js";
import { mapLimit } from "../../client/request-memo.js";

type Metric = "dependents" | "callers" | "importers" | "members";

/** Render `ix rank` as llm records: a header line then one `entity` row per result (rank = line order). */
export function renderRankLlm(
  metric: string, kind: string, scope: string | null,
  results: Array<{ name: string; kind: string; score: number }>,
  evaluated: number, diagnostics: string[],
): string[] {
  const lines = [llmLine("rank", [
    ["metric", metric], ["kind", kind], ["scope", scope ?? undefined],
    ["evaluated", evaluated], ["returned", results.length],
  ])];
  for (const d of diagnostics) lines.push(llmLine("diagnostic", [["message", d]]));
  for (const r of results) {
    lines.push(llmLine("entity", [["name", r.name], ["kind", r.kind], ["score", r.score]]));
  }
  return lines;
}

const METRIC_CONFIG: Record<Metric, { direction: string; predicates: string[] }> = {
  dependents: { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] },
  callers: { direction: "in", predicates: ["CALLS", "REFERENCES"] },
  importers: { direction: "in", predicates: ["IMPORTS"] },
  members: { direction: "out", predicates: ["CONTAINS"] },
};

const VALID_METRICS = Object.keys(METRIC_CONFIG) as Metric[];

/** Get source URI from a node, checking common locations */
export function getSourceUri(node: any): string {
  return (
    node.provenance?.sourceUri ??
    node.provenance?.source_uri ??
    node.attrs?.sourceUri ??
    node.attrs?.source_uri ??
    ""
  );
}

/**
 * Apply path inclusion and exclusion filters to a list of nodes.
 *
 * Both sides go through `normalizePathSeparators`, so `--path src\cli` (what a
 * Windows user types) matches the `src/cli` that is actually stored. Case is
 * left alone — see `path-match.ts` and Ix#636.
 */
export function applyPathFilters(
  nodes: any[],
  includePath?: string,
  excludePath?: string
): any[] {
  let result = nodes;
  if (includePath) {
    const needle = normalizePathSeparators(includePath);
    result = result.filter((node: any) => normalizePathSeparators(getSourceUri(node)).includes(needle));
  }
  if (excludePath) {
    const needle = normalizePathSeparators(excludePath);
    result = result.filter((node: any) => !normalizePathSeparators(getSourceUri(node)).includes(needle));
  }
  return result;
}

/** Filter nodes by excluding specified kinds */
export function applyKindExclusion(nodes: any[], excludeKinds: string[]): any[] {
  if (excludeKinds.length === 0) return nodes;
  const excluded = new Set(excludeKinds);
  return nodes.filter((node: any) => !excluded.has(node.kind));
}

/** Pluralize an entity kind for display */
export function pluralize(kind: string): string {
  if (kind.endsWith("ss") || kind.endsWith("ch") || kind.endsWith("sh") || kind.endsWith("x")) return kind + "es";
  if (kind.endsWith("s")) return kind + "es";
  if (kind.endsWith("y") && !/[aeiou]y$/i.test(kind)) return kind.slice(0, -1) + "ies";
  return kind + "s";
}

interface ScoredEntity {
  id: string;
  name: string;
  kind: string;
  score: number;
}

/**
 * Requests in flight while scoring. The same peak load as the old batches of
 * 20, but a sliding window: a batch waited for its slowest expand before the
 * next one started, so one slow node held nineteen slots idle. Measured on the
 * Ix repository's graph (1284 functions): 4.3 s to ~1.9 s, same requests.
 */
const SCORE_CONCURRENCY = 20;

/** Score all candidates, a bounded number at a time, in candidate order. */
async function scoreAllCandidates(
  candidates: any[],
  config: { direction: string; predicates: string[] },
  client: IxClient,
  diagnostics: string[],
  entityKind: string,
): Promise<ScoredEntity[]> {
  const failed = new Array<boolean>(candidates.length).fill(false);
  const results = await mapLimit(candidates, SCORE_CONCURRENCY, async (node: any, index): Promise<ScoredEntity> => {
    try {
      const result = await client.expand(node.id, {
        direction: config.direction,
        predicates: config.predicates,
      });
      const seen = new Set<string>();
      for (const n of result.nodes) seen.add(n.id);
      return {
        id: node.id,
        name: node.name || node.attrs?.name || "(unnamed)",
        kind: node.kind || entityKind,
        score: seen.size,
      };
    } catch {
      failed[index] = true;
      return {
        id: node.id,
        name: node.name || node.attrs?.name || "(unnamed)",
        kind: node.kind || entityKind,
        score: 0,
      };
    }
  });
  // In candidate order, not in the order the failures happened to land.
  candidates.forEach((node: any, index) => {
    if (failed[index]) diagnostics.push(`Failed to expand entity ${node.id}`);
  });
  return results;
}

/** The most ids `POST /v1/degree` takes in one request. */
export const DEGREE_MAX_IDS = 5000;

/**
 * How long one `POST /v1/degree` may take before rank scores by expanding
 * instead. Well under the client's 60 s read deadline, which the fallback's
 * expands share: a slow degree call must leave them the time to finish.
 */
export const DEGREE_TIMEOUT_MS = 15_000;

/**
 * At least this many candidates beyond the ones that can be shown are
 * expanded as a check that the degree counts really bound the expand scores
 * (more when more rows are shown: as many as are shown).
 */
export const DEGREE_CHECK_MIN = 10;

/**
 * The most neighbours `/v1/expand` returns when no `limit` is sent (Ix-memory
 * `ExpandRoutes`), so the most an expand-path score can be. Only used to
 * guess which candidates to expand; a wrong guess costs requests, not scores.
 */
const EXPAND_DEFAULT_LIMIT = 1000;

/**
 * Backends (by endpoint) not to score through `POST /v1/degree` again in this
 * process: the route answered 404 or 405 (it predates them, Ix-memory <
 * v1.0.33), or it counted fewer neighbours than expand lists for some node.
 */
const degreeUnusable = new Set<string>();

/** The HTTP status an `IxClient` error carries at the front of its message, if any. */
function errorStatus(err: unknown): number | undefined {
  const m = err instanceof Error ? /^(\d{3}):/.exec(err.message) : null;
  return m ? Number(m[1]) : undefined;
}

/** The `n`th largest of `values` (1-based); `Infinity` when `n` is 0. */
function nthLargest(values: number[], n: number): number {
  if (n <= 0) return Infinity;
  return [...values].sort((a, b) => b - a)[Math.min(n, values.length) - 1]!;
}

/**
 * Score every candidate with `POST /v1/degree`, at most `DEGREE_MAX_IDS` ids
 * per request, then expand only the candidates that could be among the `top`
 * rows the caller shows, so those rows score exactly as the expand path does.
 *
 * A degree count `d` (with `distinct`) is not quite the expand-path score: a
 * self-loop makes the node its own neighbour (expand leaves the seed out), and
 * expand stops at `EXPAND_DEFAULT_LIMIT` neighbours. It is never lower, so it
 * bounds the score from above, and `min(d - 1, EXPAND_DEFAULT_LIMIT)` is the
 * usual floor. Every candidate whose ceiling reaches the `top`th highest floor
 * is expanded; when an exact score then lands below its floor, the floors are
 * worked out again and the new contenders expanded, until every row that can
 * be shown has its exact score. A candidate never expanded keeps `d` as its
 * score, which is below every shown row's. `d = 0` is taken as exact.
 *
 * That rests on `d` never being below the expand score, which is what the
 * backend's `distinct` count is meant to give but cannot be checked against
 * its source from here. So once the shown rows are exact, the candidates with
 * the highest counts not yet expanded (as many as are shown, at least
 * `DEGREE_CHECK_MIN`, zeros included) are expanded too: the ones a modest
 * undercount would have wrongly kept out. Any of them, or any other expand,
 * listing more neighbours than its `d` sends rank to the expand path. An
 * undercount on a candidate outside that margin is not caught.
 *
 * Returns null when the caller must score through `scoreAllCandidates`
 * instead: the route is missing (404/405, remembered for this backend), the
 * request failed or was refused (413, a transport error, anything else), the
 * answer is not the expected shape, the backend says it truncated a count
 * (a truncated count must never become a score), or an expand lists more
 * neighbours than `d` (remembered: its counts are no ceiling). An id absent
 * from `counts` is always expanded. An expand that fails scores 0 with
 * today's diagnostic, as on the expand path, and after one every candidate
 * not yet expanded is expanded, as the expand path would have.
 */
export async function scoreViaDegree(
  candidates: any[],
  config: { direction: string; predicates: string[] },
  client: IxClient,
  diagnostics: string[],
  entityKind: string,
  top = 0,
): Promise<ScoredEntity[] | null> {
  const endpoint = String(client.endpoint);
  if (degreeUnusable.has(endpoint)) return null;

  const counts = new Map<string, number>();
  const ids = [...new Set<string>(candidates.map((node: any) => node.id))];
  for (let start = 0; start < ids.length; start += DEGREE_MAX_IDS) {
    let res: Awaited<ReturnType<IxClient["degree"]>>;
    try {
      res = await client.degree(ids.slice(start, start + DEGREE_MAX_IDS), {
        direction: config.direction,
        predicates: config.predicates,
        distinct: true,
        timeoutMs: DEGREE_TIMEOUT_MS,
      });
    } catch (err) {
      const status = errorStatus(err);
      if (status === 404 || status === 405) degreeUnusable.add(endpoint);
      return null;
    }
    if (!res || typeof res.counts !== "object" || res.counts === null) return null;
    if (res.truncated === true) {
      diagnostics.push("Degree counts were truncated by the backend; scored each entity by expanding it instead.");
      return null;
    }
    for (const [id, n] of Object.entries(res.counts)) {
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) counts.set(id, n);
    }
  }

  // The rows the caller's `slice(0, top)` keeps.
  const shown = candidates.slice(0, top).length;
  const exact = candidates.map((node: any): number | undefined => (counts.get(node.id) === 0 ? 0 : undefined));
  const failed = new Array<boolean>(candidates.length).fill(false);
  const expanded = new Array<boolean>(candidates.length).fill(false);
  const floor = (node: any, i: number): number => {
    const d = counts.get(node.id);
    return exact[i] ?? (d === undefined ? 0 : Math.max(0, Math.min(d - 1, EXPAND_DEFAULT_LIMIT)));
  };
  const ceiling = (node: any, i: number): number => exact[i] ?? counts.get(node.id) ?? Infinity;

  // After a failed expand, expand everything left, as the expand path would
  // have: failures can otherwise lower the bar one round-trip at a time.
  let expandAll = false;
  let checked = shown === 0;
  for (;;) {
    const threshold = expandAll ? -Infinity : nthLargest(candidates.map(floor), shown);
    let pending: number[] = [];
    candidates.forEach((node: any, i) => {
      if (exact[i] === undefined && ceiling(node, i) >= threshold) pending.push(i);
    });
    if (pending.length === 0 && !checked) {
      // The shown rows are exact: check the counts just below them.
      checked = true;
      pending = candidates
        .map((node: any, i) => ({ i, d: counts.get(node.id) ?? 0 }))
        .filter(({ i }) => !expanded[i])
        .sort((a, b) => b.d - a.d || a.i - b.i)
        .slice(0, Math.max(shown, DEGREE_CHECK_MIN))
        .map(({ i }) => i);
    }
    if (pending.length === 0) break;
    const scores = await mapLimit(pending, SCORE_CONCURRENCY, async (i): Promise<number | undefined> => {
      try {
        const result = await client.expand(candidates[i].id, {
          direction: config.direction,
          predicates: config.predicates,
        });
        const seen = new Set<string>();
        for (const n of result.nodes) seen.add(n.id);
        return seen.size;
      } catch {
        return undefined;
      }
    });
    for (const [k, i] of pending.entries()) {
      const score = scores[k];
      const d = counts.get(candidates[i].id);
      if (score !== undefined && d !== undefined && score > d) {
        degreeUnusable.add(endpoint);
        return null;
      }
      if (score === undefined) {
        failed[i] = true;
        expandAll = true;
      }
      exact[i] = score ?? 0;
      expanded[i] = true;
    }
  }

  // In candidate order, as the expand path reports them.
  candidates.forEach((node: any, i) => {
    if (failed[i]) diagnostics.push(`Failed to expand entity ${node.id}`);
  });
  return candidates.map((node: any, i): ScoredEntity => ({
    id: node.id,
    name: node.name || node.attrs?.name || "(unnamed)",
    kind: node.kind || entityKind,
    score: exact[i] ?? counts.get(node.id)!,
  }));
}

export function registerRankCommand(program: Command): void {
  program
    .command("rank")
    .description("Rank entities by graph-derived importance (dependents, callers, importers, members)")
    .requiredOption("--by <metric>", `Metric to rank by (${VALID_METRICS.join(", ")})`)
    .requiredOption("--kind <kind>", "Entity kind to rank (e.g. class, method, module)")
    .option("--top <n>", "Number of results to return", "10")
    .option("--path <path>", "Filter entities by source path substring")
    .option("--exclude-path <path>", "Exclude entities whose source path contains this substring")
    .option("--exclude-kind <kinds>", "Comma-separated kinds to exclude from results")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText(
      "after",
      `\nExamples:
  ix rank --by dependents --kind class --top 10
  ix rank --by callers --kind method --top 20
  ix rank --by importers --kind module --top 10
  ix rank --by members --kind class --top 20
  ix rank --by dependents --kind class --path memory-layer --top 10
  ix rank --by dependents --kind class --exclude-path test --top 10
  ix rank --by dependents --kind class --exclude-kind config_entry --top 10
  ix rank --format json --by dependents --kind class`
    )
    .action(
      async (opts: {
        by: string;
        kind: string;
        top: string;
        path?: string;
        excludePath?: string;
        excludeKind?: string;
        format: string;
      }) => {
        const metric = opts.by as Metric;
        if (!VALID_METRICS.includes(metric)) {
          console.error(
            `Error: invalid metric "${opts.by}". Must be one of: ${VALID_METRICS.join(", ")}`
          );
          process.exit(1);
        }

        const topN = parseInt(opts.top, 10);
        const isJson = opts.format === "json";
        const client = createClient();
        const diagnostics: string[] = [];

        // 1. Fetch all entities of the given kind
        await ensureReadScope(client); // fold in a Path-2 stitched system (Ix#225 Half B)
        // The backend's scope is a raw AQL CONTAINS against source_uri, which is
        // always POSIX — send the separator-normalized needle or a Windows-style
        // --path silently matches nothing server-side too (Ix#636).
        const scopeNeedle = opts.path ? normalizePathSeparators(opts.path) : undefined;
        const allNodes = await client.listByKind(opts.kind, { limit: 2000, scope: scopeNeedle, ...activeReadScope() });

        if (allNodes.length === 0) {
          if (opts.format === "llm") {
            for (const line of renderRankLlm(metric, opts.kind, opts.path ?? null, [], 0, ["No entities found for the given kind."])) console.log(line);
          } else if (isJson) {
            printJson({
              metric,
              kind: opts.kind,
              scope: opts.path ?? null,
              results: [],
              summary: { evaluated: 0, totalCandidates: 0, returned: 0 },
              diagnostics: ["No entities found for the given kind."],
            });
          } else {
            console.log(chalk.dim("No entities found for the given kind."));
          }
          return;
        }

        // 2. Apply path inclusion filter
        let candidates = applyPathFilters(allNodes, opts.path, opts.excludePath);

        // 3. Apply kind exclusion filter
        const excludeKinds = opts.excludeKind ? opts.excludeKind.split(",").map(s => s.trim()) : [];
        candidates = applyKindExclusion(candidates, excludeKinds);

        if (candidates.length === 0) {
          const filterDesc = [
            opts.path ? `path "${opts.path}"` : null,
            opts.excludePath ? `exclude-path "${opts.excludePath}"` : null,
            excludeKinds.length > 0 ? `exclude-kind "${excludeKinds.join(",")}"` : null,
          ].filter(Boolean).join(", ");
          if (opts.format === "llm") {
            for (const line of renderRankLlm(metric, opts.kind, opts.path ?? null, [], 0, [`No entities matched filters: ${filterDesc}.`])) console.log(line);
          } else if (isJson) {
            printJson({
              metric,
              kind: opts.kind,
              scope: opts.path ?? null,
              results: [],
              summary: { evaluated: 0, totalCandidates: 0, returned: 0 },
              diagnostics: [`No entities matched filters: ${filterDesc}.`],
            });
          } else {
            console.log(chalk.dim(`No entities matched filters: ${filterDesc}.`));
          }
          return;
        }

        // 4. Score ALL candidates: one /v1/degree per DEGREE_MAX_IDS plus an
        // expand of each candidate that could be shown, or one expand each
        // where the backend cannot answer that.
        const config = METRIC_CONFIG[metric];
        const scored = await scoreViaDegree(candidates, config, client, diagnostics, opts.kind, topN)
          ?? await scoreAllCandidates(candidates, config, client, diagnostics, opts.kind);

        // 6. Sort descending, take top N
        scored.sort((a, b) => b.score - a.score);
        const results = scored.slice(0, topN);

        // 7. Output
        if (opts.format === "llm") {
          for (const line of renderRankLlm(metric, opts.kind, opts.path ?? null, results.map(r => ({ name: r.name, kind: r.kind, score: r.score })), candidates.length, diagnostics)) console.log(line);
        } else if (isJson) {
          printJson({
            metric,
            kind: opts.kind,
            scope: scopeNeedle,
            results: results.map(r => ({ name: r.name, kind: r.kind, score: r.score })),
            summary: { evaluated: candidates.length, returned: results.length },
            diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
          });
        } else {
          console.log(chalk.bold(`Top ${results.length} ${pluralize(opts.kind)} by ${metric}:`));
          const maxNameLen = Math.max(...results.map((r) => r.name.length), 1);
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const rank = String(i + 1).padStart(4);
            const name = r.name.padEnd(maxNameLen);
            console.log(`${rank}. ${name}  ${r.score}`);
          }
          if (diagnostics.length > 0) {
            console.log(chalk.dim(`\n${diagnostics.join("\n")}`));
          }
        }
      }
    );
}
