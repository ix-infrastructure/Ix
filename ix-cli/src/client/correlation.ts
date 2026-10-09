// Copyright 2026 Ix Infrastructure Inc.

import { randomUUID } from "node:crypto";

/**
 * The X-Correlation-Id this CLI sends on every backend request.
 *
 * The backend tags its request log, error bodies and slow-query log (AQL that
 * runs long) with the request's correlation id, and reuses an inbound one only
 * when it is 1-64 characters of `[A-Za-z0-9._-]`; anything else is replaced by
 * a fresh UUID. So the id is `<invocation>.<n>`: one random UUID per process
 * (36 characters), then the request's sequence number. Every request of one
 * `ix` run shares the prefix, so the backend's log for that run is one grep,
 * and each request is still told apart.
 *
 * Sent to every endpoint. It is an opaque random value tied to nothing on the
 * machine, kOS's edge forwards it untouched, and Ix-memory validates it as
 * above.
 */
export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/** What the backend accepts as an inbound id (Ix-memory CorrelationIdMiddleware). */
export const ACCEPTED_CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

const invocationId = randomUUID();
let sequence = 0;

/** This process's prefix: every request id it sends starts with it. */
export function invocationCorrelationId(): string {
  return invocationId;
}

/** The id for the next request: `<invocation>.<n>`. */
export function nextCorrelationId(): string {
  sequence += 1;
  return `${invocationId}.${sequence}`;
}

/**
 * Under IX_DEBUG=1, one stderr line per request naming its id, so a failure or
 * a slow query can be found in the backend's log. The query string is left
 * out: it can carry the user's search text.
 */
export function debugRequest(method: string, path: string, id: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.IX_DEBUG !== "1") return;
  const bare = path.split("?", 1)[0];
  process.stderr.write(`[debug] ${method} ${bare} ${CORRELATION_ID_HEADER}: ${id}\n`);
}
