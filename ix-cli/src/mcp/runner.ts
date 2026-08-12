import { execFile } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { Command, CommanderError } from "commander";

import { registerOssCommands, registerProStubs } from "../cli/register/oss.js";
import { tryLoadProCommands } from "../cli/register/pro-loader.js";
import { resetReadScope } from "../cli/resolve.js";
import { releaseHeldLocks } from "../cli/single-flight.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = fileURLToPath(new URL("../cli/main.js", import.meta.url));

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Cap on a single command's captured output. The subprocess runner got this
 * for free from `execFile`'s `maxBuffer`; in-process nothing bounds it, and an
 * unbounded `ix text` on a large repo would otherwise grow the long-lived
 * server's heap instead of a short-lived child's.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface IxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type IxRunner = (args: string[], timeoutMs?: number) => Promise<IxRunResult>;

/**
 * The write functions as they were before any capture patch. Captured at module
 * load so both the patch (which forwards to them when idle) and the MCP
 * transport (which must never be captured) share one pristine reference.
 */
const pristineStdoutWrite = process.stdout.write.bind(process.stdout);
const pristineStderrWrite = process.stderr.write.bind(process.stderr);
const pristineExit = process.exit.bind(process);

interface ActiveRun {
  stdout: string[];
  stderr: string[];
  bytes: number;
  maxBytes: number;
  truncated: boolean;
  /**
   * Set once the result has been returned. Output arriving afterwards is from a
   * command that outlived its timeout and is dropped, so a hung command cannot
   * grow a buffer nobody will ever read.
   */
  closed: boolean;
}

/**
 * The run currently owning the process globals, or null when idle.
 *
 * One slot, because runs are serialized. Running them concurrently would need
 * every global they touch to be context-local, and `process.exitCode` — the
 * signal commands use to report failure — is a non-configurable property on
 * Node 22, so it cannot be. Isolating output per async context while the exit
 * code stayed global would attribute a call's output to the right result and
 * its success to the wrong one. See `createInProcessRunner`.
 *
 * A timeout breaks that serialization — the queue advances while the abandoned
 * command runs on — which is what {@link liveOrphans} exists to contain.
 */
let activeRun: ActiveRun | null = null;
let captureInstalled = false;
let redirectIdleStdout = false;

/**
 * Which run a write belongs to, tracked so a command that outlived its timeout
 * still resolves to its own (already-returned) run. The queue advances on
 * timeout, so without this a timed-out `ix map` would dribble progress into
 * whichever tool call is running by then. Attribution falls back to
 * {@link activeRun} wherever the context does not propagate, so this can only
 * narrow the damage, never widen it.
 */
const runContext = new AsyncLocalStorage<ActiveRun>();

/**
 * Commands abandoned at their timeout that are still running.
 *
 * Nothing cancels a timed-out command — no Ix command takes an abort signal —
 * so it keeps writing to the process globals after the queue has moved on.
 * Output is attributed per run through {@link runContext}; `process.exitCode`
 * cannot be, because it is a non-configurable accessor and so cannot be made
 * context-local (verified on Node 26: `Object.defineProperty` throws).
 *
 * What is knowable is when it is untrustworthy. While an orphan is alive, its
 * late `process.exitCode = 1` — the failure shape most commands use — is
 * indistinguishable from the running command's own, and reading it reported a
 * *successful* tool call as failed, with its real answer buried inside an
 * `error` string. A run started while this set is non-empty therefore ignores
 * `process.exitCode` and judges only by what the command threw.
 */
const liveOrphans = new Set<Promise<void>>();

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

/** The run a write belongs to: its own context first, else whoever holds the globals. */
function resolveRun(): ActiveRun | null {
  return runContext.getStore() ?? activeRun;
}

/** Which buffer each console method feeds, mirroring Node's own routing. */
const CONSOLE_SINKS = [
  ["log", "stdout"],
  ["info", "stdout"],
  ["debug", "stdout"],
  ["warn", "stderr"],
  ["error", "stderr"],
] as const satisfies ReadonlyArray<readonly [keyof Console, "stdout" | "stderr"]>;

/** Thrown in place of a real `process.exit()` while a run owns the globals. */
class ProcessExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitSignal";
  }
}

function appendChunk(run: ActiveRun, sink: "stdout" | "stderr", chunk: unknown, encoding?: string): void {
  if (run.truncated) return;

  const text =
    typeof chunk === "string"
      ? chunk
      : Buffer.from(chunk as Uint8Array).toString((encoding as BufferEncoding) ?? "utf8");

  run.bytes += Buffer.byteLength(text);
  if (run.bytes > run.maxBytes) {
    run.truncated = true;
    run.stderr.push(`\n[ix mcp] output exceeded ${run.maxBytes} bytes and was truncated\n`);
    return;
  }
  run[sink].push(text);
}

/**
 * Replace a stream's `write` with one that diverts into the active run.
 *
 * Covers direct stream writes such as `cli/stderr.ts`, and — in a plain Node
 * process — `console.log`, which bottoms out here. The console methods are
 * patched separately because that is not true everywhere: a harness that
 * substitutes its own `console` (vitest does) never reaches this.
 */
function patchWrite(
  stream: NodeJS.WriteStream,
  sink: "stdout" | "stderr",
  idleWrite: (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean,
): void {
  stream.write = function patched(chunk: unknown, encodingOrCb?: unknown, maybeCb?: unknown): boolean {
    const run = resolveRun();
    if (!run) return idleWrite(chunk, encodingOrCb, maybeCb);

    const callback = typeof encodingOrCb === "function" ? encodingOrCb : maybeCb;
    const encoding = typeof encodingOrCb === "string" ? encodingOrCb : undefined;
    if (!run.closed) appendChunk(run, sink, chunk, encoding);
    if (typeof callback === "function") (callback as () => void)();
    return true;
  } as typeof stream.write;
}

/**
 * Take ownership of the process globals that CLI commands write through.
 *
 * Idempotent, and transparent while no run is active: writes fall through to
 * the pristine stream functions unless `redirectIdleStdout` is set.
 */
function installCapture(options: { redirectIdleStdout?: boolean } = {}): void {
  redirectIdleStdout = redirectIdleStdout || options.redirectIdleStdout === true;
  if (captureInstalled) return;
  captureInstalled = true;

  // When serving MCP over stdio, fd 1 carries the JSON-RPC framing and nothing
  // else — the transport gets its own handle via createProtocolStdout. Any
  // stdout write that cannot be attributed to a run is therefore a stray one,
  // and letting it reach fd 1 would desync the protocol for the rest of the
  // session; it goes to stderr instead, where it is merely noise.
  patchWrite(process.stdout, "stdout", (chunk, encoding, cb) =>
    redirectIdleStdout
      ? (pristineStderrWrite as Function)(chunk, encoding, cb)
      : (pristineStdoutWrite as Function)(chunk, encoding, cb),
  );
  patchWrite(process.stderr, "stderr", (chunk, encoding, cb) =>
    (pristineStderrWrite as Function)(chunk, encoding, cb),
  );

  for (const [method, sink] of CONSOLE_SINKS) {
    const original = console[method].bind(console);
    console[method] = (...parts: unknown[]): void => {
      const run = resolveRun();
      if (!run) return original(...parts);
      if (!run.closed) appendChunk(run, sink, `${format(...parts)}\n`);
    };
  }

  // `ix status` and `ix text` call `process.exit(1)` on their error paths. In a
  // child process that ends one command; in-process it would take the whole MCP
  // server down mid-session, so it becomes a throw the runner turns into a
  // failed tool result.
  process.exit = ((code?: number) => {
    if (!resolveRun()) return pristineExit(code);
    throw new ProcessExitSignal(code ?? 0);
  }) as typeof process.exit;
}

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

function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
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
}

/**
 * Undo the process-lifetime state a finished command left behind.
 *
 * Every one of these was released by process exit when a command *was* a
 * process. In a server that never exits they are leaks, and each of them makes
 * the next tool call answer from something stale rather than fail loudly.
 */
function afterCommand(args: string[]): void {
  if (SCOPE_CHANGING_COMMANDS.has(args[0] ?? "")) resetReadScope();

  // `ix map` takes a single-flight lock it never releases itself, relying on
  // process exit. Held by a long-lived server, the lock file names the server's
  // own live PID — so it never reads as stale — and every later ix_map coalesces
  // and returns an empty success while the graph goes unrefreshed. It also
  // blocks the user's own editor-hook `ix map` for the same 20 minutes. Skipped
  // while an orphan is in flight: a map still running is entitled to its lock.
  if (liveOrphans.size === 0) releaseHeldLocks();
}

/**
 * Replace the CLI's fatal error handlers for the lifetime of the server.
 *
 * `main.ts` installs `unhandledRejection`/`uncaughtException` handlers whose
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
): Promise<IxRunResult> {
  const program = throwOnUsageError(await createProgram(version));
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
  activeRun = run;

  // Decided before the command starts: an orphan already in flight can write
  // process.exitCode at any point during this run, and there is no way to tell
  // its write from this command's own.
  const exitCodeIsOurs = liveOrphans.size === 0;

  let failure: string | null = null;
  let commandExitCode: number | string | undefined;

  const work = runContext.run(run, () => program.parseAsync(args, { from: "user" }));
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
    }
  } finally {
    commandExitCode = commandExitCode ?? (exitCodeIsOurs ? process.exitCode : undefined);
    process.exitCode = callerExitCode;
    run.closed = true;
    activeRun = null;

    if (commandSettled) {
      afterCommand(args);
    } else {
      liveOrphans.add(finished);
      void finished.then(() => {
        liveOrphans.delete(finished);
        afterCommand(args);
      });
    }
  }

  const ok = failure === null && (commandExitCode === undefined || commandExitCode === 0);
  return {
    ok,
    stdout: run.stdout.join(""),
    stderr: run.stderr.join("") + (failure ?? ""),
  };
}

/**
 * Run Ix commands inside this process instead of spawning the CLI per call.
 *
 * Booting `main.js` costs ~0.58s before any query runs, which a tool-calling
 * agent pays on every hop of a `locate → callers → read` chain. Running the
 * same command tree here removes that entirely and lets `cli/resolve.ts`'s
 * per-cwd scope cache survive between calls — but only between *reads*: see
 * {@link afterCommand} for the state whose sole invalidation used to be the
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

  let queue: Promise<unknown> = Promise.resolve();

  return (args, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const result = queue.then(() =>
      executeInProcess(args, timeoutMs, version, createProgram, maxBytes),
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
  return (proProbe ??= tryLoadProCommands(new Command()));
}

/** Spawn the CLI as a child process — one command per process, fully isolated. */
export async function runCurrentIx(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<IxRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_ENTRYPOINT, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, IX_MCP_CHILD: "1" },
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
