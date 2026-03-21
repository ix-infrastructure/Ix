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
