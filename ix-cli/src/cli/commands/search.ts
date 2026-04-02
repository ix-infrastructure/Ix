import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes, relativePath } from "../format.js";
import { scoreCandidate } from "../resolve.js";
import { applyRoleFilter, roleHint } from "../role-filter.js";
import { stderr } from "../stderr.js";

/** Structural kinds that should rank higher than incidental matches. */
const STRUCTURAL_KINDS = new Set([
  "class", "trait", "object", "interface", "function", "method", "module", "file",
]);

/**
 * Compute a ranking score for a search result.
 * Lower score = better match.
 *
 * Combines backend weight (_search_weight from AQL) with client-side
 * resolver scoring for fine-grained ranking.
 *
 * Tiers (for JSON output):
 *   0 — exact name + exact kind
 *   1 — exact name + structural kind
 *   2 — exact name (any kind)
 *   3 — partial name match (backend weight 60)
 *   4 — provenance/claim/decision match
 *   5 — fuzzy/incidental match
 */
function rankScore(
  node: any,
  term: string,
  requestedKind: string | undefined,
  pathFilter: string | undefined
): { tier: number; score: number; matchSource: string } {
  // Weight is embedded in attrs by the backend AQL (survives parseNode → GraphNode → JSON)
  const backendWeight: number = node.attrs?._search_weight ?? (node as any)._search_weight ?? 0;
  const resolverScore = scoreCandidate(node, term, { kind: requestedKind, path: pathFilter });

  // Backend weight provides relevance signal, resolver refines within tier
  if (backendWeight >= 100) {
    // Exact backend name match — use resolver to sub-rank
    if (resolverScore <= -3) return { tier: 0, score: -backendWeight + resolverScore, matchSource: "name_exact" };
    if (resolverScore <= 0) return { tier: 1, score: -backendWeight + resolverScore, matchSource: "name_exact" };
    return { tier: 2, score: -backendWeight + resolverScore, matchSource: "name_exact" };
  }
  if (backendWeight >= 60) {
    return { tier: 3, score: -backendWeight + resolverScore, matchSource: "name_partial" };
  }
  if (backendWeight >= 40) {
    return { tier: 4, score: -backendWeight, matchSource: "provenance" };
  }
  if (backendWeight >= 20) {
    return { tier: 4, score: -backendWeight, matchSource: "claim_or_decision" };
  }

  // No backend weight — fall back to pure resolver scoring
  if (resolverScore <= -8) return { tier: 0, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= -3) return { tier: 0, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= 0) return { tier: 1, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= 2) return { tier: 2, score: resolverScore, matchSource: "resolver" };
  return { tier: 5, score: resolverScore, matchSource: "attrs" };
}

/**
 * Full sort key: (tier, sub-score, structural-boost, name).
 */
function searchSort(
  a: { node: any; rank: { tier: number; score: number; matchSource: string } },
  b: { node: any; rank: { tier: number; score: number; matchSource: string } }
): number {
  if (a.rank.tier !== b.rank.tier) return a.rank.tier - b.rank.tier;
  if (a.rank.score !== b.rank.score) return a.rank.score - b.rank.score;
  // Within same tier: structural kinds first
  const aStructural = STRUCTURAL_KINDS.has((a.node.kind || "").toLowerCase()) ? 0 : 1;
  const bStructural = STRUCTURAL_KINDS.has((b.node.kind || "").toLowerCase()) ? 0 : 1;
  if (aStructural !== bStructural) return aStructural - bStructural;
  const aName = (a.node.name || a.node.attrs?.name || "").toLowerCase();
  const bName = (b.node.name || b.node.attrs?.name || "").toLowerCase();
  return aName.localeCompare(bName);
}

export function registerSearchCommand(program: Command): void {
  program
    .command("search <term>")
    .description("Search the knowledge graph by term — ranked by structural relevance")
    .option("--limit <n>", "Max results", "10")
    .option("--kind <kind>", "Filter and boost results by node kind (e.g. class, function, decision)")
    .option("--language <lang>", "Filter by language/file extension (e.g. scala, ts)")
    .option("--path <path>", "Boost results from files matching this path substring")
    .option("--as-of <rev>", "Search as of a specific revision")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--include-tests", "Include test and fixture entities in results")
    .option("--tests-only", "Show only test and fixture entities")
    .addHelpText("after", `\nRanking priority:
  1. Exact name + exact kind match
  2. Exact name + structural kind (class, function, etc.)
  3. Exact name (any kind)
  4. Exact filename/module match
  5. Container-aware near match
  6. Fuzzy/incidental match

Use --path to boost results from specific directories.

Examples:
  ix search IngestionService --kind class
  ix search auth --language python --limit 10
  ix search expand --path memory-layer
  ix search "" --kind file --limit 50 --format json`)
    .action(async (term: string, opts: {
      limit: string; kind?: string; language?: string; path?: string; asOf?: string; format: string; includeTests?: boolean; testsOnly?: boolean
    }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);

      // Fetch more results than requested so we can re-rank and trim
      const fetchLimit = Math.min(limit * 3, 60);
      const nodes = await client.search(term, {
        limit: fetchLimit,
        kind: opts.kind,
        language: opts.language,
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
      });

      // Re-rank client-side using shared scoring + backend weight
      const scored = nodes.map(n => ({
        node: n,
        rank: rankScore(n, term, opts.kind, opts.path),
      }));

      scored.sort(searchSort);

      const { filtered: roleFiltered, hiddenTestCount } = applyRoleFilter(
        scored.map(s => s.node),
        { includeTests: opts.includeTests, testsOnly: opts.testsOnly },
      );
      // Re-wrap with scores for trimming
      const roleFilteredScored = scored.filter(s => roleFiltered.includes(s.node));
      const trimmed = roleFilteredScored.slice(0, limit);
      const ranked = trimmed.map(s => s.node);

      if (opts.format === "json") {
        const diagnostics: { code: string; message: string }[] = [];
        if (!opts.kind) {
          diagnostics.push({
            code: "unfiltered_search",
            message: "Results may be broad. Use --kind to filter and boost structural matches.",
          });
        }
        if (hiddenTestCount > 0) {
          diagnostics.push({
            code: "test_candidates_hidden",
            message: roleHint(hiddenTestCount)!,
          });
        }
        console.log(JSON.stringify({
          results: trimmed.map((s, i) => ({
            id: s.node.id,
            name: s.node.name || (s.node.attrs as any)?.name || "(unnamed)",
            kind: s.node.kind,
            path: relativePath(s.node.provenance?.sourceUri) ?? undefined,
            language: (s.node.attrs as any)?.language ?? undefined,
            rank: i + 1,
            tier: s.rank.tier,
            score: s.rank.score,
            matchSource: s.rank.matchSource,
          })),
          summary: {
            count: ranked.length,
            totalCandidates: nodes.length,
          },
          diagnostics,
        }, null, 2));
      } else {
        formatNodes(ranked, opts.format);
        const hint = roleHint(hiddenTestCount);
        if (hint) stderr(chalk.dim(hint));
      }
    });
}
