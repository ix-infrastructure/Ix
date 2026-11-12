// Copyright 2026 Ix Infrastructure Inc.

import { format } from "node:util";
import { Command } from "commander";

import { registerOssCommands } from "../../register/oss.js";
import { registerOssFallbacks } from "../../register/oss-fallbacks.js";
import { registerProStubs } from "../../register/pro-stubs.js";
import { readConfiguredFormat } from "../../config.js";
import { resetReadScope } from "../../resolve.js";
import {
  bindCommanderErrors,
  commandFormat,
  renderCliError,
  resolveErrorFormat,
  setErrorFormat,
  setErrorFormatFallback,
  throwCommanderExit,
  writeCommanderError,
} from "../../errors.js";
import type { FakeBackend } from "./fake-backend.js";

/** What one `ix` invocation printed, and the code it would have exited with. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  /** Directory to run in, as a user's shell would be. Restored afterwards. */
  cwd?: string;
  /** Extra environment for this run only (`undefined` unsets). Restored afterwards. */
  env?: Record<string, string | undefined>;
}

/** Thrown in place of `process.exit`, so the run unwinds instead of ending the worker. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/**
 * Run `ix <argv>` in process against `backend`, the way `run-cli.ts` runs it,
 * and return what it printed and its exit code.
 *
 * The command tree, the error boundary and the format a failure is answered
 * in are the CLI's own (OSS commands, the no-Pro fallbacks and stubs), so a
 * test reads the same stdout, stderr and exit code a user or an agent plugin
 * would. `backend` is a started `FakeBackend`, or an endpoint URL (for a
 * backend that is down, say); it becomes `IX_ENDPOINT` for the run.
 *
 * Each run starts as a fresh process would: no exit code, no recorded error
 * format, no cached read scope. Process state it changes (stdout/stderr and
 * console, `process.exit`, `process.exitCode`, the cwd, the env) is restored
 * before it returns. Runs must not overlap; vitest runs a file's tests one at
 * a time, which is enough.
 *
 * Prefer this to a per-file `parseAsync` harness and a hand-written client
 * fake: the backend answers come from `FakeBackend`, which follows the real
 * routes, so a response-shape change has one place to land.
 */
export async function runCommand(
  argv: readonly string[],
  backend: FakeBackend | string,
  opts: RunCommandOptions = {},
): Promise<CommandResult> {
  const endpoint = typeof backend === "string" ? backend : backend.url;
  const args = [...argv];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const env = { IX_ENDPOINT: endpoint, ...opts.env };
  const savedEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const savedCwd = process.cwd();
  const savedExitCode = process.exitCode;
  const saved = {
    stdoutWrite: process.stdout.write,
    stderrWrite: process.stderr.write,
    exit: process.exit,
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  const capture = (sink: string[]) =>
    ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown): boolean => {
      sink.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    }) as typeof process.stdout.write;
  // console formats its arguments as Node's does, then writes a line.
  const line = (sink: string[]) => (...a: unknown[]): void => {
    sink.push(`${format(...a)}\n`);
  };

  let exitCode: number | undefined;
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (opts.cwd !== undefined) process.chdir(opts.cwd);
    process.exitCode = undefined;
    resetReadScope();
    setErrorFormat(undefined);
    setErrorFormatFallback(() => resolveErrorFormat(args, process.env, readConfiguredFormat));

    process.stdout.write = capture(stdout);
    process.stderr.write = capture(stderr);
    console.log = line(stdout);
    console.info = line(stdout);
    console.debug = line(stdout);
    console.warn = line(stderr);
    console.error = line(stderr);
    process.exit = ((code?: number | string | null) => {
      throw new ExitSignal(code === undefined || code === null ? 0 : Number(code));
    }) as typeof process.exit;

    // As run-cli.ts builds it, minus the Pro probe: a test never loads Pro.
    const program = new Command()
      .name("ix")
      .exitOverride(throwCommanderExit)
      .configureOutput({ outputError: writeCommanderError });
    program.hook("preAction", (_this, actionCommand) => {
      setErrorFormat(commandFormat(actionCommand));
    });
    registerOssCommands(program);
    await registerOssFallbacks(program);
    registerProStubs(program);
    bindCommanderErrors(program, args);

    try {
      await program.parseAsync(args, { from: "user" });
    } catch (err) {
      if (err instanceof ExitSignal) throw err;
      // The boundary run-cli.ts puts around parseAsync; it always exits.
      renderCliError(err, false, endpoint);
    }
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    exitCode = err.code;
  } finally {
    const finalCode = process.exitCode;
    process.stdout.write = saved.stdoutWrite;
    process.stderr.write = saved.stderrWrite;
    process.exit = saved.exit;
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    console.warn = saved.warn;
    console.error = saved.error;
    setErrorFormat(undefined);
    setErrorFormatFallback(undefined);
    resetReadScope();
    if (process.cwd() !== savedCwd) process.chdir(savedCwd);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.exitCode = savedExitCode;
    exitCode ??= typeof finalCode === "number" ? finalCode : finalCode ? Number(finalCode) : 0;
  }
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
}
