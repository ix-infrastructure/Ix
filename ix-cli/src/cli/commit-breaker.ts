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
// What the cutoff does NOT do is abandon work permanently. Patches it holds
// back are retried once at the end of the run if the backend has meanwhile
// accepted anything at all -- because five adjacent patches that the backend
// rejects on their own merits look exactly like a dead backend until a later
// chunk commits. Without that, the mtime baseline (never written on a run with
// commit errors) guarantees the next `ix map` re-ingests in the same order,
// trips at the same point, and drops the same patches forever.
//
// It also never skips a chunk's BULK commit. One request per chunk is not the
// amplification -- the fan-out is, at one request per patch -- and sending it is
// what lets a backend that has recovered mid-run prove so and unstick the rest.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 5;

/** Consecutive failed commits before a run stops trying. 0 disables the cutoff. */
export function commitFailureLimit(raw = process.env.IX_COMMIT_FAILURE_LIMIT): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  // Number(), not parseInt(): parseInt stops at the first non-digit, so it read
  // "0.5" as 0 -- silently DISABLING the cutoff -- and "1e3" as 1, tripping on
  // the very first failure. Neither is what the caller asked for, and neither
  // fell back to the documented default. 0 stays meaningful (never trip), so
  // only a negative or non-integer value falls back.
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LIMIT;
}

export interface CommitBreaker {
  /** Consecutive failures required to trip. 0 means this breaker never trips. */
  readonly limit: number;
  /**
   * True once the run has given up on the backend. Latching: a later success
   * does NOT un-trip it.
   *
   * Without the latch the flag tracks the current streak instead of the
   * decision, and the decision is what other code has already acted on. A
   * chunk that split on a 413 can have its first half abandoned and counted
   * as errors, then its second half succeed and clear the streak -- leaving a
   * run that abandoned patches, reported them as commit errors, and finishes
   * claiming it never gave up.
   */
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
  /**
   * Start a fresh streak, un-latched.
   *
   * For the end-of-run retry only. The held-back patches are re-sent with the
   * breaker ACTIVE but with no memory of the streak that held them, so a
   * backend that is genuinely refusing everything trips again after N and the
   * retry stays bounded -- while patches held back by a false trip simply
   * commit. `skipped()` is cumulative and deliberately not reset.
   */
  reset(): void;
}

export function createCommitBreaker(limit = commitFailureLimit()): CommitBreaker {
  let consecutive = 0;
  let latched = false;
  let skippedCount = 0;
  let last: unknown;

  return {
    limit,
    tripped: () => latched,
    recordSuccess: () => { consecutive = 0; },
    recordFailure: (error) => {
      consecutive++;
      last = error;
      if (limit > 0 && consecutive >= limit) latched = true;
    },
    skipped: () => skippedCount,
    recordSkipped: (n = 1) => { skippedCount += n; },
    lastError: () => last,
    consecutiveFailures: () => consecutive,
    reset: () => { consecutive = 0; latched = false; },
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
export function describeCommitCutoff(
  breaker: CommitBreaker,
  endpoint: string,
  /** Patches that DID land before the run gave up. */
  patchesApplied = 0,
): string {
  const detail = String(breaker.lastError() ?? "unknown error");
  const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  // A backend can start refusing part-way through a large ingest, so "the
  // graph is unchanged" is only true when nothing landed. Saying it anyway
  // contradicts the summary printed directly beneath this.
  const state =
    patchesApplied === 0
      ? "The graph is unchanged."
      : `${patchesApplied} ${patchesApplied === 1 ? "patch" : "patches"} landed before it stopped; the rest are missing from the graph.`;
  // The configured limit, not the live streak. Requests already in flight when
  // the breaker tripped keep landing and keep incrementing, so the streak is
  // whatever the race happened to produce -- a number that is not the rule and
  // does not match IX_COMMIT_FAILURE_LIMIT.
  return [
    `Error: Stopped committing after ${breaker.limit} consecutive failures against ${endpoint}.`,
    `  It refused ${breaker.limit} in a row, so ${breaker.skipped()} further ${breaker.skipped() === 1 ? "patch was" : "patches were"} not sent —`,
    `  they would have failed the same way and added load to a backend that is already the reason.`,
    `  Last error: ${trimmed}`,
    `  ${state} Re-run \`ix map\` once the backend is healthy; if \`ix doctor\` passes,`,
    `  check the database itself (an ArangoDB that cannot begin a transaction is reachable and consistent).`,
    `  Set IX_COMMIT_FAILURE_LIMIT=0 to send every patch regardless.`,
  ].join("\n");
}
