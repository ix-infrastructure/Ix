// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { resolveWorkspaceRoot, clearIngestMtimeCache } from "../config.js";
import { bootstrap, ensureWorkspaceIdState } from "../bootstrap.js";
import { SUPPORTED_EXTENSIONS } from "../supported-extensions.js";

const SUPPORTED_NAMES = new Set([
  ".gitignore", ".gitattributes", ".editorconfig", ".env",
  ".eslintrc", ".prettierrc", ".babelrc",
  "Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile",
  "BUILD", "WORKSPACE",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next",
  ".cache", "__pycache__", ".ix", ".claude",
]);

const DEBOUNCE_MS = 300;
const MAP_COALESCED_EXIT_CODE = 75;
const MAP_RETRY_MS = 1000;
const MAP_RETRY_MAX_MS = 30_000;
/**
 * How many times a coalesced map is retried before the refresh is given up on.
 *
 * The backoff below reaches its 30s ceiling after five doublings (31s of
 * waiting), so 45 attempts spans roughly 21 minutes. That is deliberately just
 * past `DEFAULT_LOCK_MAX_MS` in single-flight.ts (20 min), which is the point at
 * which a lock whose holder died is stolen — so a genuinely long map is still
 * waited out, and only a lock that outlives its own staleness window gives up.
 *
 * A fixed 1s retry with no ceiling reached that same 20 minutes in ~1,200 Node
 * process spawns. This reaches it in 45.
 */
const MAP_RETRY_ATTEMPTS = 45;
/** Retrying silently for minutes looks identical to a watcher that has died. */
const MAP_RETRY_NOTIFY_AFTER = 3;

interface MapChild {
  once(event: "error", listener: (err: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

type MapLauncher = (command: string, args: string[], options: SpawnOptions) => MapChild;

const RUNTIME_LOADER_FLAGS = new Set([
  "--import", "--loader", "--experimental-loader", "--require", "-r",
]);

/** Preserve source loaders for a TypeScript CLI entry without cloning debugger flags. */
export function childCliArgs(
  entry: string,
  cliArgs: string[],
  execArgv: string[] = process.execArgv,
): string[] {
  if (!/\.[cm]?tsx?$/.test(entry)) return [entry, ...cliArgs];

  const loaders: string[] = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index]!;
    if (RUNTIME_LOADER_FLAGS.has(arg)) {
      const value = execArgv[index + 1];
      if (value !== undefined) {
        loaders.push(arg, value);
        index++;
      }
      continue;
    }
    if (
      [...RUNTIME_LOADER_FLAGS].some(flag => arg.startsWith(`${flag}=`)) ||
      (arg.startsWith("-r") && !arg.startsWith("--") && arg.length > 2)
    ) {
      loaders.push(arg);
    }
  }

  return [...loaders, entry, ...cliArgs];
}

export function canonicalMapInvocation(
  root: string,
  entry = process.argv[1],
  execArgv = process.execArgv,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!entry) throw new Error("Could not locate the Ix CLI entry point.");
  return {
    command: process.execPath,
    args: childCliArgs(entry, ["map", root, "--silent"], execArgv),
    env: {
      ...process.env,
      IX_AUTO_MAP: "1",
      IX_MAP_FULL_INGEST: "1",
      IX_MAP_COALESCE_EXIT_CODE: String(MAP_COALESCED_EXIT_CODE),
    },
  };
}

function runChild(
  invocation: ReturnType<typeof canonicalMapInvocation>,
  launch: MapLauncher,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = launch(invocation.command, invocation.args, {
      env: invocation.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || code === MAP_COALESCED_EXIT_CODE) {
        resolve({ code, signal });
      } else {
        reject(new Error(`ix map failed${signal ? ` (${signal})` : ` (exit ${code ?? 1})`}`));
      }
    });
  });
}

/** Exponential backoff, capped, so a held lock costs attempts rather than spawns. */
export function mapRetryDelay(attempt: number): number {
  return Math.min(MAP_RETRY_MS * 2 ** (attempt - 1), MAP_RETRY_MAX_MS);
}

export async function runCanonicalMap(
  root: string,
  launch: MapLauncher = spawn as MapLauncher,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  notify: (message: string) => void = message => console.error(`${chalk.dim("[watch]")} ${message}`),
): Promise<void> {
  const invocation = canonicalMapInvocation(root);
  for (let attempt = 1; attempt <= MAP_RETRY_ATTEMPTS; attempt++) {
    const { code } = await runChild(invocation, launch);
    if (code === 0) return;
    // Exit 75 means another ix map holds the workspace lock. The child runs
    // --silent, so without this the watcher looks hung rather than patient.
    if (attempt === MAP_RETRY_NOTIFY_AFTER) {
      notify("another ix map holds this workspace; waiting for it to finish...");
    }
    await wait(mapRetryDelay(attempt));
  }
  throw new Error(
    `ix map stayed coalesced across ${MAP_RETRY_ATTEMPTS} attempts; another ix map has held the workspace lock the whole time`,
  );
}

/** Serialize refreshes and coalesce changes during a run into one trailing refresh. */
export class WatchRefreshScheduler {
  private running = false;
  private queued = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly onError: (err: unknown) => void,
  ) {}

  request(): void {
    this.queued = true;
    if (!this.running) void this.drain();
  }

  waitForIdle(): Promise<void> {
    if (!this.running && !this.queued) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queued) {
        this.queued = false;
        try {
          await this.refresh();
        } catch (err) {
          this.onError(err);
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }
}

/** Detect new, changed, and deleted files while advancing the polling snapshot. */
export function updatePollingSnapshot(
  currentFiles: string[],
  mtimes: Map<string, number>,
  statMtime: (filePath: string) => number = filePath => fs.statSync(filePath).mtimeMs,
): string[] {
  const next = new Map<string, number>();
  const changed: string[] = [];

  for (const filePath of currentFiles) {
    try {
      const mtime = statMtime(filePath);
      next.set(filePath, mtime);
      if (mtimes.get(filePath) !== mtime) changed.push(filePath);
    } catch {
      // A racy delete is handled by the missing-file pass below.
    }
  }

  const current = new Set(next.keys());
  for (const filePath of mtimes.keys()) {
    if (!current.has(filePath)) changed.push(filePath);
  }

  mtimes.clear();
  for (const [filePath, mtime] of next) mtimes.set(filePath, mtime);
  return changed;
}

function isSupportedPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_NAMES.has(path.basename(filePath));
}

export function shouldWatch(root: string, filePath: string): boolean {
  if (!isSupportedPath(filePath)) return false;
  const segments = path.relative(root, filePath).split(path.sep);
  return !segments.some(segment => IGNORE_DIRS.has(segment));
}

export function prepareMigratedWorkspaceRefresh(
  root: string,
  clear: (workspaceRoot: string) => void = clearIngestMtimeCache,
): void {
  clear(root);
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && isSupportedPath(fullPath)) results.push(fullPath);
    }
  }
  return results;
}

function createBatchNotifier(root: string, scheduler: WatchRefreshScheduler): {
  notify(filePath: string): void;
  cancel(): void;
} {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  const flush = () => {
    timer = undefined;
    for (const filePath of [...pending].sort()) {
      console.log(`${chalk.dim("[watch]")} changed: ${path.relative(root, filePath)}`);
    }
    pending.clear();
    scheduler.request();
  };

  return {
    notify(filePath: string) {
      pending.add(filePath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      pending.clear();
    },
  };
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Watch files and auto-ingest on changes")
    .option("--path <path>", "Restrict watching to a subdirectory")
    .option("--root <dir>", "Workspace root directory")
    .action(async (opts: { path?: string; root?: string }) => {
      const root = path.resolve(resolveWorkspaceRoot(opts.root));
      try {
        await bootstrap(root);
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exit(1);
      }

      const { migrated } = ensureWorkspaceIdState(root);
      const watchPath = opts.path
        ? path.resolve(root, opts.path)
        : root;

      if (!fs.existsSync(watchPath)) {
        console.error(`Path does not exist: ${watchPath}`);
        process.exit(1);
      }

      const refresh = () => runCanonicalMap(root);
      const scheduler = new WatchRefreshScheduler(refresh, err =>
        console.error(`${chalk.red("[watch]")} refresh error: ${(err as Error).message}`)
      );

      if (migrated) {
        console.error(chalk.dim("[watch] Workspace migrated to a stable id; re-ingesting once before watching..."));
        prepareMigratedWorkspaceRefresh(root);
        await refresh();
      }

      const relative = path.relative(root, watchPath) || ".";
      console.log(chalk.cyan(`[watch] Watching ${relative}`));
      console.log(chalk.dim(`[watch] Debounce: ${DEBOUNCE_MS}ms`));
      console.log(chalk.dim("[watch] Press Ctrl+C to stop.\n"));

      const batch = createBatchNotifier(root, scheduler);

      // Use fs.watch recursively
      try {
        const watcher = fs.watch(watchPath, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const fullPath = path.resolve(watchPath, filename);
          if (shouldWatch(root, fullPath)) batch.notify(fullPath);
        });

        // Keep process alive
        process.on("SIGINT", () => {
          watcher.close();
          batch.cancel();
          console.log(chalk.dim("\n[watch] Stopped."));
          process.exit(0);
        });
      } catch (err: any) {
        // Fallback to polling if fs.watch with recursive isn't supported
        if (err.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") {
          console.log(chalk.dim("[watch] Falling back to polling mode (2s interval)..."));
          pollMode(watchPath, root, scheduler);
        } else {
          throw err;
        }
      }
    });
}

/**
 * Fallback polling mode for platforms where recursive fs.watch isn't available.
 */
function pollMode(
  watchPath: string,
  root: string,
  scheduler: WatchRefreshScheduler,
): void {
  const mtimes = new Map<string, number>();

  // Initial scan
  for (const f of collectFiles(watchPath)) {
    try { mtimes.set(f, fs.statSync(f).mtimeMs); } catch {}
  }

  const interval = setInterval(() => {
    const changed = updatePollingSnapshot(collectFiles(watchPath), mtimes);
    if (changed.length === 0) return;
    for (const filePath of changed.sort()) {
      console.log(`${chalk.dim("[watch]")} changed: ${path.relative(root, filePath)}`);
    }
    scheduler.request();
  }, 2000);

  process.on("SIGINT", () => {
    clearInterval(interval);
    console.log(chalk.dim("\n[watch] Stopped."));
    process.exit(0);
  });
}
