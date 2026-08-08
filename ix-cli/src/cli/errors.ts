import chalk from "chalk";

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

  if (base.toLowerCase().includes("fetch failed") && e.cause) {
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
 * Transport-level codes meaning "we never reached the backend at all", as
 * opposed to the backend answering with an error. Node's fetch surfaces these
 * as `TypeError: fetch failed` with the real error nested under `cause`.
 */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True when the error is a failure to reach the backend at all. This is by far
 * the most common failure for a fresh install — the CLI is on PATH but the
 * Docker backend was never started — so it gets its own actionable message
 * instead of an undici stack trace.
 */
export function isBackendUnreachable(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: unknown } | null | undefined;
  if (typeof e?.code === "string" && UNREACHABLE_CODES.has(e.code)) return true;
  const cause = e?.cause as { code?: unknown } | null | undefined;
  return typeof cause?.code === "string" && UNREACHABLE_CODES.has(cause.code);
}

export function renderCliError(err: unknown, debug = false, endpoint?: string): void {
  if (err instanceof CliUsageError || err instanceof CliResolutionError) {
    process.stderr.write(chalk.red(`Error: ${err.message}\n`));
    if (err.hint) {
      process.stderr.write(chalk.dim(`${err.hint}\n`));
    }
    if (debug && err instanceof CliResolutionError && err.detail) {
      process.stderr.write(chalk.dim(`Detail: ${err.detail}\n`));
    }
    process.exit(1);
  }

  const e = err as any;

  if (isBackendUnreachable(err)) {
    renderStructuredError({
      error: "backend_unreachable",
      message: `Ix backend not reachable${endpoint ? ` at ${endpoint}` : ""}.`,
      next: "Start it with `ix docker start`, then check `ix status`.",
    });
    if (debug && e?.stack) {
      process.stderr.write(chalk.dim(`${e.stack}\n`));
    }
    process.exit(1);
  }

  const structured = typeof e?.message === "string" ? parseBackendError(e.message) : null;
  if (structured) {
    renderStructuredError(structured);
    if (debug && e?.stack) {
      process.stderr.write(chalk.dim(`${e.stack}\n`));
    }
    process.exit(1);
  }

  // formatFetchError unwraps `fetch failed` so the transport cause is visible
  // rather than being hidden behind a message that says nothing.
  const msg = err === null || err === undefined ? String(err) : formatFetchError(err);
  process.stderr.write(chalk.red(`Error: ${msg}\n`));

  if (debug && e?.stack) {
    process.stderr.write(chalk.dim(`${e.stack}\n`));
  }

  process.exit(1);
}
