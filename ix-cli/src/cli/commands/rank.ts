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
 * Backends (by endpoint) not to score through `POST /v1/degree` again in this
 * process: the route answered 404 or 405 (it predates them, Ix-memory <
 * v1.0.33), or its counts disagreed with expand's on the rows a rank showed.
 */
const degreeUnusable = new Set<string>();

/** The HTTP status an `IxClient` error carries at the front of its message, if any. */
function errorStatus(err: unknown): number | undefined {
  const m = err instanceof Error ? /^(\d{3}):/.exec(err.message) : null;
  return m ? Number(m[1]) : undefined;
}

/**
 * Score every candidate with `POST /v1/degree`, at most `DEGREE_MAX_IDS` ids
 * per request, counting distinct neighbour nodes as the expand path does.
 *
 * Returns null when the caller must score through `scoreAllCandidates`
 * instead: the route is missing (404/405, remembered for this backend), the
 * request failed or was refused (413, a transport error, anything else), the
 * answer is not the expected shape, or the backend says it truncated a count,
 * since a truncated count must never become a score. An id absent from
 * `counts` is scored by expanding it, so it ends up exactly as today: its
 * neighbour count, or 0 with today's diagnostic when the expand fails.
 *
 * The `verifyTop` highest counts (the rows the caller shows) are checked
 * against expand before they are trusted: a backend whose `distinct` count
 * is not expand's distinct neighbour nodes (the seed, a self-loop, a hidden
 * node counted differently) falls back to the expand path, silently, and is
 * not asked again in this process. An expand that fails during the check
 * falls back too, without being remembered.
 */
export async function scoreViaDegree(
  candidates: any[],
  config: { direction: string; predicates: string[] },
  client: IxClient,
  diagnostics: string[],
  entityKind: string,
  verifyTop = 0,
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
      if (typeof n === "number" && Number.isFinite(n)) counts.set(id, n);
    }
  }

  const diagnosticsBefore = diagnostics.length;
  const missing = candidates.filter((node: any) => !counts.has(node.id));
  const rescored = new Map<any, ScoredEntity>();
  if (missing.length > 0) {
    const scored = await scoreAllCandidates(missing, config, client, diagnostics, entityKind);
    missing.forEach((node: any, index) => rescored.set(node, scored[index]!));
  }
  const fromDegree = new Set<ScoredEntity>();
  const results = candidates.map((node: any): ScoredEntity => {
    const expanded = rescored.get(node);
    if (expanded) return expanded;
    const entity = {
      id: node.id,
      name: node.name || node.attrs?.name || "(unnamed)",
      kind: node.kind || entityKind,
      score: counts.get(node.id)!,
    };
    fromDegree.add(entity);
    return entity;
  });

  const agrees = await degreeAgreesWithExpand(results, fromDegree, verifyTop, config, client);
  if (agrees !== true) {
    // The expand path redoes every candidate and reports its own failures.
    diagnostics.length = diagnosticsBefore;
    if (agrees === "differs") degreeUnusable.add(endpoint);
    return null;
  }
  return results;
}

/**
 * Whether the `top` highest degree-counted rows, picked the way the caller
 * sorts and slices them, have the same score as `expand` gives: `true`,
 * `"differs"` when a count disagrees, `"failed"` when an expand failed.
 */
async function degreeAgreesWithExpand(
  results: ScoredEntity[],
  fromDegree: Set<ScoredEntity>,
  top: number,
  config: { direction: string; predicates: string[] },
  client: IxClient,
): Promise<true | "differs" | "failed"> {
  const shown = [...results].sort((a, b) => b.score - a.score).slice(0, top).filter((r) => fromDegree.has(r));
  if (shown.length === 0) return true;
  const checks = await mapLimit(shown, SCORE_CONCURRENCY, async (row): Promise<true | "differs" | "failed"> => {
    try {
      const result = await client.expand(row.id, { direction: config.direction, predicates: config.predicates });
      return new Set(result.nodes.map((n) => n.id)).size === row.score ? true : "differs";
    } catch {
      return "failed";
    }
  });
  return checks.includes("differs") ? "differs" : checks.includes("failed") ? "failed" : true;
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

        // 4. Score ALL candidates: one /v1/degree per DEGREE_MAX_IDS, the
        // rows shown checked against expand, or one expand each where the
        // backend cannot answer that or its counts disagree.
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
