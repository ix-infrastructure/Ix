import { describe, expect, it } from "vitest";
import {
  commitFailureLimit,
  createCommitBreaker,
  describeCommitCutoff,
  perFileAction,
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

  it("falls back on the shapes parseInt and Number each got wrong", () => {
    // parseInt read "1e3" as 1 -- a cutoff tripping on the very first failure --
    // and Number reads it as 1000. Neither is what someone typing it meant, and
    // guessing is worse than the documented default. Same for the values Number
    // quietly coerces to 0, which would DISABLE the cutoff: the opposite of a
    // conservative fallback.
    expect(commitFailureLimit("1e3")).toBe(5);
    expect(commitFailureLimit("0x10")).toBe(5);
    expect(commitFailureLimit("  ")).toBe(5);
    expect(commitFailureLimit(" 3 ")).toBe(5);
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

  it("stays tripped across further failures", () => {
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    expect(b.tripped()).toBe(true);
    b.recordFailure(new Error("c"));
    expect(b.tripped()).toBe(true);
  });

  it("un-trips on a success, because that is direct evidence the backend is alive", () => {
    // A permanent latch is the worse bug now that patches are held and re-sent
    // rather than abandoned: after one trip, a backend that recovered completely
    // still had every DELETION patch dropped for the rest of the run, since
    // those never go through the bulk path that would have proved it healthy.
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    expect(b.tripped()).toBe(true);

    b.recordSuccess();
    expect(b.tripped()).toBe(false);
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

describe("reset, which is what the end-of-run retry runs on", () => {
  it("un-latches and clears the streak", () => {
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    expect(b.tripped()).toBe(true);

    b.reset();
    expect(b.tripped()).toBe(false);
    expect(b.consecutiveFailures()).toBe(0);
  });

  it("keeps skipped() cumulative, because the report spans the whole run", () => {
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("a"));
    b.recordSkipped(7);
    b.reset();
    b.recordSkipped(3);
    expect(b.skipped()).toBe(10);
  });

  it("re-trips after the same number of failures, so the retry stays bounded", () => {
    // This is why the retry is not a bypass: a backend that really is refusing
    // everything gets N more attempts, not one per held-back patch.
    const b = createCommitBreaker(3);
    for (const m of ["a", "b", "c"]) b.recordFailure(new Error(m));
    b.reset();

    b.recordFailure(new Error("d"));
    b.recordFailure(new Error("e"));
    expect(b.tripped()).toBe(false);
    b.recordFailure(new Error("f"));
    expect(b.tripped()).toBe(true);
  });

  it("lets a success during the retry keep it un-tripped", () => {
    // The false-trip case: the held-back patches are fine, so they commit and
    // the streak never rebuilds.
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("a"));
    b.recordFailure(new Error("b"));
    b.reset();

    b.recordFailure(new Error("c"));
    b.recordSuccess();
    b.recordFailure(new Error("d"));
    expect(b.tripped()).toBe(false);
  });
});

describe("perFileAction", () => {
  // Every revision of this decision that could not be driven directly grew a
  // defect only an end-to-end run would show. These are those defects.

  it("sends when nothing says otherwise", () => {
    expect(perFileAction({ replay: false, tripped: false })).toBe("send");
    expect(perFileAction({ replay: false, tripped: false, budgetLeft: 3 })).toBe("send");
  });

  it("holds on a trip when the caller has no budget", () => {
    expect(perFileAction({ replay: false, tripped: true })).toBe("hold");
  });

  it("ignores the streak when the caller gave a budget", () => {
    // The bug this exists for: with both live, the streak trips at `limit` long
    // before a budget of `2 * limit` can bind, so the budget was inert and the
    // drain still stranded every good patch sitting behind a run of bad ones.
    expect(perFileAction({ replay: false, tripped: true, budgetLeft: 3 })).toBe("send");
  });

  it("holds once the budget is spent", () => {
    expect(perFileAction({ replay: false, tripped: false, budgetLeft: 0 })).toBe("hold");
    expect(perFileAction({ replay: false, tripped: true, budgetLeft: 0 })).toBe("hold");
  });

  it("holds a REPLAY too once the budget is spent", () => {
    // A 409 naming 999 landed ids would otherwise send 999 serialized doomed
    // commits while holding the fallback mutex, so nothing else could even trip
    // the breaker.
    expect(perFileAction({ replay: true, tripped: false, budgetLeft: 0 })).toBe("hold");
  });

  it("stops a replay on a trip by counting it, never by holding it", () => {
    // Those patches are confirmed landed by the server's own 409 body. Holding
    // them would drop them from the counters and let the cutoff report "The
    // graph is unchanged" for a run whose patches are all in the graph.
    expect(perFileAction({ replay: true, tripped: true })).toBe("count-applied");
  });

  it("still sends a replay while nothing has given up", () => {
    // An earlier revision folded the replay check into the tripped check and
    // inverted it, so nothing was ever held back at all.
    expect(perFileAction({ replay: true, tripped: false })).toBe("send");
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
    expect(describeCommitCutoff(b, "e")).toContain("after 2 failures");
    // Not "consecutive": the fan-out stops on a streak but the end-of-run retry
    // stops on a total budget, and this banner prints for both.
    expect(msg).not.toContain("consecutive");
    expect(msg).toContain("after 2 failures");
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
