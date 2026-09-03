import { describe, expect, it } from "vitest";
import {
  commitFailureLimit,
  createCommitBreaker,
  describeCommitCutoff,
} from "../commit-breaker.js";

describe("commitFailureLimit", () => {
  it("defaults to 5", () => {
    expect(commitFailureLimit(undefined)).toBe(5);
    expect(commitFailureLimit("")).toBe(5);
  });

  it("takes a caller's limit", () => {
    expect(commitFailureLimit("2")).toBe(2);
  });

  it("treats 0 as a deliberate opt-out, not as a bad value", () => {
    // The difference matters: falling back to the default here would make
    // IX_COMMIT_FAILURE_LIMIT=0 silently keep the cutoff, so a user who needs
    // every patch attempted has no way to say so.
    expect(commitFailureLimit("0")).toBe(0);
  });

  it("falls back on a value that is not a non-negative integer", () => {
    expect(commitFailureLimit("-1")).toBe(5);
    expect(commitFailureLimit("many")).toBe(5);
    // parseInt stopped at the first non-digit, so "0.5" read as 0 -- silently
    // DISABLING the cutoff, which is the opposite of a conservative fallback.
    expect(commitFailureLimit("0.5")).toBe(5);
  });

  it("reads a value parseInt would have truncated", () => {
    // "1e3" is 1000, and parseInt made it 1 -- a cutoff that trips on the very
    // first failure. Number() reads what was written.
    expect(commitFailureLimit("1e3")).toBe(1000);
  });
});

describe("createCommitBreaker", () => {
  it("does not trip before the limit is reached", () => {
    const b = createCommitBreaker(3);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    expect(b.tripped()).toBe(false);
    expect(b.consecutiveFailures()).toBe(2);
  });

  it("trips on the Nth consecutive failure", () => {
    const b = createCommitBreaker(3);
    for (const m of ["a", "b", "c"]) b.recordFailure(new Error(m));
    expect(b.tripped()).toBe(true);
  });

  it("counts CONSECUTIVE failures, so one success clears the streak", () => {
    // The distinction is the whole point. A handful of patches that fail for
    // their own reasons, interleaved with commits that land, is a backend that
    // is working — abandoning the rest of the run there would lose real work.
    const b = createCommitBreaker(3);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    b.recordSuccess();
    b.recordFailure(new Error("c"));
    b.recordFailure(new Error("d"));
    expect(b.tripped()).toBe(false);
    expect(b.consecutiveFailures()).toBe(2);
  });

  it("never trips at limit 0", () => {
    const b = createCommitBreaker(0);
    for (let i = 0; i < 100; i++) b.recordFailure(new Error(String(i)));
    expect(b.tripped()).toBe(false);
  });

  it("stays tripped once tripped, even after a later success", () => {
    // Latching, not a view of the current streak. Other code has already acted
    // on the decision: a chunk that split on a 413 can have its first half
    // abandoned and counted as errors, and then its second half succeed --
    // leaving a run that abandoned patches but claims it never gave up.
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    expect(b.tripped()).toBe(true);

    b.recordSuccess();
    expect(b.tripped()).toBe(true);
    expect(b.consecutiveFailures()).toBe(0);
  });

  it("counts the patches abandoned because it was already tripped", () => {
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("a"));
    b.recordSkipped(17);
    b.recordSkipped();
    expect(b.skipped()).toBe(18);
  });
});

describe("describeCommitCutoff", () => {
  it("names the count, the endpoint, what was not sent, and the error", () => {
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("500: transaction begin timeout"));
    b.recordFailure(new Error("500: transaction begin timeout"));
    b.recordSkipped(17);

    const msg = describeCommitCutoff(b, "http://localhost:8090");
    // The configured limit, not the live streak: requests already in flight when
    // the breaker tripped keep landing and keep incrementing it, so the streak
    // is whatever the race produced and does not match IX_COMMIT_FAILURE_LIMIT.
    b.recordFailure(new Error("a straggler that landed after the decision"));
    expect(describeCommitCutoff(b, "e")).toContain("2 consecutive failures");
    expect(msg).toContain("2 consecutive failures");
    expect(msg).toContain("http://localhost:8090");
    expect(msg).toContain("17 further patches were not sent");
    expect(msg).toContain("transaction begin timeout");
    expect(msg).toContain("IX_COMMIT_FAILURE_LIMIT=0");
  });

  it("does not claim the graph is unchanged when patches landed before it stopped", () => {
    // A backend can start refusing part-way through a large ingest. Saying "the
    // graph is unchanged" then contradicts the summary printed right beneath.
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("x"));
    b.recordSkipped(3);

    expect(describeCommitCutoff(b, "e", 0)).toContain("The graph is unchanged.");

    const partial = describeCommitCutoff(b, "e", 40);
    expect(partial).not.toContain("The graph is unchanged");
    expect(partial).toContain("40 patches landed before it stopped");
  });

  it("says 'patch was' for one and 'patches were' for many", () => {
    const one = createCommitBreaker(1);
    one.recordFailure(new Error("x"));
    one.recordSkipped(1);
    expect(describeCommitCutoff(one, "e")).toContain("1 further patch was not sent");
  });

  it("truncates a long body rather than pasting an HTML error page into the summary", () => {
    // Ix#528: the observed failure was a proxy 504 whose body is a full HTML
    // page. describeStitchFailure already refuses to echo those; this message
    // quotes the error because the exact text is the diagnostic, so it caps it.
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("x".repeat(5000)));
    const msg = describeCommitCutoff(b, "e");
    expect(msg.length).toBeLessThan(1000);
    expect(msg).toContain("…");
  });
});
