// Copyright 2026 Ix Infrastructure Inc.

/**
 * Failure codes that mean the request never reached the server.
 *
 * The connection was refused, the host did not resolve, or the connect phase
 * timed out — in every case nothing was transmitted, so a destructive request
 * provably did not run. That judgement is what lets `reset` distinguish "your
 * backend is not running" from "something may have been deleted".
 *
 * `UND_ERR_SOCKET` is deliberately NOT here even though `cli/errors.ts` counts
 * it as unreachable for rendering purposes. It means an established socket
 * closed without answering, so the request may well have been transmitted and
 * acted on — exactly the ambiguous case reset must not wave through.
 * `ECONNRESET` and `ETIMEDOUT` are absent for the same reason.
 *
 * Lives in `client/` rather than `cli/` so the HTTP client can use it without
 * pulling the CLI's presentation layer (chalk) into the `./client/*` export.
 */
export const PRE_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * True when `err` (or any error in its `cause` chain — undici wraps the real
 * code one level down in a `TypeError: fetch failed`) proves nothing was sent.
 */
/**
 * `name` on the errors reset raises when an operation's outcome is unknown.
 *
 * These carry a `cause` so IX_DEBUG can show the transport failure, which puts
 * a code like UND_ERR_SOCKET one level below an error whose OWN message is the
 * thing the user must read. Without this marker `isBackendUnreachable` matches
 * on that cause and renders "start the backend, then check status" — turning
 * "do not repeat this reset" into an instruction to retry.
 */
export const RESET_RECONCILIATION_ERROR = "ResetReconciliationError";

export function isPreConnectionFailure(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && PRE_CONNECTION_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
