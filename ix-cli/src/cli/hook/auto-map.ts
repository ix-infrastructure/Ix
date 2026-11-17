// Copyright 2026 Ix Infrastructure Inc.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { appendHookLog } from "./entry.js";
import { runHookMain, withDeadline } from "./io.js";
import { canonicalPath, fingerprint, gitTopLevel, hookStateDir } from "./session.js";

/**
 * `ix hook auto-map`: the guarded automatic map an agent host runs on its own
 * events (the end of a turn, an edit), so the next question is asked of a
 * current graph. Each agent plugin used to keep its own copy of this
 * (ix-claude-plugin's `ix_request_auto_map`, the Cursor plugin's
 * `requestAutoMap`, the Gemini plugin's `request_guarded_map`); this is the
 * one they call instead. The order is the Claude plugin's:
 *
 * 1. The project root: the git top level of the directory the host names
 *    (`--root`, else the payload, else the host's project variable, else the
 *    hook's cwd). Not a git repository, or the repository is $HOME (a dotfiles
 *    repo is not a project, and mapping it walks the whole home directory):
 *    skip.
 * 2. Debounce, per root: no second attempt inside IX_MAP_DEBOUNCE_SECONDS
 *    (default 300). The stamp is written before step 3, so an unmapped
 *    project is asked at most once per window too.
 * 3. Mapped: a registered workspace whose last graph ingest completed (what
 *    `ix status` reports as `graphCompleted`), read in process -- no `ix
 *    status` child. An automatic map never creates a workspace.
 * 4. A map already running for the root (the map lock, `single-flight.ts`)
 *    is asked for one more pass instead of starting a second process that
 *    would only coalesce into it.
 * 5. Otherwise a detached `ix map <root> --silent` from the root with
 *    IX_AUTO_MAP=1 (the CLI then skips it against a remote backend), with the
 *    same Node and CLI entry as this process. It outlives the hook, so the
 *    hook's deadline never kills a map midway.
 *
 * The hook process contract holds (`io.ts`): exit 0, print nothing -- this
 * hook has nothing to tell the model -- state under `<IX_HOME>/hook-state`,
 * one deadline per run.
 */

export const DEFAULT_AUTO_MAP_DEBOUNCE_SECONDS = 300;

export interface AutoMapOptions {
  /** Whose payload is on stdin: `claude` (default), `cursor`, `gemini` or `codex`. */
  host?: string;
  /** The project directory, over anything the payload says. */
  root?: string;
}

export type AutoMapOutcome =
  | "not-git"
  | "home"
  | "debounced"
  | "not-mapped"
  | "coalesced"
  | "spawned"
  | "spawn-failed";

export interface AutoMapResult {
  /** The project directory the host named. */
  dir: string;
  /** Its git root, once there is one. */
  root?: string;
  outcome: AutoMapOutcome;
}

interface DetachedChild {
  on(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

export interface AutoMapDeps {
  env?: NodeJS.ProcessEnv;
  /** The hook process's cwd, the last fallback for the project directory. */
  cwd?: string;
  now?: () => number;
  gitTopLevel?: (dir: string) => string | undefined;
  isMapped?: (root: string) => boolean | Promise<boolean>;
  mapLockHeld?: (root: string) => boolean;
  requestMapRerun?: (root: string) => void;
  spawn?: (command: string, args: string[], options: SpawnOptions) => DetachedChild;
  /** The CLI entry the map runs from; default `main.js` (`main.ts` under tsx) beside this module's parent. */
  entry?: string;
  execArgv?: string[];
  debug?: (msg: string) => void;
}

/**
 * Where each host puts the directory it works in. Field names only; a host
 * whose adapter (`host.ts`) grows a project-directory field can move there.
 * Codex and Gemini CLI send `cwd` as Claude Code does; Cursor sends the
 * workspace folders it has open as `workspace_roots`.
 */
const HOST_PROJECT_FIELDS: Readonly<Record<string, { field: string; list?: boolean; envVar?: string }>> = {
  claude: { field: "cwd", envVar: "CLAUDE_PROJECT_DIR" },
  cursor: { field: "workspace_roots", list: true, envVar: "CURSOR_PROJECT_DIR" },
  gemini: { field: "cwd", envVar: "GEMINI_PROJECT_DIR" },
  codex: { field: "cwd" },
};

/**
 * The directories to map from, in order, deduplicated: `--root`; else the
 * absolute directories the host's payload names; else the host's project
 * variable; else `cwd`. A relative or non-string payload value is ignored: it
 * is not a statement about where the project is.
 */
export function autoMapProjectDirs(
  opts: AutoMapOptions, raw: string, env: NodeJS.ProcessEnv, cwd: string,
): string[] {
  if (opts.root) return [path.resolve(cwd, opts.root)];
  const spec = Object.hasOwn(HOST_PROJECT_FIELDS, opts.host ?? "claude")
    ? HOST_PROJECT_FIELDS[opts.host ?? "claude"]
    : { field: "cwd" };
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { payload = undefined; }
  const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[spec.field] : undefined;
  const candidates = spec.list ? (Array.isArray(value) ? value : []) : [value];
  const dirs = candidates.filter((d): d is string => typeof d === "string" && d !== "" && path.isAbsolute(d));
  if (dirs.length > 0) return [...new Set(dirs)];
  const fromEnv = spec.envVar ? env[spec.envVar] : undefined;
  if (fromEnv && path.isAbsolute(fromEnv)) return [fromEnv];
  return [cwd];
}

/** IX_MAP_DEBOUNCE_SECONDS in ms: a whole number of seconds, 0 for none; anything else keeps 300 s. */
export function autoMapDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.IX_MAP_DEBOUNCE_SECONDS?.trim();
  const seconds = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_AUTO_MAP_DEBOUNCE_SECONDS;
  return seconds * 1000;
}

/** The root's debounce stamp: `<hook-state>/auto-map/<hash of the root>.stamp`, holding the last attempt in epoch ms. */
export function autoMapStampPath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(hookStateDir(env), "auto-map", `${fingerprint(root).slice(0, 24)}.stamp`);
}

function lastAttempt(stamp: string): number | undefined {
  try {
    const raw = fs.readFileSync(stamp, "utf-8").trim();
    return /^\d+$/.test(raw) ? Number(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: a stamp that cannot be written only means the next request is not debounced. */
function writeStamp(stamp: string, now: number): void {
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stamp, String(now), { mode: 0o600 });
  } catch { /* not debounced next time, still guarded by the mapped check and the map lock */ }
}

/**
 * Whether `root` is a registered workspace whose last graph ingest completed:
 * `ix status --root <root>`'s `graphCompleted`, plus the registration that an
 * automatic map must find rather than create. Never throws.
 */
export async function isWorkspaceMapped(root: string): Promise<boolean> {
  try {
    const [{ findWorkspaceForCwd }, { hasCompletedSourceGraphBaseline }] = await Promise.all([
      import("../workspace.js"),
      import("../stale.js"),
    ]);
    return findWorkspaceForCwd(root) !== undefined && hasCompletedSourceGraphBaseline(root);
  } catch {
    return false;
  }
}

function defaultEntry(): string {
  const self = fileURLToPath(import.meta.url);
  return path.join(path.dirname(path.dirname(self)), `main${path.extname(self)}`);
}

async function mapInvocation(
  root: string, env: NodeJS.ProcessEnv, deps: AutoMapDeps,
): Promise<{ command: string; args: string[]; options: SpawnOptions }> {
  const { childCliArgs } = await import("../commands/watch.js");
  return {
    command: process.execPath,
    args: childCliArgs(deps.entry ?? defaultEntry(), ["map", root, "--silent"], deps.execArgv ?? process.execArgv),
    options: {
      cwd: root,
      env: { ...env, IX_AUTO_MAP: "1" },
      // Its own process group and no inherited pipes: a host that waits for
      // the hook's stdout to close must not wait for the map.
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    },
  };
}

async function autoMapRoot(
  dir: string, root: string, env: NodeJS.ProcessEnv, deps: AutoMapDeps,
): Promise<AutoMapResult> {
  const debug = deps.debug ?? (() => {});
  const home = env.HOME || os.homedir();
  if (home && canonicalPath(home) === root) {
    debug(`auto-map: ${root} is $HOME`);
    return { dir, root, outcome: "home" };
  }

  const now = (deps.now ?? Date.now)();
  const stamp = autoMapStampPath(root, env);
  const last = lastAttempt(stamp);
  const window = autoMapDebounceMs(env);
  if (last !== undefined && now - last >= 0 && now - last < window) {
    debug(`auto-map: ${root} was tried ${Math.round((now - last) / 1000)} s ago`);
    return { dir, root, outcome: "debounced" };
  }
  writeStamp(stamp, now);

  let mapped: boolean;
  try { mapped = await (deps.isMapped ?? isWorkspaceMapped)(root); } catch { mapped = false; }
  if (!mapped) {
    debug(`auto-map: ${root} is not mapped`);
    return { dir, root, outcome: "not-mapped" };
  }

  try {
    const lock = deps.mapLockHeld && deps.requestMapRerun
      ? { mapLockHeld: deps.mapLockHeld, requestMapRerun: deps.requestMapRerun }
      : await import("../single-flight.js");
    if (lock.mapLockHeld(root)) {
      // What a second `ix map` would do on finding the lock held, without the process.
      lock.requestMapRerun(root);
      debug(`auto-map: a map of ${root} is running; asked it for one more pass`);
      return { dir, root, outcome: "coalesced" };
    }
  } catch { /* the map takes the lock itself; a second one coalesces there */ }

  try {
    const { command, args, options } = await mapInvocation(root, env, deps);
    const child = (deps.spawn ?? nodeSpawn)(command, args, options);
    child.on("error", () => { /* ix vanished, or could not start: the next window tries again */ });
    child.unref();
    debug(`auto-map: started ix map ${root} --silent`);
    return { dir, root, outcome: "spawned" };
  } catch (err) {
    debug(`auto-map: could not start ix map: ${err instanceof Error ? err.message : String(err)}`);
    return { dir, root, outcome: "spawn-failed" };
  }
}

/**
 * Request the guarded map for every project the host names (one per git
 * root). Never throws; resolves once each child is started, not finished.
 */
export async function requestAutoMap(
  raw: string, opts: AutoMapOptions = {}, deps: AutoMapDeps = {},
): Promise<AutoMapResult[]> {
  const env = deps.env ?? process.env;
  const results: AutoMapResult[] = [];
  const seen = new Set<string>();
  let dirs: string[];
  try { dirs = autoMapProjectDirs(opts, raw, env, deps.cwd ?? process.cwd()); } catch { return results; }
  for (const dir of dirs) {
    let root: string | undefined;
    try { root = (deps.gitTopLevel ?? gitTopLevel)(dir); } catch { root = undefined; }
    if (!root) { results.push({ dir, outcome: "not-git" }); continue; }
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      results.push(await autoMapRoot(dir, root, env, deps));
    } catch {
      results.push({ dir, root, outcome: "spawn-failed" });
    }
  }
  return results;
}

/** `--host <name>`, `--root=<dir>`; anything else is ignored. */
export function parseAutoMapArgs(argv: string[]): AutoMapOptions {
  const opts: AutoMapOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--host") opts.host = value();
    else if (flag === "--root") opts.root = value();
  }
  return opts;
}

/**
 * The whole process: read stdin, request the map within the deadline, print
 * nothing, exit 0 ({@link runHookMain}). IX_HOOK_LOG gets one line per run.
 */
export async function runAutoMapProcess(opts: AutoMapOptions): Promise<void> {
  await runHookMain(async (raw, left, debug) => {
    const started = Date.now();
    const results = await withDeadline(requestAutoMap(raw, opts, { debug }), left);
    if (!results) debug(`auto-map: no answer within ${left} ms`);
    appendHookLog(process.env.IX_HOOK_LOG || undefined, {
      ts: new Date(started).toISOString(), hook: "auto-map", host: opts.host ?? "claude",
      path: results ? "auto-map" : "timeout", ms: Date.now() - started, chars: 0,
      notes: (results ?? []).map((r) => `${r.outcome}: ${r.root ?? r.dir}`),
    });
    return undefined;
  });
}
