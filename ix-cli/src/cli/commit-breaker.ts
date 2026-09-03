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
  /**
   * A failure worth QUOTING, but not worth counting.
   *
   * A bulk commit that fails while the breaker is already tripped is abandoned
   * without any per-file attempt, so nothing else here ever sees it -- and
   * that is the dominant shape of a dead-backend run, since a batch is one
   * chunk. Without this, `lastError()` freezes at the last per-file failure
   * and the banner keeps quoting it for the rest of the run: five
   * `TimeoutError`s in batch 1, then nineteen batches rejected with
   * `Invalid message body`, and the user is still told the database is busy
   * and sent to `docker stats`. That is the misrouting the message exists to
   * prevent, so the quote has to keep up.
   *
   * Deliberately not `recordFailure`: one bulk is one request, not N, and
   * counting it would let a single abandoned bulk stand in for a streak.
   */
  noteError(error: unknown): void;
  /**
   * Did the run give up on the backend at ANY point?
   *
   * Distinct from `tripped()`, which a later success clears, and from
   * `skipped()`, which counts only what was still unsent at the end. The
   * diagnosis is gated on this: a run whose drain eventually placed every held
   * patch has `skipped() === 0`, and gating the banner on that meant the one
   * message #560 asked for -- the reason `ix doctor` passes while nothing
   * commits -- was printed only when the run ALSO lost patches. A 12-file
   * ingest against a locked ArangoDB at the default limit hit exactly that: it
   * held 7, the drain sent all 7, and the user got the generic "all N patches
   * failed to commit, re-run with --verbose" and no diagnosis at all.
   */
  everTripped(): boolean;
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
  let everLatched = false;
  let skippedCount = 0;
  let last: unknown;

  return {
    limit,
    tripped: () => latched,
    everTripped: () => everLatched,
    recordSuccess: () => { consecutive = 0; latched = false; },
    noteError: (error) => { last = error; },
    recordFailure: (error) => {
      consecutive++;
      last = error;
      if (limit > 0 && consecutive >= limit) {
        latched = true;
        everLatched = true;
      }
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
  const outOfBudget = state.budgetLeft !== undefined && state.budgetLeft <= 0;
  // A replay is decided FIRST, and is never held. Both reasons to stop want the
  // same thing from it -- stop sending -- but a hold is not that: the caller
  // turns everything it holds into a commit error, so holding a replay would
  // report writes the server has already CONFIRMED as failures and suppress the
  // mtime baseline over them. Counting stops the fan-out just as dead and says
  // the true thing. (An earlier revision returned "hold" here; no caller passes
  // both a replay and a budget today, so it was a latent contradiction between
  // this table and its only consumer rather than a live bug.)
  if (state.replay) return state.tripped || outOfBudget ? "count-applied" : "send";
  if (outOfBudget) return "hold";
  // Only when no budget was given -- with both live the streak always preempts,
  // which is exactly how the budget came to be inert.
  if (state.budgetLeft === undefined && state.tripped) return "hold";
  return "send";
}

/**
 * Walk a held-back set, changing direction each time the budget stops it.
 *
 * A single bounded pass cannot avoid stranding good patches. `attempt` stops
 * after a fixed number of failures, so any run of failures longer than that
 * budget ends the pass wherever it happens to be and leaves everything past it
 * unattempted -- and unattempted means reported as a commit error, which
 * suppresses the mtime baseline, which makes the next `ix map` re-ingest in the
 * same order and reproduce the same outcome. Those patches never land.
 *
 * Reversing helps with ONE cluster of bad patches and only one: the fan-out
 * stopped inside a cluster, so walking from the far end puts the good patches
 * first. With two clusters the reversed walk meets the second one and strands
 * everything behind it exactly as before.
 *
 * Changing direction on each stop fixes that, because the region a pass could
 * not reach is approached from its other end next time. Two clusters need two
 * passes, three need three, and `maxPasses` bounds the doomed requests at
 * roughly `maxPasses x budget`.
 *
 * What ends it is a pass that REACHED THE END, or the pass cap. Note what is
 * deliberately NOT a stopping condition: a pass that placed nothing. An earlier
 * revision treated that as proof the backend was dead, and it is not -- a pass
 * that spent its whole budget inside a leading cluster of bad patches has
 * produced no evidence at all about the region it never reached. With
 * `[good x 400, bad x 15]` and a budget of 10, the reversed first pass met the
 * bad patches immediately, placed nothing, and stranded all 400 good ones
 * unsent. Only reaching the end is evidence about the whole set.
 *
 * That is why `maxPasses` is the bound that matters and why the per-pass budget
 * is the breaker's limit rather than twice it: a genuinely dead backend now
 * always costs `maxPasses x budget` doomed requests, so the product is the
 * number to keep small. `createDrainGate` stops this repeating per batch.
 */
export async function drainInPasses<T>(
  held: readonly T[],
  attempt: (items: T[]) => Promise<T[]>,
  maxPasses = 3,
): Promise<T[]> {
  let pending = [...held].reverse();
  for (let pass = 1; pending.length > 0; pass++) {
    const unreached = await attempt(pending);
    if (unreached.length === 0) return [];
    if (pass >= maxPasses) return unreached;
    pending = [...unreached].reverse();
  }
  return [];
}

/** Whether a batch's held-back patches are worth draining. See [[createDrainGate]]. */
export interface DrainGate {
  /** Is the gate open right now? Pass the run's applied count. */
  shouldDrain(appliedSoFar: number): boolean;
  /** Record what a drain achieved, so the gate can close on a dead backend. */
  record(placedAnything: boolean, appliedSoFar: number): void;
}

/**
 * The drain decision, one level up from `drainInPasses`: per BATCH, not per pass.
 *
 * A run has many batches, and each can hold patches back. Without a gate a
 * genuinely dead backend is re-probed once per batch for the length of the run
 * -- forty batches, each spending a full drain budget of doomed requests --
 * which is the amplification #560 is about, moved rather than removed. So after
 * `missesBeforeGivingUp` drains that place NOTHING, the gate closes.
 *
 * It reopens the moment a patch lands anywhere. That direction is the one that
 * matters and the one an earlier revision got wrong: closing is an INFERENCE
 * about the backend drawn from two drains, and the run keeps going afterwards.
 * A thirty-second blip in batches 3 and 4 must not disable the drain for the
 * remaining thirty-five, because a hold at batch 30 -- against a backend that
 * has since committed nineteen thousand patches -- would then have its patches
 * counted as errors and never sent. Anything landing after the gate closed
 * falsifies the evidence that closed it.
 *
 * One miss is not enough evidence to close on: a few-second fast-rejecting blip
 * produces it, and closing then strands a later batch's held patches with no
 * drain at all.
 */
export function createDrainGate(missesBeforeGivingUp = 2): DrainGate {
  let misses = 0;
  let closed = false;
  let appliedWhenClosed = 0;
  return {
    shouldDrain(appliedSoFar) {
      if (closed && appliedSoFar > appliedWhenClosed) {
        closed = false;
        misses = 0;
      }
      return !closed;
    },
    record(placedAnything, appliedSoFar) {
      misses = placedAnything ? 0 : misses + 1;
      if (misses >= missesBeforeGivingUp) {
        closed = true;
        appliedWhenClosed = appliedSoFar;
      }
    },
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
  /** Patches that landed anywhere in the run. */
  patchesApplied = 0,
  /**
   * Did the run's own wall-clock budget fire?
   *
   * When it did, the deadline branch of `describeCommitOutcome` owns what to do
   * about the missing patches, and the two must not contradict each other: a
   * cutoff that fired BEFORE the clock has already called `recordSkipped`, so
   * this would otherwise print "N were not sent, sending them would have added
   * load to a backend that is already the reason they fail" directly above
   * "Ingest ran out of time: raise IX_MAP_DEADLINE_MS". The diagnosis below --
   * what the backend actually answered -- is still worth printing; the
   * attribution of the count is not.
   */
  deadlineHit = false,
): string {
  const detail = String(breaker.lastError() ?? "unknown error");
  const trimmed = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  // A backend can start refusing part-way through a large ingest, so "the
  // graph is unchanged" is only true when nothing landed. Saying it anyway
  // contradicts the summary printed directly beneath this.
  //
  // Deliberately NOT "landed BEFORE it stopped". Since a cutoff holds patches
  // and the run continues, there is no single moment it stopped: a run that
  // tripped in batch 1, recovered, and committed 19,000 more would have claimed
  // all 19,000 landed "before it stopped". Naming no order needs no snapshot to
  // be true, which is also one less piece of run-scoped state to keep correct.
  const state =
    patchesApplied === 0
      ? "The graph is unchanged."
      : `${patchesApplied} other ${patchesApplied === 1 ? "patch" : "patches"} did land, so the graph is partly updated.`;
  // No failure count in this message at all, deliberately, and neither
  // `breaker.limit` nor the live streak is read here. The fan-out stops on a
  // streak, the drain on a per-pass budget, and the batch gate on two empty
  // drains -- this banner prints for all three, so any single number it named
  // would be wrong for two of them. Earlier revisions named one and had to
  // keep re-explaining which; saying "kept failing" is true of every path.
  // "Commits kept failing", not "Stopped committing": this prints whenever the
  // run gave up at any point, and the drain may since have placed every patch
  // it held. Claiming it stopped would then be false on the one line whose job
  // is saying what happened.
  const unsent =
    breaker.skipped() === 0 || deadlineHit
      ? []
      : [
          `  ${breaker.skipped()} ${breaker.skipped() === 1 ? "patch was" : "patches were"} not sent — sending them one at a`,
          `  time would have added load to a backend that is already the reason they fail.`,
        ];
  return [
    `Error: Commits against ${endpoint} kept failing, so ix stopped fanning out one request per patch.`,
    ...unsent,
    `  Last error: ${trimmed}`,
    `  ${state} Re-run \`ix map\` once it is fixed.`,
    // Two different causes produce this, and the CLI cannot tell them apart:
    // the memory layer answers 500 both for a saturated ArangoDB and for a
    // patch body it will not accept (verified against the released image).
    // Asserting the database is the cause sends a user with a rejected patch
    // to `docker stats` and `/_api/query/current`, which is the wrong
    // subsystem entirely. The backend's own words are quoted above; let them
    // say which.
    `  Either the database cannot keep up — \`ix doctor\` still passes, since an ArangoDB that`,
    `  cannot begin a transaction is reachable and consistent — or the backend is rejecting these`,
    `  particular patches. The error above is the backend's own answer and says which.`,
    `  Set IX_COMMIT_FAILURE_LIMIT=0 to send every patch regardless.`,
  ].join("\n");
}
