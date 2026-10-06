// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { hookTimeoutMs, readStdin, withDeadline } from "./io.js";
import {
  fingerprint, gitDiffHead, gitTopLevel, loadState, parseUnifiedDiff, saveState, statePath,
} from "./session.js";
import type { HookDeps, HookOptions, PostToolUseInput } from "./claude-post-edit.js";

/**
 * The post-edit hook's front door, loaded before -- and instead of -- the
 * CLI: `main.ts` dispatches `ix hook claude-post-edit` here directly.
 *
 * It runs after every hooked tool call, Bash included, because agents edit
 * through Bash scripts as often as through Edit. Most of those calls change
 * nothing new, so the order is cheapest-first:
 *
 * 1. `git diff -U0 HEAD`. Empty: nothing tracked has changed; print nothing.
 * 2. Its fingerprint against the one this session last reported on. Same
 *    diff: nothing new; print nothing.
 * 3. Only now load the graph code (`claude-post-edit.ts`) and ask about the
 *    edited symbols this session has not been told about yet.
 *
 * Steps 1-2 need node's builtins and one git process. Outside a git
 * repository the Edit / Write tool's own patch is the fallback.
 */

export interface EntryDeps extends HookDeps {
  gitTopLevel?: (dir: string) => string | undefined;
  gitDiffHead?: (repoRoot: string) => string;
}

/**
 * One JSON line per hook call, appended to `IX_HOOK_LOG` when it is set: what
 * the call did and why it printed nothing when it did not. Best-effort.
 */
export function appendHookLog(file: string | undefined, record: Record<string, unknown>): void {
  if (!file) return;
  try { fs.appendFileSync(file, `${JSON.stringify(record)}\n`); } catch { /* never fail the hook over its log */ }
}

/** Never throws; undefined means print nothing. */
export async function runPostEditHook(raw: string, opts: HookOptions = {}, deps: EntryDeps = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const logFile = env.IX_HOOK_LOG || undefined;
  const started = Date.now();
  const notes: string[] = [];
  const record: Record<string, unknown> = { ts: new Date().toISOString() };
  const outer = deps.debug;
  const debug = (m: string) => { if (logFile) notes.push(m); outer?.(m); };
  deps = { ...deps, debug };
  let output: string | undefined;
  try {
    output = await runPostEditHookInner(raw, opts, deps, env, record, notes);
    return output;
  } finally {
    if (logFile) {
      appendHookLog(logFile, {
        ...record, ms: Date.now() - started, chars: output?.length ?? 0, notes,
      });
    }
  }
}

async function runPostEditHookInner(
  raw: string, opts: HookOptions, deps: EntryDeps, env: NodeJS.ProcessEnv,
  record: Record<string, unknown>, notes: string[],
): Promise<string | undefined> {
  const debug = deps.debug ?? (() => {});
  try {
    let input: PostToolUseInput;
    try { input = JSON.parse(raw) as PostToolUseInput; } catch { debug("stdin is not JSON"); return undefined; }
    if (!input || typeof input !== "object") return undefined;
    record.session = input.session_id;
    record.tool = input.tool_name;
    const base = input.cwd && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
    const worktree = path.resolve(opts.worktree ?? base);
    const repoRoot = (deps.gitTopLevel ?? gitTopLevel)(worktree);

    if (!repoRoot) {
      const file = statePath(input.session_id, worktree, env);
      const state = loadState(file);
      const heavy = await import("./claude-post-edit.js");
      const outcome = await heavy.reportToolEdit(input, new Set(state.reported), opts, deps);
      record.path = "tool-edit";
      notes.push(...(outcome.notes ?? []));
      if (outcome.reported.length > 0) saveState(file, { ...state, reported: [...state.reported, ...outcome.reported] });
      return outcome.output;
    }

    const diff = (deps.gitDiffHead ?? gitDiffHead)(repoRoot);
    if (!diff.trim()) { record.path = "no_changes"; debug("no tracked changes"); return undefined; }
    const fp = fingerprint(diff);
    const file = statePath(input.session_id, repoRoot, env);
    const state = loadState(file);
    if (state.fingerprint === fp) { record.path = "diff_unchanged"; debug("diff unchanged since last report"); return undefined; }

    const files = parseUnifiedDiff(diff);
    const heavy = await import("./claude-post-edit.js");
    const outcome = await heavy.reportChangedFiles({ repoRoot, files, already: new Set(state.reported) }, opts, deps);
    record.path = outcome.output ? "reported" : "silent";
    record.files = files.length;
    notes.push(...(outcome.notes ?? []));
    saveState(file, {
      // Keep the old fingerprint while edited symbols wait behind the cap, so
      // the next call -- even one that edits nothing -- reports them.
      fingerprint: outcome.complete ? fp : state.fingerprint,
      reported: [...new Set([...state.reported, ...outcome.reported])],
    });
    return outcome.output;
  } catch (err) {
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * The hook's answer, or undefined once `ms` have passed. A call the deadline
 * cuts off never writes its own `IX_HOOK_LOG` line -- the process exits before
 * `runPostEditHook` finishes -- so it is logged here: a timeout is one of the
 * reasons the hook is silent, and the log is where that is looked up.
 */
export async function answerWithin(raw: string, opts: HookOptions, ms: number, deps: EntryDeps = {}): Promise<string | undefined> {
  const started = Date.now();
  let settled = false;
  const work = runPostEditHook(raw, opts, deps).finally(() => { settled = true; });
  const out = await withDeadline(work, ms);
  if (!settled) {
    deps.debug?.(`no answer within ${ms} ms`);
    appendHookLog((opts.env ?? process.env).IX_HOOK_LOG || undefined, {
      ts: new Date(started).toISOString(), path: "timeout", ms: Date.now() - started, chars: 0, notes: [],
    });
  }
  return out;
}

/** `--graph-root <dir>`, `--worktree=<dir>`, `--budget <n>`; anything else is ignored. */
export function parseHookArgs(argv: string[]): HookOptions {
  const opts: HookOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--graph-root") opts.graphRoot = value();
    else if (flag === "--worktree") opts.worktree = value();
    else if (flag === "--budget") {
      const n = Number(value());
      if (Number.isSafeInteger(n) && n > 0) opts.budget = n;
    }
  }
  return opts;
}

/**
 * The whole process: read stdin, answer within the deadline, print, exit 0.
 * Exits at once so a request still in flight past the deadline can neither
 * hold the agent nor surface later as an unhandled rejection.
 */
export async function runHookProcess(opts: HookOptions): Promise<void> {
  const started = Date.now();
  const timeout = hookTimeoutMs();
  const debugOn = process.env.IX_HOOK_DEBUG === "1";
  const debug = (msg: string) => { if (debugOn) process.stderr.write(`[ix hook] ${msg}\n`); };
  let out: string | undefined;
  try {
    const raw = await readStdin(timeout);
    const left = Math.max(0, timeout - (Date.now() - started));
    out = await answerWithin(raw, opts, left, { debug });
  } catch (err) {
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
    out = undefined;
  }
  debug(`${out ? "reported" : "nothing"} in ${Date.now() - started} ms`);
  if (out) process.stdout.write(`${out}\n`, () => process.exit(0));
  else process.exit(0);
}
