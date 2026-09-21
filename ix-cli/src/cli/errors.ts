// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { PRE_CONNECTION_CODES, RESET_RECONCILIATION_ERROR } from "../client/transport.js";

import { llmError } from "./llm.js";

// ── Answering in the format the caller asked for ───────────────────────────

/**
 * The `--format` this run was invoked with, or undefined for the default.
 *
 * A failure is the one answer an agent is least equipped to guess at, and it
 * was the only one this CLI would not give in the format it had been asked
 * for: a backend that is down produced several lines of coloured prose on
 * stderr and nothing at all on stdout, so a caller parsing records saw an
 * empty stream and a non-zero exit with no reason attached.
 */
let requestedFormat: string | undefined;

/** Record the format for the error boundary. Called once, from `main.ts`. */
export function setErrorFormat(format: string | undefined): void {
  requestedFormat = format;
}

/**
 * The `--format` the caller typed, read straight off argv.
 *
 * Read from argv rather than from the parsed command because this has to work
 * before commander has parsed anything: the handler that calls
 * `renderCliError` is installed for `unhandledRejection` and
 * `uncaughtException`, which can fire at any point, including during
 * registration.
 *
 * Only what was typed. `IX_FORMAT` and `config.format` choose the default
 * elsewhere (#682); until that lands, honouring them here would answer in
 * records for a run whose payload came out as text.
 *
 * Stops at `--`, so a term that merely looks like a flag —
 * `ix text -- "--format llm"` — is not read as one.
 */
export function detectRequestedFormat(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") return undefined;
    if (arg.startsWith("--format=")) return arg.slice("--format=".length);
    if (arg === "--format") return argv[i + 1];
  }
  return undefined;
}

/**
 * Emit the failure as one record on stdout, or return false if the caller did
 * not ask for records.
 *
 * On stdout, not stderr: stdout is where the answer goes, and "there is no
 * answer, because X" is an answer. The human prose is then skipped rather than
 * printed alongside, so the caller gets exactly one report.
 */
function emitLlmError(code: string, message: string, hint?: string): boolean {
  if (requestedFormat !== "llm") return false;
  console.log(llmError(code, message, hint ? [["hint", hint]] : []));
  return true;
}

/**
 * Structured error with user-facing message and optional next-step guidance.
 * Parsed from backend JSON responses that include `error`, `message`, and `next` fields.
 */
export interface StructuredError {
  error: string;
  message: string;
  next?: string;
}

/**
 * Attempt to parse a structured error from a backend HTTP error message.
 * Backend errors arrive as "${status}: ${jsonBody}" from the API client.
 */
export function parseBackendError(errMessage: string): StructuredError | null {
  // Match "NNN: {json}" pattern from api.ts error throwing
  const match = errMessage.match(/^(\d{3}):\s*(.+)$/s);
  if (!match) return null;

  try {
    const body = JSON.parse(match[2]);
    if (body.error && body.message) {
      return {
        error: body.error,
        message: body.message,
        next: body.next ?? undefined,
      };
    }
  } catch {
    // Not valid JSON — fall through
  }
  return null;
}

/**
 * Render a structured error to stderr with clean formatting.
 * No stack traces, no internal jargon.
 */
export function renderStructuredError(err: StructuredError): void {
  console.error("");
  console.error(chalk.red(`  ${err.message}`));
  if (err.next) {
    console.error("");
    console.error(chalk.dim("  Next"));
    console.error(`  ${err.next}`);
  }
  console.error("");
}

export class CliUsageError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliResolutionError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "CliResolutionError";
  }
}

/**
 * Format an error for display, unwrapping fetch `TypeError: fetch failed`
 * to expose the underlying transport cause (e.g. ECONNRESET, UND_ERR_SOCKET).
 *
 * Node's built-in fetch (undici) throws `TypeError('fetch failed')` on any
 * transport-level failure and stashes the real error in `err.cause`. Without
 * this unwrap, users see a bare "fetch failed" with no actionable detail —
 * see the Node 18 EOL / undici 5.x transport-drop bug report.
 */
export function formatFetchError(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  const e = err as { message?: unknown; cause?: unknown };
  const base = typeof e.message === "string" && e.message.length > 0
    ? e.message
    : String(err);

  // "terminated" is what undici reports when a connection dies after the
  // response headers — the commonest mid-flight shape, and one that carries no
  // detail at all without this unwrap.
  const lower = base.toLowerCase();
  if ((lower.includes("fetch failed") || lower.includes("terminated")) && e.cause) {
    const cause = e.cause as { code?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof cause.code === "string" && cause.code.length > 0) {
      parts.push(cause.code);
    }
    if (typeof cause.message === "string" && cause.message.length > 0) {
      parts.push(cause.message);
    } else if (parts.length === 0) {
      parts.push(String(e.cause));
    }
    return `${base} (${parts.join(": ")})`;
  }

  return base;
}

/**
 * Transport-level codes meaning "we did not get a working backend on the other
 * end", as opposed to the backend answering with an error. Node's fetch
 * surfaces these as `TypeError: fetch failed` with the real error under `cause`.
 *
 * `UND_ERR_SOCKET` ("other side closed") belongs here despite describing an
 * established socket: measured, it is what you get from a port that accepts and
 * then closes without answering — a container that is still booting, a dead
 * container behind a published port, a port-forward to nothing. That user does
 * need "start the backend, then check status".
 *
 * `ECONNRESET` and `ETIMEDOUT` are deliberately absent. Those are a connection
 * that was working and then died, which is a different problem with a different
 * remedy; they fall through to the generic path, which names the cause. The
 * connect-phase half of `ETIMEDOUT` does not need special handling: undici's
 * 10s connect timeout fires first and reports `UND_ERR_CONNECT_TIMEOUT`, which
 * is already listed here.
 */
// The pre-connection codes are shared with the HTTP client, which needs the
// same "nothing was transmitted" judgement to decide whether a failed reset
// could have deleted anything. One definition, not two: a second hand-written
// copy is how the two drift apart. `UND_ERR_SOCKET` is added only here — see
// above for why it counts as unreachable for rendering but not for reset.
const UNREACHABLE_CODES = new Set([...PRE_CONNECTION_CODES, "UND_ERR_SOCKET"]);

function isUnreachableCode(e: { code?: unknown } | null | undefined): boolean {
  return typeof e?.code === "string" && UNREACHABLE_CODES.has(e.code);
}

/** True for an endpoint served from this machine, where `ix docker start` applies. */
function isLocalEndpoint(endpoint?: string): boolean {
  if (!endpoint) return true; // unresolved endpoint defaults to the local install
  return /^\w+:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(endpoint);
}

/**
 * Under IX_DEBUG, print the error *and its cause chain*.
 *
 * `err.stack` alone is empty for the very case this module exists to handle:
 * Node's fetch rejects with a `TypeError: fetch failed` whose frames are lost
 * across the async boundary, so the whole diagnostic — ECONNREFUSED vs
 * ENOTFOUND vs a TLS failure — lives in `err.cause`. Printing only the stack
 * meant `IX_DEBUG=1` emitted one useless line for a backend-down error.
 *
 * Walks the chain by hand rather than handing the error to `util.inspect`.
 * This is the process-wide error boundary, and inspect prints every own
 * property of whatever was thrown; Pro holds a tunnel JWT and a long-lived
 * refresh token, so the day something throws an error carrying its own request
 * we would print credentials into output the user is about to paste into an
 * issue. Only stack, message and code are ever emitted.
 */
function writeDebugDetail(err: unknown): void {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;

  while (cur !== null && cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { stack?: unknown; message?: unknown; code?: unknown; cause?: unknown };
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    const body =
      typeof e.stack === "string" && e.stack.length > 0
        ? `${code}${e.stack}`
        : `${code}${typeof e.message === "string" ? e.message : String(cur)}`;
    lines.push(lines.length === 0 ? body : `  [cause] ${body}`);
    cur = typeof cur === "object" ? e.cause : undefined;
  }

  process.stderr.write(chalk.dim(`${lines.length > 0 ? lines.join("\n") : String(err)}\n`));
}

/**
 * True when the error is a failure to reach the backend at all. This is by far
 * the most common failure for a fresh install — the CLI is on PATH but the
 * Docker backend was never started — so it gets its own actionable message
 * instead of an undici stack trace.
 */
export function isBackendUnreachable(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  // An error that carries its own instruction must not be re-explained by its
  // cause. Reset attaches the transport failure for IX_DEBUG, which would
  // otherwise render "start the backend, then check status" on top of a
  // "do not repeat this reset" warning — advising the retry it exists to stop.
  if (e?.name === RESET_RECONCILIATION_ERROR) return false;
  if (isUnreachableCode(e)) return true;
  return isUnreachableCode(e?.cause as { code?: unknown } | null | undefined);
}

/**
 * The one description of a backend nobody answered at.
 *
 * Shared so a command that catches the failure itself — `ix status` does, to
 * keep its own shape — reports the same code, the same sentence and the same
 * next step as the process-wide boundary. It was two wordings before, one of
 * them with no next step at all.
 */
export function backendUnreachableError(endpoint?: string): StructuredError {
  return {
    error: "backend_unreachable",
    message: `Ix backend not reachable${endpoint ? ` at ${endpoint}` : ""}.`,
    // `ix docker start` only fixes a backend this machine is supposed to run.
    // Pro points `config.endpoint` at a cloud instance, where that advice is
    // both useless and actively wrong — it starts a backend you aren't using.
    next: isLocalEndpoint(endpoint)
      ? "Start it with `ix docker start`, then check `ix status`."
      : "Check your network, and that the endpoint is right (`ix config get endpoint`).",
  };
}

export function renderCliError(err: unknown, debug = false, endpoint?: string): void {
  if (err instanceof CliUsageError || err instanceof CliResolutionError) {
    const code = err instanceof CliUsageError ? "usage_error" : "resolution_failed";
    if (!emitLlmError(code, err.message, err.hint)) {
      process.stderr.write(chalk.red(`Error: ${err.message}\n`));
      if (err.hint) {
        process.stderr.write(chalk.dim(`${err.hint}\n`));
      }
    }
    if (debug && err instanceof CliResolutionError && err.detail) {
      process.stderr.write(chalk.dim(`Detail: ${err.detail}\n`));
    }
    process.exit(1);
  }

  const e = err as any;

  if (isBackendUnreachable(err)) {
    const unreachable = backendUnreachableError(endpoint);
    if (!emitLlmError(unreachable.error, unreachable.message, unreachable.next)) {
      renderStructuredError(unreachable);
    }
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  const structured = typeof e?.message === "string" ? parseBackendError(e.message) : null;
  if (structured) {
    if (!emitLlmError(structured.error, structured.message, structured.next)) {
      renderStructuredError(structured);
    }
    if (debug) writeDebugDetail(err);
    process.exit(1);
  }

  // formatFetchError unwraps `fetch failed` so the transport cause is visible
  // rather than being hidden behind a message that says nothing.
  const msg = err === null || err === undefined ? String(err) : formatFetchError(err);
  // `cli_error` because nothing above recognised it: the code has to stay
  // stable and honest rather than guess at a class from the message text.
  if (!emitLlmError("cli_error", msg)) {
    process.stderr.write(chalk.red(`Error: ${msg}\n`));
  }

  if (debug) writeDebugDetail(err);

  process.exit(1);
}
