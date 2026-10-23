// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_TIMEOUT_MAX_RETRIES, isTransientCommitStatus, retryAfterMs, retryCommit, TRANSIENT_RETRY_BUDGET_MS } from "../commit-retry.js";
import { httpError } from "../../client/api.js";

/** An error shaped the way `httpError` builds one for a commit route. */
function statusError(status: number, retryAfter?: string): Error {
  const headers = new Headers(retryAfter !== undefined ? { "retry-after": retryAfter } : {});
  return httpError(status, JSON.stringify({ error: `${status}: nope` }), headers);
}

/** `fn` that fails with each of `failures` in turn, then answers "ok". */
function failing(...failures: unknown[]): { fn: () => Promise<string>; calls: () => number } {
  let n = 0;
  return {
    fn: async () => {
      const failure = failures[n++];
      if (failure !== undefined) throw failure;
      return "ok";
    },
    calls: () => n,
  };
}

describe("isTransientCommitStatus", () => {
  it("is true for 502, 503, 504 and 429, from the status or the message", () => {
    for (const status of [502, 503, 504, 429]) {
      expect(isTransientCommitStatus(statusError(status)), String(status)).toBe(true);
      expect(isTransientCommitStatus(new Error(`${status}: body`)), `${status} message`).toBe(true);
    }
  });

  it("is false for 500, 413, 409, 401 and anything without a status", () => {
    for (const status of [500, 413, 409, 401, 400]) {
      expect(isTransientCommitStatus(statusError(status)), String(status)).toBe(false);
    }
    expect(isTransientCommitStatus(new Error("fetch failed"))).toBe(false);
    expect(isTransientCommitStatus("503")).toBe(false);
  });

  it("is never true for an abort", () => {
    const abort = new Error("503: upstream aborted");
    expect(isTransientCommitStatus(abort)).toBe(false);
    expect(isTransientCommitStatus(new DOMException("timed out", "TimeoutError"))).toBe(false);
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("Sun, 11 Oct 2026 12:00:00 GMT");

  it("reads delta-seconds", () => {
    expect(retryAfterMs("2", now)).toBe(2000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
  });

  it("reads an IMF-fixdate, and clamps a past one to 0", () => {
    expect(retryAfterMs("Sun, 11 Oct 2026 12:00:03 GMT", now)).toBe(3000);
    expect(retryAfterMs("Sun, 11 Oct 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("is undefined for absent or unreadable values", () => {
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs("", now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs("-1", now)).toBeUndefined();
  });
});

describe("retryCommit", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const transient = { maxRetries: 6, transient: true, random: () => 0 } as const;

  it("a 503 then a 200 succeeds after exactly one retry, once the backoff has passed", async () => {
    const { fn, calls } = failing(statusError(503));
    let settled = false;
    const result = retryCommit(fn, transient).then(v => { settled = true; return v; });

    await vi.advanceTimersByTimeAsync(499);
    expect(calls()).toBe(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(calls()).toBe(2);
  });

  it("a 429 with Retry-After: 2 waits 2 s, not the backoff", async () => {
    const { fn, calls } = failing(statusError(429, "2"));
    const result = retryCommit(fn, transient);

    await vi.advanceTimersByTimeAsync(1999);
    expect(calls(), "no second call before 2 s").toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(calls()).toBe(2);
  });

  it("a Retry-After HTTP-date waits until that date, and a past one retries at once", async () => {
    vi.setSystemTime(Date.parse("Sun, 11 Oct 2026 12:00:00 GMT"));
    const ahead = failing(statusError(503, "Sun, 11 Oct 2026 12:00:03 GMT"));
    const first = retryCommit(ahead.fn, transient);
    await vi.advanceTimersByTimeAsync(2999);
    expect(ahead.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toBe("ok");

    const past = failing(statusError(503, "Sun, 11 Oct 2026 11:00:00 GMT"));
    const second = retryCommit(past.fn, transient);
    await vi.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toBe("ok");
    expect(past.calls()).toBe(2);
  });

  it("caps transient retries at three, inside about 5 s by default", async () => {
    const waits: number[] = [];
    const always503 = vi.fn(async () => { throw statusError(503); });
    const result = retryCommit(always503, {
      maxRetries: 100,
      transient: true,
      random: () => 0,
      sleep: async ms => { waits.push(ms); },
    });

    await expect(result).rejects.toThrow(/^503:/);
    // 500 + 1000 + 2000 = 3.5 s, under the 5 s default; the cap of three stops it.
    expect(waits).toEqual([500, 1000, 2000]);
    expect(always503).toHaveBeenCalledTimes(4);
  });

  it("cuts the last backoff to what is left of a smaller budget", async () => {
    const waits: number[] = [];
    const always503 = vi.fn(async () => { throw statusError(503); });
    await expect(retryCommit(always503, {
      maxRetries: 6,
      transient: true,
      transientBudgetMs: 2_000,
      random: () => 0,
      sleep: async ms => { waits.push(ms); },
    })).rejects.toThrow(/^503:/);
    expect(waits).toEqual([500, 1000, 500]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(2_000);
  });

  it("honours a Retry-After only up to the budget, and never waits past it", async () => {
    const waits: number[] = [];
    const { fn, calls } = failing(statusError(503, "60"), statusError(503, "60"));
    await expect(retryCommit(fn, { ...transient, sleep: async ms => { waits.push(ms); } })).rejects.toThrow(/^503:/);
    expect(waits, "60 s cut to the 5 s budget, then nothing left").toEqual([5_000]);
    expect(calls()).toBe(2);
  });

  it("a Retry-After of 0 still stops after three retries", async () => {
    const always = vi.fn(async () => { throw statusError(429, "0"); });
    await expect(retryCommit(always, { ...transient, sleep: async () => {} })).rejects.toThrow(/^429:/);
    expect(always).toHaveBeenCalledTimes(4);
  });

  it("transientBudgetMs 0 makes exactly one attempt for a 503", async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = failing(statusError(503));
    await expect(retryCommit(fn, { ...transient, transientBudgetMs: 0, sleep })).rejects.toThrow(/^503:/);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it("maxRetries 0 stops conflict retries only; a 503 is still retried on the transient budget", async () => {
    const conflict = failing(new Error("500: write-write conflict"));
    await expect(retryCommit(conflict.fn, { maxRetries: 0, transient: true })).rejects.toThrow(/write-write/);
    expect(conflict.calls()).toBe(1);

    const unavailable = failing(statusError(503, "0"));
    await expect(retryCommit(unavailable.fn, { maxRetries: 0, transient: true, sleep: async () => {} })).resolves.toBe("ok");
    expect(unavailable.calls()).toBe(2);
  });

  it("still retries a lock conflict on its old short backoff", async () => {
    const { fn, calls } = failing(new Error("500: write-write conflict"));
    const result = retryCommit(fn, { maxRetries: 6, transient: false, random: () => 0 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toBe("ok");
    expect(calls()).toBe(2);
  });

  it("never retries 500, 413 or 409", async () => {
    for (const status of [500, 413, 409]) {
      const { fn, calls } = failing(statusError(status));
      await expect(retryCommit(fn, transient), String(status)).rejects.toThrow(new RegExp(`^${status}:`));
      expect(calls(), String(status)).toBe(1);
    }
  });

  it("does not retry a transient status unless asked to", async () => {
    const { fn, calls } = failing(statusError(503, "0"));
    await expect(retryCommit(fn, { maxRetries: 6, transient: false })).rejects.toThrow(/^503:/);
    expect(calls()).toBe(1);
  });

  it("does not retry an abort", async () => {
    const { fn, calls } = failing(new DOMException("This operation was aborted", "AbortError"));
    await expect(retryCommit(fn, transient)).rejects.toThrow(/aborted/);
    expect(calls()).toBe(1);
  });

  it("an abort during the wait rejects promptly, with the commit's own error", async () => {
    const deadline = new AbortController();
    const { fn, calls } = failing(statusError(503, "20"));
    const result = retryCommit(fn, { ...transient, signal: deadline.signal });
    const assertion = expect(result).rejects.toThrow(/^503:/);
    await vi.advanceTimersByTimeAsync(100);
    deadline.abort();
    await assertion;
    expect(calls()).toBe(1);
  });

  it("stops retrying a transient status once the caller has given up", async () => {
    const { fn, calls } = failing(statusError(503, "0"));
    await expect(retryCommit(fn, { ...transient, shouldGiveUp: () => true })).rejects.toThrow(/^503:/);
    expect(calls()).toBe(1);
  });

  it("waits for an async give-up check, and hands it the failure", async () => {
    const { fn, calls } = failing(statusError(503, "0"));
    const shouldGiveUp = vi.fn(async (_err: unknown) => true);
    await expect(retryCommit(fn, { ...transient, shouldGiveUp })).rejects.toThrow(/^503:/);
    expect(calls()).toBe(1);
    expect(String(shouldGiveUp.mock.calls[0][0])).toMatch(/^Error: 503:/);
  });

  it("keeps retrying when the give-up check itself fails", async () => {
    const { fn, calls } = failing(statusError(503, "0"));
    const result = retryCommit(fn, {
      ...transient,
      shouldGiveUp: async () => { throw new Error("probe broke"); },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe("ok");
    expect(calls()).toBe(2);
  });

  it("reports each retry", async () => {
    const onRetry = vi.fn();
    const { fn } = failing(statusError(503, "1"));
    const result = retryCommit(fn, { ...transient, onRetry });
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 1000, kind: "transient" }));
  });
});

// F1 of the #845 review: the budget used to bound only the sleeps, so a 504 on
// a bulk that took minutes could be sent three more times. It now bounds the
// requests too, and a 504 gets at most one re-send.
describe("retryCommit: the transient budget bounds total time", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** `fn` whose every attempt takes `ms` on the (fake) clock, then fails with `failures` in turn, then answers `answer`. */
  function slow<T>(ms: number, failures: unknown[], answer: T): { fn: () => Promise<T>; calls: () => number } {
    let n = 0;
    return {
      fn: () => new Promise<T>((resolve, reject) => {
        const failure = failures[n++];
        setTimeout(() => (failure !== undefined ? reject(failure) : resolve(answer)), ms);
      }),
      calls: () => n,
    };
  }

  /** Run `retryCommit` to completion on the fake clock; the outcome and the time it took. */
  async function run<T>(fn: () => Promise<T>, budget = TRANSIENT_RETRY_BUDGET_MS) {
    const start = Date.now();
    const settled = retryCommit(fn, { maxRetries: 6, transient: true, transientBudgetMs: budget, random: () => 0 })
      .then(value => ({ value, error: undefined as unknown }), (error: unknown) => ({ value: undefined, error }))
      .then(outcome => ({ ...outcome, elapsed: Date.now() - start }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    return settled;
  }

  it("never re-sends a slow 504 bulk: one request, then straight to the caller's fallback", async () => {
    // A proxy timing out a five-minute bulk. The backend is likely still applying it.
    const { fn, calls } = slow(300_000, [statusError(504), statusError(504), statusError(504), statusError(504)], "ok");
    const outcome = await run(fn);
    expect(String(outcome.error)).toMatch(/^Error: 504:/);
    expect(calls(), "no full re-send of a slow bulk").toBe(1);
    expect(outcome.elapsed).toBe(300_000);
  });

  it("re-sends a fast 504 at most once, with budget left for more", async () => {
    expect(GATEWAY_TIMEOUT_MAX_RETRIES).toBe(1);
    const { fn, calls } = slow(10, [statusError(504), statusError(504), statusError(504)], "ok");
    const outcome = await run(fn);
    expect(String(outcome.error)).toMatch(/^Error: 504:/);
    expect(calls()).toBe(2);
  });

  it("a 503 after a 504 is still bounded by the one-504 rule only for 504s", async () => {
    const { fn, calls } = slow(10, [statusError(504), statusError(503)], "ok");
    const outcome = await run(fn);
    expect(outcome.value).toBe("ok");
    expect(calls()).toBe(3);
  });

  it("a 504 the backend applied comes back Idempotent on the re-send, and that is the answer", async () => {
    const { fn, calls } = slow(10, [statusError(504)], { rev: 7, status: "Idempotent" });
    const outcome = await run(fn);
    expect(outcome.value).toEqual({ rev: 7, status: "Idempotent" });
    expect(calls()).toBe(2);
  });

  it("a 504 the backend partly applied comes back 409 on the re-send, which is thrown to the partial-commit handling", async () => {
    const partial = httpError(409, JSON.stringify({
      error: "conflict",
      message: "bulk request is partially committed (1/2 patch IDs)",
      committed_patch_ids: ["a"],
    }), new Headers());
    const { fn, calls } = slow(10, [statusError(504), partial], "ok");
    const outcome = await run(fn);
    expect(outcome.error).toBe(partial);
    expect(calls()).toBe(2);
  });

  it("charges each request to the budget: two 1.5 s attempts and a wait, not four", async () => {
    const { fn, calls } = slow(1_500, Array(10).fill(statusError(503)), "ok");
    const outcome = await run(fn);
    expect(String(outcome.error)).toMatch(/^Error: 503:/);
    // 1.5 s + 0.5 s wait + 1.5 s = 3.5 s; a third attempt would end at 6.5 s.
    expect(calls()).toBe(2);
    expect(outcome.elapsed).toBe(3_500);
  });

  it.each([0, 50, 400, 900, 1_500, 2_400, 3_000, 4_999, 5_000, 20_000, 300_000])(
    "never runs past the budget once a retry is involved (attempts of %i ms)",
    async attemptMs => {
      const { fn, calls } = slow(attemptMs, Array(10).fill(statusError(503)), "ok");
      const outcome = await run(fn);
      expect(outcome.error).toBeDefined();
      // A single attempt is whatever the request takes; anything retried fits the budget.
      if (calls() > 1) expect(outcome.elapsed).toBeLessThanOrEqual(TRANSIENT_RETRY_BUDGET_MS);
      else expect(outcome.elapsed).toBe(attemptMs);
      expect(calls()).toBeLessThanOrEqual(4);
    },
  );

  it("a request longer than the whole budget is never re-sent, even for a 503", async () => {
    const { fn, calls } = slow(TRANSIENT_RETRY_BUDGET_MS, [statusError(503, "0")], "ok");
    const outcome = await run(fn);
    expect(outcome.error).toBeDefined();
    expect(calls()).toBe(1);
  });
});
