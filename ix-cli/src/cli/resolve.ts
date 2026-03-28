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

function looksTypeLikeSymbol(symbol: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(symbol);
}

function normalizeForPathMatch(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\\/g, "/");
}

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
  const sourceUri = normalizeForPathMatch(node.provenance?.sourceUri ?? node.provenance?.source_uri ?? "");

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
  } else if (kind === "chunk") {
    score += 5; // chunks are retrieval units, not useful as trace starting points
  }
  // non-structural kinds (config_entry, doc, decision, etc.) get no boost

  if (looksTypeLikeSymbol(symbol) && name === symbolLower) {
    if (kind === "class" || kind === "interface" || kind === "trait" || kind === "object") {
      score -= 4;
    }
    // No penalty for method/function: the +3 that was here caused chunks (score=0)
    // to outscore structural entities (function/method net score=2) for PascalCase
    // names like "Apply", "StartEtcd", "Range". Chunks are now penalised explicitly above.
  }

  // ── Path match ──────────────────────────────────────────────────────
  if (opts?.path) {
    const pathLower = normalizeForPathMatch(opts.path);
    if (sourceUri.includes(pathLower)) {
      // Specificity bonus: a longer/more specific filter string gives a larger
      // score reduction, breaking ties when many entities share the same short
      // path prefix (e.g. 8 structs named Handle all under "tokio/").
      const specificityRatio = pathLower.length / Math.max(sourceUri.length, 1);
      score -= 4 + Math.round(specificityRatio * 6); // bonus from 4 to 10
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
  opts?: { kind?: string; path?: string; pick?: number; includeTests?: boolean; testsOnly?: boolean; searchLimit?: number }
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
  opts?: { kind?: string; path?: string; pick?: number; includeTests?: boolean; testsOnly?: boolean; searchLimit?: number }
): Promise<ResolveResult> {
  const kindFilter = opts?.kind;
  const nodes = await client.search(symbol, {
    limit: opts?.searchLimit ?? (opts?.path ? 200 : looksTypeLikeSymbol(symbol) ? 50 : 20),
    kind: kindFilter,
    nameOnly: true,
  });

  if (nodes.length === 0) {
    stderr(`No entity found matching "${symbol}".`);
    return { resolved: false, ambiguous: false };
  }

  // Apply role filter before scoring
  const { filtered: roleFiltered, hiddenTestCount } = applyRoleFilter(nodes, opts ?? {});

  // Hard path filter: when --path is provided, exclude candidates whose sourceUri does not
  // contain the filter string. If no candidates survive, return "not found" rather than
  // falling back to cross-repo results.
  const filteredNodes = opts?.path
    ? roleFiltered.filter((n: any) => {
        const uri = normalizeForPathMatch(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");
        return uri.includes(normalizeForPathMatch(opts.path));
      })
    : roleFiltered;

  if (opts?.path && filteredNodes.length === 0) {
    stderr(`No entity named "${symbol}" found in paths matching "${opts.path}".`);
    return { resolved: false, ambiguous: false, hiddenTestCount };
  }

  // ── Phase 1: Exact-name candidates ──────────────────────────────────
  const symbolLower = symbol.toLowerCase();
  // Prefer case-sensitive exact matches. Fall back to case-insensitive only if none found.
  // This prevents e.g. 'Apply' (capital A) from matching lowercase 'apply' module import
  // aliases before finding the actual 'Apply' method entities.
  const exactCaseName = filteredNodes.filter((n: any) => {
    const name = (n.name || n.attrs?.name || "");
    return name === symbol;
  });
  const exactName = exactCaseName.length > 0
    ? exactCaseName
    : filteredNodes.filter((n: any) => {
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

  // If the best candidate ranks strictly higher in the kind preference list than all
  // other top-tier candidates, auto-pick it — the preference list is the tiebreaker.
  const topTierKindRanks = topTier.map(s => {
    const idx = preferredKinds.indexOf((s.node.kind || "").toLowerCase());
    return idx >= 0 ? idx : preferredKinds.length;
  });
  const bestKindRank = topTierKindRanks[0];
  if (topTier.length > 1 && topTierKindRanks.every((r, i) => i === 0 || r > bestKindRank)) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, "preferred-kind") };
  }

  // If best is a container kind and second is a method/function, prefer the container
  const bestKind = (best.node.kind || "").toLowerCase();
  const secondKind = (second.node.kind || "").toLowerCase();
  if (CONTAINER_KINDS.has(bestKind) && !CONTAINER_KINDS.has(secondKind)) {
    return { resolved: true, entity: nodeToResolved(best.node, symbol, "scored") };
  }

  // If path was provided and best matches path but second doesn't, best wins
  if (opts?.path) {
    const bestUri = normalizeForPathMatch(best.node.provenance?.sourceUri ?? best.node.provenance?.source_uri ?? "");
    const secondUri = normalizeForPathMatch(second.node.provenance?.sourceUri ?? second.node.provenance?.source_uri ?? "");
    const pathLower = normalizeForPathMatch(opts.path);
    if (bestUri.includes(pathLower) && !secondUri.includes(pathLower)) {
      return { resolved: true, entity: nodeToResolved(best.node, symbol, "scored") };
    }
  }

  // Genuinely ambiguous — return only structurally relevant candidates
  const ambiguousCandidates = unique
    .filter(s => s.score <= topScore + 5) // only candidates within range
    .slice(0, 8);

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
  const seen = new Set<string>();
  const candidates: AmbiguousResult["candidates"] = [];
  let rank = 0;
  for (let i = 0; i < nodes.length && i < 8; i++) {
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

// ── Scoped symbol parsing (e.g. C++ ClassName::methodName) ────────────────

/**
 * Convert a CamelCase or PascalCase identifier to snake_case.
 * Used to derive a file path hint from a C++/Rust class name.
 * Examples: "CompactionJob" → "compaction_job", "DBImpl" → "db_impl"
 */
function camelToSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Parse a scoped symbol like "ClassName::methodName" (C++/Rust/PHP style).
 * Returns the class and method parts, or null if no `::` is present.
 * Uses the *last* `::` so that nested scopes like `ns::Class::method` resolve
 * to `{ className: "ns::Class", methodName: "method" }`.
 */
function parseScopedSymbol(symbol: string): { className: string; methodName: string } | null {
  const idx = symbol.lastIndexOf('::');
  if (idx < 1) return null;
  const className = symbol.slice(0, idx);
  const methodName = symbol.slice(idx + 2);
  if (!className || !methodName) return null;
  return { className, methodName };
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
    const fileEntity = await tryFileGraphMatch(client, target, opts);
    if (fileEntity) return fileEntity;
    // Fall through to symbol resolution
  }

  // 2.5 Scoped symbol (e.g. "CompactionJob::Run", "ns::Class::method")
  const scoped = parseScopedSymbol(target);
  if (scoped) {
    // Phase A: resolve the class entity to obtain its actual source file path.
    // This gives a precise path hint rather than a guess from snake_case conversion.
    // We suppress stderr during this lookup to avoid confusing "not found" noise.
    const shortClassName = scoped.className.split('::').pop()!;
    const classEntity = await resolveEntity(
      client,
      shortClassName,
      ['class', 'interface', 'struct', 'trait', 'object', 'function'],
      { ...opts, kind: opts?.kind ? undefined : undefined },  // no kind constraint for class lookup
    );

    // Determine the best path hint: prefer the actual file path from phase A,
    // fall back to snake_case conversion of the class name.
    let pathHint: string;
    if (classEntity?.path) {
      // Extract basename without extension (e.g. "/db/flush_job.h" → "flush_job")
      const basename = classEntity.path.replace(/\\/g, '/').split('/').pop() ?? '';
      pathHint = basename.replace(/\.[^.]+$/, '').toLowerCase();
    } else {
      // Fallback: CamelCase → snake_case (e.g. "CompactionJob" → "compaction_job")
      pathHint = camelToSnake(shortClassName);
    }

    // Phase B: find the method, boosting candidates in the class's source file.
    // Use pathHint (derived from the class entity's actual source file) as the
    // path constraint — it is always more specific than the user's broad --path
    // workspace filter (e.g. "rocksdb"), so it takes priority.
    // Use a higher search limit so that methods in the correct file are not
    // pushed out by unrelated Run/Execute methods in other classes.
    // We deliberately do NOT force kind=method because some parsers classify
    // class methods as kind "function".
    const scopedOpts = {
      ...opts,
      path: pathHint,        // always use the class-derived hint, not opts?.path
      searchLimit: 50,
    };
    const entity = await resolveEntity(client, scoped.methodName, ['method', 'function'], scopedOpts);
    if (entity) {
      // Rewrite the display name to show the full scoped form
      return { ...entity, name: `${scoped.className}::${scoped.methodName}` };
    }
    // Not found — return null (don't fall through to a literal "Foo::Bar" search)
    return null;
  }

  // 3. Symbol resolution (handles all entity kinds)
  const allKinds = ["file", "class", "object", "trait", "interface", "module", "method", "function"];
  return resolveEntity(client, target, allKinds, opts);
}

/**
 * Search the graph for a file entity matching the target path or filename.
 * Tries exact path match first, then basename match.
 */
async function tryFileGraphMatch(
  client: IxClient,
  target: string,
  opts?: { path?: string },
): Promise<ResolvedEntity | null> {
  const basename = path.basename(target);
  const targetHasPath = target.includes("/") || target.includes("\\");

  // Search for file entities matching the basename
  const nodes = await client.search(basename, {
    limit: opts?.path ? 200 : 20,
    kind: "file",
    nameOnly: true,
  });

  // Filter to actual matches
  const targetLower = normalizeForPathMatch(target);
  const basenameLower = basename.toLowerCase();
  const basenameNoExt = basename.replace(/\.[^.]+$/, "").toLowerCase();
  const normalizedPathHint = normalizeForPathMatch(opts?.path);

  const matches: Array<{ node: any; quality: number }> = [];
  for (const n of nodes as any[]) {
    const name = (n.name || "").toLowerCase();
    const uri = normalizeForPathMatch(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");

    // Exact path match (best)
    if (targetHasPath && (uri.endsWith(targetLower) || uri === targetLower)) {
      matches.push({ node: n, quality: 0 });
    }
    // Filename match in user-requested path
    else if (normalizedPathHint && uri.includes(normalizedPathHint) && name === basenameLower) {
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
  if (matches.length > 1 && matches[0].quality === matches[1].quality && (target.includes("/") || target.includes("\\") || !!normalizedPathHint)) {
    // Disambiguate by path when user provided a path
    const pathMatch = matches.find(m => {
      const uri = normalizeForPathMatch(m.node.provenance?.sourceUri ?? m.node.provenance?.source_uri ?? "");
      return uri.endsWith(targetLower) || (!!normalizedPathHint && uri.includes(normalizedPathHint));
    });
    if (pathMatch) {
      return nodeToResolved(pathMatch.node, pathMatch.node.name, "exact");
    }
  }

  return nodeToResolved(best.node, best.node.name || basename, best.quality === 0 ? "exact" : "scored");
}
