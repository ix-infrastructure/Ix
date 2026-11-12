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
 *   1. `dir` (default: cwd) must be inside a git repository; its top level is
 *      the root that is mapped.
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
  /** The git top level containing `dir`, or undefined outside a repository. */
  gitRoot?: (dir: string) => string | undefined;
  /** Whether `root` has been mapped before. */
  isMapped?: (root: string) => boolean;
  /** Whether an automatic map is skipped because the backend is remote. */
  remoteSkip?: () => Promise<boolean>;
  /** Whether the backend answers within `timeoutMs`. */
  backendUp?: (timeoutMs: number) => Promise<boolean>;
  /** Start the map for `root` and return without waiting for it. */
  startMap?: (root: string, env: NodeJS.ProcessEnv) => void | Promise<void>;
}

export const DEFAULT_AUTO_MAP_DEBOUNCE_MS = 30_000;
/** How long the backend health check may take before the backend counts as down. */
const BACKEND_CHECK_MS = 2_000;
/** A claim lock older than this was left by a process that died holding it. */
const CLAIM_LOCK_STALE_MS = 10_000;
const STAMP_VERSION = 1;

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
 * `debounced`: one did. `busy`: another caller holds the claim lock right
 * now, and starts the map itself if one is due.
 *
 * The lock is a file created with O_EXCL, held only for the read and write of
 * the stamp. One left behind by a process that died holding it is removed
 * once it is older than {@link CLAIM_LOCK_STALE_MS}; that call still answers
 * `busy`, and the next one claims.
 */
export function claimAutoMapWindow(root: string, windowMs: number, now: number): "claimed" | "debounced" | "busy" {
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
    return "busy";
  }
  try {
    const last = readState(stamp, {
      version: STAMP_VERSION,
      validate: (d) => (typeof d.startedAt === "number" && Number.isFinite(d.startedAt) ? d.startedAt : null),
    });
    // Either side of `now`: a stamp from a clock that has since gone back
    // does not hold the window for longer than the window itself.
    if (last !== null && Math.abs(now - last) < windowMs) return "debounced";
    writeStateAtomic(stamp, STAMP_VERSION, { root, startedAt: now });
    return "claimed";
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

async function spawnAutoMap(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const { command, args, options } = await autoMapInvocation(root, env);
  const child = spawn(command, args, options);
  child.on("error", () => { /* the hook has returned by then */ });
  child.unref();
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

async function defaultGitRoot(dir: string): Promise<string | undefined> {
  const { gitRootFor } = await import("./workspace.js");
  return gitRootFor(dir);
}

async function defaultIsMapped(root: string): Promise<boolean> {
  const { loadIngestBaseline } = await import("./ingest-baseline.js");
  return loadIngestBaseline(root) !== null;
}

/** Decide, and start the map when every rule allows it. Never throws. */
export async function runAutoMap(dirArg: string | undefined, deps: AutoMapDeps = {}): Promise<AutoMapOutcome> {
  const env = deps.env ?? process.env;
  let root: string | undefined;
  try {
    const dir = path.resolve(dirArg ?? process.cwd());
    let isDir = false;
    try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { rule: "not_a_repo", detail: `${dir} is not a directory` };

    const top = deps.gitRoot ? deps.gitRoot(dir) : await defaultGitRoot(dir);
    if (!top) return { rule: "not_a_repo", detail: `${dir} is not inside a git repository` };
    root = canonicalWorkspacePath(top);

    const home = canonicalWorkspacePath((deps.homeDir ?? homedir)());
    if (containsHome(root, home)) return { rule: "home", root, detail: "the git root is the home directory or contains it" };

    const mapped = deps.isMapped ? deps.isMapped(root) : await defaultIsMapped(root);
    if (!mapped) return { rule: "unmapped", root, detail: "never mapped; run `ix map` there once" };

    if (await (deps.remoteSkip ?? defaultRemoteSkip)()) {
      return { rule: "remote", root, detail: "the active backend is remote (IX_AUTO_MAP_CLOUD=1 allows it)" };
    }

    const windowMs = autoMapDebounceMs(env.IX_AUTO_MAP_DEBOUNCE_MS);
    const claim = claimAutoMapWindow(root, windowMs, (deps.now ?? Date.now)());
    if (claim === "debounced") return { rule: "debounced", root, detail: `an automatic map started within the last ${windowMs} ms` };
    if (claim === "busy") return { rule: "busy", root, detail: "another caller is starting a map for this root" };

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
