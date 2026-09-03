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
// back are re-sent once per run through the same per-file loop, with the
// breaker ACTIVE but its streak RESET -- because five adjacent patches the
// backend rejects on their own merits look exactly like a dead backend until
// the next patch commits, and only a fresh streak can tell them apart. A
// backend that really is refusing everything trips again after N, so the retry
// stays bounded. Without it, the mtime baseline (never written on a run with
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
  // Matched, not coerced. `parseInt` stopped at the first non-digit, reading
  // "0.5" as 0 -- silently DISABLING the cutoff, the opposite of a
  // conservative fallback -- and "1e3" as 1, tripping on the very first
  // failure. `Number` fixes those but accepts its own surprises: whitespace
  // coerces to 0 (disabling it again) and "0x10" to 16. A plain-decimal match
  // accepts exactly what the docs describe and falls back on everything else.
  if (!/^\d+$/.test(raw.trim()) || raw.trim() !== raw) return DEFAULT_LIMIT;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : DEFAULT_LIMIT;
}

export interface CommitBreaker {
  /** Consecutive failures required to trip. 0 means this breaker never trips. */
  readonly limit: number;
  /**
   * True while the run has given up on the backend.
   *
   * Sticky against further FAILURES -- a streak that has already tripped stays
   * tripped -- but a single success clears it. A commit landing is direct
   * evidence the backend accepts writes, and there is nothing left to give up
   * about.
   *
   * An earlier revision latched permanently, to stop a 413 split's second half
   * succeeding and making a run that had abandoned patches claim it never gave
   * up. Patches are no longer abandoned on trip -- they are held and re-sent --
   * so that contradiction is gone, and the permanent latch had become the
   * worse bug: after one trip, a backend that recovered completely still had
   * every deletion patch dropped for the rest of the run, because those never
   * go through the bulk path that would have proved it healthy.
   */
  tripped(): boolean;
  /** A commit landed. The backend is accepting writes, so the run resumes. */
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
    recordSuccess: () => { consecutive = 0; latched = false; },
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

/** What the per-file loop should do with the next patch. */
export type PerFileAction =
  /** Send it. */
  | "send"
  /** Do not send it; hold it for the end-of-run drain. */
  | "hold"
  /** Do not send it; it is already in the graph. Count it and stop the loop. */
  | "count-applied";

/**
 * The whole of the per-file loop's stop/hold decision, in one place.
 *
 * Extracted because it lives inside `ingestFiles` otherwise, closing over a
 * dozen locals, and every revision of it that could not be driven directly grew
 * a defect that only a hand-built end-to-end run would show: a budget that
 * never bound because the streak preempted it, a replay guard whose condition
 * had been inverted, an entry check that turned a bulk into N serialized
 * commits. Those are all decision-table bugs, and a decision table should be
 * readable and assertable on its own.
 *
 * `budgetLeft` and `tripped` are two different ways of saying "stop", and which
 * one applies is the substance:
 *
 *   - A caller with a BUDGET has said it wants to be bounded by the arithmetic
 *     of total failures, not by adjacency. The drain is that caller: the set it
 *     is re-sending begins with whatever run of bad patches stopped the fan-out,
 *     so a streak would stop again in the same place and strand everything
 *     behind it -- the permanent wedge, since the mtime baseline is never
 *     written on a run with commit errors and the next run repeats the order.
 *   - A caller with no budget uses the breaker's consecutive streak, which is
 *     the right bound for a fan-out that has a drain behind it to catch what it
 *     holds.
 *
 * A REPLAY is neither: those patches are confirmed landed by the server's own
 * 409 body, so re-sending is bookkeeping and failing to is not a lost write.
 */
export function perFileAction(state: {
  /** Is the caller re-sending patches the server has confirmed it holds? */
  replay: boolean;
  /** Has the run-wide breaker given up? */
  tripped: boolean;
  /** Failures this loop may still absorb, or undefined if it has no budget. */
  budgetLeft?: number;
}): PerFileAction {
  // A spent budget stops everything, replays included: a 409 naming 999 landed
  // ids would otherwise send 999 serialized doomed commits while HOLDING the
  // fallback mutex, so nothing else could even trip the breaker.
  if (state.budgetLeft !== undefined && state.budgetLeft <= 0) return "hold";
  if (state.replay) return state.tripped ? "count-applied" : "send";
  // Only when no budget was given -- with both live the streak always preempts,
  // which is exactly how the budget came to be inert.
  if (state.budgetLeft === undefined && state.tripped) return "hold";
  return "send";
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
  // "failures", not "consecutive failures": the fan-out stops on a streak but
  // the end-of-run retry stops on a total budget, and this banner prints for
  // both. Claiming a run of N in a row that the run may never have seen is a
  // misstatement on the one line whose whole job is saying what the backend did.
  return [
    `Error: Stopped committing against ${endpoint} after repeated failures.`,
    `  ${breaker.skipped()} ${breaker.skipped() === 1 ? "patch was" : "patches were"} not sent — sending them one at a`,
    `  time would have added load to a backend that is already the reason they fail.`,
    `  Last error: ${trimmed}`,
    `  ${state} Re-run \`ix map\` once the backend is healthy; if \`ix doctor\` passes,`,
    `  check the database itself (an ArangoDB that cannot begin a transaction is reachable and consistent).`,
    `  Set IX_COMMIT_FAILURE_LIMIT=0 to send every patch regardless.`,
  ].join("\n");
}
