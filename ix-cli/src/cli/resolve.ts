// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { IxClient } from "../client/api.js";
import { stderr } from "./stderr.js";
import { applyRoleFilter } from "./role-filter.js";
import { detectSystem } from "./system.js";
import { requireReadWorkspaceId, resolveWorkspaceId } from "./bootstrap.js";
import { readStitchScope, resolveWorkspaceRoot, stitchScopeCachePath, writeStitchScope } from "./config.js";
import { ixHome } from "./ix-home.js";
import { checkGraphHealth, isUnhealthy, type GraphHealth } from "./graph-health.js";
import { reportAmbiguousTarget, reportResolutionFailure } from "./ui.js";
import { relativePath } from "./format.js";
import { isQuiet } from "./output-shape.js";
import { disambiguationHint } from "./next-step.js";
import {
  candidateOrigin, isFileStemMatch, looksLikeCodeIdentifier, requestsNonCode,
} from "./candidate-origin.js";

/**
 * The read scope for the current working directory: a co-ingested multi-repo system
 * scopes by system_id (spanning all members); otherwise by the single workspace_id.
 * Computed once per cwd (detectSystem does FS reads) since a command never changes cwd.
 * Mirrors the server-side scoping that search/inventory/stats already apply — without
 * it, entity resolution searched the whole backend and a stale absolute path filter
 * (getActiveWorkspaceRoot vs. workspace-relative source_uri) dropped every candidate
 * (issue #228, originally fixed in search.ts only).
 */
let _scopeCache: {
  cwd: string;
  workspaceId?: string;
  systemId?: string;
  stitchChecked?: boolean;
  /** scopeKey() when this was computed; a different key means it is stale. */
  key: string;
} | undefined;

function mtimeOf(file: string): string {
  try {
    return String(fs.statSync(file).mtimeMs);
  } catch {
    return "-";
  }
}

/**
 * What a cached scope depends on besides the cwd: config.yaml, where `ix map`
 * registers a workspace, and the workspace's stitch-scope file, which a map or
 * ingest clears. `ix mcp` keeps this cache for the whole session, and the map
 * that changes either one usually runs in another process -- an editor hook,
 * a terminal -- that resetReadScope() never hears about. Two stats per read.
 */
function scopeKey(workspaceId: string | undefined): string {
  const stitch = workspaceId ? mtimeOf(stitchScopeCachePath(workspaceId)) : "-";
  return `${mtimeOf(path.join(ixHome(), "config.yaml"))}|${stitch}`;
}

/** The cached scope for `cwd`, if it is still current. */
function currentCache(cwd: string): NonNullable<typeof _scopeCache> | undefined {
  if (_scopeCache?.cwd !== cwd) return undefined;
  const ws = _scopeCache.workspaceId ?? resolveWorkspaceIdQuiet(cwd);
  if (_scopeCache.key !== scopeKey(ws)) return undefined;
  return _scopeCache;
}

// The workspace id for the stitch-file part of the key. Only consulted for a
// system-scoped entry, where the cache holds no workspace id of its own.
function resolveWorkspaceIdQuiet(cwd: string): string | undefined {
  try {
    return resolveWorkspaceId(cwd);
  } catch {
    return undefined;
  }
}

/**
 * Drop the cached scope so the next read resolves it again.
 *
 * The cache is keyed on cwd alone and never expires, which was safe while a
 * command's process ended with it. `ix mcp` runs many commands in one
 * long-lived process, so it calls this after anything that can change what a
 * repo is scoped to — an ingest, or a map that stitches the repo into a System
 * server-side. Without it, every later read in the session still answers
 * against the pre-map workspace.
 */
export function resetReadScope(): void {
  _scopeCache = undefined;
}
export function activeReadScope(): { workspaceId?: string; systemId?: string } {
  return activeScope();
}
function activeScope(): { workspaceId?: string; systemId?: string } {
  const cwd = process.cwd();
  const cached = currentCache(cwd);
  if (cached) return cached;
  const systemId = detectSystem(cwd)?.systemId;
  const workspaceId = systemId ? undefined : resolveWorkspaceId(cwd);
  const scope = { cwd, workspaceId, systemId, stitchChecked: false, key: scopeKey(workspaceId) };
  // "No workspace here" is never cached: it is exactly the answer an `ix map`
  // run elsewhere changes, and recomputing it is a few file reads.
  _scopeCache = workspaceId || systemId ? scope : undefined;
  return scope;
}

/**
 * Make the read scope aware of a Path-2 STITCHED system (Ix#225 Half B): a
 * separately-ingested repo has no local system marker (detectSystem returns none),
 * but the stitcher may have joined it into a system server-side. Look that up once
 * and fold it into the same cache activeScope() reads, so every read that calls
 * this (then resolves) spans the whole stitched system — matching `ix map`.
 * Best-effort + cached (one lookup per cwd); an older backend or a true singleton
 * leaves the scope at workspace level. Read commands `await` this before resolving.
 */
export async function ensureReadScope(
  client: Pick<IxClient, "workspaceSystem">,
  opts?: { allowUnmapped?: boolean },
): Promise<void> {
  await foldStitchedSystem(client);
  // A read with neither a workspace nor a system would run unscoped, across
  // every workspace on the backend: the same function once per checkout, from
  // repositories the caller never asked about. Refused with the fix instead.
  // `ix doctor` opts out -- reporting this state is its job, not failing on it.
  if (!opts?.allowUnmapped && !_scopeCache?.workspaceId && !_scopeCache?.systemId) {
    requireReadWorkspaceId(process.cwd());
  }
}

async function foldStitchedSystem(client: Pick<IxClient, "workspaceSystem">): Promise<void> {
  const cwd = process.cwd();
  if (currentCache(cwd)?.stitchChecked) return;
  const localSystem = detectSystem(cwd)?.systemId;
  if (localSystem) {
    _scopeCache = { cwd, systemId: localSystem, stitchChecked: true, key: scopeKey(resolveWorkspaceIdQuiet(cwd)) };
    return;
  }
  const ws = resolveWorkspaceId(cwd);
  let systemId: string | undefined;
  if (ws) {
    // Disk first. This lookup is ~1.5 s on a large graph and its answer changes
    // only when the workspace is mapped or ingested — both of which clear the
    // file — so asking the backend once per process was paying it on every
    // single `ix` invocation. `null` is a cached answer too: "not stitched" is
    // the common case and the one worth not re-asking.
    const cached = readStitchScope(ws);
    if (cached) {
      systemId = cached.systemId ?? undefined;
    } else {
      try {
        const answer = (await client.workspaceSystem(ws)).systemId ?? null;
        writeStitchScope(ws, answer);
        systemId = answer ?? undefined;
      } catch { /* best-effort: leave the scope at workspace level, cache nothing */ }
    }
  }
  // Unmapped: leave nothing cached, so the next read looks again (see activeScope).
  _scopeCache = ws || systemId
    ? { cwd, workspaceId: systemId ? undefined : ws, systemId, stitchChecked: true, key: scopeKey(ws) }
    : undefined;
}

/**
 * The system_id an aggregate read (inventory/search/stats/smells/subsystems) should
 * scope to: a co-ingest system (detectSystem) OR a Path-2 stitched system (backend
 * lookup), else undefined (workspace-scoped). Drop-in for `detectSystem(cwd)?.systemId`.
 */
export async function resolveReadSystemId(
  client: Pick<IxClient, "workspaceSystem">,
  opts?: { allowUnmapped?: boolean },
): Promise<string | undefined> {
  await ensureReadScope(client, opts);
  return activeReadScope().systemId;
}

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

/**
 * A near-miss worth naming when a target does not resolve.
 *
 * A miss is a dead end for the caller: an agent that gets "no entity found"
 * spends its next turn running `ix search` by hand, and a person retypes the
 * name. The candidates are already in hand (or one search away), so they are
 * cheaper to hand over than to make the caller ask for.
 */
/**
 * What a resolver needs from its caller.
 *
 * `format` is here so a miss is reported once. The prose ("No entity found
 * matching …") goes to stderr for a person; a json or llm caller gets the same
 * fact as a record on stdout from `reportUnresolvedTarget`, and printing both
 * means an agent running `ix … 2>&1` reads the miss twice.
 */
export interface ResolveOpts {
  kind?: string;
  path?: string;
  pick?: number;
  includeTests?: boolean;
  testsOnly?: boolean;
  searchLimit?: number;
  format?: string;
  /** Internal: the caller reports the miss itself (a file target's miss). */
  silentMiss?: boolean;
}

export interface Suggestion {
  id: string;
  name: string;
  kind: string;
  path?: string;
}

export type ResolveResult =
  | { resolved: true; entity: ResolvedEntity; hiddenTestCount?: number }
  | { resolved: false; ambiguous: true; result: AmbiguousResult; hiddenTestCount?: number }
  | {
      resolved: false;
      ambiguous: false;
      hiddenTestCount?: number;
      suggestions?: Suggestion[];
      /**
       * Why it missed, when that is more than "no such name": a file target
       * that is on disk but not in the graph (`file_not_in_graph`), or on
       * neither (`file_not_found`). The message then replaces the generic one.
       */
      reason?: string;
      message?: string;
      /** Set by the reporter's caller when the graph itself is empty or degraded. */
      graph?: GraphHealth;
    };

// ── Structural kind sets ──────────────────────────────────────────────────

/** High-value container kinds — typically what callers want when resolving a bare name. */
const CONTAINER_KINDS = new Set(["file", "class", "object", "trait", "interface", "module"]);

/** All kinds that represent real code structure (vs. config/doc/decision). */
const STRUCTURAL_KINDS = new Set([
  ...CONTAINER_KINDS, "function", "method", "constant",
]);

/**
 * Report a miss to a person, once.
 *
 * Under `--format json|llm` the reporter writes a machine-readable record for
 * the same miss on stdout, and an agent almost always runs with `2>&1`, so this
 * prose would be a second copy of an answer it already has.
 */
function missProse(opts: ResolveOpts | undefined, message: string): void {
  const format = opts?.format;
  if (opts?.silentMiss || format === "json" || format === "llm") return;
  stderr(message);
}

/** The best few near-misses to offer, newest scoring first, deduped by id. */
function toSuggestions(nodes: any[], limit = 3): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const n of nodes) {
    const id = String(n.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const uri = n.provenance?.sourceUri ?? n.provenance?.source_uri;
    out.push({
      id,
      name: String(n.name ?? n.attrs?.name ?? ""),
      kind: String(n.kind ?? ""),
      path: uri ? (relativePath(uri) ?? uri) : undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function looksTypeLikeSymbol(symbol: string): boolean {
  return /^[A-Z][A-Za-z0-9_]*$/.test(symbol);
}

function normalizeForPathMatch(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\\/g, "/");
}

// ── Scoring ───────────────────────────────────────────────────────────────

/**
 * Score added to a candidate that shares the name but is not the code
 * definition (see candidate-origin.ts for how each is recognised).
 *
 * - An import entity is a single-line `module`: +5 cancels the -3 container
 *   boost it gets as a `module` and leaves it +2 behind a bare exact match, so
 *   a same-named function (-1), class (-3) or defining file (0) all beat it.
 * - A CSS selector, markdown heading or JSON key (+10, only for a term that
 *   looks like a code identifier and only when the caller did not ask for that
 *   kind or language) and a copy in build output, a fixture or a sample (+10)
 *   land behind the import: an import at least points at the definition. 10
 *   is enough to put even a PascalCase CSS class (-7 with the type boost)
 *   behind a same-named function (-1).
 *
 * A demotion, never a filter — when nothing else shares the name these are
 * still the best (and only) answer.
 */
export function originPenalty(
  node: any,
  symbol: string,
  opts?: { kind?: string; language?: string },
): number {
  switch (candidateOrigin(node)) {
    case "import": return 5;
    case "generated": return 10;
    case "non-code": return looksLikeCodeIdentifier(symbol) && !requestsNonCode(opts) ? 10 : 0;
    default: return 0;
  }
}

/**
 * Score a candidate node for resolution.
 * Lower is better. Combines:
 *   - exact name match (0), defining-file stem match (3), prefix (15), other (30)
 *   - exact kind match when --kind provided (-5)
 *   - strong path match when --path provided (-4)
 *   - structural kind boost (-3 for container, -1 for method/function)
 *   - penalty for an import / non-code / generated candidate (originPenalty)
 */
export function scoreCandidate(
  node: any,
  symbol: string,
  opts?: { kind?: string; path?: string; language?: string }
): number {
  return baseScore(node, symbol, opts) + originPenalty(node, symbol, opts);
}

/** `scoreCandidate` without the origin penalty: how well the NAME matched. */
export function baseScore(
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
  } else if (isFileStemMatch(node, symbol)) {
    // `borderStylesReset.js` for `borderStylesReset`: the file is the
    // definition of an anonymous default export. Behind a same-named symbol
    // (a function nets -1, this nets 0), ahead of an import of it (+2).
    score = 3;
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
  opts?: ResolveOpts
): Promise<ResolvedEntity | null> {
  const result = await resolveEntityFull(client, symbol, preferredKinds, opts);
  if (result.resolved) return result.entity;
  if (result.ambiguous) {
    reportAmbiguousTarget(symbol, result.result, "text", opts);
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
  opts?: ResolveOpts
): Promise<ResolveResult> {
  // Scope is applied server-side (workspace_id, or system_id for a co-ingest). Only an
  // EXPLICIT --path narrows further, client-side; we no longer default the path filter
  // to the absolute workspace root, which never matched workspace-relative source_uris.
  const effectivePath = opts?.path;
  await ensureReadScope(client); // fold in a Path-2 stitched system (Ix#225 Half B)
  const { workspaceId, systemId } = activeScope();
  const kindFilter = opts?.kind;
  const searchLimit = opts?.searchLimit ?? (effectivePath ? 200 : looksTypeLikeSymbol(symbol) ? 50 : 30);
  let nodes = await client.search(symbol, {
    limit: searchLimit,
    kind: kindFilter,
    nameOnly: true,
    workspaceId,
    systemId,
  });

  // The backend orders its window by weight — every exact name before every
  // partial one — so when a name is imported in dozens of files, the window is
  // all imports and the file that DEFINES it (`borderStylesReset.js`, a
  // partial match for `borderStylesReset`) never arrives. Only when the window
  // came back full and holds no definition of the name, ask for files by that
  // name directly: a handful of rows, merged in and scored like the rest.
  if (nodes.length >= searchLimit && (!kindFilter || kindFilter === "file")
      && !hasDefinitionOf(nodes, symbol)) {
    const files = await client.search(symbol, {
      limit: 20, kind: "file", nameOnly: true, workspaceId, systemId,
    });
    nodes = mergeById(nodes, files.filter((n: any) => isFileStemMatch(n, symbol)));
  }

  if (nodes.length === 0) {
    // The backend matches names by substring, so a typo (`parseBudgetOptoin`)
    // matches nothing -- and re-running without `nameOnly` returns the same
    // empty set (measured against a 1.4M-node graph on three terms). What does
    // find it is a fragment of the name: one request each for a leading and a
    // trailing fragment, ranked by edit distance. Only on this miss path.
    missProse(opts, `No entity found matching "${symbol}".`);
    const near = await nearestNames(client, symbol, { kind: kindFilter, workspaceId, systemId });
    return { resolved: false, ambiguous: false, ...(near.length ? { suggestions: near } : {}) };
  }

  // Apply role filter before scoring
  const { filtered: roleFiltered, hiddenTestCount } = applyRoleFilter(nodes, opts ?? {});

  // Hard path filter: when --path is provided, exclude candidates whose sourceUri does not
  // contain the filter string. If no candidates survive, return "not found" rather than
  // falling back to cross-repo results.
  const filteredNodes = effectivePath
    ? roleFiltered.filter((n: any) => {
        const uri = normalizeForPathMatch(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");
        return uri.includes(normalizeForPathMatch(effectivePath));
      })
    : roleFiltered;

  if (effectivePath && filteredNodes.length === 0) {
    missProse(opts, `No entity named "${symbol}" found in paths matching "${effectivePath}".`);
    // The name exists — just not under --path. Saying where it does live is the
    // whole answer to the question the filter was asking.
    const suggestions = toSuggestions(roleFiltered);
    return { resolved: false, ambiguous: false, hiddenTestCount, ...(suggestions.length ? { suggestions } : {}) };
  }

  // ── Phase 1: Exact-name candidates ──────────────────────────────────
  const symbolLower = symbol.toLowerCase();
  // Prefer case-sensitive exact matches. Fall back to case-insensitive only if none found.
  // This prevents e.g. 'Apply' (capital A) from matching lowercase 'apply' module import
  // aliases before finding the actual 'Apply' method entities.
  // A file whose stem is the symbol counts as an exact name: it is the only
  // definition an anonymous default export has, and scoring then puts it
  // behind a same-named symbol but ahead of an import of the name. It joins
  // whichever set the NAMES chose and never chooses it: `paginator` must fall
  // back to the class `Paginator`, not stop at `paginator.py` because only
  // the file's stem matched case-sensitively.
  const exactCaseSymbols = filteredNodes.filter((n: any) => (n.name || n.attrs?.name || "") === symbol);
  const exactName = exactCaseSymbols.length > 0
    ? [
        ...exactCaseSymbols,
        ...filteredNodes.filter((n: any) =>
          isFileStemMatch(n, symbol) && (n.name || n.attrs?.name || "").startsWith(symbol)),
      ]
    : filteredNodes.filter((n: any) => {
        const name = (n.name || n.attrs?.name || "").toLowerCase();
        return name === symbolLower || isFileStemMatch(n, symbol);
      });

  // Score exact-name candidates
  if (exactName.length > 0) {
    const winner = pickBest(exactName, symbol, preferredKinds, { ...opts, path: effectivePath });
    if (winner) {
      const picked = applyPick(winner, opts);
      if (picked) return { ...picked, hiddenTestCount } as ResolveResult;
      return { ...winner, hiddenTestCount } as ResolveResult;
    }
  }

  // ── Phase 2: Fall back to all candidates ────────────────────────────
  const winner = pickBest(filteredNodes, symbol, preferredKinds, { ...opts, path: effectivePath });
  if (winner) {
    const picked = applyPick(winner, opts);
    if (picked) return { ...picked, hiddenTestCount } as ResolveResult;
    return { ...winner, hiddenTestCount } as ResolveResult;
  }

  // Nothing resolved at all
  missProse(opts, `No entity found matching "${symbol}".`);
  const suggestions = toSuggestions(filteredNodes);
  return { resolved: false, ambiguous: false, hiddenTestCount, ...(suggestions.length ? { suggestions } : {}) };
}

/**
 * True when some candidate is a code definition named `symbol` (or its defining file).
 *
 * Code kinds only: `candidateOrigin` calls anything it cannot place a
 * definition, and that includes the `region` nodes `ix map` names after
 * directories and modules (`Format`, `Search`, `CLI`, provenance `ix:map`).
 * Counting one would skip the lookup for the file that defines the name.
 */
export function hasDefinitionOf(nodes: any[], symbol: string): boolean {
  const symbolLower = symbol.toLowerCase();
  return nodes.some((n: any) => {
    const name = String(n.name || n.attrs?.name || "").toLowerCase();
    const sourceUri = String(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");
    return (name === symbolLower || isFileStemMatch(n, symbol))
      && STRUCTURAL_KINDS.has(String(n.kind || "").toLowerCase())
      && !sourceUri.startsWith("ix:")
      && candidateOrigin(n) === "definition";
  });
}

export function mergeById<T extends { id?: unknown }>(base: T[], extra: T[]): T[] {
  const seen = new Set(base.map((n) => n.id));
  return [...base, ...extra.filter((n) => !seen.has(n.id))];
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
    const message = `--pick ${opts.pick} is out of range (1-${candidates.length}).`;
    stderr(message);
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
    diagnostics: [{ code: "ambiguous_resolution", message: disambiguationHint("Use --pick <n> or --path to disambiguate.") }],
  };
}

export function printAmbiguous(symbol: string, result: AmbiguousResult, opts?: { kind?: string; path?: string }): void {
  reportAmbiguousTarget(symbol, result, "text", opts);
}

/**
 * Print the resolved target before showing results (text mode only).
 * Callers should skip this when format === "json" to keep JSON strict.
 */
export function printResolved(target: ResolvedEntity): void {
  if (isQuiet()) return;
  const shortId = target.id.slice(0, 8);
  const modeStr = target.resolutionMode !== "exact"
    ? chalk.dim(` (${target.resolutionMode})`)
    : "";
  stderr(`${chalk.dim("Resolved:")} ${chalk.cyan(target.kind)} ${chalk.dim(shortId)} ${chalk.bold(target.name)}${modeStr}\n`);
}

/** Check if a string looks like a raw UUID (not a human-readable name). */
export function isRawId(s: string): boolean {
  // Anchored at both ends: a UUID followed by anything else (`<uuid>/../health`)
  // is a name to search for, not an id to put into a URL path.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
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
 * Keeps ambiguity distinct from a genuine miss so machine callers can act on it.
 */
export async function resolveFileOrEntityFull(
  client: IxClient,
  target: string,
  opts?: ResolveOpts
): Promise<ResolveResult> {
  // 1. Raw UUID
  if (isRawId(target)) {
    try {
      const details = await client.entity(target);
      const n = details.node as any;
      return {
        resolved: true,
        entity: {
          id: target,
          kind: n.kind || "unknown",
          name: n.name || target,
          resolutionMode: "exact",
        },
      };
    } catch {
      missProse(opts, `Entity not found: ${target}`);
      return { resolved: false, ambiguous: false };
    }
  }

  // 1.5 Short ID prefix (8–31 hex chars, e.g. "aacc3359" from CLI output)
  if (/^[0-9a-f]{8,31}$/i.test(target)) {
    try {
      const fullId = await client.resolvePrefix(target);
      const details = await client.entity(fullId);
      const n = details.node as any;
      return {
        resolved: true,
        entity: {
          id: fullId,
          kind: n.kind || "unknown",
          name: n.name || target,
          resolutionMode: "exact",
        },
      };
    } catch {
      // Not a valid entity prefix — fall through to normal resolution
    }
  }

  // 2. File-like input → try graph file search
  if (looksFileLike(target)) {
    const fileEntity = await tryFileGraphMatch(client, target, opts);
    if (fileEntity) return { resolved: true, entity: fileEntity };
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
    const result = await resolveEntityFull(client, scoped.methodName, ['method', 'function'], scopedOpts);
    if (result.resolved) {
      // Rewrite the display name to show the full scoped form
      return {
        ...result,
        entity: { ...result.entity, name: `${scoped.className}::${scoped.methodName}` },
      };
    }
    // Not found — return null (don't fall through to a literal "Foo::Bar" search)
    return result;
  }

  // 3. Symbol resolution (handles all entity kinds)
  //
  // Order is a tie-break, not a filter — an unlisted kind still resolves, it
  // just sorts last among equal-scoring candidates. `constant` is here so a
  // module-level constant is not ranked behind every config entry and heading
  // that happens to share its name (Ix#679).
  const allKinds = ["file", "class", "object", "trait", "interface", "module", "method", "function", "constant"];
  if (!looksFileLike(target)) return resolveEntityFull(client, target, allKinds, opts);
  // A path is a question about a file. "No entity found" answered it as if it
  // were a symbol, which does not say whether the file exists, was never
  // ingested, or was mistyped -- three different next steps.
  const result = await resolveEntityFull(client, target, allKinds, { ...opts, silentMiss: true });
  if (result.resolved || result.ambiguous) return result;
  return fileMiss(client, target, opts);
}

/**
 * The miss for a file target: on disk but not in the graph, or on neither,
 * with the graph's nearest file names as suggestions.
 */
async function fileMiss(client: IxClient, target: string, opts?: ResolveOpts): Promise<ResolveResult> {
  const candidates = path.isAbsolute(target)
    ? [target]
    : [path.resolve(resolveWorkspaceRoot(), target), path.resolve(process.cwd(), target)];
  const onDisk = candidates.some((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const message = onDisk
    ? `"${target}" exists on disk but is not in the graph: it has not been ingested yet (run \`ix map\`), ` +
      "or it is ignored or of a type Ix does not parse."
    : `No file "${target}" in the graph, and none at that path on disk.`;
  missProse(opts, message);
  const { workspaceId, systemId } = activeScope();
  const stem = path.basename(target).replace(/\.[^.]+$/, "");
  const near = (await nearestNames(client, stem, { kind: "file", workspaceId, systemId }, (n) => {
    const name = String(n.name ?? "");
    return name.replace(/\.[^.]+$/, "");
  })).filter((sug) => !opts?.path || (sug.path ?? "").toLowerCase().includes(opts.path.toLowerCase()));
  return {
    resolved: false,
    ambiguous: false,
    reason: onDisk ? "file_not_in_graph" : "file_not_found",
    message,
    ...(near.length ? { suggestions: near } : {}),
  };
}

/** Levenshtein distance, case-insensitive. Small inputs only (names). */
export function editDistance(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/**
 * The graph names closest to `symbol`, for a miss. Two name-only searches, for
 * a leading and a trailing fragment (a typo sits in one half or the other),
 * then ranked by edit distance and kept only when close enough to be a
 * plausible intent. Best-effort: any failure is "no suggestions".
 */
export async function nearestNames(
  client: Pick<IxClient, "search">,
  symbol: string,
  scope: { kind?: string; workspaceId?: string; systemId?: string },
  nameOf: (node: any) => string = (n) => String(n.name ?? n.attrs?.name ?? ""),
  limit = 3,
): Promise<Suggestion[]> {
  if (symbol.length < 4) return [];
  const width = Math.max(3, Math.ceil(symbol.length * 0.5));
  const fragments = [...new Set([symbol.slice(0, width), symbol.slice(-width)])];
  try {
    const found = (await Promise.all(fragments.map((term) => client.search(term, {
      limit: 30, kind: scope.kind, nameOnly: true, workspaceId: scope.workspaceId, systemId: scope.systemId,
    })))).flat();
    const maxDistance = Math.max(2, Math.floor(symbol.length / 3));
    const ranked = found
      .filter((n: any) => n?.id && n.kind !== "chunk")
      .map((n: any) => ({ n, d: editDistance(nameOf(n), symbol) }))
      .filter(({ d }) => d <= maxDistance)
      .sort((a, b) => a.d - b.d || Number(!STRUCTURAL_KINDS.has(a.n.kind)) - Number(!STRUCTURAL_KINDS.has(b.n.kind)));
    // One row per name and file: an import of the name in the same file adds nothing.
    const seen = new Set<string>();
    const unique = ranked.map(({ n }) => n).filter((n: any) => {
      const key = `${n.name}|${n.provenance?.sourceUri ?? n.provenance?.source_uri ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return toSuggestions(unique, limit);
  } catch {
    return [];
  }
}

export async function resolveFileOrEntity(
  client: IxClient,
  target: string,
  opts?: ResolveOpts,
): Promise<ResolvedEntity | null> {
  const result = await resolveFileOrEntityFull(client, target, opts);
  if (result.resolved) return result.entity;
  if (result.ambiguous) reportAmbiguousTarget(target, result.result, "text", opts);
  return null;
}

export async function resolveFileOrReport(
  client: IxClient,
  target: string,
  opts: ResolveOpts | undefined,
  format: string,
): Promise<ResolvedEntity | null> {
  // The format goes in so the resolver knows whether a person will read its
  // prose, or whether the structured record below is the only copy that should
  // reach stdout.
  const result = await resolveFileOrEntityFull(client, target, { ...opts, format });
  if (result.resolved) return result.entity;
  if (!result.ambiguous) {
    // A miss on an empty or hollowed graph is not evidence the name does not
    // exist. Only on this path, and cached per backend revision.
    const graph = await checkGraphHealth(client, activeScope());
    if (isUnhealthy(graph)) {
      reportResolutionFailure(target, { ...result, graph }, format, opts);
      return null;
    }
  }
  reportResolutionFailure(target, result, format, opts);
  return null;
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
  // Explicit --path only (not the absolute workspace root); scope server-side instead.
  const effectivePath = opts?.path;
  await ensureReadScope(client); // fold in a Path-2 stitched system (Ix#225 Half B)
  const { workspaceId, systemId } = activeScope();

  // Search for file entities matching the basename
  const nodes = await client.search(basename, {
    limit: effectivePath ? 200 : 50,
    kind: "file",
    nameOnly: true,
    workspaceId,
    systemId,
  });

  // Filter to actual matches. Leading `./` and `../` say where the caller is
  // standing, not where the file is, so they are not part of the suffix match.
  const targetLower = normalizeForPathMatch(target).replace(/^(\.\.?\/)+/, "");
  const basenameLower = basename.toLowerCase();
  const basenameNoExt = basename.replace(/\.[^.]+$/, "").toLowerCase();
  const normalizedPathHint = normalizeForPathMatch(effectivePath);

  const matches: Array<{ node: any; quality: number }> = [];
  for (const n of nodes as any[]) {
    const name = (n.name || "").toLowerCase();
    const uri = normalizeForPathMatch(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");

    // Exact path match (best): covers both absolute URIs matching absolute target,
    // and relative URIs that are a suffix of an absolute target path.
    if (targetHasPath && (uri.endsWith(targetLower) || uri === targetLower
        || (uri.includes("/") && targetLower.endsWith(uri)))) {
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
  // A path names one file. When no node sits at it, a same-named file
  // elsewhere is a different file: `docs-site/package.json` resolved to the
  // repo-root `package.json` and was answered about with full confidence. The
  // miss is reported instead, with that file among its suggestions.
  if (targetHasPath && !effectivePath && !matches.some((m) => m.quality === 0)) return null;

  // Sort by quality then by URI length ascending (shorter = closer to root = more prominent)
  matches.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality - b.quality;
    const uriA = normalizeForPathMatch(a.node.provenance?.sourceUri ?? a.node.provenance?.source_uri ?? "");
    const uriB = normalizeForPathMatch(b.node.provenance?.sourceUri ?? b.node.provenance?.source_uri ?? "");
    return uriA.length - uriB.length;
  });

  // If multiple matches at same quality, prefer path-matching target
  const best = matches[0];
  if (matches.length > 1 && matches[0].quality === matches[1].quality && (target.includes("/") || target.includes("\\") || !!normalizedPathHint)) {
    // Disambiguate by path when user provided a path
    const pathMatch = matches.find(m => {
      const uri = normalizeForPathMatch(m.node.provenance?.sourceUri ?? m.node.provenance?.source_uri ?? "");
      return uri.endsWith(targetLower) || uri === targetLower
        || (uri.includes("/") && targetLower.endsWith(uri))
        || (!!normalizedPathHint && uri.includes(normalizedPathHint));
    });
    if (pathMatch) {
      return nodeToResolved(pathMatch.node, pathMatch.node.name, "exact");
    }
  }

  return nodeToResolved(best.node, best.node.name || basename, best.quality === 0 ? "exact" : "scored");
}
