import * as path from "node:path";
import chalk from "chalk";
import type { IxClient } from "../client/api.js";
import { stderr } from "./stderr.js";
import { applyRoleFilter } from "./role-filter.js";

export type ResolutionMode = "exact" | "preferred-kind" | "scored" | "ambiguous" | "heuristic";

export interface ResolvedEntity {
  id: string;
  kind: string;
  name: string;
  path?: string;
  resolutionMode: ResolutionMode;
}

export interface AmbiguousResult {
  resolutionMode: "ambiguous";
  candidates: Array<{ id: string; name: string; kind: string; path?: string; score?: number; rank?: number }>;
  diagnostics?: Array<{ code: string; message: string }>;
}

export type ResolveResult =
  | { resolved: true; entity: ResolvedEntity; hiddenTestCount?: number }
  | { resolved: false; ambiguous: true; result: AmbiguousResult; hiddenTestCount?: number }
  | { resolved: false; ambiguous: false; hiddenTestCount?: number };

// ── Structural kind sets ──────────────────────────────────────────────────

/** High-value container kinds — typically what callers want when resolving a bare name. */
const CONTAINER_KINDS = new Set(["file", "class", "object", "trait", "interface", "module"]);

/** All kinds that represent real code structure (vs. config/doc/decision). */
const STRUCTURAL_KINDS = new Set([
  ...CONTAINER_KINDS, "function", "method",
]);

// ── Scoring ───────────────────────────────────────────────────────────────

/**
 * Score a candidate node for resolution.
 * Lower is better. Combines:
 *   - exact name match (0 vs 10)
 *   - exact kind match when --kind provided (-5)
 *   - strong path match when --path provided (-4)
 *   - structural kind boost (-3 for container, -1 for method/function)
 *   - penalty for fuzzy/incidental matches (+5)
 */
export function scoreCandidate(
  node: any,
  symbol: string,
  opts?: { kind?: string; path?: string }
): number {
  const name: string = (node.name || node.attrs?.name || "").toLowerCase();
  const kind: string = (node.kind || "").toLowerCase();
  const symbolLower = symbol.toLowerCase();
  const sourceUri: string = (node.provenance?.sourceUri ?? node.provenance?.source_uri ?? "").toLowerCase();

  let score = 50; // baseline

  // ── Name match ──────────────────────────────────────────────────────
  if (name === symbolLower) {
    score = 0; // exact name match — best tier
  } else if (name.startsWith(symbolLower)) {
    score = 15; // prefix match — moderate
  } else {
    score = 30; // fuzzy / incidental — poor
  }

  // ── Kind match ──────────────────────────────────────────────────────
  if (opts?.kind && kind === opts.kind.toLowerCase()) {
    score -= 5; // exact kind requested by user
  }

  // ── Structural boost ────────────────────────────────────────────────
  if (CONTAINER_KINDS.has(kind)) {
    score -= 3; // containers are high-value resolution targets
  } else if (STRUCTURAL_KINDS.has(kind)) {
    score -= 1; // methods/functions are useful but lower than containers
  }
  // non-structural kinds (config_entry, doc, decision, etc.) get no boost

  // ── Path match ──────────────────────────────────────────────────────
  if (opts?.path) {
    const pathLower = opts.path.toLowerCase();
    if (sourceUri.includes(pathLower)) {
      score -= 4; // strong path preference
    }
  }

  return score;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Resolve a symbol to a single entity, preferring specific kinds and path filters.
 * Returns null and prints guidance if no match or ambiguous.
 */
export async function resolveEntity(
  client: IxClient,
  symbol: string,
  preferredKinds: string[],
  opts?: { kind?: string; path?: string; pick?: number; includeTests?: boolean; testsOnly?: boolean }
): Promise<ResolvedEntity | null> {
  const result = await resolveEntityFull(client, symbol, preferredKinds, opts);
  if (result.resolved) return result.entity;
  if (result.ambiguous) {
    printAmbiguous(symbol, result.result, opts);
  }
  return null;
}

/**
 * Full resolution returning structured result for JSON consumers.
 *
 * Two-phase ranking:
 *   Phase 1: Score exact-name candidates. If a clear winner exists, return it.
 *   Phase 2: If no exact-name candidates or still ambiguous, include fuzzy matches.
 */
export async function resolveEntityFull(
  client: IxClient,
  symbol: string,
  preferredKinds: string[],
  opts?: { kind?: string; path?: string; pick?: number; includeTests?: boolean; testsOnly?: boolean }
): Promise<ResolveResult> {
  const kindFilter = opts?.kind;
  const nodes = await client.search(symbol, { limit: 20, kind: kindFilter, nameOnly: true });

  if (nodes.length === 0) {
    stderr(`No entity found matching "${symbol}".`);
    return { resolved: false, ambiguous: false };
  }

  // Apply role filter before scoring
  const { filtered: filteredNodes, hiddenTestCount } = applyRoleFilter(nodes, opts ?? {});

  // ── Phase 1: Exact-name candidates ──────────────────────────────────
  const symbolLower = symbol.toLowerCase();
  const exactName = filteredNodes.filter((n: any) => {
    const name = (n.name || n.attrs?.name || "").toLowerCase();
    return name === symbolLower;
  });

  // Score exact-name candidates
  if (exactName.length > 0) {
    const winner = pickBest(exactName, symbol, preferredKinds, opts);
    if (winner) {
      const picked = applyPick(winner, opts);
      if (picked) return { ...picked, hiddenTestCount } as ResolveResult;
      return { ...winner, hiddenTestCount } as ResolveResult;
    }
  }

  // ── Phase 2: Fall back to all candidates ────────────────────────────
  const winner = pickBest(filteredNodes, symbol, preferredKinds, opts);
  if (winner) {
    const picked = applyPick(winner, opts);
    if (picked) return { ...picked, hiddenTestCount } as ResolveResult;
    return { ...winner, hiddenTestCount } as ResolveResult;
  }

  // Nothing resolved at all
  stderr(`No entity found matching "${symbol}".`);
  return { resolved: false, ambiguous: false, hiddenTestCount };
}

/**
 * Given a candidate set, score them, dedup, and either pick a winner or declare ambiguity.
 */
function pickBest(
  candidates: any[],
  symbol: string,
  preferredKinds: string[],
  opts?: { kind?: string; path?: string }
): ResolveResult | null {
  // Here is a test
  // LEt's see if it worked
  // Score all candidates
  const scored = candidates.map(n => ({
    node: n,
    score: scoreCandidate(n, symbol, opts),
  }));

  // Sort by score ascending (lower = better)
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tie-break: prefer preferred kinds in order
    const aIdx = preferredKinds.indexOf(a.node.kind);
    const bIdx = preferredKinds.indexOf(b.node.kind);
    const aRank = aIdx >= 0 ? aIdx : preferredKinds.length;
    const bRank = bIdx >= 0 ? bIdx : preferredKinds.length;
    return aRank - bRank;
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
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, opts)) };
  }

  // Best is significantly better than second (score gap >= 3) — winner
  if (second && best.score + 3 <= second.score) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, opts)) };
  }

  // If user specified --kind, take the best — they asked for it
  if (opts?.kind) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, "exact") };
  }

  // Check if all top candidates at the same score tier are the same entity
  const topScore = best.score;
  const topTier = unique.filter(s => s.score === topScore);
  const topIds = new Set(topTier.map(s => s.node.id));
  if (topIds.size === 1) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, resolutionMode(best, opts)) };
  }

  // If best is a container kind and second is a method/function, prefer the container
  const bestKind = (best.node.kind || "").toLowerCase();
  const secondKind = (second.node.kind || "").toLowerCase();
  if (CONTAINER_KINDS.has(bestKind) && !CONTAINER_KINDS.has(secondKind)) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, "scored") };
  }

  // If path was provided and best matches path but second doesn't, best wins
  if (opts?.path) {
    const bestUri = (best.node.provenance?.sourceUri ?? best.node.provenance?.source_uri ?? "").toLowerCase();
    const secondUri = (second.node.provenance?.sourceUri ?? second.node.provenance?.source_uri ?? "").toLowerCase();
    const pathLower = opts.path.toLowerCase();
    if (bestUri.includes(pathLower) && !secondUri.includes(pathLower)) {
      return { resolved: true, entity: nodeToResolved(best.node, symbol, "scored") };
    }
  }

  // Genuinely ambiguous — return only structurally relevant candidates
  const ambiguousCandidates = unique
    .filter(s => s.score <= topScore + 5) // only candidates within range
    .slice(0, 5);

  return {
    resolved: false,
    ambiguous: true,
    result: buildAmbiguous(ambiguousCandidates.map(s => s.node), ambiguousCandidates.map(s => s.score)),
  };
}

/**
 * When --pick is set and the result is ambiguous, select the candidate by 1-based index.
 * Returns the resolved result, an error result, or null if --pick is not set.
 */
export function applyPick(
  result: ResolveResult,
  opts?: { pick?: number }
): ResolveResult | null {
  if (opts?.pick == null) return null;
  if (result.resolved) return null; // already resolved, no need to pick
  if (!result.ambiguous) return null;

  const candidates = result.result.candidates;
  const idx = opts.pick - 1; // convert 1-based to 0-based

  if (idx < 0 || idx >= candidates.length) {
    stderr(`--pick ${opts.pick} is out of range (1-${candidates.length}).`);
    return { resolved: false, ambiguous: false };
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

function resolutionMode(scored: { score: number }, opts?: { kind?: string }): ResolutionMode {
  if (opts?.kind) return "exact";
  if (scored.score <= 0) return "exact";
  if (scored.score <= 5) return "preferred-kind";
  return "scored";
}

// ── Helpers ───────────────────────────────────────────────────────────────

function nodeToResolved(node: any, symbol: string, mode: ResolutionMode): ResolvedEntity {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name || node.attrs?.name || symbol,
    path: node.provenance?.sourceUri ?? node.provenance?.source_uri ?? node.path,
    resolutionMode: mode,
  };
}

function buildAmbiguous(nodes: any[], scores?: number[]): AmbiguousResult {
  //this is a test
  const seen = new Set<string>();
  const candidates: AmbiguousResult["candidates"] = [];
  let rank = 0;
  for (let i = 0; i < nodes.length && i < 5; i++) {
    const node = nodes[i] as any;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    rank++;
    candidates.push({
      id: node.id,
      name: node.name || node.attrs?.name || "(unnamed)",
      kind: node.kind ?? "",
      path: node.provenance?.sourceUri ?? node.provenance?.source_uri ?? node.path,
      score: scores?.[i],
      rank,
    });
  }
  return {
    resolutionMode: "ambiguous",
    candidates,
    diagnostics: [{ code: "ambiguous_resolution", message: "Use --pick <n> or --path to disambiguate." }],
  };
}

export function printAmbiguous(symbol: string, result: AmbiguousResult, opts?: { kind?: string; path?: string }): void {
  stderr(`Ambiguous symbol "${symbol}":`);
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i];
    const shortPath = c.path ? ` in ${c.path}` : "";
    stderr(`  ${i + 1}. ${chalk.cyan((c.kind ?? "").padEnd(10))} ${chalk.dim(c.id.slice(0, 8))}  ${c.name}${chalk.dim(shortPath)}`);
  }
  const hints: string[] = ["--pick <n>"];
  if (!opts?.kind) hints.push("--kind");
  if (!opts?.path) hints.push("--path");
  stderr(chalk.dim(`\nUse ${hints.join(" or ")} to disambiguate.`));
}

/**
 * Print the resolved target before showing results (text mode only).
 * Callers should skip this when format === "json" to keep JSON strict.
 */
export function printResolved(target: ResolvedEntity): void {
  const shortId = target.id.slice(0, 8);
  const modeStr = target.resolutionMode !== "exact"
    ? chalk.dim(` (${target.resolutionMode})`)
    : "";
  stderr(`${chalk.dim("Resolved:")} ${chalk.cyan(target.kind)} ${chalk.dim(shortId)} ${chalk.bold(target.name)}${modeStr}\n`);
}

/** Check if a string looks like a raw UUID (not a human-readable name). */
export function isRawId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)
    || /^[0-9a-f]{32,}$/i.test(s);
}

// ── File-first resolution ─────────────────────────────────────────────────

/** Common file extensions that signal the target is file-like, not a symbol name. */
const FILE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".scala", ".sc", ".java", ".py", ".rb", ".go", ".rs",
  ".md", ".mdx", ".rst", ".txt",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".conf",
  ".sql", ".graphql", ".gql", ".sh", ".bash",
  ".html", ".css", ".scss", ".less",
]);

export function looksFileLike(target: string): boolean {
  if (target.includes("/") || target.includes("\\")) return true;
  const ext = path.extname(target).toLowerCase();
  return ext !== "" && FILE_EXTENSIONS.has(ext);
}

/**
 * Resolve a target to a graph entity ID, trying file paths first.
 *
 * Resolution order:
 *   1. Raw UUID → return directly
 *   2. File-like input → search graph for matching file entity
 *   3. Symbol name → use scored resolver
 *
 * Returns { id, name, kind } or null if not found.
 */
export async function resolveFileOrEntity(
  client: IxClient,
  target: string,
  opts?: { kind?: string; path?: string; pick?: number; includeTests?: boolean; testsOnly?: boolean }
): Promise<ResolvedEntity | null> {
  // 1. Raw UUID
  if (isRawId(target)) {
    try {
      const details = await client.entity(target);
      const n = details.node as any;
      return {
        id: target,
        kind: n.kind || "unknown",
        name: n.name || target,
        resolutionMode: "exact",
      };
    } catch {
      stderr(`Entity not found: ${target}`);
      return null;
    }
  }

  // 2. File-like input → try graph file search
  if (looksFileLike(target)) {
    const fileEntity = await tryFileGraphMatch(client, target);
    if (fileEntity) return fileEntity;
    // Fall through to symbol resolution
  }

  // 3. Symbol resolution (handles all entity kinds)
  const allKinds = ["file", "class", "object", "trait", "interface", "module", "function", "method"];
  return resolveEntity(client, target, allKinds, opts);
}

/**
 * Search the graph for a file entity matching the target path or filename.
 * Tries exact path match first, then basename match.
 */
async function tryFileGraphMatch(
  client: IxClient,
  target: string,
): Promise<ResolvedEntity | null> {
  const basename = path.basename(target);

  // Search for file entities matching the basename
  const nodes = await client.search(basename, { limit: 20, kind: "file", nameOnly: true });

  // Filter to actual matches
  const targetLower = target.toLowerCase();
  const basenameLower = basename.toLowerCase();
  const basenameNoExt = basename.replace(/\.[^.]+$/, "").toLowerCase();

  const matches: Array<{ node: any; quality: number }> = [];
  for (const n of nodes as any[]) {
    const name = (n.name || "").toLowerCase();
    const uri = (n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "").toLowerCase();

    // Exact path match (best)
    if (uri.endsWith(targetLower) || uri === targetLower) {
      matches.push({ node: n, quality: 0 });
    }
    // Exact filename match
    else if (name === basenameLower) {
      matches.push({ node: n, quality: 1 });
    }
    // Bare name match (no extension)
    else if (name.replace(/\.[^.]+$/, "") === basenameNoExt) {
      matches.push({ node: n, quality: 2 });
    }
  }

  if (matches.length === 0) return null;

  // Sort by quality then pick best
  matches.sort((a, b) => a.quality - b.quality);

  // If multiple matches at same quality, prefer path-matching target
  const best = matches[0];
  if (matches.length > 1 && matches[0].quality === matches[1].quality && target.includes("/")) {
    // Disambiguate by path when user provided a path
    const pathMatch = matches.find(m => {
      const uri = (m.node.provenance?.sourceUri ?? m.node.provenance?.source_uri ?? "").toLowerCase();
      return uri.endsWith(targetLower);
    });
    if (pathMatch) {
      return nodeToResolved(pathMatch.node, pathMatch.node.name, "exact");
    }
  }

  return nodeToResolved(best.node, best.node.name || basename, best.quality === 0 ? "exact" : "scored");
}
