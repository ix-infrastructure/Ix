// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import type { IxClient } from "../client/api.js";
import type { GraphNode } from "../client/types.js";
import { stderr } from "./stderr.js";
import { applyRoleFilter } from "./role-filter.js";
import { detectSystem } from "./system.js";
import { requireReadWorkspaceId, resolveWorkspaceId } from "./bootstrap.js";
import { readStitchScope, resolveWorkspaceRoot, stitchScopeCachePath, writeStitchScope } from "./config.js";
import { ixHome } from "./ix-home.js";
import { checkGraphHealth, isUnhealthy } from "./graph-health.js";
import { reportAmbiguousTarget, reportResolutionFailure, reportResolutionNotices } from "./ui.js";
import { relativePath } from "./format.js";
import { isQuiet } from "./output-shape.js";
import { disambiguationHint } from "./next-step.js";
import { explainSymbolMiss, missProbeWouldRun } from "./miss-reason.js";
import { strictTargets } from "./outcome.js";
import { reportTextMatches, sourceTextMatches, type TextMatch, type TextMatchSource } from "./text-matches.js";
import { isBackendUnreachable } from "./errors.js";
import { findTargetCandidates, rowsInclude } from "./target-suggestions.js";
import { isFileStemMatch } from "./candidate-origin.js";
import { normalizeForPathMatch } from "./path-match.js";
import { STRUCTURAL_KINDS, type GraphKind } from "./graph-model.js";
import { hasDefinitionOf, looksTypeLikeSymbol } from "./resolve/score.js";
import {
  AMBIGUOUS_HINT, allCandidatesOf, applyPick as pickAmong, buildAmbiguous, candidateOf, cmpStr,
  fuzzyNotice, importIdsOf, isFuzzyResult, nodePath, nodeToResolved, pickBest,
  pickFromNotice as pickInNotice, pickedOutOfRange, rememberAll, roundRobinByFile, type Candidate,
} from "./resolve/pick.js";
import type {
  AmbiguousResult, ResolutionMode, ResolutionNotice, ResolvedEntity, ResolveResult, Suggestion,
} from "./resolve/types.js";

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

/**
 * What a resolver needs from its caller.
 *
 * `format` is here so a miss is reported once. The prose ("No entity found
 * matching …") goes to stderr for a person; a json or llm caller gets the same
 * fact as a record on stdout from `reportUnresolvedTarget`, and printing both
 * means an agent running `ix … 2>&1` reads the miss twice.
 */
export interface ResolveOpts {
  suggest?: boolean;
  /** Only these command boundaries run the bounded candidate probes. */
  suggestCommand?: string;
  missStarted?: number;
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
  /**
   * `--strict`: report an ambiguous target (exit 2) or a name found only as
   * text (exit 3) as an error, rather than answer it (`answerAmbiguous`,
   * text-matches.ts). `IX_STRICT_TARGETS=1` does the same for every command.
   */
  strict?: boolean;
  /**
   * False: a miss is never answered with its source text matches, only
   * reported (exit 3). For a command whose output is an artifact the caller
   * asked for — `ix context --out` / `--save` — where a list of files is not
   * the bundle and exit 0 would claim one was written. An ambiguous target is
   * still answered, since that does produce the artifact.
   */
  textAnswer?: boolean;
  /**
   * The command's own `--format json` body with nothing in it (`results: []`,
   * `tree: []`), printed under a text-matches answer so its keys are there on
   * exit 0 (text-matches.ts `textMatchesJson`).
   */
  textAnswerJson?: Record<string, unknown>;
}

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

// ── Scoring and picking ───────────────────────────────────────────────────
// Pure, in resolve/score.ts and resolve/pick.ts; re-exported here so the
// modules that import them from resolve.ts keep working while they move.

export { baseScore, hasDefinitionOf, originPenalty, scoreCandidate } from "./resolve/score.js";
export { allCandidatesOf, isFuzzyResult, roundRobinByFile } from "./resolve/pick.js";
export type {
  AmbiguousResult, ResolutionMode, ResolutionNotice, ResolvedEntity, ResolveResult, Suggestion,
} from "./resolve/types.js";

/** resolve/pick.ts `applyPick`, saying an out-of-range `--pick` on stderr (every format). */
export function applyPick(result: ResolveResult, opts?: { pick?: number }): ResolveResult | null {
  return pickAmong(result, opts, stderr);
}

/** resolve/pick.ts `pickFromNotice`, saying an out-of-range `--pick` on stderr (every format). */
export function pickFromNotice(result: ResolveResult, opts?: { pick?: number }): ResolveResult {
  return pickInNotice(result, opts, stderr);
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
  return withContainers(client, await rankEntity(client, symbol, preferredKinds, opts));
}

/**
 * `resolveEntityFull` without the candidates' containers: for lookups inside
 * the resolver, and for a caller that may re-resolve before it reports (add
 * them with `withContainers` on the result it keeps).
 */
export async function rankEntity(
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

  // `--path` is applied client-side, after the backend has cut its
  // weight-ordered window. A common name (`add`, `get`) declared in hundreds
  // of files can fill that window before the row under --path arrives, and
  // the read then misses a name the file plainly declares. Only when the
  // window came back full, ask again with the path as `scope`, which the
  // backend applies before its limit. An older backend ignores `scope` and
  // returns the same window, so the merge changes nothing there.
  if (effectivePath && windowFull) {
    const scoped = await client.search(symbol, {
      limit: searchLimit,
      kind: kindFilter,
      nameOnly: true,
      workspaceId,
      systemId,
      scope: effectivePath.replace(/\\/g, "/"),
    });
    nodes = mergeById(nodes, scoped);
  }

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
    const near = opts?.suggest === false ? []
      : await nearestNames(client, symbol, { kind: kindFilter, workspaceId, systemId });
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
    const suggestions = opts?.suggest === false ? [] : toSuggestions(roleFiltered);
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
  const pickOpts = { ...opts, path: effectivePath, windowFull, hint: disambiguationHint(AMBIGUOUS_HINT) };

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
  const suggestions = opts?.suggest === false ? [] : toSuggestions(filteredNodes);
  return { resolved: false, ambiguous: false, hiddenTestCount, ...(suggestions.length ? { suggestions } : {}) };
}

export function mergeById<T extends { id?: unknown }>(base: T[], extra: T[]): T[] {
  const seen = new Set(base.map((n) => n.id));
  return [...base, ...extra.filter((n) => !seen.has(n.id))];
}

/**
 * Answer an ambiguous target for its top candidate, at the command layer.
 *
 * The ambiguous result becomes one resolved for the first candidate in the
 * record's own order (what `--pick 1` chooses), with an `ambiguous_target`
 * notice naming the choice and listing the candidates, numbered as `--pick`
 * numbers them (`rememberAll`, so the full list stays reachable). A guess, but
 * a visible one: #847 stopped *silent* guessing, and the notice is printed in
 * every format. An error here was pure overhead to an agent, which never
 * followed up with `--pick`.
 *
 * Only where a user-supplied target's failed resolution would be reported
 * (`resolveFileOrReport`, `ix locate`); internal resolution (`pickBest`,
 * `--from-issue` starts, rank, the post-edit hook) never calls it. Returns the
 * result untouched when it is not ambiguous, or under `--strict` /
 * `IX_STRICT_TARGETS=1`, and in two cases that are no tie to break:
 *
 * - Every candidate is a fuzzy match (no entity carries the name): the
 *   backend matches by substring, so `timeout` "matches" `connectTimeout` and
 *   `readTimeout`, and answering for either would be callers of a different
 *   symbol. The caller tries the name's source text first
 *   ({@link fuzzyTextAnswer}); otherwise the candidates are the answer, exit 2.
 * - An explicit `--pick <n>` past the end of the list: the caller asked for
 *   one candidate, and answering another with exit 0 would pass for it.
 */
export function answerAmbiguous(target: string, result: ResolveResult, opts?: { strict?: boolean }): ResolveResult {
  if (result.resolved || !result.ambiguous || strictTargets(opts)) return result;
  if (isFuzzyResult(result) || pickedOutOfRange(result)) return result;
  const amb = result.result;
  const all = allCandidatesOf(amb);
  const top = all[0];
  if (!top) return result;
  const total = amb.total ?? all.length;
  const where = top.path ? ` (${top.path})` : "";
  const count = `${amb.truncated ? "at least " : ""}${total}`;
  const notice: ResolutionNotice = {
    code: "ambiguous_target",
    target,
    message: `"${target}" matches ${count} candidates; using ${top.name}${where}.`,
    chosen: { id: top.id, name: top.name, kind: top.kind, path: top.path },
    candidates: amb.candidates,
    total,
    ...(amb.truncated ? { truncated: true } : {}),
  };
  // The record's "Use --pick or --path to disambiguate" is the notice's own
  // hint line now; anything else stays.
  const diagnostics = (amb.diagnostics ?? []).filter((d) => d.code !== "ambiguous_resolution");
  if (diagnostics.length) notice.diagnostics = diagnostics;
  rememberAll(notice, amb.candidates, all, importIdsOf(amb));
  return {
    resolved: true,
    entity: { id: top.id, kind: top.kind, name: top.name, path: top.path, resolutionMode: "scored" },
    notices: [notice],
    ...(result.hiddenTestCount ? { hiddenTestCount: result.hiddenTestCount } : {}),
  };
}

/**
 * The source text answer for a name whose only candidates are fuzzy matches.
 *
 * No entity carries the name, so it is a miss with near names, and the miss's
 * answer applies: the source files that mention the name itself (a config
 * key `timeout` beside `connectTimeout` and `readTimeout`), with the fuzzy
 * candidates as the near code symbols. One bounded probe, the one a miss
 * runs (explainSymbolMiss, under its run budget). Null, nothing printed, when
 * the text does not answer: under `--strict`, for a file or id target, when a
 * filter set aside an entity with the name, or when no source file has it.
 */
export async function fuzzyTextAnswer(
  client: IxClient,
  target: string,
  result: ResolveResult,
  opts: ResolveOpts | undefined,
): Promise<{ miss: TextMatchSource; rows: TextMatch[] } | null> {
  if (result.resolved || !result.ambiguous || !isFuzzyResult(result) || pickedOutOfRange(result)) return null;
  if (!answersText(opts) || isRawId(target) || looksFileLike(target) || !missProbeWouldRun(target)) return null;
  if (await filteredOut(client, target, result, opts)) return null;
  const why = await explainSymbolMiss(client, target, { path: opts?.path, ...activeScope() });
  if (!why) return null;
  const suggestions: Suggestion[] = result.result.candidates.map(({ id, name, kind, path: p }) => ({ id, name, kind, ...(p ? { path: p } : {}) }));
  const miss: TextMatchSource = { ...why, suggestions };
  const rows = sourceTextMatches(target, miss.matches);
  return rows.length ? { miss, rows } : null;
}

/** At most this many names are asked for containers; candidates usually share one. */
const CONTAINER_NAME_LOOKUPS = 3;

/**
 * The container lookup is decoration on an answer that is already complete,
 * and `/v1/expand-by-name` is not scoped to the workspace: on a large shared
 * graph a common name (`get`, `__init__`) can be slow. Past this the rows go
 * out without `container` rather than hold up the exit-2 record.
 */
export const CONTAINER_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Name the type that holds each candidate of an ambiguous result: its
 * `container`, the CONTAINS parent the graph has for it unless that is a file
 * (a top-level definition has none). Eight `crop` rows in one file cannot be
 * told apart without it.
 *
 * Entities carry no container attribute, so it comes from the edges: one
 * `/v1/expand-by-name` per distinct candidate name (one in the usual case,
 * where every candidate has the name that was asked for), never a request per
 * candidate. That endpoint answers for every entity of the name, so only
 * edges into a listed candidate are read. Best effort: a backend that cannot
 * answer (or not within CONTAINER_LOOKUP_TIMEOUT_MS) leaves the rows as they
 * were, and `container` is then absent.
 *
 * Only the ambiguous record (exit 2) pays for this. A resolved target, a
 * `--pick` and a tie notice make no extra request.
 */
export async function withContainers(client: IxClient, result: ResolveResult): Promise<ResolveResult> {
  if (result.resolved || !result.ambiguous) return result;
  const all = allCandidatesOf(result.result);
  const ids = new Set(all.map((c) => c.id));
  const names = [...new Set(result.result.candidates.map((c) => c.name).filter(Boolean))].slice(0, CONTAINER_NAME_LOOKUPS);
  const answers = await Promise.all(names.map(async (name) => {
    try {
      return await client.expandByName(name, { direction: "in", predicates: ["CONTAINS"], timeoutMs: CONTAINER_LOOKUP_TIMEOUT_MS });
    } catch {
      return null;
    }
  }));
  const owners = new Map<string, Set<string>>();
  for (const answer of answers) {
    if (!answer || !Array.isArray(answer.nodes) || !Array.isArray(answer.edges)) continue;
    const byId = new Map(answer.nodes.map((n) => [n.id, n] as const));
    for (const e of answer.edges) {
      if (e?.predicate !== "CONTAINS" || !ids.has(String(e.dst))) continue;
      const parent = byId.get(String(e.src));
      const name = parent?.name || parent?.attrs?.name;
      if (!name || String(parent?.kind ?? "").toLowerCase() === "file") continue;
      const set = owners.get(String(e.dst)) ?? new Set<string>();
      set.add(String(name));
      owners.set(String(e.dst), set);
    }
  }
  // Added in place: the listed rows are the same objects as the head of the
  // full list, so `--pick` and the shown page stay one list. Two different
  // owners for one candidate is not an answer.
  for (const c of all) {
    const found = owners.get(c.id);
    if (found?.size === 1) c.container = [...found][0];
  }
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
  return withContainers(client, await rankFileOrEntity(client, target, opts));
}

/** `resolveFileOrEntityFull` without the candidates' containers (`--all` lists none). */
async function rankFileOrEntity(
  client: IxClient,
  target: string,
  opts?: ResolveOpts
): Promise<ResolveResult> {
  // 1. Raw UUID
  if (isRawId(target)) {
    let n: GraphNode | undefined;
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
      const n = details.node;
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
  const allKinds: GraphKind[] = ["file", "class", "object", "trait", "interface", "module", "method", "function", "constant"];
  if (scoped) {
    // `Class.method` / `Class#method`: a name stored with a dot (`os.path`)
    // resolves literally, so the qualified reading is tried only when the
    // literal lookup finds nothing, and only if the class itself is found.
    // A literal hit that is only fuzzy (no exact name) does not stop the
    // qualified reading, but the qualified one replaces it only where that
    // keeps the exit code: a resolved literal is replaced only by a resolved one.
    const literal = await rankEntity(client, target, allKinds, { ...opts, silentMiss: true });
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
  if (!looksFileLike(target)) return rankEntity(client, target, allKinds, opts);
  // A path is a question about a file. "No entity found" answered it as if it
  // were a symbol, which does not say whether the file exists, was never
  // ingested, or was mistyped -- three different next steps.
  const result = await rankEntity(client, target, allKinds, { ...opts, silentMiss: true });
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
  const classResult = await rankEntity(
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
  const result = await rankEntity(client, scoped.methodName, ['method', 'function'], scopedOpts);
  if (result.resolved) {
    // Rewrite the display name to show the full scoped form, as the user typed it
    return {
      ...result,
      entity: { ...result.entity, name: `${scoped.className}${scoped.sep}${scoped.methodName}` },
    };
  }
  return result;
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
  const named = (n: GraphNode) => n && n.id !== cls.id && (n.name || n.attrs?.name) === memberName;
  let children: GraphNode[] | null;
  try {
    const expanded = await client.expand(cls.id, { direction: "out", predicates: ["CONTAINS"] });
    children = Array.isArray(expanded?.nodes) ? expanded.nodes.filter((n) => n?.id !== cls.id) : null;
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
    .filter((n) => named(n) && nodePath(n) === classFile)
    .map(candidateOf);
  return { found, truncated: nodes.length >= limit };
}

/**
 * `Class.method` / `Class#method`: the method looked up IN each class (one
 * class, or every class that holds the name). One method found resolves; several
 * are the ambiguous record (exit 1, the same code as the miss this replaces),
 * sorted by (path, line, id) and dealt round-robin by file (roundRobinByFile)
 * so `--pick n` selects among them. None is null,
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
  const ordered = roundRobinByFile([...found.values()].sort((a, b) =>
    cmpStr(normalizeForPathMatch(a.path), normalizeForPathMatch(b.path))
    || (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
    || cmpStr(a.id, b.id)));
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
      { code: "ambiguous_resolution", message: disambiguationHint(AMBIGUOUS_HINT) },
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
  const near = opts?.suggest === false ? [] : (await nearestNames(client, stem, { kind: "file", workspaceId, systemId }, (n) => {
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
  opts = { ...opts, missStarted: performance.now() };
  // The format goes in so the resolver knows whether a person will read its
  // prose, or whether the structured record below is the only copy that should
  // reach stdout.
  const result = answerAmbiguous(target, await resolveFileOrEntityFull(client, target, { ...opts, format }), opts);
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
    // Fuzzy matches only: the name's own source text, if any, is the answer.
    const text = await fuzzyTextAnswer(client, target, result, opts);
    if (text && reportTextMatches(target, text.miss, format, opts?.textAnswerJson)) return;
    reportResolutionFailure(target, result, format, opts);
    return;
  }
  // A miss on an empty or hollowed graph is not evidence the name does not
  // exist. Only on this path, and cached per backend revision.
  const graph = await checkGraphHealth(client, activeScope());
  if (isUnhealthy(graph)) {
    reportResolutionFailure(target, await withTargetCandidates(client, target, { ...result, graph }, opts), format, opts);
    return;
  }
  const reason = await withMissReason(client, target, result, opts, format);
  // The near names first: an answer from the text keeps them, as the miss does.
  const guided = await withTargetCandidates(client, target, reason, opts);
  // A name in source files but in no entity (a config key) is answered with
  // those files, exit 0 (text-matches.ts); found nowhere, it is the miss.
  if (answersText(opts) && reportTextMatches(target, guided, format, opts?.textAnswerJson)) return;
  reportResolutionFailure(target, guided, format, opts);
}

/** The source text matches a miss will be answered with; none under `--strict` or `textAnswer: false`. */
export function textMatchesFor(
  target: string,
  miss: { matches?: TextMatch[] },
  opts?: { strict?: boolean; textAnswer?: boolean },
): TextMatch[] {
  return answersText(opts) ? sourceTextMatches(target, miss.matches) : [];
}

function answersText(opts?: { strict?: boolean; textAnswer?: boolean }): boolean {
  return opts?.textAnswer !== false && !strictTargets(opts);
}

/** Add guidance at the final command miss, never during qualified-name resolution. */
export async function withTargetCandidates(
  client: IxClient,
  target: string,
  result: Extract<ResolveResult, { ambiguous: false }>,
  opts?: ResolveOpts,
): Promise<Extract<ResolveResult, { ambiguous: false }>> {
  if (!opts?.suggestCommand) return result;
  const { suggestions, ...guidance } = await findTargetCandidates(client, target, {
    ...opts, ...activeScope(), fileTarget: looksFileLike(target),
  }, performance.now() - (opts.missStarted ?? performance.now()));
  // The resolver's own near names (no time budget) stay the suggestions, so a
  // probe that runs out of time on a slow backend never takes them away; the
  // probe's ranking fills them only when the resolver found none. A retry is
  // kept only for an entity those rows list, so the hint and the rows agree.
  const kept = result.suggestions?.length ? result.suggestions : suggestions;
  const { retryCommand, ...rest } = guidance;
  return {
    ...result, ...rest,
    ...(!result.suggestions?.length && suggestions?.length ? { suggestions } : {}),
    ...(retryCommand && rowsInclude(kept, guidance.didYouMean[0]) ? { retryCommand } : {}),
  };
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
  // filteredOut costs a search: not for a probe that is off or out of budget.
  if (!missProbeWouldRun(target)) return result;
  if (await filteredOut(client, target, result, opts)) return result;
  const why = await explainSymbolMiss(client, target, { path: opts?.path, ...activeScope() });
  if (!why) return result;
  // The resolver already wrote the bare miss for a person; this is the part
  // that says what to do about it. Machine formats get it in the record. A
  // miss answered with its text matches says what it is there instead.
  const answered = textMatchesFor(target, why, opts).length > 0;
  if (format !== "json" && format !== "llm" && !answered) stderr(chalk.dim(why.message));
  return {
    ...result, reason: why.reason, message: why.message,
    ...(why.files ? { files: why.files } : {}),
    ...(why.matches ? { matches: why.matches } : {}),
    ...(why.remap ? { remap: true } : {}),
  };
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
  withAll.missStarted = performance.now();
  // The --all candidate list does not show containers: no request for them.
  const result = await rankFileOrEntity(client, target, { ...opts, format });
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
  const amb = buildAmbiguous(tied.map((m) => m.node), undefined, {
    hint: disambiguationHint(AMBIGUOUS_HINT), total: tied.length, truncated,
  });
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
