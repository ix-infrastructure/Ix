// Copyright 2026 Ix Infrastructure Inc.

/**
 * Choosing among scored candidates: the winner, a tie notice, or an ambiguous
 * record, and `--pick n` among the listed ones. Pure: nothing here talks to
 * the backend, reads the environment or prints (resolve-split.test.ts checks).
 * Whatever depends on who is reading, such as the disambiguation hint's
 * phrasing or saying an out-of-range `--pick` on stderr, is passed in.
 */

import { candidateOrigin } from "../candidate-origin.js";
import { CONTAINER_KINDS } from "../graph-model.js";
import { normalizeForPathMatch } from "../path-match.js";
import { scoreCandidate } from "./score.js";
import type { AmbiguousResult, ResolutionMode, ResolutionNotice, ResolvedEntity, ResolveResult } from "./types.js";

/** The ambiguous record's hint as a person at a shell reads it. */
export const AMBIGUOUS_HINT = "Use --pick <n> or --path to disambiguate.";

/** Start line of a node, for a stable candidate order. Missing sorts last. */
function lineOf(node: any): number {
  const v = Number(node?.attrs?.line_start ?? node?.attrs?.lineStart ?? node?.line_start);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

export function nodePath(node: any): string {
  return normalizeForPathMatch(node?.provenance?.sourceUri ?? node?.provenance?.source_uri ?? node?.path ?? "");
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Tiebreak for equal candidates: (path, line, id), independent of backend order. */
function displayOrder(a: any, b: any): number {
  return cmpStr(nodePath(a), nodePath(b)) || lineOf(a) - lineOf(b) || cmpStr(String(a.id), String(b.id));
}

/**
 * A ranked candidate list dealt round-robin by file: the best of each file
 * (files in the order of their best), then each file's second-best, and so on.
 * Within a file the ranked order stands. Only 8 are listed, and a file that
 * defines the name eight times would otherwise fill the page alone, with the
 * definitions the caller wants in other files out of sight. This is the order
 * the list is numbered in, so `--pick n` and `--all`'s `candidate=<n>` follow it.
 * Files compare as lower-cased posix paths, so `src\a.py` and `src/a.py` are one file.
 */
export function roundRobinByFile<T>(ranked: readonly T[], nodeOf: (item: T) => any = (item) => item): T[] {
  const files = new Map<string, T[]>();
  for (const item of ranked) {
    const key = nodePath(nodeOf(item));
    const group = files.get(key);
    if (group) group.push(item);
    else files.set(key, [item]);
  }
  const groups = [...files.values()];
  const dealt: T[] = [];
  for (let round = 0; dealt.length < ranked.length; round++) {
    for (const group of groups) if (round < group.length) dealt.push(group[round]);
  }
  return dealt;
}

function entityPath(node: any): string | undefined {
  return node.provenance?.sourceUri ?? node.provenance?.source_uri ?? node.path;
}

/** The one-line notice for a target resolved by a fuzzy (non-exact) name. */
export function fuzzyNotice(symbol: string, e: ResolvedEntity): ResolutionNotice {
  const where = e.path ? ` (${e.path})` : "";
  return {
    code: "fuzzy_match",
    target: symbol,
    message: `No exact match for ${symbol}; using fuzzy match ${e.name}${where}`,
    chosen: { id: e.id, name: e.name, kind: e.kind, path: e.path },
    candidates: [{ id: e.id, name: e.name, kind: e.kind, path: e.path, rank: 1 }],
    total: 1,
  };
}

/**
 * The notice for a pick among equal candidates: resolved, but say what else
 * tied. `tier` is only the candidates at the chosen one's score (the true
 * ties); `lowerCount` is how many more scored close but worse. Those are only
 * counted in the message, so `total`, the listed candidates and `--pick n` all
 * describe the same set.
 */
function tieNotice(
  symbol: string,
  chosen: any,
  tier: Array<{ node: any; score: number }>,
  windowFull: boolean | undefined,
  lowerCount = 0,
): ResolutionNotice {
  // The notice keeps only the candidates, never the record's hint.
  const amb = buildAmbiguous(tier.map((s) => s.node), tier.map((s) => s.score), {
    hint: AMBIGUOUS_HINT,
    total: tier.length,
    truncated: windowFull,
  });
  const where = entityPath(chosen);
  const lower = lowerCount > 0
    ? ` ${lowerCount} more scored lower and ${lowerCount === 1 ? "is" : "are"} not listed.`
    : "";
  const notice: ResolutionNotice = {
    code: "ambiguous_target",
    target: symbol,
    message: `"${symbol}" matches ${windowFull ? "at least " : ""}${tier.length} candidates equally; using ${chosen.name || symbol}${where ? ` (${where})` : ""}.${lower}`,
    chosen: { id: chosen.id, name: chosen.name || chosen.attrs?.name || symbol, kind: chosen.kind ?? "", path: where },
    candidates: amb.candidates,
    total: tier.length,
    ...(windowFull ? { truncated: true } : {}),
  };
  rememberAll(notice, amb.candidates, allCandidatesOf(amb), importIdsOf(amb));
  return notice;
}

/**
 * Given a candidate set, score them, dedup, and either pick a winner or declare ambiguity.
 * `hint` is the ambiguous record's "how to disambiguate" line, phrased by the
 * caller for whoever reads it (next-step.ts `disambiguationHint`).
 */
export function pickBest(
  candidates: any[],
  symbol: string,
  preferredKinds: string[],
  opts: { kind?: string; path?: string; windowFull?: boolean; hint: string },
): ResolveResult | null {
  // Score all candidates
  const scored = candidates.map(n => ({
    node: n,
    score: scoreCandidate(n, symbol, opts),
  }));

  const kindRank = (n: any) => {
    const idx = preferredKinds.indexOf(n.kind);
    return idx >= 0 ? idx : preferredKinds.length;
  };
  // Sort by score ascending (lower = better); ties by preferred kind, then by
  // (path, line, id) so the pick never depends on the order the backend sent.
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return kindRank(a.node) - kindRank(b.node) || displayOrder(a.node, b.node);
  });

  // Dedup by id
  const seen = new Set<string>();
  const unique = scored.filter(s => {
    if (seen.has(s.node.id)) return false;
    seen.add(s.node.id);
    return true;
  });

  if (unique.length === 0) return null;

  // If the best candidate has a clearly better score than the second, it wins
  const best = unique[0];
  const second = unique[1];

  // Single candidate — clear winner
  if (unique.length === 1) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, symbol)) };
  }

  // Best is significantly better than second (score gap >= 3) — winner
  if (second && best.score + 3 <= second.score) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, symbol)) };
  }

  // Check if all top candidates at the same score tier are the same entity
  const topScore = best.score;
  const topTier = unique.filter(s => s.score === topScore);
  const topIds = new Set(topTier.map(s => s.node.id));
  if (topIds.size === 1) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, symbol)) };
  }

  // Candidates within range of the top score: the ambiguous record's list.
  const eligible = unique.filter(s => s.score <= topScore + 5);
  // A tie rule's notice lists only the true ties (the top score tier); the
  // near-misses below it are counted, not presented as equal.
  const tied = (mode: ResolutionMode): ResolveResult => ({
    resolved: true,
    entity: nodeToResolved(best.node, symbol, mode),
    notices: [tieNotice(symbol, best.node, topTier, opts.windowFull, eligible.length - topTier.length)],
  });

  // If the best candidate ranks strictly higher in the kind preference list than all
  // other top-tier candidates, auto-pick it — the preference list is the tiebreaker.
  const topTierKindRanks = topTier.map(s => {
    const idx = preferredKinds.indexOf((s.node.kind || "").toLowerCase());
    return idx >= 0 ? idx : preferredKinds.length;
  });
  const bestKindRank = topTierKindRanks[0];
  if (topTier.length > 1 && topTierKindRanks.every((r, i) => i === 0 || r > bestKindRank)) {
    return tied("preferred-kind");
  }

  // If best is a container kind and second is a method/function, prefer the container
  const bestKind = (best.node.kind || "").toLowerCase();
  const secondKind = (second.node.kind || "").toLowerCase();
  if (CONTAINER_KINDS.has(bestKind) && !CONTAINER_KINDS.has(secondKind)) {
    return tied("scored");
  }

  // If path was provided and best matches path but second doesn't, best wins
  if (opts.path) {
    const bestUri = normalizeForPathMatch(best.node.provenance?.sourceUri ?? best.node.provenance?.source_uri ?? "");
    const secondUri = normalizeForPathMatch(second.node.provenance?.sourceUri ?? second.node.provenance?.source_uri ?? "");
    const pathLower = normalizeForPathMatch(opts.path);
    if (bestUri.includes(pathLower) && !secondUri.includes(pathLower)) {
      return { resolved: true, entity: nodeToResolved(best.node, symbol, "scored") };
    }
  }

  // Genuinely ambiguous — return only structurally relevant candidates
  return {
    resolved: false,
    ambiguous: true,
    result: buildAmbiguous(eligible.map(s => s.node), eligible.map(s => s.score), {
      hint: opts.hint,
      total: eligible.length,
      truncated: opts.windowFull,
    }),
  };
}

/**
 * When --pick is set and the result is ambiguous, select the candidate by 1-based index.
 * Returns the resolved result, an error result, or null if --pick is not set.
 * An out-of-range pick is recorded as a `pick_out_of_range` diagnostic and
 * handed to `onOutOfRange`; nothing here prints.
 */
export function applyPick(
  result: ResolveResult,
  opts?: { pick?: number },
  onOutOfRange?: (message: string) => void,
): ResolveResult | null {
  if (opts?.pick == null) return null;
  if (result.resolved) return null; // already resolved, no need to pick
  if (!result.ambiguous) return null;

  // Every tied candidate, the shown 8 first: `--all` numbers past 8 (n=9...)
  // and `--pick` must reach them by the same numbers.
  const candidates = allCandidatesOf(result.result);
  const idx = opts.pick - 1; // convert 1-based to 0-based

  if (idx < 0 || idx >= candidates.length) {
    const message = `--pick ${opts.pick} is out of range (1-${candidates.length}).`;
    onOutOfRange?.(message);
    return {
      ...result,
      result: {
        ...result.result,
        diagnostics: [
          { code: "pick_out_of_range", message },
          ...(result.result.diagnostics ?? []),
        ],
      },
    };
  }

  const picked = candidates[idx];
  return {
    resolved: true,
    entity: {
      id: picked.id,
      kind: picked.kind,
      name: picked.name,
      path: picked.path,
      resolutionMode: "scored",
    },
  };
}

/**
 * `--pick n` on a resolved result that carries an ambiguous_target notice picks
 * among the notice's candidates. Unlike applyPick on an ambiguous result, an
 * out-of-range pick keeps the default choice and the exit code stays 0: --pick
 * must not create a new non-zero exit. As in applyPick, an out-of-range pick
 * goes to `onOutOfRange` rather than being printed here.
 */
export function pickFromNotice(
  result: ResolveResult,
  opts?: { pick?: number },
  onOutOfRange?: (message: string) => void,
): ResolveResult {
  if (opts?.pick == null || !result.resolved || !result.notices) return result;
  const at = result.notices.findIndex((n) => n.code === "ambiguous_target");
  if (at < 0) return result;
  const notice = result.notices[at];
  const candidates = allCandidatesOf(notice);
  const idx = opts.pick - 1;
  if (idx < 0 || idx >= candidates.length) {
    const message = `--pick ${opts.pick} is out of range (1-${candidates.length}).`;
    onOutOfRange?.(message);
    const notices = result.notices.slice();
    notices[at] = { ...notice, diagnostics: [{ code: "pick_out_of_range", message }, ...(notice.diagnostics ?? [])] };
    return { ...result, notices };
  }
  const picked = candidates[idx];
  const keepFuzzy = result.entity.resolutionMode === "fuzzy";
  return {
    ...result,
    entity: {
      id: picked.id,
      kind: picked.kind,
      name: picked.name,
      path: picked.path,
      resolutionMode: keepFuzzy ? "fuzzy" : "scored",
    },
    notices: result.notices
      .filter((_, i) => i !== at)
      .map((n) => {
        if (n.code !== "fuzzy_match") return n;
        const where = picked.path ? ` (${picked.path})` : "";
        return {
          ...n,
          message: `No exact match for ${n.target}; using fuzzy match ${picked.name}${where}`,
          chosen: { id: picked.id, name: picked.name, kind: picked.kind, path: picked.path },
          candidates: [{ ...picked, rank: 1 }],
        };
      }),
  };
}

/** An ambiguous result left so by an explicit `--pick` past the end of its list. */
export function pickedOutOfRange(result: ResolveResult): boolean {
  return !result.resolved && result.ambiguous && !!result.result.diagnostics?.some((d) => d.code === "pick_out_of_range");
}

/** "exact" only for a case-sensitive exact name; otherwise the score bands. */
function resolutionMode(scored: { node: any; score: number }, symbol: string): ResolutionMode {
  const name = scored.node?.name || scored.node?.attrs?.name || "";
  if (scored.score <= 0 && name === symbol) return "exact";
  if (scored.score <= 5) return "preferred-kind";
  return "scored";
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function nodeToResolved(node: any, symbol: string, mode: ResolutionMode): ResolvedEntity {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name || node.attrs?.name || symbol,
    path: node.provenance?.sourceUri ?? node.provenance?.source_uri ?? node.path,
    resolutionMode: mode,
  };
}

/**
 * Every tied candidate behind an ambiguous result or notice, not only the 8
 * shown. Kept beside the object rather than on it, so no json or llm renderer
 * that prints the result can leak a list of hundreds. `--all` reads it
 * (`allCandidatesOf`): the shown 8 first, numbered as `--pick` numbers them,
 * then the rest in display order. `imports` holds the ids of the candidates
 * that are imports of the name rather than definitions (candidate-origin.ts),
 * which `--all` skips when a definition is listed too.
 */
const fullCandidates = new WeakMap<object, { all: AmbiguousResult["candidates"]; imports: Set<string> }>();

export function rememberAll(
  owner: object,
  shown: AmbiguousResult["candidates"],
  all: AmbiguousResult["candidates"],
  imports: Set<string> = new Set(),
): void {
  const shownIds = new Set(shown.map((c) => c.id));
  fullCandidates.set(owner, { all: [...shown, ...all.filter((c) => !shownIds.has(c.id))], imports });
}

/** The full candidate list behind an ambiguous result or notice (falls back to the shown ones). */
export function allCandidatesOf(owner: AmbiguousResult | ResolutionNotice): AmbiguousResult["candidates"] {
  return fullCandidates.get(owner)?.all ?? owner.candidates;
}

/** The ids among `allCandidatesOf(owner)` that are imports of the name, not definitions. */
export function importIdsOf(owner: object): Set<string> {
  return fullCandidates.get(owner)?.imports ?? new Set();
}

/** Consecutive runs of equal score, in order; no scores is one run. */
function scoreTiers<T extends { score?: number }>(ranked: readonly T[]): T[][] {
  const tiers: T[][] = [];
  for (const item of ranked) {
    const last = tiers[tiers.length - 1];
    if (last && last[0].score === item.score) last.push(item);
    else tiers.push([item]);
  }
  return tiers;
}

export function buildAmbiguous(
  nodes: any[],
  scores: number[] | undefined,
  extra: { hint: string; total?: number; truncated?: boolean; diagnostics?: Array<{ code: string; message: string }> },
): AmbiguousResult {
  // The caller's ranking dealt round-robin by file within each score tier,
  // then the first 8 shown and numbered for --pick. A tier is a run of equal
  // scores: spreading never puts a worse score (an import's +5) ahead of a
  // better one, so the page is still the 8 best by score. The ranking breaks
  // ties by (path, line, id), so `--pick n` means the same thing on every run.
  const seen = new Set<string>();
  const ranked: Array<{ node: any; score?: number }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as any;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    ranked.push({ node, score: scores?.[i] });
  }
  const dealt = scoreTiers(ranked).flatMap((tier) => roundRobinByFile(tier, (r) => r.node));
  const picked = dealt.slice(0, 8);
  const candidates: AmbiguousResult["candidates"] = picked.map(({ node, score }, i) => {
    const line = lineOf(node);
    const rank = i + 1;
    return {
      id: node.id,
      name: node.name || node.attrs?.name || "(unnamed)",
      kind: node.kind ?? "",
      path: entityPath(node),
      ...(line !== Number.MAX_SAFE_INTEGER ? { line } : {}),
      score,
      rank,
    };
  });
  const result: AmbiguousResult = {
    resolutionMode: "ambiguous",
    candidates,
    ...(extra.total != null ? { total: extra.total } : {}),
    ...(extra.truncated ? { truncated: true } : {}),
    diagnostics: [
      { code: "ambiguous_resolution", message: extra.hint },
      ...(extra.diagnostics ?? []),
    ],
  };
  const imports = new Set(ranked.filter(({ node }) => candidateOrigin(node) === "import").map(({ node }) => String(node.id)));
  rememberAll(result, candidates, dealt.map(({ node }) => candidateOf(node)), imports);
  return result;
}

/** A result that came from resolveEntityFull's fuzzy phase (no exact name). */
export function isFuzzyResult(r: ResolveResult): boolean {
  if (r.resolved) {
    return r.entity.resolutionMode === "fuzzy" || !!r.notices?.some((n) => n.code === "fuzzy_match");
  }
  return r.ambiguous && !!r.result.diagnostics?.some((d) => d.code === "fuzzy_match");
}

export type Candidate = AmbiguousResult["candidates"][number];

export function candidateOf(n: any): Candidate {
  const line = lineOf(n);
  return {
    id: String(n.id),
    name: n.name || n.attrs?.name || "",
    kind: n.kind ?? "",
    path: entityPath(n),
    ...(line !== Number.MAX_SAFE_INTEGER ? { line } : {}),
  };
}
