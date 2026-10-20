// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Command, CommanderError } from "commander";

import { registerOssCommands, registerProStubs } from "../cli/register/oss.js";
import { tryLoadProCommands } from "../cli/register/pro-loader.js";
import { resetResolutionNotices } from "../cli/format.js";
import { resetReadScope } from "../cli/resolve.js";
import { releaseLocksOwnedBy } from "../cli/single-flight.js";
import {
  type ActiveRun,
  appendChunk,
  installCapture,
  liveOrphans,
  MAX_OUTPUT_BYTES,
  pristineStderrWrite,
  pristineStdoutWrite,
  ProcessExitSignal,
  runContext,
  setActiveRun,
} from "../cli/in-process.js";
import { IX_CALLER_ENV } from "../cli/next-step.js";
import { runWithSignal } from "../client/run-signal.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = fileURLToPath(new URL("../cli/main.js", import.meta.url));

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long a command aborted at its timeout gets to unwind before it is
 * treated as an orphan. An aborted fetch rejects at once, so a command whose
 * work is backend requests settles well inside this.
 */
const ABORT_SETTLE_MS = 1_000;


/** How much of a thrown error's text to keep once the output cap has fired. */
const FAILURE_DETAIL_CHARS = 2 * 1024;

export interface IxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type IxRunner = (args: string[], timeoutMs?: number) => Promise<IxRunResult>;

/**
 * Commands whose effects invalidate `cli/resolve.ts`'s per-cwd scope cache.
 *
 * That cache never expires — one command per process *was* its invalidation.
 * Left alone in a long-lived server, the first tool call in a not-yet-ingested
 * repo pinned the scope, and every read after an `ix_map` that stitched the
 * repo into a System still resolved against the pre-map workspace: "not found"
 * for symbols the agent had just watched itself ingest, until the host
 * restarted the server.
 */
const SCOPE_CHANGING_COMMANDS = new Set(["map", "ingest"]);

/**
 * A stdout stream for the MCP transport that bypasses the capture patch.
 *
 * The transport holds this instead of `process.stdout`, so protocol framing
 * cannot be swallowed by a run or reordered behind command output.
 */
export function createProtocolStdout(): Writable {
  return new Writable({
    write(chunk, encoding, callback) {
      // Writable hands Buffer chunks the pseudo-encoding "buffer", which is not
      // a value process.stdout.write accepts.
      if (Buffer.isBuffer(chunk)) pristineStdoutWrite(chunk, callback);
      else pristineStdoutWrite(chunk, encoding, callback);
    },
  });
}

/**
 * Build a fresh command tree.
 *
 * Rebuilt per run rather than cached: commander stores parsed option values on
 * the `Command` objects and does not clear them between parses, so a reused
 * program would leak `--path` from one `ix_text` call into the next call that
 * omitted it.
 */
async function buildProgram(version: string): Promise<Command> {
  const program = new Command();
  program.name("ix").version(version);
  registerOssCommands(program);

  if (!(await tryLoadProCommands(program))) registerProStubs(program);

  return program;
}

/**
 * Make commander report usage errors by throwing rather than exiting.
 *
 * Without this it calls process.exit, which the patch above turns into a bare
 * ProcessExitSignal carrying no explanation; a CommanderError carries the
 * actual message. Applied per run so an injected program gets it too.
 */
function throwOnUsageError(program: Command): Command {
  program.exitOverride();
  for (const command of program.commands) command.exitOverride();
  return program;
}

/** A run that hit its deadline, as distinct from a command that threw. */
class RunTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "RunTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RunTimeoutError(label, timeoutMs)), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface InProcessRunnerOptions {
  version?: string;
  redirectIdleStdout?: boolean;
  /**
   * Command-tree factory, called once per run. Defaults to the real Ix tree;
   * tests substitute a small one to exercise the capture machinery without a
   * backend.
   */
  createProgram?: (version: string) => Command | Promise<Command>;
  /** Output cap for a single run. Defaults to {@link MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /**
   * How long an abandoned command keeps {@link liveOrphans} membership before
   * it is dropped regardless. Defaults to as long again as the command was
   * given. Tests shorten it; nothing else should need to.
   */
  orphanGraceMs?: number;
  /**
   * How long a command aborted at its timeout may take to settle before it is
   * left running as an orphan. Defaults to {@link ABORT_SETTLE_MS}.
   */
  abortSettleMs?: number;
}

/**
 * Undo the process-lifetime state a finished command left behind.
 *
 * Every one of these was released by process exit when a command *was* a
 * process. In a server that never exits they are leaks, and each of them makes
 * the next tool call answer from something stale rather than fail loudly.
 */
function invalidateAfter(args: string[], failed = false): void {
  // A failed read is often "no workspace here"; whatever the user does next
  // (map, cd, register) should be looked up fresh rather than answered from
  // the scope that just failed.
  if (failed || SCOPE_CHANGING_COMMANDS.has(args[0] ?? "")) resetReadScope();
}

/**
 * Give up the single-flight locks this command took.
 *
 * `ix map` takes its lock and never releases it, relying on process exit. Held
 * by a long-lived server the lock names the server's own live PID, so it never
 * reads as stale: every later ix_map coalesces into an empty success while the
 * graph goes unrefreshed, and the user's own editor-hook `ix map` is blocked
 * for the same 20 minutes.
 *
 * Scoped to this run, which is the whole point. Releasing everything held was
 * wrong in both directions — it took the lock of a map still running, and
 * holding it back to avoid that then stranded the lock of a map that had
 * finished. Ownership makes the question local: this command is over, so its
 * own locks go, and nobody else's are touched.
 */
function releaseLocksOf(run: ActiveRun): void {
  releaseLocksOwnedBy(run);
}

/**
 * Replace the CLI's fatal error handlers for the lifetime of the server.
 *
 * `run-cli.ts` installs `unhandledRejection`/`uncaughtException` handlers whose
 * every path ends in `process.exit(1)`. That is right for one command in one
 * process and fatal for a server: a stray rejection from any command's
 * fire-and-forget work would either exit outright, or — once the in-process
 * capture is installed — throw ProcessExitSignal out of the handler, which
 * becomes an uncaughtException, which throws again from inside the fatal
 * handler and aborts Node. Either way the client loses the server and all its
 * tools mid-session over an error that belonged to one tool call.
 */
export function installServerErrorHandlers(): void {
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  const report = (label: string) => (error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    pristineStderrWrite(`[ix mcp] ${label}: ${detail}\n`);
  };
  process.on("uncaughtException", report("uncaught exception"));
  process.on("unhandledRejection", report("unhandled rejection"));
}

async function executeInProcess(
  args: string[],
  timeoutMs: number,
  version: string,
  createProgram: (version: string) => Command | Promise<Command>,
  maxBytes: number,
  orphanGraceMs?: number,
  abortSettleMs: number = ABORT_SETTLE_MS,
): Promise<IxRunResult> {
  const program = throwOnUsageError(await createProgram(version));
  // Resolution notices wait in module state for the command's printJson. A
  // command that queued some and then failed before printing (a backend error
  // or a timeout after its target resolved) would otherwise hand them to the
  // next json call, attached to a different command's answer.
  resetResolutionNotices();
  const run: ActiveRun = {
    stdout: [],
    stderr: [],
    bytes: 0,
    maxBytes,
    truncated: false,
    closed: false,
  };

  const callerExitCode = process.exitCode;
  process.exitCode = undefined;
  setActiveRun(run);
  // Tell the command who is reading, so its hints name tools and arguments
  // rather than CLI flags (see cli/next-step.ts). Scoped to the run: a command
  // that outlives its timeout and prints afterwards writes into a closed run,
  // whose output is dropped, so the restore cannot mislabel anything shown.
  const callerSurface = process.env[IX_CALLER_ENV];
  process.env[IX_CALLER_ENV] = "mcp";

  // Decided before the command starts: an orphan already in flight can write
  // process.exitCode at any point during this run, and there is no way to tell
  // its write from this command's own.
  const exitCodeIsOurs = liveOrphans.size === 0;

  let failure: string | null = null;
  let commandExitCode: number | string | undefined;

  // Aborted at the deadline. Every client the command builds and every child it
  // spawns takes this signal, so a timeout closes the backend connections
  // rather than leaving the command running behind the next tool call.
  const abort = new AbortController();
  const work = runContext.run(run, () =>
    runWithSignal(abort.signal, () => program.parseAsync(args, { from: "user" })));
  // Settles either way and never rejects, so it can be watched without adding a
  // second rejection handler to `work`.
  let commandSettled = false;
  const finished = work.then(
    () => {
      commandSettled = true;
    },
    () => {
      commandSettled = true;
    },
  );

  try {
    await withTimeout(work, timeoutMs, args[0] ?? "ix");
  } catch (error) {
    if (error instanceof ProcessExitSignal) {
      // An explicit exit; the command already explained itself on stdout/stderr.
      if (error.code !== 0) commandExitCode = error.code;
    } else if (error instanceof CommanderError) {
      // exitOverride fires for `--help` and `--version` too, which are successes.
      if (error.exitCode !== 0) failure = error.message;
    } else {
      failure = error instanceof Error ? error.message : String(error);
      if (error instanceof RunTimeoutError) {
        // Stop the work, then give it a bounded moment to unwind, so the normal
        // outcome is a settled command and no orphan. Its output and exit code
        // in that moment are still this run's: the run is not closed yet.
        abort.abort(error);
        let settleTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          finished,
          new Promise<void>((resolve) => { settleTimer = setTimeout(resolve, abortSettleMs); }),
        ]);
        clearTimeout(settleTimer);
      }
    }
  } finally {
    commandExitCode = commandExitCode ?? (exitCodeIsOurs ? process.exitCode : undefined);
    process.exitCode = callerExitCode;
    if (callerSurface === undefined) delete process.env[IX_CALLER_ENV];
    else process.env[IX_CALLER_ENV] = callerSurface;
    if (failure !== null) {
      if (run.truncated) {
        // appendChunk is a no-op once the cap has fired, but *why* the command
        // threw is the one thing an operator still needs — otherwise a crash is
        // reported as nothing but "output exceeded N bytes". Keep a bounded copy.
        run.stderr.push(`\n[ix mcp] command failed: ${failure.slice(0, FAILURE_DETAIL_CHARS)}\n`);
      } else {
        appendChunk(run, "stderr", failure);
      }
    }
    run.closed = true;
    setActiveRun(null);

    if (commandSettled) {
      invalidateAfter(args, failure !== null || (commandExitCode !== undefined && commandExitCode !== 0));
      releaseLocksOf(run);
    } else {
      liveOrphans.add(finished);

      // A command that never settles at all — a hung fetch, or a rejection that
      // used to end the process and is now only logged — would otherwise hold
      // this entry forever, and exit codes would stay distrusted, so *every*
      // later failure would report ok. The wait is bounded to as long again as
      // the command was allowed to run. Locks are not keyed off this set at all
      // any more, so the bound says nothing about them: a command that never
      // settles keeps the lock it is still using until it ages out.
      //
      // The cost of that bound is real and lands on someone else: past the
      // grace this command's late `process.exitCode` is charged to whichever
      // call is running by then, which is #400's original symptom in delayed
      // form. Bounded-open beats permanently-open, so the trade stands — but it
      // is a trade, not a free win.
      //
      // The grace drops the distrust and invalidates, and nothing else. It must
      // not release the lock: the command is by definition *still running*
      // there, and its lock is still doing its job. Scope invalidation is
      // idempotent, so running it here as well as on settle costs nothing and
      // covers the command that never settles at all — which would otherwise
      // leave the pre-map scope pinned with nothing left to invalidate it.
      const grace = setTimeout(() => {
        liveOrphans.delete(finished);
        invalidateAfter(args);
      }, orphanGraceMs ?? Math.max(timeoutMs, DEFAULT_TIMEOUT_MS));
      grace.unref?.();

      void finished.then(() => {
        liveOrphans.delete(finished);
        clearTimeout(grace);
        // On settle the command really is over, however long it overran, so its
        // locks go now.
        invalidateAfter(args);
        releaseLocksOf(run);
      });
    }
  }

  // While an orphan made the exit code untrustworthy, a command that printed
  // nothing on stdout and something on stderr failed: success always prints
  // its answer. Without this, such a failure came back ok with empty output,
  // which the server then turned into `{}`.
  const silentFailure = !exitCodeIsOurs && commandExitCode === undefined &&
    run.stdout.join("").trim() === "" && run.stderr.join("").trim() !== "";
  const ok = !run.truncated && failure === null && !silentFailure &&
    (commandExitCode === undefined || commandExitCode === 0);
  return {
    ok,
    stdout: run.stdout.join(""),
    stderr: run.stderr.join(""),
  };
}

/**
 * Run Ix commands inside this process instead of spawning the CLI per call.
 *
 * Booting `main.js` costs ~0.58s before any query runs, which a tool-calling
 * agent pays on every hop of a `locate → callers → read` chain. Running the
 * same command tree here removes that entirely and lets `cli/resolve.ts`'s
 * per-cwd scope cache survive between calls — but only between *reads*: see
 * {@link invalidateAfter} for the state whose sole invalidation used to be the
 * process ending, and which is therefore reset per command here.
 *
 * Runs are serialized. Commands report failure through `process.exitCode` and
 * print through `process.stdout`, both of which are process-wide, so two
 * commands in flight together would cross their output and their exit status.
 * The queue costs parallelism on hosts that batch tool calls and still comes
 * out ahead of per-call process boot; `IX_MCP_SUBPROCESS=1` restores the old
 * isolated behaviour for anything pathological.
 */
export function createInProcessRunner(options: InProcessRunnerOptions = {}): IxRunner {
  installCapture({ redirectIdleStdout: options.redirectIdleStdout });
  const version = options.version ?? "0.0.0";
  const createProgram = options.createProgram ?? buildProgram;
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const orphanGraceMs = options.orphanGraceMs;
  const abortSettleMs = options.abortSettleMs;

  let queue: Promise<unknown> = Promise.resolve();

  return (args, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const result = queue.then(() =>
      executeInProcess(args, timeoutMs, version, createProgram, maxBytes, orphanGraceMs, abortSettleMs),
    );
    // The chain must survive a rejection, or one failed run would strand every
    // later call behind it. executeInProcess resolves rather than throws for
    // command failures, so this only catches genuine runner faults.
    queue = result.catch(() => undefined);
    return result;
  };
}

let proProbe: Promise<boolean> | undefined;

/**
 * Whether `@ix/pro` is installed, probed once per process.
 *
 * The MCP server uses this to decide whether to advertise the Pro tools at all,
 * rather than offering tools whose every call answers "requires Ix Pro".
 */
export function detectPro(): Promise<boolean> {
  // tryLoadProCommands now REJECTS for an installed-but-broken Pro. Cache the
  // resolved answer, never the rejection: `??=` would otherwise memoize a
  // rejected promise and every later caller — `ix mcp doctor`, the server's
  // own startup — would inherit it. Not advertising the tools is the correct
  // answer here anyway, and it does not reopen the guard: `buildProgram`
  // awaits the same loader for every in-process call (the default runner —
  // runCurrentIx only spawns a child when IX_MCP_SUBPROCESS=1), so a call
  // that would need Pro still fails.
  return (proProbe ??= tryLoadProCommands(new Command()).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[!!] Ix Pro is installed but failed to initialize: ${message}`);
    return false;
  }));
}

/** Spawn the CLI as a child process — one command per process, fully isolated. */
export async function runCurrentIx(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<IxRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_ENTRYPOINT, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, IX_MCP_CHILD: "1", [IX_CALLER_ENV]: "mcp" },
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

/**
 * The runner `ix mcp` uses unless `IX_MCP_SUBPROCESS=1` asks for the child
 * process path.
 */
export function resolveDefaultRunner(options: InProcessRunnerOptions = {}): IxRunner {
  if (process.env.IX_MCP_SUBPROCESS === "1") return runCurrentIx;
  return createInProcessRunner(options);
}
