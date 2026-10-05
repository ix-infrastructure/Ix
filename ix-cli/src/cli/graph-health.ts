// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IxClient } from "../client/api.js";
import { ixHome } from "./ix-home.js";
import { revisionToken } from "./map-result-cache.js";

/**
 * Is the graph a command is about to answer from structurally intact?
 *
 * A graph can hold every node of a repository and almost none of its edges.
 * Every answer drawn from it then looks normal and is wrong: `ix explain`
 * reports `callers=0 role=localized-helper` for a function with a caller, and
 * `ix context` says `stale=false` about a bundle with no members in it. The
 * failure is silent because nodes are what resolution needs, and nodes are
 * what survives.
 *
 * The state is produced by the backend. Re-ingesting a file retires the edges
 * that file produced earlier, matched by its `source_uri` -- a path relative to
 * the workspace root, and therefore the same string in every checkout of one
 * repository. Up to at least backend 1.0.30 that sweep is not filtered by
 * workspace (fix open as ix-infrastructure/Ix-memory#211), so ingesting one
 * checkout tombstones the CONTAINS / CALLS / IMPORTS edges of every other
 * checkout of the same repository on that backend. Node ids are namespaced by
 * workspace, so the other checkouts' nodes survive; their edges do not. A
 * plain `ix map` or `ix ingest --force` does not repair it: unchanged files are
 * skipped, and forced patches carry the same ids as the recorded ones and are
 * replayed as already applied. Only deleting the workspace's data first makes
 * the re-ingest real -- hence {@link GRAPH_REBUILD_FIX}.
 *
 * Two checks, both cheap:
 *
 * - {@link assessGraphStats}: workspace-wide, from `/v1/stats`. Every symbol a
 *   parser emits is attached to its file by a CONTAINS / DEFINES /
 *   CONTAINS_CHUNK edge, so a healthy graph has at least one such edge per
 *   non-file node (measured: 1.19 on the Ix repo); a hollowed one has almost
 *   none (0.01, 0.00, 0.00 on three hollowed checkouts of the same repo).
 *   Cached per scope and backend revision, see {@link checkGraphHealth}.
 * - {@link assessTargetStructure}: for one entity, from facts a command has
 *   already fetched. A definition no file contains has lost its edges even
 *   when the rest of the graph is fine -- which is the common case when only
 *   a few files were re-ingested elsewhere. Sampled: 0 of 60 functions
 *   orphaned in a healthy graph, 59 of 60 in a hollowed one.
 */

export type GraphHealthStatus = "ok" | "degraded" | "empty" | "unknown";

export interface GraphHealth {
  status: GraphHealthStatus;
  /** Stable slug for the cause: `hollow`, `orphaned_target`, `no_nodes`. */
  reason?: string;
  /** One sentence saying what is wrong, for a person or an agent. */
  message?: string;
  /** The command that repairs it. */
  fix?: string;
  nodes?: number;
  edges?: number;
  /** CONTAINS + DEFINES + CONTAINS_CHUNK edges. */
  structuralEdges?: number;
  /** Non-file nodes, each of which should have a structural edge. */
  symbols?: number;
}

/**
 * The repair for a hollowed graph: delete this workspace's data (and only
 * this workspace's), then map it again. See the module comment for why
 * nothing short of that works.
 */
export const GRAPH_REBUILD_FIX = "ix reset --workspace --yes --ingest";

/** For a registered workspace the backend holds nothing for. */
export const GRAPH_MAP_FIX = "ix map";

/**
 * The warning for changed files the backend answered `Idempotent` (F-01): it
 * had committed their patch id before -- a file reverted to earlier bytes, or
 * deleted and restored -- so it wrote nothing, and the graph still shows the
 * content in between. Shared by `ix map` and `ix status`.
 */
export function describeReplayedChanges(files: readonly string[], sample = 5): string {
  const shown = files.slice(0, sample).join(", ");
  const more = files.length > sample ? ` and ${files.length - sample} more` : "";
  return (
    `Graph is unverified: ${files.length} changed file(s) were not applied: ${shown}${more}. ` +
    "The backend already held their patch (a revert, or a restored file) and wrote nothing. " +
    `The next ix map sends them again; if this persists, rebuild with: ${GRAPH_REBUILD_FIX}`
  );
}

const STRUCTURAL_PREDICATES = new Set(["CONTAINS", "DEFINES", "CONTAINS_CHUNK"]);

/** Below this many symbols the coverage ratio is too noisy to judge by. */
const MIN_SYMBOLS_FOR_RATIO = 50;
/** Structural edges per symbol below which a graph is called hollow. Healthy: ~1.2. */
const MIN_STRUCTURAL_COVERAGE = 0.2;
/** A graph with at least this many symbols and no structural edge at all is hollow. */
const MIN_SYMBOLS_FOR_ZERO = 5;

const UNKNOWN: GraphHealth = { status: "unknown" };

const LIKELY_CAUSE =
  "Likely cause: another checkout of this repository was ingested into the same backend later (Ix-memory#211).";

function countOf(rows: unknown, key: string, match: (name: string) => boolean): number {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    const name = (row as Record<string, unknown>)?.[key];
    const count = (row as Record<string, unknown>)?.count;
    if (typeof name === "string" && typeof count === "number" && match(name)) total += count;
  }
  return total;
}

/**
 * Judge a `/v1/stats` body. Pure; `unknown` for anything it cannot read.
 */
export function assessGraphStats(stats: unknown): GraphHealth {
  const s = stats as { nodes?: { total?: unknown; byKind?: unknown }; edges?: { total?: unknown; byPredicate?: unknown } } | null;
  const nodes = s?.nodes?.total;
  const edges = s?.edges?.total;
  if (typeof nodes !== "number" || typeof edges !== "number") return UNKNOWN;

  if (nodes === 0) {
    return {
      status: "empty",
      reason: "no_nodes",
      message: "The backend holds no graph for this workspace: it is registered but has not been mapped (or its data was reset).",
      fix: GRAPH_MAP_FIX,
      nodes,
      edges,
    };
  }

  // Without the breakdowns there is nothing to judge structure by -- an older
  // backend, or a stub -- and a missing breakdown must not read as zero edges.
  if (!Array.isArray(s?.nodes?.byKind) || !Array.isArray(s?.edges?.byPredicate)) return UNKNOWN;
  const files = countOf(s?.nodes?.byKind, "kind", (k) => k === "file");
  const structuralEdges = countOf(s?.edges?.byPredicate, "predicate", (p) => STRUCTURAL_PREDICATES.has(p));
  const symbols = Math.max(nodes - files, 0);
  const counts = { nodes, edges, structuralEdges, symbols };

  const hollow =
    (symbols >= MIN_SYMBOLS_FOR_ZERO && structuralEdges === 0) ||
    (symbols >= MIN_SYMBOLS_FOR_RATIO && structuralEdges / symbols < MIN_STRUCTURAL_COVERAGE);
  if (!hollow) return { status: "ok", ...counts };

  const coverage = symbols > 0 ? Math.round((structuralEdges / symbols) * 100) : 0;
  return {
    status: "degraded",
    reason: "hollow",
    message:
      `${nodes} nodes but ${edges} edges: ${coverage}% of symbols are attached to a file (healthy: ~100%), ` +
      "so callers, callees and members are missing, not zero. " + LIKELY_CAUSE,
    fix: GRAPH_REBUILD_FIX,
    ...counts,
  };
}

/** Kinds a parser always attaches to a file (or to a class inside one). */
const ATTACHED_KINDS = new Set([
  "function", "method", "class", "interface", "trait", "object", "struct", "enum",
  "constant", "type", "type_alias", "variable",
]);

/**
 * Judge one entity from facts already in hand: a definition no file contains
 * has lost its edges. Returns undefined when there is nothing to say -- a kind
 * that is not always contained, or a target that is.
 */
export function assessTargetStructure(target: {
  name: string;
  kind: string;
  path?: string;
  container?: unknown;
}): GraphHealth | undefined {
  if (!ATTACHED_KINDS.has(target.kind) || target.container) return undefined;
  const where = target.path ? ` in ${target.path}` : "";
  return {
    status: "degraded",
    reason: "orphaned_target",
    message:
      `${target.name} (${target.kind})${where} is not attached to its file in the graph: that file's edges ` +
      "are gone, so its callers, callees and dependents are missing, not zero. " + LIKELY_CAUSE,
    fix: GRAPH_REBUILD_FIX,
  };
}

const SEVERITY: Record<GraphHealthStatus, number> = { unknown: 0, ok: 1, degraded: 2, empty: 3 };

/** The worse of two verdicts; a workspace-wide one wins a tie, since it says more. */
export function worseHealth(a: GraphHealth, b: GraphHealth | undefined): GraphHealth {
  if (!b) return a;
  return SEVERITY[b.status] > SEVERITY[a.status] ? b : a;
}

/** Whether answers drawn from this graph should be withheld or hedged. */
export function isUnhealthy(health: GraphHealth | undefined): health is GraphHealth & { status: "degraded" | "empty" } {
  return health?.status === "degraded" || health?.status === "empty";
}

// ── The cached, bounded workspace check ─────────────────────────────────────

export interface GraphHealthScope {
  workspaceId?: string;
  systemId?: string;
}

type HealthClient = Pick<IxClient, "currentRevision" | "stats"> & { endpoint?: string };

interface CacheEntry {
  key: string;
  revision: string;
  health: GraphHealth;
}

/**
 * One process's answers, for `ix mcp`, which runs many commands in one
 * process. The disk copy below is what a one-shot CLI process hits.
 */
const memo = new Map<string, CacheEntry>();

/** Test hook: forget the in-process answers. */
export function resetGraphHealthMemo(): void {
  memo.clear();
}

/**
 * Forget every cached verdict. For `ix reset`: `/v1/reset/workspace` deletes a
 * workspace's data without moving the backend's head revision (measured on
 * 1.0.30), so a verdict keyed by revision would outlive the data it described.
 */
export function clearGraphHealthCache(): void {
  memo.clear();
  try {
    for (const name of readdirSync(ixHome())) {
      if (name.startsWith("graph_health_") && name.endsWith(".json")) rmSync(join(ixHome(), name), { force: true });
    }
  } catch { /* nothing cached, or nowhere to cache it */ }
}

function cacheKey(endpoint: string | undefined, scope: GraphHealthScope): string | undefined {
  if (scope.systemId) return JSON.stringify([endpoint ?? "", "system", scope.systemId]);
  if (scope.workspaceId) return JSON.stringify([endpoint ?? "", "workspace", scope.workspaceId]);
  return undefined;
}

export function graphHealthCachePath(key: string): string {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(ixHome(), `graph_health_${digest}.json`);
}

function readCached(key: string, revision: string): GraphHealth | undefined {
  const inMemory = memo.get(key);
  if (inMemory && inMemory.revision === revision) return inMemory.health;
  try {
    const entry = JSON.parse(readFileSync(graphHealthCachePath(key), "utf-8")) as Partial<CacheEntry>;
    if (entry.key !== key || entry.revision !== revision) return undefined;
    const health = entry.health;
    if (!health || typeof health.status !== "string" || !(health.status in SEVERITY)) return undefined;
    memo.set(key, { key, revision, health });
    return health;
  } catch {
    return undefined;
  }
}

function writeCached(key: string, revision: string, health: GraphHealth): void {
  memo.set(key, { key, revision, health });
  try {
    mkdirSync(ixHome(), { recursive: true });
    writeFileSync(graphHealthCachePath(key), JSON.stringify({ key, revision, health }) + "\n", "utf8");
  } catch { /* a cache that cannot be written is not an error */ }
}

/** How long the stats probe may take before the answer goes out without it. */
export function graphHealthTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IX_GRAPH_HEALTH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

/**
 * The workspace-wide verdict for a read scope. Never throws: a check that
 * cannot run answers `unknown`, which every caller treats as "say nothing".
 *
 * Cached per (endpoint, scope, backend head revision). The head revision is
 * global, and that is the point: what hollows a graph is an ingest into some
 * *other* workspace, which moves the global head, so a cached `ok` cannot
 * outlive the write that invalidated it. The revision read is one indexed
 * lookup (~10 ms); `/v1/stats` (~65 ms on a 9k-node workspace, seconds on a
 * very large one) runs only when the head has moved, and is bounded by
 * {@link graphHealthTimeoutMs}. Callers start this alongside their own
 * requests and await it last, so on a warm cache it costs nothing visible.
 *
 * `IX_GRAPH_HEALTH=0` turns the check off.
 */
export async function checkGraphHealth(
  client: HealthClient,
  scope: GraphHealthScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GraphHealth> {
  if (env.IX_GRAPH_HEALTH === "0") return UNKNOWN;
  const key = cacheKey(client.endpoint, scope);
  if (!key) return UNKNOWN;
  try {
    const revision = revisionToken(await client.currentRevision());
    if (revision === undefined) return UNKNOWN;
    const cached = readCached(key, revision);
    if (cached) return cached;
    const stats = await client.stats({ ...scope, timeoutMs: graphHealthTimeoutMs(env) });
    const health = assessGraphStats(stats);
    if (health.status !== "unknown") writeCached(key, revision, health);
    return health;
  } catch {
    return UNKNOWN;
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** The `graph` record every llm renderer emits for an unhealthy graph. */
export function graphHealthLlmFields(health: GraphHealth): Array<[string, string | number | undefined]> {
  return [
    ["status", health.status],
    ["reason", health.reason],
    ["message", health.message],
    ["fix", health.fix],
  ];
}

/** The same verdict for `--format json`: only what a consumer acts on. */
export function graphHealthJson(health: GraphHealth): Record<string, unknown> {
  const out: Record<string, unknown> = { status: health.status };
  if (health.reason) out.reason = health.reason;
  if (health.message) out.message = health.message;
  if (health.fix) out.fix = health.fix;
  for (const k of ["nodes", "edges", "structuralEdges", "symbols"] as const) {
    if (typeof health[k] === "number") out[k] = health[k];
  }
  return out;
}

/** One line for a person, e.g. under a warning banner. */
export function graphHealthProse(health: GraphHealth): string {
  const head = health.status === "empty" ? "Graph is empty." : "Graph is degraded.";
  return `${head} ${health.message ?? ""}${health.fix ? ` Fix: ${health.fix}` : ""}`.trim();
}
