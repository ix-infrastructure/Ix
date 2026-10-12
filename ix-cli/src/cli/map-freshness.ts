// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import type { IxClient } from "../client/api.js";
import { mapStalePath } from "./config.js";
import { loadIngestBaseline } from "./ingest-baseline.js";

/**
 * The architecture map left for later (CL-13).
 *
 * `ix map` runs after every agent turn and on every edit (the plugins' Stop
 * and PostToolUse hooks). After an incremental ingest the `/v1/map` request is
 * most of its cost -- 2.6-3.9 s on keras for a one-line edit -- and nothing on
 * that path reads the regions it returns. So `ix map` skips the request,
 * prints the regions of the last map, and writes this marker. The commands
 * that read regions (`overview`, `subsystems`, `locate`, `impact`,
 * `explain`, `view`) call `ensureFreshMap` first, which recomputes the map once while the marker
 * is set.
 *
 * The marker sits beside `map_result_*` in IX_HOME, keyed the same way, and is
 * removed with the map baseline (`clearMapBaseline`), so reset and a forced
 * re-ingest leave none behind.
 */
export interface MapStaleInfo {
  /** When the map was deferred, epoch ms. */
  since: number;
  /** The ingest baseline's revision the deferral followed, or null when there was none. */
  ingestRev: number | null;
  /** When a refresh was last attempted, epoch ms; the debounce runs from here. */
  lastAttemptAt?: number;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The marker for `projectRoot`, or null when there is none. A malformed file reads as none. */
export function readMapStale(projectRoot: string): MapStaleInfo | null {
  try {
    const data = JSON.parse(fs.readFileSync(mapStalePath(projectRoot), "utf-8")) as Record<string, unknown> | null;
    if (data === null || typeof data !== "object") return null;
    if (!isFiniteNumber(data.since)) return null;
    if (data.ingestRev !== null && !isFiniteNumber(data.ingestRev)) return null;
    if (data.lastAttemptAt !== undefined && !isFiniteNumber(data.lastAttemptAt)) return null;
    const info: MapStaleInfo = { since: data.since, ingestRev: data.ingestRev as number | null };
    if (data.lastAttemptAt !== undefined) info.lastAttemptAt = data.lastAttemptAt;
    return info;
  } catch {
    return null;
  }
}

function writeMapStale(projectRoot: string, info: MapStaleInfo): void {
  const target = mapStalePath(projectRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Via a temp file and rename, so a reader never sees half a file.
    fs.writeFileSync(tmp, JSON.stringify(info));
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* non-critical */ }
  }
}

/**
 * Record that the map for `projectRoot` was deferred after an ingest. A new
 * marker each time, with no `lastAttemptAt`: a later edit's refresh has not
 * been tried yet, so the debounce does not hold it back. Best-effort.
 */
export function markMapStale(projectRoot: string, info: Partial<Pick<MapStaleInfo, "since" | "ingestRev">> = {}): void {
  writeMapStale(projectRoot, {
    since: info.since ?? Date.now(),
    ingestRev: info.ingestRev !== undefined ? info.ingestRev : (loadIngestBaseline(projectRoot)?.currentRev ?? null),
  });
}

/** Remove the marker: the map was computed. Best-effort. */
export function clearMapStale(projectRoot: string): void {
  try { fs.rmSync(mapStalePath(projectRoot), { force: true }); } catch { /* non-critical */ }
}

/**
 * Remove the marker only if it is still the one `seen` describes. A marker
 * re-written while a refresh was running belongs to an ingest that refresh
 * may not have mapped, and must stay.
 */
function clearMapStaleIfUnchanged(projectRoot: string, seen: MapStaleInfo): void {
  const current = readMapStale(projectRoot);
  if (current === null) return;
  if (current.since !== seen.since || current.ingestRev !== seen.ingestRev) return;
  clearMapStale(projectRoot);
}

const DEFAULT_REFRESH_DEBOUNCE_MS = 30_000;

/**
 * How long after an attempted refresh another may start, in ms; 0 = no
 * debounce. Matched, not parsed, as the other IX_*_MS settings are: a value
 * that is not a plain number of ms keeps the default.
 */
export function mapRefreshDebounceMs(raw = process.env.IX_MAP_REFRESH_DEBOUNCE_MS): number {
  if (raw === undefined) return DEFAULT_REFRESH_DEBOUNCE_MS;
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  if (!/^\d+$/.test(trimmed)) return DEFAULT_REFRESH_DEBOUNCE_MS;
  return Number.parseInt(trimmed, 10);
}

export interface EnsureFreshMapOptions {
  /** The workspace root; defaults to the root a bare `ix map` would map. */
  root?: string;
  /** For tests: the client to refresh through. */
  client?: IxClient;
  /** For tests: the clock. */
  now?: () => number;
}

/**
 * Recompute the architecture map if an `ix map` deferred it.
 *
 * Called by the commands that read regions, before their first read. Without
 * a marker it returns at once, with no network call. With one it maps exactly
 * as `ix map` would, records the result as `ix map` does, and removes the
 * marker. It never throws, never touches the exit code and prints nothing on
 * stdout: a refresh that does not succeed -- a failed request, or a response
 * that is not a completed map -- leaves the stored regions, the map baseline
 * and the marker as they were, and the command answers from them.
 *
 * Whenever the map is still stale when it returns, it says so in one line on
 * stderr, so the reader's answer is never silently older than the code:
 *
 * - Debounced: after an attempt, not again for `IX_MAP_REFRESH_DEBOUNCE_MS`
 *   (default 30 s), so a backend that cannot map is not asked by every read.
 *   The attempt is recorded before the request, so a reader killed by its
 *   hook's timeout mid-map counts too.
 * - Single-flight: takes the map lock, and returns without waiting when
 *   another process holds it. That holder may not refresh anything: an
 *   incremental `ix map` defers the map too. So the reader answers from the
 *   regions it has, and the notice says they may predate recent edits.
 * - An `ix map` that coalesced into this refresh asked for one more ingest
 *   (`requestMapRerun`). It is run here (after the map is recorded), and
 *   re-marks the map stale when it changed files; the exit code is restored.
 * - Local only: a cloud-ingested workspace never writes the marker.
 *
 * Resolves to true when the map is still stale afterwards.
 */
export async function ensureFreshMap(opts: EnsureFreshMapOptions = {}): Promise<boolean> {
  let why: string | undefined;
  try {
    why = await refresh(opts);
  } catch {
    // Never the reader's problem: it answers from the regions it has.
    why = "its refresh failed";
  }
  if (why === undefined) return false;
  try {
    process.stderr.write(`ix: architecture map is stale (${why}); regions shown may predate recent edits. Run ix map --remap to refresh.\n`);
  } catch { /* non-critical */ }
  return true;
}

/** Why the map is still stale after the attempt, or undefined when it is fresh. */
async function refresh(opts: EnsureFreshMapOptions): Promise<string | undefined> {
  // The reader's workspace (what its entity lookup queries), not the
  // write-command routing of `resolveMapRoot`: a pinned workspace B read from
  // an unrelated repo A must refresh B's map, not look at A's marker.
  //
  // Canonical, as `ix map` spells it, whoever names it: the marker's path is
  // keyed on the canonical root, but the ingest and map baselines also store
  // the root and match it as a string. A root given under another spelling --
  // a symlink, macOS's /tmp, a Windows 8.3 name like RUNNER~1 -- found the
  // marker but no baseline, so every refresh failed and the marker stayed.
  let root: string;
  if (opts.root !== undefined) {
    const { canonicalWorkspacePath } = await import("./config.js");
    root = canonicalWorkspacePath(opts.root);
  } else {
    const { canonicalMapRoot } = await import("./map-root.js");
    const { resolveWorkspaceRoot } = await import("./config.js");
    try { root = canonicalMapRoot(resolveWorkspaceRoot()); } catch { return undefined; }
  }
  const marker = readMapStale(root);
  if (marker === null) return undefined;

  const { isCloudReady } = await import("./remote.js");
  if (await isCloudReady()) return undefined;

  const now = opts.now ?? Date.now;
  const debounce = mapRefreshDebounceMs();
  if (debounce > 0 && marker.lastAttemptAt !== undefined && now() - marker.lastAttemptAt < debounce) {
    return "a refresh was tried moments ago";
  }

  const { acquireMapLock } = await import("./single-flight.js");
  const lock = acquireMapLock(root, `ix map refresh ${root}`);
  // Another `ix map` holds the lock. It may be a refresh, or an incremental
  // `ix map` that defers the map and only writes the marker -- so nothing
  // here can count on it doing this read's work.
  if (!lock) return "another ix map is running";
  try {
    // Read again under the lock: a refresh that held it until a moment ago
    // may have cleared the marker, or tried and failed (the debounce).
    const current = readMapStale(root);
    if (current === null) return undefined;
    if (debounce > 0 && current.lastAttemptAt !== undefined && now() - current.lastAttemptAt < debounce) {
      return "a refresh was tried moments ago";
    }
    writeMapStale(root, { ...current, lastAttemptAt: now() });

    // Loaded here, not at the top: `commands/map.ts` imports this module, and
    // a reader with no marker never needs any of it.
    const map = await import("./commands/map.js");
    const { createClient } = await import("../client/factory.js");
    const { resolveMapCacheSlot, saveCachedMap } = await import("./map-result-cache.js");
    const { clearMapResultCache } = await import("./config.js");
    const { readBackendHealth } = await import("./commands/upgrade.js");

    let recorded = false;
    try {
      const client = opts.client ?? createClient({ deadlineSignal: map.mapDeadlineSignal(), longRunning: true });
      const request = await map.resolveMapScope(client, root, false);
      const slot = await resolveMapCacheSlot(client, request, () => readBackendHealth(client));
      const result = await client.map(request) as import("./commands/map.js").MapResult;

      // Only a completed, non-empty map is recorded. Anything else is a
      // refresh that did not succeed: the last map's stored regions, the map
      // baseline and the marker all stay as they were, and the debounce
      // (the attempt is already written) spaces out the retry. The empty and
      // regionless diagnoses of `ix map` need the ingest's counts, which a
      // refresh has none of, so they do not run here.
      if (map.persistCompletedMapBaseline(result, root)) {
        // The last map stored is this one, or none: one keyed to another
        // request must not outlive the map that replaced it.
        if (slot) saveCachedMap(root, slot, result);
        else clearMapResultCache(root);
        clearMapStaleIfUnchanged(root, current);
        recorded = true;
      }
    } catch {
      // Failed or timed out: as above, nothing is touched.
    }
    // An `ix map` that coalesced into this refresh asked for one more ingest
    // and has already exited: run it, as the lock holder of `ix map` would, so
    // that edit is not lost -- whether or not the map above succeeded. It
    // re-marks the map stale if it changed files. An ingest's partial failure
    // sets the exit code; a reader keeps its own.
    const exitCode = process.exitCode;
    try { await map.rerunIfRequested(root, true, { silent: true, format: "json" }); }
    catch { /* rerunIfRequested reports its own failures; the reader carries on */ }
    finally { process.exitCode = exitCode; }

    if (!recorded) return "its refresh did not complete";
    if (readMapStale(root) !== null) return "files changed while it was refreshed";
    return undefined;
  } finally {
    lock.release();
  }
}
