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
//     ingest's BULK commits: one request per chunk, so a 30-second budget per
//     bulk is bounded. On the per-file path it would be 30 seconds per patch.
//
// Everything else is thrown at once. In particular 413 (the payload split owns
// that), 409 (the partial-commit and plan-mismatch handling owns that) and 500
// (a backend that answered and refused; the cutoff owns that). A 504 that the
// backend did apply comes back on the retry as a 409 naming the ids or as
// `Idempotent`, and both are already handled by the caller.
//
// One attempt counter covers every class, so `IX_COMMIT_CONFLICT_RETRIES`
// bounds the whole loop, and 0 means one attempt and no retries.
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

/** Total waiting one call may spend on transient statuses. */
export const TRANSIENT_RETRY_BUDGET_MS = 30_000;
/** First backoff for a transient status without `Retry-After`; doubles each time. */
const TRANSIENT_BASE_DELAY_MS = 500;

export interface RetryCommitOptions {
  /** Retries after the first attempt, across every class. 0 means one attempt. */
  maxRetries: number;
  /** Retry 502/503/504/429 too. Only the bulk commit sites set this. */
  transient: boolean;
  /** Total waiting allowed for transient statuses. A wait past it is not taken. */
  transientBudgetMs?: number;
  /** The run's deadline. A wait it interrupts ends the loop with the last error. */
  signal?: AbortSignal;
  /**
   * Has the caller given up on the backend? Consulted before a TRANSIENT retry
   * only: a run whose cutoff has tripped, or whose backend reports its database
   * down, should not spend 30 seconds waiting on it. Conflict and transport
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
  let transientWaitedMs = 0;
  let transientRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || signal?.aborted) throw err;
      let delay: number;
      let kind: "conflict" | "transient";
      if (isRetryableCommitConflict(err)) {
        // ArangoDB lock conflicts usually clear as soon as the competing transaction
        // commits. Transport errors may need a bit more breathing room under k8s load.
        delay = 10 * (1 << attempt) + random() * 10;
        kind = "conflict";
      } else if (transient && isTransientCommitStatus(err)) {
        if (shouldGiveUp && (await giveUpSafely(shouldGiveUp, err))) throw err;
        const asked = retryAfterMs(retryAfterOf(err), now());
        // Jittered by up to a quarter, so the chunks of one run that all met
        // the same restart do not come back in lockstep.
        delay = asked ?? TRANSIENT_BASE_DELAY_MS * 2 ** transientRetries * (1 + random() * 0.25);
        // A wait that would overrun the budget is not started: sleeping most
        // of it and then failing anyway only makes the failure later.
        if (transientWaitedMs + delay > transientBudgetMs) throw err;
        transientWaitedMs += delay;
        transientRetries++;
        kind = "transient";
      } else {
        throw err;
      }
      onRetry?.({ attempt: attempt + 1, delayMs: delay, error: err, kind });
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
