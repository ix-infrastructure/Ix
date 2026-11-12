// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { spawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { autoMapStampPath } from "./state-paths.js";
import { canonicalWorkspacePath } from "./path-containment.js";
import { readState, writeStateAtomic } from "./workspace-state.js";

/**
 * `ix map --auto [dir]`: the guarded automatic map an editor or agent hook
 * runs after an edit or at the end of a turn. One place decides whether an
 * automatic map may start, so every host follows the same rules:
 *
 *   1. `dir` (default: cwd) must be inside a registered workspace or a git
 *      repository. The root that is mapped is the one a bare `ix map` there
 *      would map (`localRootFor`): the nearest registered workspace, else the
 *      git top level, so a package registered on its own inside a monorepo
 *      keeps its own root.
 *   2. That root must not be the home directory, or contain it.
 *   3. The root must have been mapped before (it has an ingest baseline, the
 *      same thing `ix status` reports as `graphCompleted`). An automatic map
 *      never maps a repository for the first time.
 *   4. The active backend must not be remote, unless IX_AUTO_MAP_CLOUD=1
 *      (`shouldSkipAutoMap`).
 *   5. No automatic map was started for the root within the debounce window
 *      (IX_AUTO_MAP_DEBOUNCE_MS, default 30 s), by any host: the stamp lives
 *      under IX_HOME and is claimed under a lock, so two hosts asking at once
 *      start one map. The window is claimed before the backend is asked, so a
 *      backend that is down is asked at most once per window.
 *      A call inside the window is not simply dropped: when a map of the root
 *      is running it asks that map for one more ingest (`requestMapRerun`,
 *      what a coalesced `ix map` does), and the first such call in a window
 *      schedules one trailing `ix map --auto` for the end of the window, so an
 *      edit (or the end of a turn) inside the window still reaches the graph.
 *   6. The backend must answer its health check.
 *
 * Then `ix map <root> --silent` starts detached, with IX_AUTO_MAP=1, and this
 * returns at once. Every outcome prints nothing and exits 0; `--explain` (or
 * IX_HOOK_DEBUG=1) prints one line on stderr naming the rule that applied.
 */

export type AutoMapRule =
  | "started"
  | "not_a_repo"
  | "home"
  | "unmapped"
  | "remote"
  | "debounced"
  | "busy"
  | "backend_down"
  | "error";

export interface AutoMapOutcome {
  rule: AutoMapRule;
  /** The git root the decision was about, once known. */
  root?: string;
  detail?: string;
}

export interface AutoMapDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  homeDir?: () => string;
  /** The root a bare `ix map` in `dir` would map, or undefined outside any workspace or repository. */
  localRoot?: (dir: string) => string | undefined;
  /** Whether `root` has been mapped before. */
  isMapped?: (root: string) => boolean;
  /** Whether an automatic map is skipped because the backend is remote. */
  remoteSkip?: () => Promise<boolean>;
  /** Whether the backend answers within `timeoutMs`. */
  backendUp?: (timeoutMs: number) => Promise<boolean>;
  /** Start the map for `root` and return without waiting for it. */
  startMap?: (root: string, env: NodeJS.ProcessEnv) => void | Promise<void>;
  /** Start `ix map --auto <root>` that waits `delayMs` first, and return without waiting for it. */
  startTrail?: (root: string, delayMs: number, env: NodeJS.ProcessEnv) => void | Promise<void>;
  /** When a map of `root` is running, ask it for one more ingest; true when one was running. */
  requestRerun?: (root: string) => boolean | Promise<boolean>;
  /** Wait `ms` (a trailing call waits for the end of the window). */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_AUTO_MAP_DEBOUNCE_MS = 30_000;
/** How long the backend health check may take before the backend counts as down. */
const BACKEND_CHECK_MS = 2_000;
/** A claim lock older than this was left by a process that died holding it. */
const CLAIM_LOCK_STALE_MS = 10_000;
const STAMP_VERSION = 1;
/** Env var a trailing call is started with: how long it waits before it decides. */
const TRAIL_ENV = "IX_AUTO_MAP_TRAIL_MS";
/** Past the window's end, so the trailing call is not itself inside it. */
const TRAIL_SLACK_MS = 250;
/** A trailing call never waits longer than this, whatever its env says. */
const TRAIL_MAX_MS = 10 * 60_000;

interface AutoMapStamp {
  startedAt: number;
  /** The `startedAt` of the window a trailing call was scheduled for. */
  trailFor?: number;
}

function readStamp(stamp: string): AutoMapStamp | null {
  return readState(stamp, {
    version: STAMP_VERSION,
    validate: (d) => {
      if (typeof d.startedAt !== "number" || !Number.isFinite(d.startedAt)) return null;
      const trailFor = typeof d.trailFor === "number" && Number.isFinite(d.trailFor) ? d.trailFor : undefined;
      return { startedAt: d.startedAt, trailFor };
    },
  });
}

/** Whether `now` is inside the window of a map started at `last`. Either side: a clock that went back does not hold the window longer than the window. */
function inWindow(last: number, now: number, windowMs: number): boolean {
  return Math.abs(now - last) < windowMs;
}

export type WindowClaim =
  | { claim: "claimed" }
  /** `trailInMs`: set when this call is the first inside the window, and should start the trailing call. */
  | { claim: "debounced"; trailInMs?: number }
  | { claim: "busy" };

/** The debounce window in ms: IX_AUTO_MAP_DEBOUNCE_MS when it is a plain number (0 turns it off), else the default. */
export function autoMapDebounceMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_AUTO_MAP_DEBOUNCE_MS;
  return Number.parseInt(trimmed, 10);
}

/** Whether `home` is `root` or lies inside it. Both canonical. */
function containsHome(root: string, home: string): boolean {
  const rel = path.relative(root, home);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Claim the debounce window for `root`. `claimed`: no automatic map started
 * for it within `windowMs`, and the stamp now says one starts at `now`.
 * `debounced`: one did; with `trailInMs` when no trailing call has been
 * scheduled for that window yet (and `allowTrail`), and the stamp now says
 * one has. `busy`: another caller holds the claim lock right now, and does
 * whichever of those is due itself.
 *
 * The lock is a file created with O_EXCL, held only for the read and write of
 * the stamp. One left behind by a process that died holding it is removed
 * once it is older than {@link CLAIM_LOCK_STALE_MS}; that call still answers
 * `busy`, and the next one claims.
 */
export function claimAutoMapWindow(root: string, windowMs: number, now: number, allowTrail = true): WindowClaim {
  const stamp = autoMapStampPath(root);
  const lock = `${stamp}.lock`;
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > CLAIM_LOCK_STALE_MS) fs.rmSync(lock, { force: true });
    } catch { /* gone already */ }
    return { claim: "busy" };
  }
  try {
    const last = readStamp(stamp);
    if (last !== null && inWindow(last.startedAt, now, windowMs)) {
      if (!allowTrail || last.trailFor === last.startedAt) return { claim: "debounced" };
      writeStateAtomic(stamp, STAMP_VERSION, { root, startedAt: last.startedAt, trailFor: last.startedAt });
      const trailInMs = Math.min(Math.max(0, last.startedAt + windowMs - now), windowMs) + TRAIL_SLACK_MS;
      return { claim: "debounced", trailInMs };
    }
    writeStateAtomic(stamp, STAMP_VERSION, { root, startedAt: now });
    return { claim: "claimed" };
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
    try { fs.rmSync(lock, { force: true }); } catch { /* best-effort */ }
  }
}

/** The CLI entry beside this module: `main.js` when built, `main.ts` under tsx. */
function cliEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(self), `main${path.extname(self)}`);
}

/**
 * How the automatic map for `root` is started: the same Node and CLI entry as
 * this process, `ix map <root> --silent` with IX_AUTO_MAP=1, no shell, no
 * inherited stdio (a hook that waits for its child's pipes must not wait for
 * this one), detached into its own process group. Exported for tests.
 */
export async function autoMapInvocation(
  root: string,
  env: NodeJS.ProcessEnv,
  entry = cliEntryPath(),
  execArgv = process.execArgv,
): Promise<{ command: string; args: string[]; options: SpawnOptions }> {
  const { childCliArgs } = await import("./commands/watch.js");
  return {
    command: process.execPath,
    args: childCliArgs(entry, ["map", root, "--silent"], execArgv),
    options: {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true, shell: false,
      env: { ...env, IX_AUTO_MAP: "1" },
    },
  };
}

/**
 * How the trailing call for `root` is started: `ix map --auto <root>` with
 * IX_AUTO_MAP_TRAIL_MS, detached like the map itself. It waits that long,
 * then applies every rule again. Exported for tests.
 */
export async function autoMapTrailInvocation(
  root: string,
  delayMs: number,
  env: NodeJS.ProcessEnv,
  entry = cliEntryPath(),
  execArgv = process.execArgv,
): Promise<{ command: string; args: string[]; options: SpawnOptions }> {
  const { childCliArgs } = await import("./commands/watch.js");
  return {
    command: process.execPath,
    args: childCliArgs(entry, ["map", "--auto", root], execArgv),
    options: {
      cwd: root, detached: true, stdio: "ignore", windowsHide: true, shell: false,
      env: { ...env, [TRAIL_ENV]: String(Math.round(delayMs)) },
    },
  };
}

function spawnDetached(inv: { command: string; args: string[]; options: SpawnOptions }): void {
  const child = spawn(inv.command, inv.args, inv.options);
  child.on("error", () => { /* the hook has returned by then */ });
  child.unref();
}

async function spawnAutoMap(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  spawnDetached(await autoMapInvocation(root, env));
}

async function spawnTrail(root: string, delayMs: number, env: NodeJS.ProcessEnv): Promise<void> {
  spawnDetached(await autoMapTrailInvocation(root, delayMs, env));
}

/** What a coalesced `ix map` does: when a map of `root` is running, ask it for one more ingest. */
async function defaultRequestRerun(root: string): Promise<boolean> {
  const { mapLockHeld, requestMapRerun } = await import("./single-flight.js");
  if (!mapLockHeld(root)) return false;
  requestMapRerun(root);
  return true;
}

/** The wait a trailing call was started with, or undefined for an ordinary call. */
export function autoMapTrailMs(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return undefined;
  return Math.min(Number.parseInt(trimmed, 10), TRAIL_MAX_MS);
}

async function defaultRemoteSkip(): Promise<boolean> {
  const [{ isCloudReady }, { shouldSkipAutoMap }] = await Promise.all([
    import("./remote.js"),
    import("./commands/map.js"),
  ]);
  return shouldSkipAutoMap({ auto: true, cloudReady: await isCloudReady() });
}

/** The same health check `ix status` makes; a failure or a timeout is "down". */
async function defaultBackendUp(timeoutMs: number): Promise<boolean> {
  const [{ createClient }, { readBackendHealth }] = await Promise.all([
    import("../client/factory.js"),
    import("./commands/upgrade.js"),
  ]);
  try {
    await readBackendHealth(createClient(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

async function defaultLocalRoot(dir: string): Promise<string | undefined> {
  const { localRootFor } = await import("./map-root.js");
  return localRootFor(dir);
}

async function defaultIsMapped(root: string): Promise<boolean> {
  const { loadIngestBaseline } = await import("./ingest-baseline.js");
  return loadIngestBaseline(root) !== null;
}

/** Decide, and start the map when every rule allows it. Never throws. */
export async function runAutoMap(dirArg: string | undefined, deps: AutoMapDeps = {}): Promise<AutoMapOutcome> {
  const { [TRAIL_ENV]: trailRaw, ...env } = deps.env ?? process.env;
  let root: string | undefined;
  try {
    // A trailing call: wait for the end of the window it was scheduled for,
    // then decide like any other call -- except that it never schedules
    // another. If it finds a newer window, the map that opened it started
    // after the edit that scheduled this call, so that edit is covered.
    const trailMs = autoMapTrailMs(trailRaw);
    const trailing = trailMs !== undefined;
    if (trailing) await (deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(trailMs);

    const dir = path.resolve(dirArg ?? process.cwd());
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { rule: "not_a_repo", detail: `${dir} is not a directory` };

    const top = deps.localRoot ? deps.localRoot(dir) : await defaultLocalRoot(dir);
    if (!top) return { rule: "not_a_repo", detail: `${dir} is not inside a registered workspace or a git repository` };
    root = canonicalWorkspacePath(top);

    const home = canonicalWorkspacePath((deps.homeDir ?? homedir)());
    if (containsHome(root, home)) return { rule: "home", root, detail: "the root is the home directory or contains it" };

    const windowMs = autoMapDebounceMs(env.IX_AUTO_MAP_DEBOUNCE_MS);
    const now = (deps.now ?? Date.now)();
    const requestRerun = deps.requestRerun ?? defaultRequestRerun;
    const debounced = async (trailInMs?: number): Promise<AutoMapOutcome> => {
      const notes = [`an automatic map started within the last ${windowMs} ms`];
      if (await requestRerun(root!)) notes.push("asked the running map for one more ingest");
      if (trailInMs !== undefined) {
        await (deps.startTrail ?? spawnTrail)(root!, trailInMs, env);
        notes.push(`a trailing map is due in ${trailInMs} ms`);
      }
      return { rule: "debounced", root, detail: notes.join("; ") };
    };

    // The cheap answer first: a post-edit hook fires on every edit, and most
    // land inside a window whose trailing call is already scheduled. A stamp
    // exists only for a root that passed every rule below once, so this skips
    // reading the ingest baseline (one entry per file) on each of them.
    const peek = readStamp(autoMapStampPath(root));
    if (peek && inWindow(peek.startedAt, now, windowMs) && (trailing || peek.trailFor === peek.startedAt)) {
      return debounced();
    }

    const mapped = deps.isMapped ? deps.isMapped(root) : await defaultIsMapped(root);
    if (!mapped) return { rule: "unmapped", root, detail: "never mapped; run `ix map` there once" };

    if (await (deps.remoteSkip ?? defaultRemoteSkip)()) {
      return { rule: "remote", root, detail: "the active backend is remote (IX_AUTO_MAP_CLOUD=1 allows it)" };
    }

    const claim = claimAutoMapWindow(root, windowMs, now, !trailing);
    if (claim.claim === "debounced") return debounced(claim.trailInMs);
    if (claim.claim === "busy") return { rule: "busy", root, detail: "another caller is starting a map for this root" };

    if (!(await (deps.backendUp ?? defaultBackendUp)(BACKEND_CHECK_MS))) {
      return { rule: "backend_down", root, detail: `the backend did not answer within ${BACKEND_CHECK_MS} ms` };
    }

    await (deps.startMap ?? spawnAutoMap)(root, env);
    return { rule: "started", root };
  } catch (err) {
    return { rule: "error", root, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** The `--explain` line. */
export function explainAutoMap(outcome: AutoMapOutcome): string {
  const verdict = outcome.rule === "started" ? "started" : `skipped (${outcome.rule})`;
  const parts = [`ix map --auto: ${verdict}`];
  if (outcome.root) parts.push(outcome.root);
  if (outcome.detail) parts.push(outcome.detail);
  return parts.join(": ");
}

/** The `ix map --auto` action: decide, explain when asked, print nothing otherwise. Never throws or sets an exit code. */
export async function runAutoMapCommand(dirArg: string | undefined, opts: { explain?: boolean } = {}): Promise<void> {
  const outcome = await runAutoMap(dirArg);
  if (opts.explain || process.env.IX_HOOK_DEBUG === "1") {
    try { process.stderr.write(`${explainAutoMap(outcome)}\n`); } catch { /* best-effort */ }
  }
}
