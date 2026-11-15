// Copyright 2026 Ix Infrastructure Inc.

/**
 * Run one `ix` command in-process, the way a plugin sees it, and capture what
 * it printed and how it exited.
 *
 *   const backend = new FakeBackend();
 *   backend.readGraph = SMALL_GRAPH;            // or any ReadGraph
 *   const { stdout, stderr, exitCode } =
 *     await runCommand(["locate", "paint", "--format", "json"], { backend });
 *
 * What it does, per call:
 *
 *   - builds a fresh commander program from `registerOssCommands()` (which
 *     applies `applyOssSetup()`), as `mcp/runner.ts` `buildProgram` does, and
 *     wires it to the error boundary exactly as `run-cli.ts` does: commander
 *     usage errors are thrown (`throwCommanderExit` / `writeCommanderError`),
 *     the `preAction` hook records the command's `--format` for failures,
 *     `bindCommanderErrors` gives each command its usage-error format, and
 *     anything `parseAsync` rejects with goes through `renderCliError`;
 *   - gives the run a scratch IX_HOME whose config.yaml registers one temp
 *     workspace (files from `opts.files`) and points IX_ENDPOINT at the
 *     FakeBackend; cwd is that workspace unless `opts.cwd` says otherwise
 *     (`"unmapped"` is a temp directory no workspace contains);
 *   - strips every ambient `IX_*` variable and points PATH at an empty
 *     directory, then applies `opts.env`, so a developer's IX_FORMAT or
 *     IX_STRICT_TARGETS cannot change a snapshot, and neither can whether
 *     ripgrep or git happens to be installed (see Limits);
 *   - runs the command under its own run signal (`runWithSignal`), as
 *     `mcp/runner.ts` does, so per-run budgets such as the miss probe's start
 *     at zero for every call, as they do in a fresh `ix` process. The signal
 *     is never aborted;
 *   - captures console.*, process.stdout.write and process.stderr.write,
 *     turns process.exit() into a throw, and reads process.exitCode;
 *   - restores every one of those globals, plus env, cwd, chalk's colour level
 *     and the TTY flags, in a `finally`, and resets the CLI's per-process
 *     memos before and after so one run cannot leak into the next.
 *
 * Limits (what this is NOT):
 *
 *   - No Pro. `tryLoadProCommands` is not called and no Pro stubs are
 *     registered, so only OSS commands exist. The plugin-facing contract under
 *     test is the OSS one.
 *   - Not a child process. `main.ts`'s Node-version check, the compile cache,
 *     the lazy command table (`planStartup`), the update check and the
 *     `unhandledRejection` / `uncaughtException` handlers are not exercised.
 *     A command that leaves work running after its action resolves can still
 *     write after this returns; that output is lost, not attributed.
 *   - No external tools by default. PATH is an empty directory, so `rg` and
 *     `git` are not found and commands take their documented no-ripgrep paths
 *     (the miss probe and the callers text fallback answer nothing; the
 *     not-mapped hint names no git root). That is the same on every OS, which
 *     is the point; pass `env: { PATH: process.env.PATH! }` to run with them.
 *   - Output is not a TTY and chalk is at level 0, which is what a plugin
 *     capturing the stream gets. Colour and progress-bar output are not covered.
 *   - Runs are not concurrency-safe: they patch process globals. Call it from
 *     one test at a time (vitest runs a file's tests sequentially by default).
 *   - The help text (`ix --help`) is commander's default, not `buildHelpText`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { format as formatArgs } from "node:util";
import chalk from "chalk";
import { Command } from "commander";

import { registerOssCommands } from "../../register/oss.js";
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
import { readConfiguredFormat, resetConfigMemo, saveConfig } from "../../config.js";
import { resetReadScope } from "../../resolve.js";
import { resetResolutionNotices } from "../../format.js";
import { resetGraphHealthMemo } from "../../graph-health.js";
import { resetWorkspaceIdMemosForTests } from "../../bootstrap.js";
import { runWithSignal } from "../../../client/run-signal.js";
import type { FakeBackend } from "./fake-backend.js";

/** The workspace id registered in the scratch config. */
export const RUN_WORKSPACE_ID = "ws000001";

export interface RunCommandOptions {
  /** The backend IX_ENDPOINT points at. Started here if it is not running; the caller stops it. */
  backend: FakeBackend;
  /** Extra environment for this run, applied after ambient IX_* is stripped. */
  env?: Record<string, string>;
  /**
   * Files to write into the workspace, by workspace-relative path. They should
   * match what the backend's graph claims, for commands that read source.
   */
  files?: Record<string, string>;
  /** Where the command runs: the workspace (default) or an unmapped directory. */
  cwd?: "workspace" | "unmapped";
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The temp root every path in the run lives under, for normalising. */
  tempRoot: string;
}

/** Thrown in place of process.exit() while a run owns the process. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const CONSOLE_METHODS = [
  ["log", "stdout"],
  ["info", "stdout"],
  ["debug", "stdout"],
  ["warn", "stderr"],
  ["error", "stderr"],
] as const;

function resetCliMemos(): void {
  resetConfigMemo();
  resetReadScope();
  resetResolutionNotices();
  resetGraphHealthMemo();
  resetWorkspaceIdMemosForTests();
  setErrorFormat(undefined);
  setErrorFormatFallback(undefined);
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("ix")
    .version("0.0.0-test")
    .exitOverride(throwCommanderExit)
    .configureOutput({ outputError: writeCommanderError });
  program.hook("preAction", (_thisCommand, actionCommand) => {
    setErrorFormat(commandFormat(actionCommand));
  });
  registerOssCommands(program);
  return program;
}

export async function runCommand(argv: string[], opts: RunCommandOptions): Promise<RunCommandResult> {
  const { backend } = opts;
  const endpoint = backend.url ?? await backend.start();

  const tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ix-run-command-")));
  const home = path.join(tempRoot, "home");
  const workspace = path.join(tempRoot, "repo");
  const unmapped = path.join(tempRoot, "elsewhere");
  const emptyBin = path.join(tempRoot, "bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(unmapped, { recursive: true });
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  // ── Save every global the run touches ──────────────────────────────────
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const savedExitCode = process.exitCode;
  const savedExit = process.exit;
  const savedStdoutWrite = process.stdout.write;
  const savedStderrWrite = process.stderr.write;
  const savedConsole = CONSOLE_METHODS.map(([m]) => [m, console[m]] as const);
  const savedChalkLevel = chalk.level;
  const savedStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const savedStderrTTY = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("IX_")) delete process.env[key];
    }
    process.env.IX_HOME = home;
    process.env.IX_ENDPOINT = endpoint;
    process.env.PATH = emptyBin;
    for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;

    resetCliMemos();
    saveConfig({
      endpoint,
      // The built-in default; every snapshot passes --format anyway.
      format: "text",
      workspaces: [{ workspace_id: RUN_WORKSPACE_ID, workspace_name: "repo", root_path: workspace, default: true }],
    });
    resetConfigMemo();

    process.chdir(opts.cwd === "unmapped" ? unmapped : workspace);
    process.exitCode = undefined;
    chalk.level = 0;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true, writable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true, writable: true });

    const sink = (into: string[]) => ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      into.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") (done as () => void)();
      return true;
    });
    process.stdout.write = sink(out) as typeof process.stdout.write;
    process.stderr.write = sink(err) as typeof process.stderr.write;
    for (const [method, stream] of CONSOLE_METHODS) {
      const into = stream === "stdout" ? out : err;
      console[method] = (...parts: unknown[]): void => { into.push(`${formatArgs(...parts)}\n`); };
    }
    process.exit = ((code?: number) => {
      throw new ExitSignal(code ?? 0);
    }) as typeof process.exit;

    // What run-cli.ts sets before parsing: until a command is parsed, a
    // failure is answered in the typed --format, IX_FORMAT, or config.format.
    setErrorFormatFallback(() => resolveErrorFormat(argv, process.env, readConfiguredFormat));

    const program = buildProgram();
    bindCommanderErrors(program, argv);
    try {
      try {
        const signal = new AbortController().signal;
        await runWithSignal(signal, () => program.parseAsync(argv, { from: "user" }));
      } catch (thrown) {
        if (thrown instanceof ExitSignal) throw thrown;
        // run-cli.ts's boundary. It always ends in process.exit().
        renderCliError(thrown, false, endpoint);
      }
    } catch (thrown) {
      if (!(thrown instanceof ExitSignal)) throw thrown;
      exitCode = thrown.code;
    }
    if (exitCode === undefined) exitCode = Number(process.exitCode ?? 0);
  } finally {
    process.exit = savedExit;
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    for (const [method, original] of savedConsole) console[method] = original;
    if (savedStdoutTTY) Object.defineProperty(process.stdout, "isTTY", savedStdoutTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (savedStderrTTY) Object.defineProperty(process.stderr, "isTTY", savedStderrTTY);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
    chalk.level = savedChalkLevel;
    process.exitCode = savedExitCode;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetCliMemos();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  return { stdout: out.join(""), stderr: err.join(""), exitCode, tempRoot };
}
