// Copyright 2026 Ix Infrastructure Inc.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The abort signal of the command run this code belongs to, if any.
 *
 * `ix mcp` runs many commands in one process, each under a deadline. Racing
 * the command against a timer returned the tool call but left the command
 * running: its backend requests stayed open and its late writes landed in
 * whichever call ran next. The runner now aborts at the deadline, and every
 * client the command builds (`createClient`) and every child it spawns reads
 * this signal, so the abort actually stops the work.
 *
 * Kept in `client/` so the factory can read it without importing the MCP
 * runner. Outside a run there is no signal and nothing changes.
 */
const store = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with `signal` as the current run's abort signal. */
export function runWithSignal<T>(signal: AbortSignal, fn: () => T): T {
  return store.run(signal, fn);
}

/** The current run's abort signal, or undefined outside one. */
export function currentRunSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** Both signals, either, or neither. */
export function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}
