// Copyright 2026 Ix Infrastructure Inc.

/**
 * The hook's process contract, kept free of the CLI's imports: this module is
 * loaded on every hooked tool call, most of which change nothing.
 */

import { commandStdin } from "../stdin-source.js";

export const DEFAULT_HOOK_TIMEOUT_MS = 3000;

/**
 * The one place the hook's stdout contract lives: Claude Code reads
 * `hookSpecificOutput.additionalContext` off a PostToolUse hook's JSON and
 * hands it to the model after the tool result.
 */
export function postToolUseOutput(additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext },
  });
}

export function hookTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IX_HOOK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOOK_TIMEOUT_MS;
}

/** All of stdin, or "" when there is none or it does not arrive in time. */
export function readStdin(
  timeoutMs: number,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = commandStdin(),
): Promise<string> {
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
