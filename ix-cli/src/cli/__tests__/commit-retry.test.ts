// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTransientCommitStatus, retryAfterMs, retryCommit } from "../commit-retry.js";
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

  it("caps total waiting at about 30 s: repeated 503s give up when the next backoff would pass it", async () => {
    const waits: number[] = [];
    const always503 = vi.fn(async () => { throw statusError(503); });
    const result = retryCommit(always503, {
      maxRetries: 100,
      transient: true,
      random: () => 0,
      sleep: async ms => { waits.push(ms); },
    });

    await expect(result).rejects.toThrow(/^503:/);
    // 500 + 1000 + 2000 + 4000 + 8000 = 15.5 s; the next, 16 s, would reach 31.5 s.
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(always503).toHaveBeenCalledTimes(6);
  });

  it("a Retry-After longer than the budget fails at once, without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const { fn, calls } = failing(statusError(503, "60"));
    await expect(retryCommit(fn, { ...transient, sleep })).rejects.toThrow(/^503:/);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it("maxRetries 0 makes exactly one attempt, for a conflict and for a 503", async () => {
    const conflict = failing(new Error("500: write-write conflict"));
    await expect(retryCommit(conflict.fn, { maxRetries: 0, transient: true })).rejects.toThrow(/write-write/);
    expect(conflict.calls()).toBe(1);

    const unavailable = failing(statusError(503, "0"));
    await expect(retryCommit(unavailable.fn, { maxRetries: 0, transient: true })).rejects.toThrow(/^503:/);
    expect(unavailable.calls()).toBe(1);
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
