// Copyright 2026 Ix Infrastructure Inc.

// ---------------------------------------------------------------------------
// Retrying one commit request (IN-19C).
//
// Two classes of failure are worth sending the same commit again for, and they
// want different waits:
//
//   - lock conflicts and transport drops, which clear in milliseconds. These
//     have always been retried, everywhere a commit is sent, on a 10 ms * 2^n
//     backoff.
//   - a backend or proxy saying "not now": 502, 503, 504 and 429. These clear
//     in seconds, and a 429 or 503 may say how many in `Retry-After`. They are
//     retried only where the caller asks (`transient: true`), which is the
//     ingest's BULK commits: one request per chunk, at most three retries in
//     a 5-second budget per bulk (`IX_COMMIT_TRANSIENT_RETRY_MS`). A
//     `Retry-After` longer than what is left of the budget is cut to it. Hook
//     runners give `ix map` about 30 s in all, so a long wait here would cost
//     more than the retry can win back.
//
// The budget bounds TOTAL time, not just the sleeps: every attempt's own
// duration and every give-up check (a health probe) is charged to it, and a re-send is made only when the time spent so
// far, the wait, and one more attempt as long as the one that just failed all
// fit. A bulk that took longer than the budget to fail is therefore never sent
// again here; it goes straight to the caller's per-file fallback. A 504 gets at
// most ONE re-send on top of that: a gateway timeout means the request was
// slow, and the backend may still be applying it. Re-sending is safe either
// way -- the backend keys every patch by its id, so a bulk it already applied
// answers `Idempotent`, and one it partly applied answers a 409 naming the ids
// that landed -- but it is not free, so it is kept rare.
//
// Everything else is thrown at once. In particular 413 (the payload split owns
// that), 409 (the partial-commit and plan-mismatch handling owns that) and 500
// (a backend that answered and refused; the cutoff owns that). A 504 that the
// backend did apply comes back on the retry as a 409 naming the ids or as
// `Idempotent`, and both are already handled by the caller.
//
// Each class has its own bound: `IX_COMMIT_CONFLICT_RETRIES` counts conflict
// and transport retries only (0: none), and `IX_COMMIT_TRANSIENT_RETRY_MS`
// bounds the transient waits (0: no transient retries).
// ---------------------------------------------------------------------------

/** Lock contention, as opposed to the transport failures below. Kept separate
  * only so each group's reason for being retryable stays readable. */
const COMMIT_CONFLICT_RETRY_PATTERNS = [
  // ArangoDB lock conflicts. These were briefly split into their own constant
  // so `commitFailureIndictsBackend` could exclude them; that exclusion was
  // reverted in round 3 -- it made the cutoff inert in a real saturation mode --
  // and the split had no consumer left, so it is inlined.
  'write-write conflict',
  'timeout waiting to lock key',
  'error: 1200',
  // Transport-level failures (k8s ingress reset, socket drop under load).
  //
  // These are retried because the request usually never reached the server --
  // but "usually" is the whole of Ix#495. A bulk commit is chunked and writes
  // its idempotency keys as each chunk lands, so a socket that drops after the
  // server started work leaves part of the group committed. Retrying then
  // re-sends a set the server has partly seen, and because the bulk group id is
  // a hash of the patch ids, the retry reproduces the same group and is refused
  // with a 409 that no further retry can clear.
  //
  // The retry stays (it is right far more often than not); what changed is that
  // the resulting 409 is now recoverable — see isBulkPartiallyCommittedError.
  'fetch failed',
  'econnreset',
  'econnrefused',
];

// An abort from the shared wall-clock deadline (or a per-request timeout) must
// NOT be retried — the whole point of the deadline is to stop work. Retrying
// here would defeat it and add 6 more backed-off requests to an already-late
// run. AbortSignal.timeout raises a TimeoutError; an aborted deadline raises an
// AbortError; both also stringify with "aborted".
export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return String(err).toLowerCase().includes("aborted");
}

export function isRetryableCommitConflict(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const message = String(err).toLowerCase();
  return COMMIT_CONFLICT_RETRY_PATTERNS.some(pattern => message.includes(pattern));
}

/** Statuses that mean "not now" rather than "no". */
const TRANSIENT_COMMIT_STATUSES = new Set([429, 502, 503, 504]);

/**
 * The HTTP status of a failed request: the `status` `httpError` puts on the
 * error when it has the headers, else the `<status>:` its message starts with.
 */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const m = /^(\d{3}):/.exec((err as Error | null)?.message ?? "");
  return m ? Number(m[1]) : undefined;
}

/** A 502, 503, 504 or 429: worth one more try after a wait. Never an abort. */
export function isTransientCommitStatus(err: unknown): boolean {
  if (isAbortError(err)) return false;
  const status = statusOf(err);
  return status !== undefined && TRANSIENT_COMMIT_STATUSES.has(status);
}

/**
 * Milliseconds a `Retry-After` value asks for: delta-seconds or an HTTP-date
 * (IMF-fixdate), never below 0. Undefined when absent or unreadable, in which
 * case the caller backs off on its own schedule.
 */
export function retryAfterMs(value: string | undefined | null, now: number = Date.now()): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  // Every HTTP-date form starts with the day name. Without this, `Date.parse`
  // reads "-1" as the year -1 and a malformed delay became "retry now".
  if (!/^[A-Za-z]/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

function retryAfterOf(err: unknown): string | undefined {
  const value = (err as { retryAfter?: unknown } | null)?.retryAfter;
  return typeof value === "string" ? value : undefined;
}

/** A wait that ends early, rejecting, when `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The caller's answer, with a broken check read as "do not give up". */
async function giveUpSafely(
  shouldGiveUp: (error: unknown) => boolean | Promise<boolean>,
  error: unknown,
): Promise<boolean> {
  try {
    return (await shouldGiveUp(error)) === true;
  } catch {
    return false;
  }
}

/**
 * `promise`'s answer, or undefined if it has not answered within `ms`. The
 * promise is left to settle on its own; `giveUpSafely` never rejects.
 */
function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Total time one call may spend on transient statuses, attempts and waits together (the default of `IX_COMMIT_TRANSIENT_RETRY_MS`). */
export const TRANSIENT_RETRY_BUDGET_MS = 5_000;
/** Most transient retries one call makes, whatever the budget: a `Retry-After: 0` must not loop. */
export const TRANSIENT_MAX_RETRIES = 3;
/** Most re-sends after a 504: the backend may still be working on the first one. */
export const GATEWAY_TIMEOUT_MAX_RETRIES = 1;
/** First backoff for a transient status without `Retry-After`; doubles each time. */
const TRANSIENT_BASE_DELAY_MS = 500;

export interface RetryCommitOptions {
  /** Conflict and transport retries after the first attempt. 0 means none. Transient statuses are bounded by the budget instead. */
  maxRetries: number;
  /** Retry 502/503/504/429 too. Only the bulk commit sites set this. */
  transient: boolean;
  /**
   * Total time allowed for transient retries: every attempt's duration, every
   * give-up check and the waits. A re-send is made only if one more attempt as long as the last one
   * still fits; a longer wait is cut to what is left. 0 means no transient retries.
   */
  transientBudgetMs?: number;
  /** The run's deadline. A wait it interrupts ends the loop with the last error. */
  signal?: AbortSignal;
  /**
   * Has the caller given up on the backend? Consulted before a TRANSIENT retry
   * only: a run whose cutoff has tripped, or whose backend reports its database
   * down, should not spend its transient budget waiting on it. Conflict and transport
   * retries keep their existing behaviour.
   *
   * It may be async, so a caller can ASK the backend (a short health probe)
   * rather than only read what it already knows: on the first bulk of a run
   * nothing has asked yet. It gets the failure that prompted it. A rejection
   * counts as "keep going", so a probe that breaks never ends the loop.
   */
  shouldGiveUp?: (error: unknown) => boolean | Promise<boolean>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown; kind: "conflict" | "transient" }) => void;
}

/**
 * Send a commit, and send it again while the failure is one a wait can fix.
 * The last error is rethrown when the retries, the budget or the caller's
 * patience run out, and at once for anything else.
 */
export async function retryCommit<T>(fn: () => Promise<T>, options: RetryCommitOptions): Promise<T> {
  const {
    maxRetries,
    transient,
    transientBudgetMs = TRANSIENT_RETRY_BUDGET_MS,
    signal,
    shouldGiveUp,
    sleep = abortableSleep,
    random = Math.random,
    now = Date.now,
    onRetry,
  } = options;
  // Time charged to the transient budget: every attempt's own duration, every give-up check and
  // every transient wait.
  let transientSpentMs = 0;
  let transientRetries = 0;
  let gatewayTimeoutRetries = 0;
  let conflictRetries = 0;
  for (;;) {
    const attemptStart = now();
    try {
      return await fn();
    } catch (err) {
      const attemptMs = Math.max(0, now() - attemptStart);
      transientSpentMs += attemptMs;
      if (signal?.aborted) throw err;
      let delay: number;
      let kind: "conflict" | "transient";
      if (isRetryableCommitConflict(err)) {
        if (conflictRetries >= maxRetries) throw err;
        // ArangoDB lock conflicts usually clear as soon as the competing transaction
        // commits. Transport errors may need a bit more breathing room under k8s load.
        delay = 10 * (1 << conflictRetries) + random() * 10;
        conflictRetries++;
        kind = "conflict";
      } else if (transient && isTransientCommitStatus(err)) {
        // What is left once the re-send itself is paid for, estimated as
        // long as the attempt that just failed. Nothing left: no re-send.
        let remaining = transientBudgetMs - transientSpentMs - attemptMs;
        if (transientRetries >= TRANSIENT_MAX_RETRIES || remaining <= 0) throw err;
        const gatewayTimeout = statusOf(err) === 504;
        if (gatewayTimeout && gatewayTimeoutRetries >= GATEWAY_TIMEOUT_MAX_RETRIES) throw err;
        if (shouldGiveUp) {
          // The give-up check may be a health probe that takes seconds. Its
          // time is charged to the budget like an attempt's, it may take no
          // longer than what is left (a check that has not answered by then
          // leaves no room for a re-send anyway), and what is left is worked
          // out again after it.
          const probeStart = now();
          const giveUp = await withinBudget(giveUpSafely(shouldGiveUp, err), remaining);
          transientSpentMs += Math.max(0, now() - probeStart);
          if (giveUp !== false) throw err;
          if (signal?.aborted) throw err;
          remaining = transientBudgetMs - transientSpentMs - attemptMs;
          if (remaining <= 0) throw err;
        }
        const asked = retryAfterMs(retryAfterOf(err), now());
        // Jittered by up to a quarter, so the chunks of one run that all met
        // the same restart do not come back in lockstep. Either wait is cut to
        // what is left of the budget, so `Retry-After` is honoured only up to it.
        delay = Math.min(
          remaining,
          asked ?? TRANSIENT_BASE_DELAY_MS * 2 ** transientRetries * (1 + random() * 0.25),
        );
        transientSpentMs += delay;
        transientRetries++;
        if (gatewayTimeout) gatewayTimeoutRetries++;
        kind = "transient";
      } else {
        throw err;
      }
      onRetry?.({ attempt: conflictRetries + transientRetries, delayMs: delay, error: err, kind });
      try {
        await sleep(delay, signal);
      } catch {
        // The deadline fired during the wait. The commit's own failure is the
        // one worth reporting, and the caller reads the deadline separately.
        throw err;
      }
    }
  }
}
