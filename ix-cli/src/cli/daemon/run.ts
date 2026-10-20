// Copyright 2026 Ix Infrastructure Inc.

/**
 * One request to the warm daemon, run as the call would have run on its own.
 *
 * The answer must be byte-for-byte the cold path's: same stdout, same stderr,
 * same exit code. So a run gets what a fresh process would have had -- the
 * caller's cwd, environment, argv and stdin -- and the module state a fresh
 * process starts without is reset before it starts. It then goes through the
 * CLI's own code (`cli-invocation.ts`, or the hook's fast path as `main.ts`
 * dispatches it), not a copy of it.
 *
 * Where the daemon cannot vouch for the answer, it does not give one: the run
 * comes back as `fallback` and the client runs the call itself. That covers
 * output over the cap, an exit code an earlier, still-running command may have
 * written, an error that escaped the command, and a call that would load more
 * than the one command (Pro installed, IX_LOAD_ALL_COMMANDS).
 */

import { fileURLToPath } from "node:url";

import { beginInvocation } from "../../client/correlation.js";
import { runWithSignal } from "../../client/run-signal.js";
import { prepareInvocation, runInvocation } from "../cli-invocation.js";
import { detectRequestedFormat, setErrorFormat } from "../errors.js";
import { resetResolutionNotices, setPrettyJson } from "../format.js";
import { resetGraphHealthMemo } from "../graph-health.js";
import {
  type ActiveRun,
  installCapture,
  liveOrphans,
  MAX_OUTPUT_BYTES,
  ProcessExitSignal,
  runContext,
  setActiveRun,
} from "../in-process.js";
import { setOutputShape } from "../output-shape.js";
import { planStartup } from "../register/oss-table.js";
import { resetReadScope } from "../resolve.js";
import { releaseLocksOwnedBy } from "../single-flight.js";
import { feedStdin } from "../stdin-source.js";
import { confinement, confinementAllows, startupKey, type OutputChunk, type RunRequest } from "./protocol.js";

/** The entry point a cold call runs as, when the request does not say. */
const CLI_MAIN = fileURLToPath(new URL("../main.js", import.meta.url));

/**
 * How long a command that called `process.exit()` gets to unwind. In its own
 * process nothing would run after the exit; here the throw that stands in for
 * it still has to climb out, which normally takes microseconds.
 */
const EXIT_SETTLE_MS = 1_000;

export type RunOutcome =
  | { kind: "ok"; exitCode: number; out: OutputChunk[] }
  | { kind: "fallback"; reason: string };

/** Not the one-command registry: the daemon does not answer these. */
class NotServedHere extends Error {}

/** The run in progress, so an error escaping it can be charged to it. */
let current: { run: ActiveRun; poison: (reason: string) => void } | null = null;

/**
 * Give up on the run in progress: its client is gone, so nobody will read the
 * answer. In its own process the call would have died with its caller. The
 * run's signal is aborted, which stops its backend requests and children, and
 * tells the hook not to save state for a report nobody saw.
 */
export function abandonCurrent(reason: string): void {
  current?.poison(reason);
}

/**
 * An uncaught exception or unhandled rejection while a run is in progress.
 * In its own process that ends the call with an error; here the run is
 * abandoned and the client runs the call itself, which reproduces that exactly.
 * True when a run took it.
 */
export function chargeEscapedError(): boolean {
  if (!current) return false;
  current.poison("uncaught");
  return true;
}

/** What the exit status of a process that ended with `code` would be. */
function exitStatus(code: unknown): number {
  if (code === undefined || code === null || code === "") return 0;
  const n = Number(code);
  if (!Number.isInteger(n)) return 1;
  return n & 0xff;
}

/** Make `process.env` exactly `next`, in place, so getenv(3) sees it too. */
function replaceEnv(next: Record<string, string>): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(next, key)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (process.env[key] !== value) process.env[key] = value;
  }
}

function snapshotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * The environment the last run had. `cli/resolve.ts` keeps the read scope per
 * cwd between runs, as `ix mcp` does; a run with a different environment
 * (another IX_ENDPOINT, another token) may resolve differently, so it starts
 * without one.
 */
let lastEnvKey: string | undefined;

function envKey(env: Record<string, string>): string {
  return JSON.stringify(Object.keys(env).sort().map((k) => [k, env[k]]));
}

/** What this daemon started with; see `startupKey`. */
const startedWith = startupKey(process.env);

/** Prepare the capture once, before the first run. */
export function prepareRuns(): void {
  installCapture();
}

/** This daemon's own confinement, and whether it may serve at all; see protocol.ts. */
const ownConfinement = confinement();
const confinementOk = confinementAllows(ownConfinement, process.env);

/** The command the request names, as the cold path would run it. */
async function invoke(args: string[], startedAt: number | undefined): Promise<void> {
  // `main.ts` sends this one straight to the hook's own entry, before the CLI.
  if (args[0] === "hook" && args[1] === "claude-post-edit" && !args.some((a) => a === "-h" || a === "--help")) {
    const { parseHookArgs, runHookProcess } = await import("../hook/entry.js");
    // The deadline runs from when the caller started, not from when its turn
    // here came.
    await runHookProcess(parseHookArgs(args.slice(2)), typeof startedAt === "number" ? startedAt : Date.now());
    return;
  }
  // Pro installed, or IX_LOAD_ALL_COMMANDS: the cold path would load every
  // command and Pro with them. Decided before registering anything, so the
  // hand-back costs the caller next to nothing.
  if (planStartup(args).kind !== "command") throw new NotServedHere("registry");
  const { program, lazy } = await prepareInvocation(args);
  if (!lazy) throw new NotServedHere("registry");
  await runInvocation(program, lazy, {
    debug: process.env.IX_DEBUG === "1",
    passThrough: (err) => err instanceof ProcessExitSignal,
  });
}

/** Run one request. Never throws; anything the daemon cannot vouch for is a fallback. */
export async function runRequest(req: RunRequest): Promise<RunOutcome> {
  const args = [...req.argv];
  if (startupKey(req.env) !== startedWith) return { kind: "fallback", reason: "startup-env" };
  // A caller confined differently from this daemon -- a sandbox -- would get
  // the daemon's access, not its own.
  if (!confinementOk || req.confinement !== ownConfinement.key) {
    return { kind: "fallback", reason: "confinement" };
  }
  const saved = {
    cwd: process.cwd(),
    argv: process.argv,
    exitCode: process.exitCode,
    env: snapshotEnv(),
  };

  try {
    process.chdir(req.cwd);
  } catch {
    return { kind: "fallback", reason: "cwd" };
  }
  replaceEnv(req.env);
  process.argv = [saved.argv[0] ?? process.execPath, req.entry ?? CLI_MAIN, ...args];
  feedStdin(req.stdin !== undefined ? Buffer.from(req.stdin, "base64") : Buffer.alloc(0));

  // What a fresh process starts without.
  const key = envKey(req.env);
  if (key !== lastEnvKey) resetReadScope();
  lastEnvKey = key;
  setErrorFormat(detectRequestedFormat(args));
  setPrettyJson(false);
  setOutputShape({});
  resetResolutionNotices();
  // Its disk copy is what a fresh process reads, and another process's
  // `ix reset` clears that copy without telling this one.
  resetGraphHealthMemo();
  beginInvocation();
  process.exitCode = undefined;

  // Decided before the command starts: an earlier command still running can
  // write process.exitCode at any time, and its write is not ours.
  const exitCodeIsOurs = liveOrphans.size === 0;

  const abort = new AbortController();
  let explicitExit: number | undefined;
  let poisoned: string | undefined;
  let wake: () => void = () => {};
  const woken = new Promise<void>((resolve) => { wake = resolve; });

  const run: ActiveRun = {
    stdout: [],
    stderr: [],
    raw: [],
    bytes: 0,
    maxBytes: MAX_OUTPUT_BYTES,
    truncated: false,
    closed: false,
    // In its own process the call would end here: nothing it writes later is
    // seen and nothing it does later counts.
    onExit: (code) => {
      if (run.closed) return;
      explicitExit = exitStatus(code ?? process.exitCode);
      run.closed = true;
      abort.abort(new Error("process.exit"));
      wake();
    },
  };
  current = {
    run,
    poison: (reason) => {
      if (run.closed) return;
      poisoned = reason;
      run.closed = true;
      abort.abort(new Error(reason));
      wake();
    },
  };
  setActiveRun(run);

  let failure: unknown;
  let settled = false;
  let status: number | undefined;
  const work = runContext.run(run, () => runWithSignal(abort.signal, () => invoke(args, req.startedAt)));
  const finished = work.then(
    () => { settled = true; },
    (err: unknown) => {
      settled = true;
      if (!(err instanceof ProcessExitSignal)) failure = err;
    },
  );

  try {
    await Promise.race([finished, woken]);
    if (!settled) {
      // Exited or abandoned: give the stand-in throw its moment to climb out.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([finished, new Promise<void>((r) => { timer = setTimeout(r, EXIT_SETTLE_MS); })]);
      clearTimeout(timer);
    }
  } finally {
    const exitCode = process.exitCode;
    run.closed = true;
    setActiveRun(null);
    current = null;
    feedStdin(undefined);
    process.exitCode = saved.exitCode;
    process.argv = saved.argv;
    replaceEnv(saved.env);
    try { process.chdir(saved.cwd); } catch { /* the daemon's own cwd is "/" */ }

    status = explicitExit ?? (exitCodeIsOurs ? exitStatus(exitCode) : undefined);
    if (settled) {
      releaseLocksOwnedBy(run);
      // A failed read is often "no workspace here"; what the caller does next
      // should be looked up fresh, as `ix mcp` does.
      if (status !== 0) resetReadScope();
    } else {
      liveOrphans.add(finished);
      const grace = setTimeout(() => liveOrphans.delete(finished), 30_000);
      grace.unref?.();
      void finished.then(() => {
        liveOrphans.delete(finished);
        clearTimeout(grace);
        resetReadScope();
        releaseLocksOwnedBy(run);
      });
    }
  }

  if (poisoned) return { kind: "fallback", reason: poisoned };
  if (run.truncated) return { kind: "fallback", reason: "too-big" };
  if (failure instanceof NotServedHere) return { kind: "fallback", reason: failure.message };
  if (failure !== undefined) return { kind: "fallback", reason: "runner" };
  if (status === undefined) return { kind: "fallback", reason: "exit-code" };
  if (!settled && explicitExit === undefined) return { kind: "fallback", reason: "unsettled" };
  const out: OutputChunk[] = (run.raw ?? []).map(([sink, bytes]) => [sink === "stdout" ? 1 : 2, bytes.toString("base64")]);
  return { kind: "ok", exitCode: status, out };
}
