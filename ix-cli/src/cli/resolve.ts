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
import { reportAmbiguousTarget, reportResolutionFailure, reportResolutionNotices } from "./ui.js";
import { relativePath } from "./format.js";
import { isQuiet } from "./output-shape.js";
import { disambiguationHint } from "./next-step.js";
import { explainSymbolMiss } from "./miss-reason.js";
import { isBackendUnreachable } from "./errors.js";
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

export type ResolutionMode = "exact" | "preferred-kind" | "scored" | "ambiguous" | "heuristic" | "fuzzy";

export interface ResolvedEntity {
  id: string;
  kind: string;
  name: string;
  path?: string;
  resolutionMode: ResolutionMode;
}

export interface AmbiguousResult {
  resolutionMode: "ambiguous";
  candidates: Array<{ id: string; name: string; kind: string; path?: string; line?: number; score?: number; rank?: number }>;
  diagnostics?: Array<{ code: string; message: string }>;
  /** How many candidates tied (the candidate list shows at most 8 of them). */
  total?: number;
  /** True when the search window came back full, so `total` is a lower bound. */
  truncated?: boolean;
}

/**
 * A resolved target that was a guess worth reporting. The result still resolves
 * (exit 0); the notice says which candidates were passed over, or that the
 * match was fuzzy. It is never an `error`, so plugin runners see no failure.
 */
export interface ResolutionNotice {
  code: "ambiguous_target" | "fuzzy_match";
  target: string;
  message: string;
  chosen: { id: string; name: string; kind: string; path?: string };
  candidates: AmbiguousResult["candidates"];
  total: number;
  truncated?: boolean;
  /** Extra diagnostics, e.g. `pick_out_of_range`. */
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
  /** The command takes `--all`, so an ambiguity's hint names it. */
  offerAll?: boolean;
}

export interface Suggestion {
  id: string;
  name: string;
  kind: string;
  path?: string;
}

export type ResolveResult =
  | { resolved: true; entity: ResolvedEntity; hiddenTestCount?: number; notices?: ResolutionNotice[] }
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
      /** For a symbol miss with a `symbol_*` reason: the files the name appears in. */
      files?: string[];
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
  if (result.resolved) {
    if (result.notices?.length) reportResolutionNotices(result.notices, "text", opts);
    return result.entity;
  }
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
  const windowFull = nodes.length >= searchLimit;

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

  // Finish a pick: --pick selects among an ambiguous result's candidates, or
  // among the candidates a resolved result's notice passed over.
  const finish = (winner: ResolveResult): ResolveResult => {
    const picked = applyPick(winner, opts);
    if (picked) return { ...picked, hiddenTestCount } as ResolveResult;
    return { ...pickFromNotice(winner, opts), hiddenTestCount } as ResolveResult;
  };
  const pickOpts = { ...opts, path: effectivePath, windowFull };

  // Score exact-name candidates
  if (exactName.length > 0) {
    const winner = pickBest(exactName, symbol, preferredKinds, pickOpts);
    if (winner) return finish(winner);
  }

  // ── Phase 2: Fall back to all candidates ────────────────────────────
  // No candidate carries the name, so whatever wins is a fuzzy match: it
  // resolves (exit 0 as before) but is labelled, and the notice says so.
  const winner = pickBest(filteredNodes, symbol, preferredKinds, pickOpts);
  if (winner) {
    if (winner.resolved) {
      const e = winner.entity;
      return finish({
        ...winner,
        entity: { ...e, resolutionMode: "fuzzy" },
        notices: [fuzzyNotice(symbol, e), ...(winner.notices ?? [])],
      });
    }
    if (winner.ambiguous) {
      winner.result.diagnostics = [
        ...(winner.result.diagnostics ?? []),
        { code: "fuzzy_match", message: `No exact match for ${symbol}; these are fuzzy matches.` },
      ];
      // --pick among fuzzy candidates is still a fuzzy match: keep the label.
      const picked = applyPick(winner, opts);
      if (picked?.resolved) {
        const e = picked.entity;
        return {
          ...picked,
          entity: { ...e, resolutionMode: "fuzzy" },
          notices: [fuzzyNotice(symbol, e)],
          hiddenTestCount,
        };
      }
    }
    return finish(winner);
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

/** Start line of a node, for a stable candidate order. Missing sorts last. */
function lineOf(node: any): number {
  const v = Number(node?.attrs?.line_start ?? node?.attrs?.lineStart ?? node?.line_start);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}

function nodePath(node: any): string {
  return normalizeForPathMatch(node?.provenance?.sourceUri ?? node?.provenance?.source_uri ?? node?.path ?? "");
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Order for display and `--pick`: (path, line, id), independent of backend order. */
function displayOrder(a: any, b: any): number {
  return cmpStr(nodePath(a), nodePath(b)) || lineOf(a) - lineOf(b) || cmpStr(String(a.id), String(b.id));
}

function entityPath(node: any): string | undefined {
  return node.provenance?.sourceUri ?? node.provenance?.source_uri ?? node.path;
}

/** The one-line notice for a target resolved by a fuzzy (non-exact) name. */
function fuzzyNotice(symbol: string, e: ResolvedEntity): ResolutionNotice {
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
  const amb = buildAmbiguous(tier.map((s) => s.node), tier.map((s) => s.score), {
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
 */
function pickBest(
  candidates: any[],
  symbol: string,
  preferredKinds: string[],
  opts?: { kind?: string; path?: string; windowFull?: boolean }
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
    notices: [tieNotice(symbol, best.node, topTier, opts?.windowFull, eligible.length - topTier.length)],
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
  if (opts?.path) {
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
      total: eligible.length,
      truncated: opts?.windowFull,
    }),
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

  // Every tied candidate, the shown 8 first: `--all` numbers past 8 (n=9...)
  // and `--pick` must reach them by the same numbers.
  const candidates = allCandidatesOf(result.result);
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

/**
 * `--pick n` on a resolved result that carries an ambiguous_target notice picks
 * among the notice's candidates. Unlike applyPick on an ambiguous result, an
 * out-of-range pick keeps the default choice and the exit code stays 0: --pick
 * must not create a new non-zero exit.
 */
export function pickFromNotice(
  result: ResolveResult,
  opts?: { pick?: number },
): ResolveResult {
  if (opts?.pick == null || !result.resolved || !result.notices) return result;
  const at = result.notices.findIndex((n) => n.code === "ambiguous_target");
  if (at < 0) return result;
  const notice = result.notices[at];
  const candidates = allCandidatesOf(notice);
  const idx = opts.pick - 1;
  if (idx < 0 || idx >= candidates.length) {
    const message = `--pick ${opts.pick} is out of range (1-${candidates.length}).`;
    stderr(message);
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

/** "exact" only for a case-sensitive exact name; otherwise the score bands. */
function resolutionMode(scored: { node: any; score: number }, symbol: string): ResolutionMode {
  const name = scored.node?.name || scored.node?.attrs?.name || "";
  if (scored.score <= 0 && name === symbol) return "exact";
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

function rememberAll(
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
function importIdsOf(owner: object): Set<string> {
  return fullCandidates.get(owner)?.imports ?? new Set();
}

function buildAmbiguous(
  nodes: any[],
  scores?: number[],
  extra?: { total?: number; truncated?: boolean; diagnostics?: Array<{ code: string; message: string }> },
): AmbiguousResult {
  // The 8 best by the caller's ranking, then shown (and numbered for --pick) in
  // (path, line, id) order so `--pick n` means the same thing on every run.
  const seen = new Set<string>();
  const picked: Array<{ node: any; score?: number }> = [];
  for (let i = 0; i < nodes.length && picked.length < 8; i++) {
    const node = nodes[i] as any;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    picked.push({ node, score: scores?.[i] });
  }
  picked.sort((a, b) => displayOrder(a.node, b.node));
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
    ...(extra?.total != null ? { total: extra.total } : {}),
    ...(extra?.truncated ? { truncated: true } : {}),
    diagnostics: [
      { code: "ambiguous_resolution", message: disambiguationHint("Use --pick <n> or --path to disambiguate.") },
      ...(extra?.diagnostics ?? []),
    ],
  };
  const unique = nodes.filter((n: any, i) => n?.id && nodes.findIndex((m: any) => m?.id === n.id) === i);
  const imports = new Set(unique.filter((n: any) => candidateOrigin(n) === "import").map((n: any) => String(n.id)));
  rememberAll(result, candidates, [...unique].sort(displayOrder).map(candidateOf), imports);
  return result;
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
 * Parse a scoped symbol like "ClassName::methodName" (C++/Rust/PHP style), or
 * the `Class.method` / `Class#method` spellings (JS, Java, Python docs).
 * Splits on the *last* separator so nested scopes like `ns::Class::method`
 * resolve to `{ className: "ns::Class", methodName: "method" }`. `.` and `#`
 * need identifier parts on both sides and a target that is not a file name;
 * `allowFileName` lifts the last rule, for `Response.json` once no file of
 * that name is found.
 */
function parseScopedSymbol(
  symbol: string,
  allowFileName = false,
): { className: string; methodName: string; sep: "::" | "." | "#" } | null {
  const idx = symbol.lastIndexOf('::');
  if (idx >= 1) {
    const className = symbol.slice(0, idx);
    const methodName = symbol.slice(idx + 2);
    if (className && methodName) return { className, methodName, sep: "::" };
    return null;
  }
  if (!allowFileName && looksFileLike(symbol)) return null;
  const at = Math.max(symbol.lastIndexOf('#'), symbol.lastIndexOf('.'));
  if (at < 1) return null;
  const className = symbol.slice(0, at);
  const methodName = symbol.slice(at + 1);
  if (!/^[A-Za-z_$][\w$]*$/.test(methodName)) return null;
  if (!/^[A-Za-z_$][\w$]*([.#][A-Za-z_$][\w$]*)*$/.test(className)) return null;
  return { className, methodName, sep: symbol[at] as "." | "#" };
}

/** The separator when `target` is `Class::method`, `Class.method` or `Class#method`, else null. */
export function qualifiedSeparator(target: string): "::" | "." | "#" | null {
  return parseScopedSymbol(target)?.sep ?? null;
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
    let n: any;
    try {
      n = (await client.entity(target))?.node;
    } catch (err) {
      // Only "no such id" is a miss. A backend that is down, refusing or
      // erroring is a real error (exit 1), not a missing symbol (exit 3).
      if (!isLookupMiss(err)) throw err;
    }
    // A 200 without a node names nothing too: a miss, not a cli_error.
    if (!n || typeof n !== "object") {
      missProse(opts, `Entity not found: ${target}`);
      return { resolved: false, ambiguous: false };
    }
    return {
      resolved: true,
      entity: {
        id: target,
        kind: n.kind || "unknown",
        name: n.name || target,
        resolutionMode: "exact",
      },
    };
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
    } catch (err) {
      // A hex-looking target can still be a symbol name (`deadbeef`), so any
      // answer short of an unreachable backend falls through to the name
      // search rather than failing a symbol that exists. Unreachable is
      // rethrown only because the name search would fail the same way.
      if (isBackendUnreachable(err)) throw err;
    }
  }

  // 2. File-like input → try graph file search
  if (looksFileLike(target)) {
    const fileResult = await tryFileGraphMatch(client, target, opts);
    // `Response.json`, `Template.html`, `Tree.go`: a method name can end in a
    // file extension. When no file has exactly that name, the qualified
    // reading is tried before a weaker file match or a miss; a file that has
    // the name still wins.
    const dotted = /[\\/]/.test(target) ? null : parseScopedSymbol(target, true);
    const namesFile = fileResult?.resolved && fileResult.entity.name.toLowerCase() === target.toLowerCase();
    if (fileResult && (!dotted || namesFile)) return fileResult;
    if (dotted) {
      const qualified = await resolveQualified(client, dotted, opts, true);
      if (qualified?.resolved) return qualified;
    }
    if (fileResult) return fileResult;
    // Fall through to symbol resolution
  }

  // 2.5 Scoped symbol (e.g. "CompactionJob::Run", "ns::Class::method")
  const scoped = parseScopedSymbol(target);
  if (scoped?.sep === "::") {
    // Not found is returned as is (no fall-through to a literal "Foo::Bar" search).
    return (await resolveQualified(client, scoped, opts, false))!;
  }

  // 3. Symbol resolution (handles all entity kinds)
  //
  // Order is a tie-break, not a filter — an unlisted kind still resolves, it
  // just sorts last among equal-scoring candidates. `constant` is here so a
  // module-level constant is not ranked behind every config entry and heading
  // that happens to share its name (Ix#679).
  const allKinds = ["file", "class", "object", "trait", "interface", "module", "method", "function", "constant"];
  if (scoped) {
    // `Class.method` / `Class#method`: a name stored with a dot (`os.path`)
    // resolves literally, so the qualified reading is tried only when the
    // literal lookup finds nothing, and only if the class itself is found.
    // A literal hit that is only fuzzy (no exact name) does not stop the
    // qualified reading, but the qualified one replaces it only where that
    // keeps the exit code: a resolved literal is replaced only by a resolved one.
    const literal = await resolveEntityFull(client, target, allKinds, { ...opts, silentMiss: true });
    if ((literal.resolved || literal.ambiguous) && !isFuzzyResult(literal)) return literal;
    const qualified = await resolveQualified(client, scoped, opts, true);
    if (qualified?.resolved) return qualified;
    if (literal.resolved || literal.ambiguous) return literal;
    if (qualified?.ambiguous) return qualified;
    missProse(opts, opts?.path
      ? `No entity named "${target}" found in paths matching "${opts.path}".`
      : `No entity found matching "${target}".`);
    return literal;
  }
  if (!looksFileLike(target)) return resolveEntityFull(client, target, allKinds, opts);
  // A path is a question about a file. "No entity found" answered it as if it
  // were a symbol, which does not say whether the file exists, was never
  // ingested, or was mistyped -- three different next steps.
  const result = await resolveEntityFull(client, target, allKinds, { ...opts, silentMiss: true });
  if (result.resolved || result.ambiguous) return result;
  return fileMiss(client, target, opts);
}

/**
 * Resolve `Class<sep>method`. For `::` (requireClass false): find the class for
 * its source file, then the method boosted toward that file, as before. With
 * `requireClass` (the `.`/`#` spellings) the method must be contained by the
 * class (its CONTAINS children, else the class's exact source file); a class
 * that is not found, found only by a fuzzy match, or holding no such member
 * gives null, so a miss never becomes an unlabelled guess.
 */
async function resolveQualified(
  client: IxClient,
  scoped: { className: string; methodName: string; sep: "::" | "." | "#" },
  opts: ResolveOpts | undefined,
  requireClass: boolean,
): Promise<ResolveResult | null> {
  // Phase A: resolve the class entity to obtain its actual source file path.
  // This gives a precise path hint rather than a guess from snake_case conversion.
  // The lookup is silent: no "not found" or ambiguity text for the class.
  const shortClassName = scoped.className.split(/::|[.#]/).pop()!;
  const classResult = await resolveEntityFull(
    client,
    shortClassName,
    ['class', 'interface', 'struct', 'trait', 'object', 'function'],
    // No kind constraint for the class lookup. For `.`/`#`, --pick selects the
    // method, not the class, so it is not spent on the class lookup.
    { ...opts, kind: undefined, silentMiss: true, ...(requireClass ? { pick: undefined } : {}) },
  );
  // For `.`/`#` the class must exist by name: a fuzzy class (`User` matching
  // `UserService`) would turn a miss into a confident wrong answer.
  if (requireClass) {
    if (isFuzzyResult(classResult)) return null;
    // The method must live IN the class. A class name held by several classes
    // (ambiguous, or resolved by a tie rule) is still a class that exists: the
    // method is looked for in each of them rather than reported as a miss.
    if (classResult.resolved) {
      const tie = classResult.notices?.find((n) => n.code === "ambiguous_target");
      const e = classResult.entity;
      const classes = tie ? tie.candidates : [{ id: e.id, name: e.name, kind: e.kind, path: e.path }];
      return resolveInClasses(client, scoped, classes, !!tie?.truncated || (tie ? tie.total > tie.candidates.length : false), opts);
    }
    if (classResult.ambiguous) {
      const classes = classResult.result;
      return resolveInClasses(client, scoped, classes.candidates,
        !!classes.truncated || (classes.total ?? 0) > classes.candidates.length, opts);
    }
    return null;
  }
  const classEntity = classResult.resolved ? classResult.entity : null;

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
    // Rewrite the display name to show the full scoped form, as the user typed it
    return {
      ...result,
      entity: { ...result.entity, name: `${scoped.className}${scoped.sep}${scoped.methodName}` },
    };
  }
  return result;
}

/** A result that came from resolveEntityFull's fuzzy phase (no exact name). */
export function isFuzzyResult(r: ResolveResult): boolean {
  if (r.resolved) {
    return r.entity.resolutionMode === "fuzzy" || !!r.notices?.some((n) => n.code === "fuzzy_match");
  }
  return r.ambiguous && !!r.result.diagnostics?.some((d) => d.code === "fuzzy_match");
}

type Candidate = AmbiguousResult["candidates"][number];

function candidateOf(n: any): Candidate {
  const line = lineOf(n);
  return {
    id: String(n.id),
    name: n.name || n.attrs?.name || "",
    kind: n.kind ?? "",
    path: entityPath(n),
    ...(line !== Number.MAX_SAFE_INTEGER ? { line } : {}),
  };
}

/**
 * The members of `cls` named exactly `memberName`. Containment comes from the
 * graph: the class's CONTAINS children. Only when the graph has no CONTAINS
 * children for the class (or cannot be asked) does it fall back to the same
 * source file, compared exactly, never as a substring: `a/config.ts` is not
 * `xa/config.ts`.
 */
async function membersOf(
  client: IxClient,
  cls: { id: string; path?: string },
  memberName: string,
): Promise<{ found: Candidate[]; truncated: boolean }> {
  const named = (n: any) => n && String(n.id) !== cls.id && (n.name || n.attrs?.name) === memberName;
  let children: any[] | null;
  try {
    const expanded = await client.expand(cls.id, { direction: "out", predicates: ["CONTAINS"] });
    children = Array.isArray(expanded?.nodes) ? expanded.nodes.filter((n: any) => String(n?.id) !== cls.id) : null;
  } catch {
    children = null;
  }
  if (children && children.length > 0) {
    return { found: children.filter(named).map(candidateOf), truncated: false };
  }
  if (!cls.path) return { found: [], truncated: false };
  const classFile = normalizeForPathMatch(cls.path);
  const { workspaceId, systemId } = activeScope();
  const limit = 50;
  const nodes = await client.search(memberName, { limit, nameOnly: true, workspaceId, systemId, scope: cls.path });
  const found = nodes
    .filter((n: any) => named(n) && nodePath(n) === classFile)
    .map(candidateOf);
  return { found, truncated: nodes.length >= limit };
}

/**
 * `Class.method` / `Class#method`: the method looked up IN each class (one
 * class, or every class that holds the name). One method found resolves; several
 * are the ambiguous record (exit 1, the same code as the miss this replaces),
 * sorted by (path, line, id) so `--pick n` selects among them. None is null,
 * which the caller reports as the miss.
 */
async function resolveInClasses(
  client: IxClient,
  scoped: { className: string; methodName: string; sep: "::" | "." | "#" },
  classes: Candidate[],
  classesTruncated: boolean,
  opts: ResolveOpts | undefined,
): Promise<ResolveResult | null> {
  // Only the listed classes are searched; when more classes tied, the method
  // list is a lower bound and is marked truncated.
  let truncated = classesTruncated;
  const found = new Map<string, Candidate>();
  const seenClasses = new Set<string>();
  for (const cls of classes) {
    if (seenClasses.has(cls.id)) continue;
    seenClasses.add(cls.id);
    const r = await membersOf(client, cls, scoped.methodName);
    if (r.truncated) truncated = true;
    for (const c of r.found) if (!found.has(c.id)) found.set(c.id, c);
  }
  if (found.size === 0) return null;
  const display = `${scoped.className}${scoped.sep}${scoped.methodName}`;
  const ordered = [...found.values()].sort((a, b) =>
    cmpStr(normalizeForPathMatch(a.path), normalizeForPathMatch(b.path))
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
    || cmpStr(a.id, b.id));
  if (ordered.length === 1) {
    const only = ordered[0];
    return {
      resolved: true,
      entity: { id: only.id, kind: only.kind, name: display, path: only.path, resolutionMode: "scored" },
    };
  }
  const qualifiedResult: AmbiguousResult = {
    resolutionMode: "ambiguous",
    candidates: ordered.slice(0, 8).map((c, i) => ({ ...c, rank: i + 1 })),
    total: ordered.length,
    ...(truncated ? { truncated: true } : {}),
    diagnostics: [
      { code: "ambiguous_resolution", message: disambiguationHint("Use --pick <n> or --path to disambiguate.") },
    ],
  };
  rememberAll(qualifiedResult, qualifiedResult.candidates, ordered);
  const ambiguous: ResolveResult = { resolved: false, ambiguous: true, result: qualifiedResult };
  const picked = applyPick(ambiguous, opts);
  if (picked?.resolved) return { ...picked, entity: { ...picked.entity, name: display } };
  return picked ?? ambiguous;
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
      .sort((a, b) => a.d - b.d
        || Number(!STRUCTURAL_KINDS.has(a.n.kind)) - Number(!STRUCTURAL_KINDS.has(b.n.kind))
        || cmpStr(String(nameOf(a.n)), String(nameOf(b.n)))
        || cmpStr(nodePath(a.n), nodePath(b.n))
        || cmpStr(String(a.n.id), String(b.n.id)));
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
  if (result.resolved) {
    if (result.notices?.length) reportResolutionNotices(result.notices, "text", opts);
    return result.entity;
  }
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
  if (result.resolved) {
    if (result.notices?.length) reportResolutionNotices(result.notices, format, opts);
    return result.entity;
  }
  await reportUnresolved(client, target, result, opts, format);
  return null;
}

/**
 * Report a target that did not resolve, with the best "why" available: the
 * graph is empty or degraded, or (for a symbol) what the workspace's text says
 * about the name. Sets the exit code (outcome.ts).
 */
export async function reportUnresolved(
  client: IxClient,
  target: string,
  result: Exclude<ResolveResult, { resolved: true }>,
  opts: ResolveOpts | undefined,
  format: string,
): Promise<void> {
  if (result.ambiguous) {
    reportResolutionFailure(target, result, format, opts);
    return;
  }
  // A miss on an empty or hollowed graph is not evidence the name does not
  // exist. Only on this path, and cached per backend revision.
  const graph = await checkGraphHealth(client, activeScope());
  if (isUnhealthy(graph)) {
    reportResolutionFailure(target, { ...result, graph }, format, opts);
    return;
  }
  reportResolutionFailure(target, await withMissReason(client, target, result, opts, format), format, opts);
}

/**
 * A symbol miss with the reason the workspace's text gives (miss-reason.ts).
 * A file target already carries its own; a raw id has no text to look for.
 */
export async function withMissReason<T extends { reason?: string; message?: string; hiddenTestCount?: number }>(
  client: IxClient,
  target: string,
  result: T,
  opts: ResolveOpts | undefined,
  format: string | undefined,
): Promise<T> {
  if (result.reason || isRawId(target) || looksFileLike(target)) return result;
  if (await filteredOut(client, target, result, opts)) return result;
  const why = await explainSymbolMiss(client, target, { path: opts?.path, ...activeScope() });
  if (!why) return result;
  // The resolver already wrote the bare miss for a person; this is the part
  // that says what to do about it. Machine formats get it in the record.
  if (format !== "json" && format !== "llm") stderr(chalk.dim(why.message));
  return { ...result, reason: why.reason, message: why.message, ...(why.files ? { files: why.files } : {}) };
}

/**
 * Whether the miss is the filters' doing: `--kind`, `--path` or the test
 * filter set aside an entity that does carry the name. The probe judges by
 * the text alone, so it would call such a name never extracted and send the
 * agent to `ix text`; the plain miss, with its suggestions, is the true
 * answer. One unfiltered search, and only when a filter was in play. A failed
 * search counts as filtered out: it is no evidence the entity is missing.
 */
async function filteredOut(
  client: IxClient,
  target: string,
  result: { hiddenTestCount?: number },
  opts: ResolveOpts | undefined,
): Promise<boolean> {
  if (!opts?.kind && !opts?.path && !opts?.testsOnly && !result.hiddenTestCount) return false;
  const name = target.split(/::|[.#]/).filter(Boolean).pop() ?? target;
  const { workspaceId, systemId } = activeScope();
  try {
    const nodes = await client.search(name, { limit: 50, nameOnly: true, workspaceId, systemId });
    return (nodes as any[]).some((n) => (n?.name || n?.attrs?.name || "") === name);
  } catch {
    return true;
  }
}

/** The entities a command with `--all` runs over. */
export interface TargetSet {
  /**
   * Under `--all`, each entity's `n` is its `--pick` number in the ambiguity
   * list, so numbers can skip a candidate `--all` leaves out (an import).
   */
  entities: Array<ResolvedEntity & { n?: number }>;
  /**
   * Present when `--all` expanded the target to its candidates. `capped`:
   * more candidates were listed than `ALL_CANDIDATE_CAP`, so only the first
   * ones are answered.
   */
  all?: { total: number; truncated?: boolean; capped?: boolean };
}

/**
 * The one entity a target resolves to or, under `--all`, every listed
 * candidate of an ambiguous one (and of a target that resolved by choosing
 * among equal ties). `null` after reporting a miss.
 *
 * Without `--all`, or with `--pick`, this is `resolveFileOrReport`.
 */
export async function resolveTargetSetOrReport(
  client: IxClient,
  target: string,
  opts: (ResolveOpts & { all?: boolean }) | undefined,
  format: string,
): Promise<TargetSet | null> {
  const withAll = { ...opts, offerAll: true };
  if (!opts?.all || opts.pick !== undefined) {
    const entity = await resolveFileOrReport(client, target, withAll, format);
    return entity ? { entities: [entity] } : null;
  }
  const result = await resolveFileOrEntityFull(client, target, { ...opts, format });
  if (result.resolved) {
    const tie = result.notices?.find((n) => n.code === "ambiguous_target");
    if (!tie || tie.candidates.length <= 1) {
      if (result.notices?.length) reportResolutionNotices(result.notices, format, opts);
      return { entities: [result.entity] };
    }
    return candidateSet(tie, tie.total, tie.truncated);
  }
  if (result.ambiguous) {
    return candidateSet(result.result, result.result.total, result.result.truncated);
  }
  await reportUnresolved(client, target, result, withAll, format);
  return null;
}

/**
 * The most candidates one `--all` call answers for. Each is at least one
 * backend query (`impact` runs a whole analysis per candidate, one after
 * another), so a common name must not turn one call into hundreds of round
 * trips; past the cap, `--kind`/`--path` or `--pick` reach the rest.
 */
export const ALL_CANDIDATE_CAP = 25;

/**
 * Why an `--all` answer may not cover every candidate, or undefined when it
 * does: `ALL_CANDIDATE_CAP` stopped it, or the resolver's search window came
 * back full, so names past it were never seen.
 */
export function candidatesCut(set: TargetSet, answered: number, verb: string): string | undefined {
  if (!set.all) return undefined;
  if (set.all.capped) {
    return `${verb} the first ${answered} of ${set.all.total}${set.all.truncated ? "+" : ""} candidates ` +
      `(--all answers at most ${ALL_CANDIDATE_CAP}); narrow with --kind or --path, or reach one with --pick <n>.`;
  }
  if (!set.all.truncated && set.all.total <= answered) return undefined;
  return `${verb} ${answered} candidates, but the name search was cut off, so there may be more; ` +
    "narrow with --kind or --path to cover the rest.";
}

/**
 * The candidates `--all` answers for, each keeping its `--pick` number. An
 * import of the name (`from app.utils import clamp`) is listed in an ambiguity
 * but is not a definition: when a definition is listed too, the import is
 * skipped, since its callers are the definition's. When only imports are
 * listed they are still the answer (the same demotion-not-filter rule as
 * `originPenalty`).
 */
function candidateSet(owner: AmbiguousResult | ResolutionNotice, total?: number, truncated?: boolean): TargetSet {
  const numbered = allCandidatesOf(owner).map((c, i) => ({ c, n: i + 1 }));
  const imports = importIdsOf(owner);
  const definitions = numbered.filter(({ c }) => !imports.has(c.id));
  const kept = definitions.length > 0 ? definitions : numbered;
  const skipped = numbered.length - kept.length;
  const answered = kept.slice(0, ALL_CANDIDATE_CAP);
  return {
    entities: answered.map(({ c, n }) => ({ id: c.id, kind: c.kind, name: c.name, path: c.path, resolutionMode: "ambiguous", n })),
    all: {
      total: Math.max((total ?? numbered.length) - skipped, kept.length),
      ...(truncated ? { truncated: true } : {}),
      ...(kept.length > answered.length ? { capped: true } : {}),
    },
  };
}

/**
 * Whether an id lookup failed because the id names nothing: the backend's
 * 400/404/410 (`<status>: ...`, see `httpError`) or `resolvePrefix`'s own
 * no-match and ambiguous-prefix errors. Anything else -- a refused
 * connection, a 5xx, a 401 -- is not evidence about the id.
 */
export function isLookupMiss(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /^(400|404|410):/.test(message)
    || message.startsWith("No entity found for prefix:")
    || message.startsWith("Ambiguous prefix ");
}

/**
 * Search the graph for a file entity matching the target path or filename.
 *
 * Tiers, best first:
 *   quality: 0  the full path: equal to the uri, relative to the cwd, or an
 *               absolute path ending in it (the longest uri wins); or a
 *               filename inside --path
 *   quality: 1  a path suffix on a '/' boundary (`src/index.ts` in `pkg/src/index.ts`)
 *   quality: 2  a suffix not on a boundary (`li/config.ts`): kept so a path
 *               that names one file is not sent to the file miss, but
 *               labelled fuzzy with a fuzzy_match notice (`site/package.json`
 *               is not `docs-site/package.json`)
 *   quality: 3  the exact filename
 *   quality: 4  the filename without its extension
 * Within a tier, the shortest uri, then uri, then id. It never returns
 * ambiguous (a file target never newly exits 1): equal candidates resolve to
 * the first and carry an ambiguous_target notice listing the rest.
 */
async function tryFileGraphMatch(
  client: IxClient,
  target: string,
  opts?: { path?: string; pick?: number },
): Promise<ResolveResult | null> {
  const basename = path.basename(target);
  const targetHasPath = target.includes("/") || target.includes("\\");
  // Explicit --path only (not the absolute workspace root); scope server-side instead.
  const effectivePath = opts?.path;
  await ensureReadScope(client); // fold in a Path-2 stitched system (Ix#225 Half B)
  const { workspaceId, systemId } = activeScope();

  // Search for file entities matching the basename
  const limit = effectivePath ? 200 : 50;
  const nodes = await client.search(basename, {
    limit,
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
  const isAbsolute = path.isAbsolute(target) || /^[a-z]:\//.test(targetLower);
  let fromCwd = "";
  if (targetHasPath && !isAbsolute) {
    try { fromCwd = normalizeForPathMatch(path.relative(resolveWorkspaceRoot(), path.resolve(process.cwd(), target))); }
    catch { fromCwd = ""; }
  }

  const matches: Array<{ node: any; quality: number; uri: string; fuzzy?: boolean }> = [];
  for (const n of nodes as any[]) {
    const name = (n.name || "").toLowerCase();
    const uri = normalizeForPathMatch(n.provenance?.sourceUri ?? n.provenance?.source_uri ?? "");
    const add = (quality: number, fuzzy = false) => { matches.push({ node: n, quality, uri, fuzzy }); };

    if (targetHasPath && (uri === targetLower || (fromCwd && uri === fromCwd))) {
      add(0);
    } else if (targetHasPath && isAbsolute && uri.includes("/") && targetLower.endsWith("/" + uri)) {
      add(0);
    }
    // Filename match in user-requested path
    else if (normalizedPathHint && uri.includes(normalizedPathHint) && name === basenameLower) {
      add(0);
    }
    // Suffix on a '/' boundary
    else if (targetHasPath && uri.endsWith("/" + targetLower)) {
      add(1);
    }
    // Suffix that is not on a boundary
    // (a target longer than the uri, ending in it on a boundary, is not fuzzy)
    else if (targetHasPath && (uri.endsWith(targetLower) || (uri.includes("/") && targetLower.endsWith(uri)))) {
      add(2, !targetLower.endsWith("/" + uri));
    }
    // Exact filename match
    else if (name === basenameLower) {
      add(3);
    }
    // Bare name match (no extension)
    else if (name.replace(/\.[^.]+$/, "") === basenameNoExt) {
      add(4);
    }
  }

  if (matches.length === 0) return null;
  // A path names one file. When no node sits at it, a same-named file
  // elsewhere is a different file: `docs-site/package.json` resolved to the
  // repo-root `package.json` and was answered about with full confidence. The
  // miss is reported instead, with that file among its suggestions.
  if (targetHasPath && !effectivePath && !matches.some((m) => m.quality <= 2)) return null;

  // Quality, then the shortest uri (closer to the root = more prominent; for an
  // absolute path the longest, the deepest file it ends in), then uri, then id.
  matches.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality - b.quality;
    const byLength = isAbsolute && a.quality === 0 ? b.uri.length - a.uri.length : a.uri.length - b.uri.length;
    return byLength || cmpStr(a.uri, b.uri) || cmpStr(String(a.node.id), String(b.node.id));
  });

  const best = matches[0];
  // The candidates that tie with the best: same tier (and, for an absolute
  // path, the same file).
  const tied: typeof matches = [];
  const seenIds = new Set<string>();
  for (const m of matches) {
    if (m.quality !== best.quality) break;
    if (isAbsolute && best.quality === 0 && m.uri !== best.uri) continue;
    if (seenIds.has(m.node.id)) continue;
    seenIds.add(m.node.id);
    tied.push(m);
  }
  const entityOf = (m: typeof best, mode: ResolutionMode) => nodeToResolved(m.node, m.node.name || basename, mode);
  const fuzzy = !!best.fuzzy;
  if (tied.length <= 1) {
    if (fuzzy) {
      const entity = entityOf(best, "fuzzy");
      return { resolved: true, entity, notices: [fuzzyNotice(target, entity)] };
    }
    return { resolved: true, entity: entityOf(best, best.quality === 0 ? "exact" : "scored") };
  }
  const truncated = nodes.length >= limit;
  const amb = buildAmbiguous(tied.map((m) => m.node), undefined, { total: tied.length, truncated });
  const chosen = entityOf(best, fuzzy ? "fuzzy" : "scored");
  const notice: ResolutionNotice = {
    code: "ambiguous_target",
    target,
    message: `"${target}" matches ${truncated ? "at least " : ""}${tied.length} files equally; using ${chosen.path ?? chosen.name}.`,
    chosen: { id: chosen.id, name: chosen.name, kind: chosen.kind, path: chosen.path },
    candidates: amb.candidates,
    total: tied.length,
    ...(truncated ? { truncated: true } : {}),
  };
  rememberAll(notice, amb.candidates, allCandidatesOf(amb), importIdsOf(amb));
  const notices = fuzzy ? [notice, fuzzyNotice(target, chosen)] : [notice];
  return pickFromNotice({ resolved: true, entity: chosen, notices }, opts);
}
