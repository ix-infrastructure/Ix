// Copyright 2026 Ix Infrastructure Inc.

/**
 * The JSON printing core: `--pretty`, resolution notices, `printJson` and
 * `captureJson`. Commands print their `--format json` payload with `printJson`.
 */

// ── JSON output shape ──────────────────────────────────────────────────────

/**
 * Whether the caller explicitly asked for indented JSON.
 *
 * False means nobody asked, and the shape then follows the destination:
 * indented for a terminal, compact for anything else. Two spaces of indent per
 * level is roughly a fifth of a JSON payload, and the only reader that gains
 * anything from it is a human looking at a screen. Every other reader — a pipe
 * into `jq`, an agent's tool result, the MCP child process — pays tokens for
 * whitespace it discards.
 */
let prettyJsonRequested = false;

/** Record `--pretty`. Called once from the root `preAction` hook. */
export function setPrettyJson(pretty: boolean): void {
  prettyJsonRequested = pretty;
}

/**
 * The indent `JSON.stringify` should use, read at print time.
 *
 * Deliberately not cached: `process.stdout.isTTY` is what makes this decision,
 * and a test that redirects stdout would otherwise get the shape from whatever
 * the process looked like at import time.
 */
function jsonIndent(): number | undefined {
  if (prettyJsonRequested) return 2;
  return process.stdout.isTTY ? 2 : undefined;
}

// ── Resolution notices ─────────────────────────────────────────────────────

/**
 * Notices about a guessed target (`ambiguous_target`, `fuzzy_match`) waiting for
 * the command's own json object. Module state: `ix mcp` runs commands in this
 * process by default (see mcp/runner.ts), so its runner calls
 * `resetResolutionNotices` before each command, and so should tests that call a
 * command in-process.
 */
let pendingResolutionNotices: unknown[] = [];

/** Queue notices for the next `printJson`. */
export function noteResolutionNotices(list: readonly unknown[]): void {
  pendingResolutionNotices.push(...list);
}

export function takeResolutionNotices(): unknown[] {
  const taken = pendingResolutionNotices;
  pendingResolutionNotices = [];
  return taken;
}

export function resetResolutionNotices(): void {
  pendingResolutionNotices = [];
}

/**
 * Merge pending notices into a plain object that is not an error record.
 * Anything else (an array, a scalar, an `{error}`) is printed untouched and the
 * notices are dropped: an error is its own answer, and the exit code is the same.
 */
function withResolutionNotices(value: unknown): unknown {
  const notices = takeResolutionNotices();
  if (notices.length === 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (typeof obj.error === "string") return value;
  const fuzzy = notices.some((n) => (n as { code?: string })?.code === "fuzzy_match");
  return {
    ...obj,
    ...(fuzzy && obj.resolutionMode === undefined ? { resolutionMode: "fuzzy" } : {}),
    resolutionNotices: notices,
  };
}

/** Set while {@link captureJson} runs: payloads are collected instead of printed. */
let jsonSink: unknown[] | undefined;

/** Print a JSON payload on stdout, indented only when that helps someone. */
export function printJson(value: unknown): void {
  const payload = withResolutionNotices(value);
  if (jsonSink) {
    jsonSink.push(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, jsonIndent()));
}

/**
 * Run `fn` and return the payloads it passed to `printJson`, unprinted. A
 * multi-target command runs its one-target body per target and prints one
 * object grouping them, rather than several JSON documents on one stream.
 */
export async function captureJson(fn: () => Promise<void>): Promise<unknown[]> {
  const previous = jsonSink;
  const sink: unknown[] = [];
  jsonSink = sink;
  try {
    await fn();
  } finally {
    jsonSink = previous;
  }
  return sink;
}
