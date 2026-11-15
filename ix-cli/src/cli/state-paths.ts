// Copyright 2026 Ix Infrastructure Inc.

/**
 * Where Ix keeps its per-project-root state files under IX_HOME (ingest
 * baselines, map markers, the verify record) and how they are cleared. Split
 * out of `config.ts` (#943); `config.ts` re-exports everything here.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ixHome } from "./ix-home.js";
import { canonicalWorkspacePath } from "./path-containment.js";

/**
 * The key of a project root's per-root state files. Canonical first: `ix
 * ingest <path>` resolves its root with `canonicalWorkspacePath`, and a caller
 * that spelled the same root differently -- a symlink, macOS's /tmp, a Windows
 * 8.3 name like RUNNER~1 -- found no baseline under its own spelling and
 * re-ingested everything, every time.
 */
function rootKey(projectRoot: string): string {
  return createHash("sha256").update(canonicalWorkspacePath(projectRoot)).digest("hex").slice(0, 12);
}

/**
 * Path to the per-project ingest mtime cache (the "skip unchanged files on re-map"
 * pre-filter). Keyed on a hash of the project root. Single source of truth shared by
 * ingest (load/save), reset, and watch (clear) — all three MUST agree on this path.
 */
export function ingestMtimeCachePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_mtimes_${key}.json`);
}

/**
 * Path to the progress of an unfinished re-ingest for a new extractor (see
 * `loadRebuildProgress`). Cleared with the mtime cache, since it describes the
 * same graph.
 */
export function ingestRebuildPath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_rebuild_${key}.json`);
}

/**
 * Path to the orphan sweeps an earlier run could not finish (see
 * `loadOrphanSweepPending`). Cleared with the mtime cache, since it describes
 * the same graph.
 */
export function ingestOrphanSweepPath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_orphans_${key}.json`);
}

/**
 * Path to the per-file symbol summaries an incremental map resolves against
 * (see `ingest-symbols.ts`). Cleared, with its journal, with the mtime cache.
 */
export function ingestSymbolsPath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `ingest_symbols_${key}.json`);
}

/** The symbol table's journal: entries changed since the table was last written in full. */
export function ingestSymbolsJournalPath(projectRoot: string): string {
  return `${ingestSymbolsPath(projectRoot)}.journal`;
}

/** Path to the architecture-map completion marker for one project root. */
export function mapBaselinePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_baseline_${key}.json`);
}

/**
 * Path to the last `ix verify` result for one project root (see `verify.ts`).
 * Deliberately not cleared with the baselines: `ix status` labels a record
 * older than the last ingest instead of losing it.
 */
export function verifyRecordPath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `verify_${key}.json`);
}

/**
 * Path to the last `/v1/map` response for one project root, which a map that
 * ingested nothing reuses instead of asking again (see `map-result-cache.ts`).
 * Cleared with the map baseline, since both describe the same hierarchy.
 */
export function mapResultCachePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_result_${key}.json`);
}

/**
 * Path to the "architecture map is stale" marker for one project root: an
 * `ix map` after an incremental edit left its `/v1/map` request for the next
 * command that reads regions (see `map-freshness.ts`). Cleared with the map
 * baseline, since it describes the same hierarchy.
 */
export function mapStalePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_stale_${key}.json`);
}

/**
 * Path to the outcome of the last background map refresh for one project
 * root (see `map-freshness.ts`): when it ran and whether it completed, and
 * why not. Read by `ix doctor` and `ix status`; cleared with the map baseline.
 */
export function mapRefreshOutcomePath(projectRoot: string): string {
  const key = rootKey(projectRoot);
  return join(ixHome(), `map_refresh_${key}.json`);
}

/**
 * Which per-root state files are cleared together.
 *
 *   - `ingest`: describes the source graph; cleared by reset, workspace
 *     migration and a forced re-ingest (`clearIngestMtimeCache`), with the
 *     map group.
 *   - `map`: describes the architecture hierarchy built from it; cleared on
 *     its own when a hierarchy build fails (`clearMapBaseline`).
 *   - `kept`: survives both, on purpose (see `verifyRecordPath`).
 */
export type WorkspaceStateGroup = "ingest" | "map" | "kept";

export interface WorkspaceStateFile {
  /** A short name, for tests and messages. */
  name: string;
  /** The module that reads and writes it. */
  owner: string;
  group: WorkspaceStateGroup;
  path: (projectRoot: string) => string;
}

/**
 * Every per-project-root state file under IX_HOME. A new one goes here, or
 * the registry test fails; its group decides what clears it. Each is written
 * with `writeStateAtomic` and carries a `formatVersion` (`workspace-state.ts`),
 * except the symbol journal, which is appended to and versioned by its header
 * line.
 */
export const WORKSPACE_STATE_FILES: readonly WorkspaceStateFile[] = [
  { name: "ingest_mtimes", owner: "ingest-baseline.ts", group: "ingest", path: ingestMtimeCachePath },
  { name: "ingest_rebuild", owner: "ingest-baseline.ts", group: "ingest", path: ingestRebuildPath },
  { name: "ingest_orphans", owner: "ingest-baseline.ts", group: "ingest", path: ingestOrphanSweepPath },
  { name: "ingest_symbols", owner: "ingest-symbols.ts", group: "ingest", path: ingestSymbolsPath },
  { name: "ingest_symbols.journal", owner: "ingest-symbols.ts", group: "ingest", path: ingestSymbolsJournalPath },
  { name: "map_baseline", owner: "map-baseline.ts", group: "map", path: mapBaselinePath },
  { name: "map_result", owner: "map-result-cache.ts", group: "map", path: mapResultCachePath },
  { name: "map_stale", owner: "map-freshness.ts", group: "map", path: mapStalePath },
  { name: "map_refresh", owner: "map-freshness.ts", group: "map", path: mapRefreshOutcomePath },
  { name: "verify", owner: "verify.ts", group: "kept", path: verifyRecordPath },
];

function clearGroup(projectRoot: string, group: WorkspaceStateGroup): void {
  for (const file of WORKSPACE_STATE_FILES) {
    if (file.group !== group) continue;
    try { rmSync(file.path(projectRoot), { force: true }); } catch { /* non-critical */ }
  }
}

/** Drop the cached `/v1/map` response, so the next map asks the backend. Best-effort. */
export function clearMapResultCache(projectRoot: string): void {
  try { rmSync(mapResultCachePath(projectRoot), { force: true }); } catch { /* non-critical */ }
}

/**
 * Remove every `map` state file: the architecture-map completion marker, and
 * the cached map response, the stale marker and the refresh outcome with it:
 * whatever made the marker wrong makes the cached hierarchy wrong too, and a
 * map that is no longer recorded is not merely deferred. Leaves the source
 * ingest baseline alone. Best-effort.
 */
export function clearMapBaseline(projectRoot: string): void {
  clearGroup(projectRoot, "map");
}

/**
 * Remove every `ingest` and `map` state file, so the next map re-ingests
 * every file.
 *
 * Reset and workspace migration invalidate both the source graph and the
 * hierarchy. A failed hierarchy build clears only `clearMapBaseline` instead.
 */
export function clearIngestMtimeCache(projectRoot: string): void {
  clearGroup(projectRoot, "ingest");
  clearMapBaseline(projectRoot);
}
