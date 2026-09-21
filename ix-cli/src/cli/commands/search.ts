// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { formatNodes, relativePath } from "../format.js";
import { scoreCandidate, resolveReadSystemId } from "../resolve.js";
import { applyRoleFilter, roleHint } from "../role-filter.js";
import { stderr } from "../stderr.js";
import { llmLine } from "../llm.js";
import { normalizePathSeparators } from "../path-match.js";

/** Render `ix search` as llm records: a header line then one `node` row per hit (rank = order). */
export function renderSearchLlm(
  results: Array<{ name: string; kind: string; id?: string; path?: string; score?: number }>,
  totalCandidates: number, diagnostics: Array<{ code: string; message: string }>,
): string[] {
  const lines = [llmLine("search", [["count", results.length], ["candidates", totalCandidates]])];
  for (const r of results) {
    lines.push(llmLine("node", [
      ["name", r.name], ["kind", r.kind], ["id", r.id?.slice(0, 8)],
      ["path", r.path], ["score", r.score],
    ]));
  }
  for (const d of diagnostics) lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
  return lines;
}

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

/** Tier 0 through tier 5 — see `rankScore`. */
const TIER_COUNT = 6;

/** The lowest tier: nothing in the name matched, only an attribute did. */
const INCIDENTAL_TIER = 5;

/**
 * The tier as a 0-1 relevance, best first.
 *
 * The internal sort key is negative and "lower is better" — `score=-101` above
 * `score=-31` — which is exactly backwards from what every other score an agent
 * meets means, and it leaked into `--format json` and `--format llm` as the only
 * number on the row. There are six tiers, so each is worth a sixth: 1.00 for an
 * exact name and kind, down to 0.17 for a match that came from an attribute.
 *
 * Deliberately per-tier and not per-row: the sub-score that separates two rows
 * inside a tier is a sum of two heuristics with no calibrated meaning, and the
 * order it produces is already carried by the order the rows are printed in
 * (and by `rank` in JSON). A number that looks more precise than it is invites
 * an agent to threshold on it.
 */
export function tierRelevance(tier: number): number {
  const clamped = Math.min(Math.max(tier, 0), TIER_COUNT - 1);
  return Math.round(((TIER_COUNT - clamped) / TIER_COUNT) * 100) / 100;
}

type Scored = { node: any; rank: { tier: number; score: number; matchSource: string } };

function rowPath(node: any): string {
  return normalizePath(node.provenance?.sourceUri ?? node.provenance?.source_uri ?? "");
}

/**
 * Drop a chunk row when the symbol it was cut from is already in the answer.
 *
 * A chunk is a retrieval unit: the ingester emits one per symbol, named after
 * that symbol and carrying a `DEFINES` edge to it (core-ingestion
 * `patch-builder.ts`). So a search that matches a function by name matches its
 * chunk too, and the pair arrives as two rows with the same name and the same
 * file — one of which no command can then do anything with, because `explain`,
 * `callers` and `read` all want the symbol.
 *
 * A chunk with no twin survives: an unnamed `file_body:` chunk is the only row
 * standing for that part of the file, and dropping it would lose the hit.
 */
export function foldChunkTwins(scored: Scored[]): Scored[] {
  const symbols = new Set(
    scored
      .filter((s) => (s.node.kind || "").toLowerCase() !== "chunk")
      .map((s) => `${(s.node.name || "").toLowerCase()}\u0000${rowPath(s.node)}`),
  );
  if (symbols.size === 0) return scored;
  return scored.filter((s) => {
    if ((s.node.kind || "").toLowerCase() !== "chunk") return true;
    return !symbols.has(`${(s.node.name || "").toLowerCase()}\u0000${rowPath(s.node)}`);
  });
}

/**
 * Drop the bottom tier once something actually matched by name.
 *
 * Tier 5 is the resolver's fallback: no part of the name matched and the row is
 * here because a term appeared somewhere in the node's attributes. Next to a
 * real hit it is filler that pushes a relevant row off the end of `--limit`.
 * With nothing better in the set it is the only answer there is, so it stays.
 */
export function dropIncidentalMatches(scored: Scored[]): Scored[] {
  const named = scored.some((s) => s.rank.tier < INCIDENTAL_TIER);
  return named ? scored.filter((s) => s.rank.tier < INCIDENTAL_TIER) : scored;
}

function normalizePath(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\\/g, "/");
}

const PATH_CANDIDATE_LIMIT = 2000;

export function registerSearchCommand(program: Command): void {
  program
    .command("search <term>")
    .description("Search the knowledge graph by term — ranked by structural relevance")
    .option("--limit <n>", "Max results", "10")
    .option("--kind <kind>", "Filter and boost results by node kind (e.g. class, function, decision)")
    .option("--language <lang>", "Filter by language/file extension (e.g. scala, ts)")
    .option("--path <path>", "Filter results by file path (case-insensitive substring match)")
    .option("--as-of <rev>", "Search as of a specific revision")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--include-tests", "Include test and fixture entities in results")
    .option("--tests-only", "Show only test and fixture entities")
    .option("--semantic", "Use vector-similarity (embedding) search instead of keyword matching")
    .addHelpText("after", `\nRanking priority (score 1.00 down to 0.17):
  1. Exact name + exact kind match
  2. Exact name + structural kind (class, function, etc.)
  3. Exact name (any kind)
  4. Exact filename/module match
  5. Container-aware near match
  6. Fuzzy/incidental match — dropped when any of 1-5 matched

A chunk is folded away when the symbol it was cut from is already in the answer.

Use --path to filter results from specific directories.
Keyword searches send --path to the backend as a candidate filter (backend 1.0.31+)
and widen the candidate window up to 2000 nodes on older backends.
If that bound is reached, a diagnostic warns that matches may be missing.

Examples:
  ix search IngestionService --kind class
  ix search auth --language python --limit 10
  ix search expand --path memory-layer
  ix search "" --kind file --limit 50 --format json`)
    .action(async (term: string, opts: {
      limit: string; kind?: string; language?: string; path?: string; asOf?: string; format: string; includeTests?: boolean; testsOnly?: boolean; semantic?: boolean
    }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      // Only an explicit --path scopes results. The active workspace is already
      // applied server-side via workspaceId (below), and provenance.sourceUri is
      // workspace-RELATIVE, so defaulting this to the absolute getActiveWorkspaceRoot()
      // made the substring filter below drop every match (see issue #228).
      const effectivePathFilter = opts.path;

      // Fetch more results than requested so we can re-rank and trim
      let fetchLimit = Math.min(limit * 3, 60);
      // Auto-detect a multi-repo system; when present, scope by system_id (which
      // spans all member repos) instead of the single-repo workspace_id.
      const systemId = await resolveReadSystemId(client);
      const workspaceId = systemId ? undefined : resolveWorkspaceId();
      // Semantic search hits a different backend endpoint that embeds the term and
      // returns nodes already ordered by vector similarity. It ignores --language
      // and --as-of (the endpoint accepts neither); scoping is shared.
      const fetchCandidates = (candidateLimit: number) => opts.semantic
        ? client.semanticSearch(term, {
            limit: candidateLimit,
            kind: opts.kind,
            workspaceId,
            systemId,
          })
        : client.search(term, {
            limit: candidateLimit,
            kind: opts.kind,
            language: opts.language,
            asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
            workspaceId,
            systemId,
            // Push --path down as `scope` so a backend that knows the field
            // (Ix-memory ≥ 1.0.31) filters candidates BEFORE its limit and the
            // window below holds only matching paths (Ix#647: the target sat
            // at candidate 71 and 386 and no --limit could reach it). An older
            // backend ignores the unknown field, and the client-side filter
            // and widening loop below still apply either way. Separators only:
            // the backend lowercases both sides itself, and the stored side is
            // POSIX by construction (see path-match.ts).
            scope: effectivePathFilter ? normalizePathSeparators(effectivePathFilter) : undefined,
          });
      let rawNodes = await fetchCandidates(fetchLimit);
      const filterPath = (candidates: typeof rawNodes) => effectivePathFilter
        ? candidates.filter((node: any) => {
            const sourceUri = normalizePath(node.provenance?.sourceUri ?? node.provenance?.source_uri ?? "");
            return sourceUri.includes(normalizePath(effectivePathFilter));
          })
        : candidates;
      let nodes = filterPath(rawNodes);

      // The released search API cannot filter by path or paginate. Widen its
      // prefix only when filtering leaves too few results, with a finite bound.
      while (effectivePathFilter && !opts.semantic && fetchLimit > 0
        && rawNodes.length >= fetchLimit && fetchLimit < PATH_CANDIDATE_LIMIT
        && applyRoleFilter(nodes, opts).filtered.length < limit) {
        fetchLimit = Math.min(fetchLimit * 4, PATH_CANDIDATE_LIMIT);
        rawNodes = await fetchCandidates(fetchLimit);
        nodes = filterPath(rawNodes);
      }
      const pathWindowLimited = effectivePathFilter && !opts.semantic
        && fetchLimit === PATH_CANDIDATE_LIMIT && rawNodes.length >= fetchLimit;

      // Re-rank client-side using shared scoring + backend weight. The rank object
      // is still computed for display (tier/score), but for semantic search we keep
      // the backend's vector-similarity order and skip the keyword-based re-sort,
      // which would otherwise demote semantically-relevant results lacking the term.
      const scored = nodes.map(n => ({
        node: n,
        rank: rankScore(n, term, opts.kind, effectivePathFilter),
      }));

      if (!opts.semantic) scored.sort(searchSort);

      // Rank, then prune, then cut. Both passes run before `--limit` so a row
      // dropped here makes room for a real one instead of leaving a shorter
      // answer. Semantic search keeps its own ordering but is pruned the same
      // way: a chunk twin is just as useless there.
      const hygienic = dropIncidentalMatches(foldChunkTwins(scored));

      const { filtered: roleFiltered, hiddenTestCount } = applyRoleFilter(
        hygienic.map(s => s.node),
        { includeTests: opts.includeTests, testsOnly: opts.testsOnly },
      );
      // Re-wrap with scores for trimming
      const roleFilteredScored = hygienic.filter(s => roleFiltered.includes(s.node));
      const trimmed = roleFilteredScored.slice(0, limit);
      const ranked = trimmed.map(s => s.node);

      const diagnostics: { code: string; message: string }[] = [];
      if (pathWindowLimited) {
        diagnostics.push({
          code: "path_search_truncated",
          message: `Search inspected only the first ${PATH_CANDIDATE_LIMIT} candidates before filtering by path; matching results may be missing. Use a more specific search term.`,
        });
      }
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
      // `unfiltered_search` fires on every search that did not pass `--kind`,
      // which is most of them, and says the same eighteen words each time
      // about results the caller can already see. It stays in JSON, where a
      // program may be keyed to it, and stays out of the record stream an
      // agent reads.
      //
      // Taken after every push, not before: `test_candidates_hidden` is the
      // one diagnostic here that names rows the caller CANNOT see, and it is
      // added below the `unfiltered_search` push.
      const llmDiagnostics = diagnostics.filter((d) => d.code !== "unfiltered_search");

      if (opts.format === "llm") {
        const rows = trimmed.map((s) => ({
          name: s.node.name || (s.node.attrs as any)?.name || "(unnamed)",
          kind: s.node.kind,
          id: s.node.id,
          path: relativePath(s.node.provenance?.sourceUri) ?? undefined,
          score: tierRelevance(s.rank.tier),
        }));
        for (const line of renderSearchLlm(rows, rawNodes.length, llmDiagnostics)) console.log(line);
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify({
          results: trimmed.map((s, i) => ({
            id: s.node.id,
            name: s.node.name || (s.node.attrs as any)?.name || "(unnamed)",
            kind: s.node.kind,
            path: relativePath(s.node.provenance?.sourceUri) ?? undefined,
            language: (s.node.attrs as any)?.language ?? undefined,
            rank: i + 1,
            tier: s.rank.tier,
            score: tierRelevance(s.rank.tier),
            matchSource: s.rank.matchSource,
          })),
          summary: {
            count: ranked.length,
            totalCandidates: rawNodes.length,
          },
          diagnostics,
        }, null, 2));
      } else {
        formatNodes(ranked, opts.format);
        if (pathWindowLimited) stderr(chalk.dim(diagnostics.find(d => d.code === "path_search_truncated")!.message));
        const hint = roleHint(hiddenTestCount);
        if (hint) stderr(chalk.dim(hint));
      }
    });
}
