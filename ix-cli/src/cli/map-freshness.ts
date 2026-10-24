// Copyright 2026 Ix Infrastructure Inc.

import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { IxClient } from "../client/api.js";
import { mapRefreshOutcomePath, mapStalePath } from "./config.js";
import { loadIngestBaseline } from "./ingest-baseline.js";
import { llmLine } from "./llm.js";

/**
 * The architecture map left for later (CL-13).
 *
 * `ix map` runs after every agent turn and on every edit (the plugins' Stop
 * and PostToolUse hooks). After an incremental ingest the `/v1/map` request is
 * most of its cost -- 2.6-3.9 s on keras for a one-line edit -- and nothing on
 * that path reads the regions it returns. So `ix map` skips the request,
 * prints the regions of the last map, and writes this marker. The commands
 * that read regions (`overview`, `subsystems`, `locate`, `impact`,
 * `explain`, `view`) call `ensureFreshMap` first. It never maps inline: those
 * readers run inside blocking agent hooks with ~10 s budgets, and `/v1/map`
 * can take longer than that on a large repo. While the marker is set it
 * answers from the last map, says so, and starts a detached background
 * process (`runBackgroundMapRefresh`) that recomputes the map under the map
 * lock and records how that went (`readMapRefreshOutcome`).
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
  /**
   * The last computed map the stored regions come from, when the deferring
   * `ix map` knew it; what readers report as `regions_as_of`. Absent on a
   * marker an older CLI wrote.
   */
  regionsAsOf?: { map_rev: number; file_count: number };
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
    // Only an extra: one that does not parse leaves the marker standing.
    const asOf = data.regionsAsOf as Record<string, unknown> | null | undefined;
    if (asOf && typeof asOf === "object" && isFiniteNumber(asOf.map_rev) && isFiniteNumber(asOf.file_count)) {
      info.regionsAsOf = { map_rev: asOf.map_rev, file_count: asOf.file_count };
    }
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
 *
 * `regionsAsOf` names the last computed map. When not given, the one a marker
 * already standing named is kept: no map was computed in between, or that
 * marker would have been removed.
 */
export function markMapStale(
  projectRoot: string,
  info: Partial<Pick<MapStaleInfo, "since" | "ingestRev" | "regionsAsOf">> = {},
): void {
  const next: MapStaleInfo = {
    since: info.since ?? Date.now(),
    ingestRev: info.ingestRev !== undefined ? info.ingestRev : (loadIngestBaseline(projectRoot)?.currentRev ?? null),
  };
  const regionsAsOf = info.regionsAsOf ?? readMapStale(projectRoot)?.regionsAsOf;
  if (regionsAsOf) next.regionsAsOf = { map_rev: regionsAsOf.map_rev, file_count: regionsAsOf.file_count };
  writeMapStale(projectRoot, next);
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
  /** For tests: the clock. */
  now?: () => number;
  /** For tests: what starts the background refresh. Defaults to `spawnMapRefresh`. */
  spawn?: (root: string) => void | Promise<void>;
}

/**
 * Whether a reader may start a background refresh. IX_MAP_BACKGROUND_REFRESH=0
 * turns it off: readers then answer from the last map, say it is stale, and
 * leave the refresh to `ix map --remap`. They never map inline either way.
 */
export function mapBackgroundRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.IX_MAP_BACKGROUND_REFRESH;
  return raw === undefined || raw.trim() !== "0";
}

const DEFAULT_BACKGROUND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The background refresh's hard wall-clock limit, in ms: well above any hook's
 * budget, so a slow map gets to finish, and finite, so a wedged one cannot hold
 * the map lock forever. IX_MAP_BACKGROUND_TIMEOUT_MS, a plain number of ms > 0;
 * anything else keeps the 5 min default.
 */
export function mapBackgroundTimeoutMs(raw = process.env.IX_MAP_BACKGROUND_TIMEOUT_MS): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_BACKGROUND_TIMEOUT_MS;
  const n = Number.parseInt(raw.trim(), 10);
  return n > 0 ? n : DEFAULT_BACKGROUND_TIMEOUT_MS;
}

/** The first argument that makes the CLI entry run a background refresh (see `main.ts`). */
export const MAP_REFRESH_ARG = "__map-refresh";

/** The CLI entry beside this module: `main.js` when built, `main.ts` under tsx. */
function cliEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `main${path.extname(self)}`);
}

/**
 * How the background refresh for `root` is started: the same Node and CLI
 * entry as this process (with its source loaders, under tsx), no shell, no
 * inherited stdio -- a hook that waits for its child's pipes to close must not
 * wait for this one -- detached into its own process group, and with no
 * console window on Windows. Exported for tests.
 */
export async function mapRefreshInvocation(
  root: string,
  entry = cliEntryPath(),
  execArgv = process.execArgv,
): Promise<{ command: string; args: string[]; options: SpawnOptions }> {
  const { childCliArgs } = await import("./commands/watch.js");
  return {
    command: process.execPath,
    args: childCliArgs(entry, [MAP_REFRESH_ARG, root], execArgv),
    options: { cwd: root, detached: true, stdio: "ignore", windowsHide: true, shell: false },
  };
}

/** Start the background refresh for `root` (`mapRefreshInvocation`) and return at once. */
export async function spawnMapRefresh(root: string): Promise<void> {
  const { command, args, options } = await mapRefreshInvocation(root);
  const child = spawn(command, args, options);
  // A child that fails to start reports it asynchronously; the reader has
  // answered by then, and the marker and debounce stand.
  child.on("error", () => { /* non-critical */ });
  // Not waited for: this process exits on its own schedule.
  child.unref();
}

/**
 * Bring the architecture map up to date after an `ix map` deferred it --
 * in the background, never here.
 *
 * Called by the commands that read regions, before their first read. Without
 * a marker it returns at once, with no network call. With one it does not
 * wait for a map: the command answers from the stored regions and, unless one
 * of these holds, a detached `runBackgroundMapRefresh` is started for the
 * workspace:
 *
 * - IX_MAP_BACKGROUND_REFRESH=0;
 * - debounced: a refresh was started less than `IX_MAP_REFRESH_DEBOUNCE_MS`
 *   (default 30 s) ago, so a backend that cannot map is not asked by every read;
 * - another process holds the map lock (an `ix map`, or a refresh already
 *   running);
 * - a cloud-ingested workspace (which never writes the marker anyway).
 *
 * It never throws, never touches the exit code and prints nothing on stdout.
 * While the map is stale it says so in one line on stderr, so the reader's
 * answer is never silently older than the code. Resolves to true when the
 * map is stale; `ensureFreshMapState` says the same in the form a reader's
 * machine output carries (`mapStaleJson`, `mapStaleLlm`).
 */
export async function ensureFreshMap(opts: EnsureFreshMapOptions = {}): Promise<boolean> {
  return (await ensureFreshMapState(opts)).mapStale === true;
}

/**
 * `ensureFreshMap`, resolving to what the reader's json and llm output say
 * about it: `{}` when the map is fresh; `mapStale` and, when the marker names
 * it, the last computed map (`regionsAsOf`) when it is stale. Read from the
 * marker `ensureFreshMap` reads anyway, so no extra file or request.
 */
export async function ensureFreshMapState(opts: EnsureFreshMapOptions = {}): Promise<MapStaleState> {
  let scheduled: { why: string; marker: MapStaleInfo | null } | undefined;
  try {
    scheduled = await scheduleRefresh(opts);
  } catch {
    // Never the reader's problem: it answers from the regions it has.
    scheduled = { why: "its refresh failed", marker: null };
  }
  if (scheduled === undefined) return {};
  try {
    process.stderr.write(`ix: architecture map is stale (${scheduled.why}); regions shown may predate recent edits. Run ix map --remap to refresh.\n`);
  } catch { /* non-critical */ }
  const asOf = scheduled.marker?.regionsAsOf;
  return asOf ? { mapStale: true, regionsAsOf: { ...asOf } } : { mapStale: true };
}

/**
 * What a deferred map (CL-13) adds to the output of the command that shows
 * it. `mapStale` says the map was not recomputed after the last ingest;
 * `regionsAsOf` names the last computed map the regions come from.
 */
export interface MapStaleState {
  mapStale?: boolean;
  regionsAsOf?: { map_rev: number; file_count: number };
}

/**
 * The one sentence a deferred map's text and llm output lead with: the counts
 * and regions are the last map's, which one, and how to get this edit's.
 * `ix map` and every region reader use it, so they say it the same way.
 */
export function mapStaleNotice(state: MapStaleState): string {
  const asOf = state.regionsAsOf
    ? ` (map rev ${state.regionsAsOf.map_rev}, ${state.regionsAsOf.file_count} files)`
    : "";
  return `Stale map: not recomputed after this edit. Every count and region here is from the last map${asOf}. Run ix map --remap to recompute it now; region views refresh it in the background.`;
}

/**
 * A region reader's json fields for `state`, spread into the top level of its
 * payload: `map_stale: true` and, when known, `regions_as_of` (`{map_rev,
 * file_count}`, as `ix map --format json` has it). Nothing when the map is
 * fresh, so a fresh answer reads exactly as before.
 */
export function mapStaleJson(state: MapStaleState): { map_stale?: true; regions_as_of?: { map_rev: number; file_count: number } } {
  if (state.mapStale !== true) return {};
  return state.regionsAsOf
    ? { map_stale: true, regions_as_of: { ...state.regionsAsOf } }
    : { map_stale: true };
}

/**
 * A region reader's llm records for `state`: the one `diagnostic
 * code=map_stale` record `ix map` prints (`renderMapLlm`), or none when the
 * map is fresh. Printed with the answer, never ahead of an `error` record: a
 * caller takes a leading `error code=` as the command failing (mcp/server.ts).
 */
export function mapStaleLlm(state: MapStaleState): string[] {
  if (state.mapStale !== true) return [];
  return [llmLine("diagnostic", [["code", "map_stale"], ["message", mapStaleNotice(state)]])];
}

/** The root a reader's refresh is for, canonical; undefined when there is none. */
async function readerRoot(given: string | undefined): Promise<string | undefined> {
  // The reader's workspace (what its entity lookup queries), not the
  // write-command routing of `resolveMapRoot`: a pinned workspace B read from
  // an unrelated repo A must refresh B's map, not look at A's marker.
  //
  // Canonical, as `ix map` spells it, whoever names it: the marker's path is
  // keyed on the canonical root, but the ingest and map baselines also store
  // the root and match it as a string. A root given under another spelling --
  // a symlink, macOS's /tmp, a Windows 8.3 name like RUNNER~1 -- found the
  // marker but no baseline, so every refresh failed and the marker stayed.
  if (given !== undefined) {
    const { canonicalWorkspacePath } = await import("./config.js");
    return canonicalWorkspacePath(given);
  }
  const { canonicalMapRoot } = await import("./map-root.js");
  const { resolveWorkspaceRoot } = await import("./config.js");
  try { return canonicalMapRoot(resolveWorkspaceRoot()); } catch { return undefined; }
}

/**
 * Why the map is stale after scheduling, and the marker that says so, or
 * undefined when it is fresh.
 */
async function scheduleRefresh(opts: EnsureFreshMapOptions): Promise<{ why: string; marker: MapStaleInfo } | undefined> {
  const root = await readerRoot(opts.root);
  if (root === undefined) return undefined;
  const marker = readMapStale(root);
  if (marker === null) return undefined;

  const { isCloudReady } = await import("./remote.js");
  if (await isCloudReady()) return undefined;

  if (!mapBackgroundRefreshEnabled()) return { why: "background refresh is off", marker };

  const now = opts.now ?? Date.now;
  const debounce = mapRefreshDebounceMs();
  // From the later of the last start and the last failed finish: a refresh
  // that ran into its time limit is not followed by another straight away.
  const debounced = (m: MapStaleInfo): boolean => {
    if (debounce <= 0) return false;
    const last = readMapRefreshOutcome(root);
    const failedAt = last?.ok === false ? last.finishedAt : undefined;
    const from = Math.max(m.lastAttemptAt ?? -Infinity, failedAt ?? -Infinity);
    return Number.isFinite(from) && now() - from < debounce;
  };
  const debouncedWhy = (m: MapStaleInfo): { why: string; marker: MapStaleInfo } => {
    const last = readMapRefreshOutcome(root);
    return { why: last?.ok === false ? "its last background refresh failed" : "a refresh was tried moments ago", marker: m };
  };
  if (debounced(marker)) return debouncedWhy(marker);

  // Taken only to decide and record the attempt, then let go for the child:
  // two readers at once start one refresh, not two.
  const { acquireMapLock } = await import("./single-flight.js");
  const lock = acquireMapLock(root, `ix map refresh scheduler ${root}`);
  // Another `ix map` holds it: a running refresh, or an incremental `ix map`
  // that defers the map and only writes the marker. Either way, not now.
  if (!lock) return { why: "another ix map is running", marker };
  let current: MapStaleInfo | null;
  try {
    current = readMapStale(root);
    if (current === null) return undefined;
    if (debounced(current)) return debouncedWhy(current);
    // Recorded before the child starts, so the readers that follow it
    // inside the debounce window do not start another.
    writeMapStale(root, { ...current, lastAttemptAt: now() });
  } finally {
    lock.release();
  }
  try {
    await (opts.spawn ?? spawnMapRefresh)(root);
  } catch {
    return { why: "its refresh could not start", marker: current };
  }
  return { why: "refreshing in background", marker: current };
}

/** What the last background refresh for a root did. */
export interface MapRefreshOutcome {
  /** When it started, epoch ms. */
  startedAt: number;
  /** When it finished, epoch ms; absent while it runs. */
  finishedAt?: number;
  /** True when it recorded a completed map; absent while it runs. */
  ok?: boolean;
  /** Why it did not complete, or what it left behind; one line. */
  reason?: string;
  /** The process that ran it. */
  pid: number;
}

/** The last background refresh's outcome for `projectRoot`, or null. A malformed file reads as none. */
export function readMapRefreshOutcome(projectRoot: string): MapRefreshOutcome | null {
  try {
    const data = JSON.parse(fs.readFileSync(mapRefreshOutcomePath(projectRoot), "utf-8")) as Record<string, unknown> | null;
    if (data === null || typeof data !== "object") return null;
    if (!isFiniteNumber(data.startedAt) || !isFiniteNumber(data.pid)) return null;
    const out: MapRefreshOutcome = { startedAt: data.startedAt, pid: data.pid };
    if (isFiniteNumber(data.finishedAt)) out.finishedAt = data.finishedAt;
    if (typeof data.ok === "boolean") out.ok = data.ok;
    if (typeof data.reason === "string") out.reason = data.reason;
    return out;
  } catch {
    return null;
  }
}

function writeMapRefreshOutcome(projectRoot: string, outcome: MapRefreshOutcome): void {
  const target = mapRefreshOutcomePath(projectRoot);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(outcome));
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* non-critical */ }
  }
}

/** An error's message on one short line, for the outcome file. */
function oneLine(e: unknown): string {
  const text = String((e as { message?: unknown })?.message ?? e).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export interface BackgroundMapRefreshOptions {
  /** For tests: the client to refresh through. */
  client?: IxClient;
  /** For tests: the clock. */
  now?: () => number;
  /** The hard limit, in ms; defaults to `mapBackgroundTimeoutMs()`. */
  timeoutMs?: number;
}

/**
 * The background refresh: what `ix __map-refresh <root>` runs, in the detached
 * process `ensureFreshMap` starts.
 *
 * Under the map lock -- the same one `ix map` takes, so it never runs beside
 * one -- and only while the marker is set, it maps exactly as `ix map` would,
 * records the result as `ix map` does, and removes the marker if no newer edit
 * re-wrote it meanwhile. A refresh that does not succeed -- a failed request,
 * a response that is not a completed map, or the hard time limit -- leaves the
 * stored regions, the map baseline and the marker as they were.
 *
 * An `ix map` that coalesced into it asked for one more ingest
 * (`requestMapRerun`); that is run after the map, and re-marks the map stale
 * when it changed files.
 *
 * Whatever happens is written where `ix doctor` and `ix status` read it
 * (`readMapRefreshOutcome`). Resolves to that outcome, or null when it did
 * nothing: another process held the lock, or the map was already fresh.
 */
export async function runBackgroundMapRefresh(
  rootArg: string,
  opts: BackgroundMapRefreshOptions = {},
): Promise<MapRefreshOutcome | null> {
  const { canonicalWorkspacePath } = await import("./config.js");
  const root = canonicalWorkspacePath(rootArg);
  const now = opts.now ?? Date.now;
  if (readMapStale(root) === null) return null;

  const { acquireMapLock } = await import("./single-flight.js");
  const lock = acquireMapLock(root, `ix map background refresh ${root}`);
  if (!lock) return null;
  try {
    const current = readMapStale(root);
    if (current === null) return null;
    const startedAt = now();
    writeMapStale(root, { ...current, lastAttemptAt: startedAt });
    writeMapRefreshOutcome(root, { startedAt, pid: process.pid });

    // The limit both aborts the requests in flight and, for whatever does
    // not listen to that, stops waiting; either way it is reported as such.
    const timeoutMs = opts.timeoutMs ?? mapBackgroundTimeoutMs();
    const timedOutReason = `timed out after ${timeoutMs / 1000} s`;
    const deadline = AbortSignal.timeout(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ ok: false; reason: string }>(resolve => {
      timer = setTimeout(() => resolve({ ok: false, reason: timedOutReason }), timeoutMs);
      timer.unref?.();
    });
    let result: { ok: boolean; reason?: string };
    try {
      result = await Promise.race([refreshUnderLock(root, current, deadline, opts.client), timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!result.ok && deadline.aborted) result = { ok: false, reason: timedOutReason };
    const outcome: MapRefreshOutcome = { startedAt, finishedAt: now(), ok: result.ok, pid: process.pid };
    if (result.reason !== undefined) outcome.reason = result.reason;
    writeMapRefreshOutcome(root, outcome);
    return outcome;
  } finally {
    lock.release();
  }
}

/** The map request and what follows it, under the lock `runBackgroundMapRefresh` holds. */
async function refreshUnderLock(
  root: string,
  seen: MapStaleInfo,
  deadline: AbortSignal,
  injected: IxClient | undefined,
): Promise<{ ok: boolean; reason?: string }> {
  // Loaded here, not at the top: `commands/map.ts` imports this module, and
  // a reader with no marker never needs any of it.
  const map = await import("./commands/map.js");
  const { createClient } = await import("../client/factory.js");
  const { resolveMapCacheSlot, saveCachedMap } = await import("./map-result-cache.js");
  const { clearMapResultCache } = await import("./config.js");
  const { readBackendHealth } = await import("./commands/upgrade.js");

  let failure: string | undefined;
  try {
    const own = map.mapDeadlineSignal();
    const client = injected ?? createClient({ deadlineSignal: own ? AbortSignal.any([own, deadline]) : deadline, longRunning: true });
    const request = await map.resolveMapScope(client, root, false);
    const slot = await resolveMapCacheSlot(client, request, () => readBackendHealth(client));
    const result = await client.map(request) as import("./commands/map.js").MapResult;

    // Only a completed, non-empty map is recorded. The empty and regionless
    // diagnoses of `ix map` need the ingest's counts, which a refresh has
    // none of, so they do not run here.
    if (map.persistCompletedMapBaseline(result, root)) {
      // The last map stored is this one, or none: one keyed to another
      // request must not outlive the map that replaced it.
      if (slot) saveCachedMap(root, slot, result);
      else clearMapResultCache(root);
      clearMapStaleIfUnchanged(root, seen);
    } else {
      failure = `the map did not complete: outcome ${String(result?.outcome)}, ${String(result?.file_count)} files`;
    }
  } catch (e) {
    failure = `the map request failed: ${oneLine(e)}`;
  }
  // An `ix map` that coalesced into this refresh asked for one more ingest
  // and has already exited: run it, as the lock holder of `ix map` would, so
  // that edit is not lost -- whether or not the map above succeeded. It
  // re-marks the map stale if it changed files.
  const exitCode = process.exitCode;
  try { await map.rerunIfRequested(root, true, { silent: true, format: "json" }); }
  catch { /* rerunIfRequested reports its own failures */ }
  finally { process.exitCode = exitCode; }

  if (failure !== undefined) return { ok: false, reason: failure };
  if (readMapStale(root) !== null) return { ok: true, reason: "files changed while it was refreshed; the map is stale again" };
  return { ok: true };
}
