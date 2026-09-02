// ---------------------------------------------------------------------------
// Run-scoped cutoff for an ingest whose every commit is failing.
//
// Background (Ix#560): a bulk commit that fails for a reason specific to the
// GROUP -- too large, partially applied -- is recoverable by sending the
// patches differently, and `commitBulkWithPayloadSplit` does exactly that: it
// falls back to committing each patch on its own. That is right for a group
// problem and exactly wrong for a BACKEND problem. When ArangoDB cannot begin a
// transaction at all, the fallback turns one failed request into one failed
// request per patch, serialized behind the fallback mutex, each waiting out its
// own timeout.
//
// Measured against a backend that fails every commit, on a 21-patch ingest:
//
//   defaults (batch 1000, concurrency 8)   1 bulk + 21 per-file = 22 requests
//   IX_COMMIT_HTTP_MAX_FILES=1,
//   IX_COMMIT_CONCURRENCY=1               21 bulk + 21 per-file = 42 requests
//
// which is why #560 reports that lowering batch size and concurrency does not
// help: the fan-out is per patch, so it ignores both. On a first map of a large
// repo the same shape sends thousands of doomed requests to a backend that is
// already the reason they are failing.
//
// The rule here is deliberately about BEHAVIOUR, not about error text. Which
// message ArangoDB, the memory layer or an intervening proxy produces for
// "saturated" varies by deployment, and a classifier assembled from guessed
// strings is inert in exactly the deployments it was written for. What is
// unambiguous is a backend that has refused N commits in a row without
// accepting one: nothing about sending the next request differs from the last N.
//
// A false trip is cheap and self-healing. The remaining patches are counted as
// commit errors, which is what they would have been anyway; the mtime baseline
// is not written on a run with commit errors, so the next `ix map` retries every
// file it did not commit.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 5;

/** Consecutive failed commits before a run stops trying. 0 disables the cutoff. */
export function commitFailureLimit(raw = process.env.IX_COMMIT_FAILURE_LIMIT): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  // 0 is meaningful (never trip), so only a negative or unparseable value falls
  // back to the default.
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_LIMIT;
}

export interface CommitBreaker {
  /** Consecutive failures required to trip. 0 means this breaker never trips. */
  readonly limit: number;
  /** True once the run has given up on the backend. */
  tripped(): boolean;
  /** A commit landed. The backend is accepting writes, so the streak is over. */
  recordSuccess(): void;
  /** A commit failed in a way that sending it again cannot fix. */
  recordFailure(error: unknown): void;
  /** Patches abandoned because the breaker was already tripped. */
  skipped(): number;
  /** Count one abandoned patch. */
  recordSkipped(n?: number): void;
  /** The most recent failure, for the message. */
  lastError(): unknown;
  /** Failures in the current streak. */
  consecutiveFailures(): number;
}

export function createCommitBreaker(limit = commitFailureLimit()): CommitBreaker {
  let consecutive = 0;
  let skippedCount = 0;
  let last: unknown;

  return {
    limit,
    tripped: () => limit > 0 && consecutive >= limit,
    recordSuccess: () => { consecutive = 0; },
    recordFailure: (error) => { consecutive++; last = error; },
    skipped: () => skippedCount,
    recordSkipped: (n = 1) => { skippedCount += n; },
    lastError: () => last,
    consecutiveFailures: () => consecutive,
  };
}

/**
 * What the user is told when a run stops early.
 *
 * This is the diagnostic #560 did not have. The symptom there is an ingest that
 * fails while `ix doctor` reports a healthy graph -- doctor asks whether the
 * backend is reachable and the graph is consistent, neither of which is false
 * when ArangoDB is merely too busy to start a transaction. Saying plainly that
 * the backend refused every write, and quoting the error once instead of once
 * per file behind --debug, is the difference between "Ix is broken" and "the
 * database is saturated".
 */
export function describeCommitCutoff(breaker: CommitBreaker, endpoint: string): string {
  const detail = String(breaker.lastError() ?? "unknown error");
  const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  return [
    `Error: Stopped committing after ${breaker.consecutiveFailures()} consecutive failures against ${endpoint}.`,
    `  The backend accepted none of them, so ${breaker.skipped()} further ${breaker.skipped() === 1 ? "patch was" : "patches were"} not sent —`,
    `  they would have failed the same way and added load to a backend that is already the reason.`,
    `  Last error: ${trimmed}`,
    `  The graph is unchanged. Re-run \`ix map\` once the backend is healthy; if \`ix doctor\` passes,`,
    `  check the database itself (an ArangoDB that cannot begin a transaction is reachable and consistent).`,
    `  Set IX_COMMIT_FAILURE_LIMIT=0 to send every patch regardless.`,
  ].join("\n");
}
