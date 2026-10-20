// Copyright 2026 Ix Infrastructure Inc.

/**
 * Running CLI commands inside a long-lived process: the capture of their
 * output, exit and locks that a process boundary used to provide.
 *
 * Shared by the MCP server's in-process runner (`mcp/runner.ts`) and the warm
 * daemon (`cli/daemon/run.ts`). Runs are serialized by both: this module holds
 * one active run at a time, because `process.exitCode`, `process.stdout` and
 * the rest are process-wide.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

import { setLockOwnerResolver } from "./single-flight.js";

/**
 * The write functions as they were before any capture patch. Captured at module
 * load so both the patch (which forwards to them when idle) and the MCP
 * transport (which must never be captured) share one pristine reference.
 */
export const pristineStdoutWrite = process.stdout.write.bind(process.stdout);
export const pristineStderrWrite = process.stderr.write.bind(process.stderr);
export const pristineExit = process.exit.bind(process);

/**
 * Cap on a single command's captured output. The subprocess runner got this
 * for free from `execFile`'s `maxBuffer`; in-process nothing bounds it, and an
 * unbounded `ix text` on a large repo would otherwise grow the long-lived
 * server's heap instead of a short-lived child's.
 */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface ActiveRun {
  stdout: string[];
  stderr: string[];
  /**
   * Set by a caller that needs the exact bytes rather than text: every chunk,
   * stdout and stderr alike, in the order it was written. `stdout`/`stderr`
   * then stay empty. The daemon replays this to the caller's own descriptors,
   * so output that is not UTF-8 survives and a caller reading both streams
   * from one pipe sees them interleaved as the command wrote them.
   */
  raw?: Array<["stdout" | "stderr", Buffer]>;
  /**
   * Called with the code when the command calls `process.exit()` during this
   * run, before the exit is turned into a {@link ProcessExitSignal}.
   */
  onExit?: (code: number | string | null | undefined) => void;
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

/** Hand the process globals to `run`, or take them back with null. */
export function setActiveRun(run: ActiveRun | null): void {
  activeRun = run;
}

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
export const runContext = new AsyncLocalStorage<ActiveRun>();

/**
 * Commands abandoned at their timeout that are still running.
 *
 * A timed-out command is aborted (its clients and children take the run's
 * signal) and given a moment to unwind, so this is normally empty. What still
 * lands here is work the signal does not reach -- a synchronous loop, a call
 * outside the factory -- which keeps writing to the process globals after the
 * queue has moved on.
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
 *
 * Membership is bounded by a grace timer as well as by the command settling,
 * because distrust is not free: while it holds, a genuinely failing command
 * reports success. An entry that could never be removed would make that
 * permanent.
 */
export const liveOrphans = new Set<Promise<void>>();

/** The run a write belongs to: its own context first, else whoever holds the globals. */
export function resolveRun(): ActiveRun | null {
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
export class ProcessExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
    this.name = "ProcessExitSignal";
  }
}

export function appendChunk(run: ActiveRun, sink: "stdout" | "stderr", chunk: unknown, encoding?: string): void {
  if (run.truncated) return;

  if (run.raw) {
    const bytes = typeof chunk === "string"
      ? Buffer.from(chunk, (encoding as BufferEncoding) ?? "utf8")
      : Buffer.from(chunk as Uint8Array);
    run.bytes += bytes.length;
    if (run.bytes > run.maxBytes) {
      run.truncated = true;
      return;
    }
    run.raw.push([sink, bytes]);
    return;
  }

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
export function installCapture(options: { redirectIdleStdout?: boolean } = {}): void {
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
    const run = resolveRun();
    if (!run) return pristineExit(code);
    run.onExit?.(code);
    throw new ProcessExitSignal(code ?? 0);
  }) as typeof process.exit;

  // Single-flight locks are taken deep inside a command, so the command has to
  // be identifiable from there. Deliberately the async context alone, without
  // resolveRun's fallback to activeRun: for output that fallback only ever
  // narrows the damage, but an owner guessed wrong here means a *different*
  // command's settle deletes a lock that is still in use. Unattributed is the
  // safe direction — the lock outlives its command and ages out — so a lock
  // taken outside any run context simply gets no owner.
  setLockOwnerResolver(() => runContext.getStore() ?? null);
}
