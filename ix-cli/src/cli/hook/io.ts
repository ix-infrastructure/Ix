// Copyright 2026 Ix Infrastructure Inc.

import { claudeCodeAdapter } from "./hosts/claude.js";

/**
 * The hook's process contract, kept free of the CLI's imports: this module is
 * loaded on every hooked tool call, most of which change nothing.
 *
 * Every `ix hook` subcommand keeps it: it exits 0 whatever happens, prints
 * nothing or exactly the host's JSON ({@link HostAdapter.writeContext}), keeps
 * its state under `<IX_HOME>/hook-state` (`session.ts`), and has one deadline
 * for the whole run, IX_HOOK_TIMEOUT_MS ({@link runHookMain}).
 */

export const DEFAULT_HOOK_TIMEOUT_MS = 3000;

/**
 * claude-post-edit's stdout: Claude Code reads
 * `hookSpecificOutput.additionalContext` off a PostToolUse hook's JSON and
 * hands it to the model after the tool result. The shape itself lives in the
 * Claude Code adapter (`hosts/claude.ts`).
 */
export function postToolUseOutput(additionalContext: string): string {
  return claudeCodeAdapter.writeContext("PostToolUse", additionalContext);
}

export function hookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IX_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOOK_TIMEOUT_MS;
}

/** All of stdin, or "" when there is none or it does not arrive in time. */
export function readStdin(timeoutMs: number, stdin: NodeJS.ReadStream = process.stdin): Promise<string> {
  if (stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = (value: string) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => done(""), timeoutMs);
    stdin.on("data", (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stdin.on("end", () => done(Buffer.concat(chunks).toString("utf-8")));
    stdin.on("error", () => done(""));
  });
}

/**
 * The whole process of one hook run: read stdin, let `answer` reply within
 * what is left of the deadline, print its reply, exit 0. Exits at once so a
 * request still in flight past the deadline can neither hold the agent nor
 * surface later as an unhandled rejection. `answer` gets the milliseconds
 * left and must not take longer ({@link withDeadline}).
 */
export async function runHookMain(
  answer: (raw: string, msLeft: number, debug: (msg: string) => void) => Promise<string | undefined>,
): Promise<void> {
  const started = Date.now();
  const timeout = hookTimeoutMs();
  const debugOn = process.env.IX_HOOK_DEBUG === "1";
  const debug = (msg: string) => { if (debugOn) process.stderr.write(`[ix hook] ${msg}\n`); };
  let out: string | undefined;
  try {
    const raw = await readStdin(timeout);
    const left = Math.max(0, timeout - (Date.now() - started));
    out = await answer(raw, left, debug);
  } catch (err) {
    debug(`failed: ${err instanceof Error ? err.message : String(err)}`);
    out = undefined;
  }
  debug(`${out ? "reported" : "nothing"} in ${Date.now() - started} ms`);
  if (out) process.stdout.write(`${out}\n`, () => process.exit(0));
  else process.exit(0);
}

/**
 * Race the hook against its deadline. A late answer is dropped, not waited
 * for: an agent's next turn is worth more than the dependents of its last one.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); });
  try {
    return await Promise.race([work.catch(() => undefined), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
