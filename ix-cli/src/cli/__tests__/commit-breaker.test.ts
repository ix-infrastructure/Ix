import { describe, expect, it } from "vitest";
import {
  commitFailureLimit,
  createCommitBreaker,
  createDrainGate,
  describeCommitCutoff,
  drainFailureBudget,
  drainInPasses,
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

  it("reads an absurdly large value as 'never trip', not as the default", () => {
    // It matches /^\d+$/ and the intent is unmistakable. Falling back gave them
    // the TIGHTEST cutoff instead -- the one direction where guessing wrong
    // loses writes.
    expect(commitFailureLimit("99999999999999999999")).toBe(Number.MAX_SAFE_INTEGER);
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

describe("everTripped", () => {
  it("is false until the limit is reached", () => {
    const b = createCommitBreaker(3);
    b.recordFailure(new Error("x"));
    b.recordFailure(new Error("x"));
    expect(b.everTripped()).toBe(false);
  });

  it("stays true after a success un-trips the breaker", () => {
    // This is the whole difference from `tripped()`. The diagnosis has to print
    // for a run that gave up and then recovered: the 12-file reproduction at
    // the default limit held 7 patches, the drain placed all 7, and gating on
    // the leftovers meant the user saw the generic "all 12 failed to commit,
    // re-run with --verbose" and no explanation of why `ix doctor` passes.
    const b = createCommitBreaker(2);
    b.recordFailure(new Error("x"));
    b.recordFailure(new Error("x"));
    expect(b.tripped()).toBe(true);

    b.recordSuccess();
    expect(b.tripped()).toBe(false);
    expect(b.everTripped()).toBe(true);
  });

  it("survives reset, which only clears the current streak", () => {
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("x"));
    b.reset();
    expect(b.tripped()).toBe(false);
    expect(b.everTripped()).toBe(true);
  });

  it("never becomes true at limit 0", () => {
    const b = createCommitBreaker(0);
    for (let i = 0; i < 50; i++) b.recordFailure(new Error("x"));
    expect(b.everTripped()).toBe(false);
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

  it("stops a REPLAY on a spent budget by counting it, never by holding it", () => {
    // Stopping is right -- a 409 naming 999 landed ids would otherwise send 999
    // serialized doomed commits while holding the fallback mutex -- but HOLDING
    // is not how to stop. The only consumer turns everything it holds into a
    // commit error, so this used to report writes the server had CONFIRMED as
    // failures and suppress the mtime baseline over them.
    expect(perFileAction({ replay: true, tripped: false, budgetLeft: 0 })).toBe("count-applied");
    expect(perFileAction({ replay: true, tripped: true, budgetLeft: 0 })).toBe("count-applied");
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

describe("drainInPasses", () => {
  /**
   * A driver standing in for the per-file loop.
   *
   * The budget defaults to `drainFailureBudget()` -- the number `ingest.ts`
   * actually passes -- and every test below uses it. An earlier version of this
   * file hardcoded 10 while the CLI ran at 5, so the stranding guarantee was
   * asserted only in a regime that does not exist and a review found it failing
   * in the one that does.
   */
  function driver(bad: ReadonlySet<string>, budget = drainFailureBudget()) {
    const sent: string[] = [];
    const placed: string[] = [];
    const attempt = async (items: string[]) => {
      let left = budget;
      let placedHere = 0;
      for (let i = 0; i < items.length; i++) {
        sent.push(items[i]);
        if (bad.has(items[i])) {
          left--;
          if (left <= 0) return { placed: placedHere > 0, unreached: items.slice(i + 1) };
        } else {
          placed.push(items[i]);
          placedHere++;
        }
      }
      return { placed: placedHere > 0, unreached: [] };
    };
    return { attempt, sent, placed };
  }

  const range = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

  it("uses the budget the CLI passes", () => {
    // The whole point of sharing this: a test that picks its own budget can
    // pass while the shipped configuration loses writes.
    expect(drainFailureBudget(commitFailureLimit())).toBe(5);
    expect(drainFailureBudget(0)).toBe(1);
  });

  it("walks the whole set from the far end when nothing fails", async () => {
    const d = driver(new Set());
    expect(await drainInPasses(["a", "b", "c"], d.attempt)).toEqual([]);
    // Reversed: the fan-out stopped INSIDE whatever run of bad patches tripped
    // it, so the rest of that run is the first thing in the held set.
    expect(d.sent).toEqual(["c", "b", "a"]);
  });

  it("stops a dead backend after three passes — tail, head, middle", async () => {
    // The amplification #560 is about. Three samples, none of them placing
    // anything, is the bar; two only ever cover the ends.
    const held = range("p", 500);
    const d = driver(new Set(held));
    const leftover = await drainInPasses(held, d.attempt);

    expect(d.sent).toHaveLength(3 * drainFailureBudget());
    expect(leftover).toHaveLength(500 - 3 * drainFailureBudget());
  });

  it("strands nothing when clusters sit at BOTH ends of the held set", async () => {
    // Two passes can only sample the two ends, so `[b x 5, g x 400, B x 10]`
    // defeated the previous rule outright: the tail pass walks into B, the head
    // pass into b, neither places anything, and all 400 committable patches
    // between them were handed back unsent -- on a healthy backend, and then
    // repeated on every later run, since the mtime baseline is not written when
    // a run has commit errors. The third pass starts in the middle.
    const bad = new Set([...range("b", 5), ...range("B", 10)]);
    const held = [...range("b", 5), ...range("g", 400), ...range("B", 10)];
    const d = driver(bad);

    expect(await drainInPasses(held, d.attempt)).toEqual([]);
    expect(d.placed).toHaveLength(400);
  });

  it("does not treat a pass that placed nothing as proof, when it stopped EARLY", async () => {
    // Held [g1..g400, b1..b15] reverses to [b15..b1, g400..g1], so the first
    // pass meets the bad patches immediately and places nothing. Stopping there
    // reported all 400 committable patches as errors without sending one, and
    // since the mtime baseline is not written on a run with commit errors the
    // next `ix map` reproduced it exactly, forever.
    const held = [...range("g", 400), ...range("b", 15)];
    const d = driver(new Set(range("b", 15)));

    expect(await drainInPasses(held, d.attempt)).toEqual([]);
    expect(d.placed).toHaveLength(400);
  });

  it("strands nothing when the bad patches form TWO clusters", async () => {
    const bad = [...range("b", 15)];
    const held = [...bad.slice(0, 5), ...range("g", 400), ...bad.slice(5), ...range("h", 485)];
    const d = driver(new Set(bad));

    expect(await drainInPasses(held, d.attempt)).toEqual([]);
    expect(d.placed).toHaveLength(885);
  });

  it("strands nothing for a cluster LONGER than the budget", async () => {
    const held = [...range("g", 400), ...range("B", 25), ...range("h", 485)];
    const d = driver(new Set(range("B", 25)));

    expect(await drainInPasses(held, d.attempt)).toEqual([]);
    expect(d.placed).toHaveLength(885);
  });

  it("strands nothing with FAR more bad patches than any pass cap would allow", async () => {
    // The case a pass cap could not survive, and the reason there is no longer
    // one. Capped at three passes of five, the walk could get past at most 15
    // failing patches; a 1,000-patch held set with 20 scattered bad ones placed
    // 686 and handed back 294 committable patches unsent -- a net loss against
    // `main`, which fans out and commits all 980.
    const bad = new Set(range("b", 20));
    const held = Array.from({ length: 1000 }, (_, i) =>
      i % 50 === 49 ? `b${Math.floor(i / 50) + 1}` : `g${i}`,
    );
    const d = driver(bad);

    const leftover = await drainInPasses(held, d.attempt);

    expect(leftover).toEqual([]);
    expect(d.placed.filter(x => !bad.has(x))).toHaveLength(980);
    // And it costs no more requests than `main` would have sent.
    expect(d.sent.length).toBeLessThanOrEqual(held.length);
  });

  it("strands nothing when clusters alternate with the budget the whole way", async () => {
    const bad = new Set(range("b", 24));
    const held = [
      ...Array.from({ length: 4 }, (_, k) => [...range("g", 50).map(x => `${x}_${k}`), ...range("b", 6).map((_, i) => `b${k * 6 + i + 1}`)]).flat(),
      ...range("z", 50),
    ];
    const d = driver(bad);

    expect(await drainInPasses(held, d.attempt)).toEqual([]);
    expect(d.placed.filter(x => !bad.has(x))).toHaveLength(250);
  });

  it("keeps going while the backend takes anything, at no more cost than main", async () => {
    // The trade-off, pinned so it is a decision rather than a surprise. A
    // backend that accepts one write and refuses the other 994 is never stopped
    // by the drain: each pass eats `budget` of the refusing patches, so it runs
    // ~199 passes. That is not a regression -- `main` sends one request per
    // patch for all 995 and has no cutoff at all -- and the alternative, a cap
    // on failures, hands back committable patches unsent, which is a real loss
    // where this is only slowness.
    const held = range("p", 995);
    const bad = new Set(held.slice(1));
    const d = driver(bad);

    await drainInPasses(held, d.attempt);

    expect(d.placed).toEqual([held[0]]);
    // Never more than one request per held patch.
    expect(d.sent.length).toBeLessThanOrEqual(held.length);
    // And no patch is attempted twice.
    expect(new Set(d.sent).size).toBe(d.sent.length);
  });

  it("does not call the backend at all for an empty held set", async () => {
    const d = driver(new Set());
    expect(await drainInPasses([], d.attempt)).toEqual([]);
    expect(d.sent).toEqual([]);
  });
});

describe("createDrainGate", () => {
  it("opens for the first held set of the run", () => {
    expect(createDrainGate().shouldDrain(0)).toBe(true);
  });

  it("stays open after one drain that placed nothing", () => {
    // One miss is a few-second fast-rejecting blip. Closing on it strands the
    // next batch's held patches with no drain at all.
    const gate = createDrainGate();
    gate.record(false, 0);
    expect(gate.shouldDrain(0)).toBe(true);
  });

  it("closes after two in a row that placed nothing", () => {
    const gate = createDrainGate();
    gate.record(false, 0);
    gate.record(false, 0);
    expect(gate.shouldDrain(0)).toBe(false);
  });

  it("a drain that placed something clears the streak", () => {
    const gate = createDrainGate();
    gate.record(false, 0);
    gate.record(true, 12);
    gate.record(false, 12);
    expect(gate.shouldDrain(12)).toBe(true);
  });

  it("REOPENS once a patch lands after it closed", () => {
    // The finding this exists for. A thirty-second blip in batches 3 and 4
    // closed the gate for the whole run, so a hold at batch 30 -- against a
    // backend that had since committed nineteen thousand patches -- had its
    // patches counted as errors and never sent. The reset used to live inside
    // the branch the flag disables, so nothing could ever reopen it.
    const gate = createDrainGate();
    gate.record(false, 100);
    gate.record(false, 100);
    expect(gate.shouldDrain(100)).toBe(false);

    expect(gate.shouldDrain(19_000)).toBe(true);
  });

  it("re-closes if the backend goes back to placing nothing", () => {
    const gate = createDrainGate();
    gate.record(false, 100);
    gate.record(false, 100);
    expect(gate.shouldDrain(19_000)).toBe(true);

    gate.record(false, 19_000);
    gate.record(false, 19_000);
    expect(gate.shouldDrain(19_000)).toBe(false);
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
    // Deliberately no count in the headline. The fan-out stops on a streak of
    // `limit`, the drain on a per-pass budget of `limit`, and this banner
    // prints for both -- so any single number it names is wrong for one of them.
    b.recordFailure(new Error("a straggler that landed after the decision"));
    expect(msg).not.toContain("consecutive");
    expect(msg).toContain("kept failing");
    expect(msg).toContain("http://localhost:8090");
    expect(msg).toContain("17 patches were not sent");
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
    expect(partial).toContain("40 other patches did land");
    // No ordering claim. A cutoff holds patches and the run continues, so there
    // is no single moment it "stopped": a run that tripped in batch 1,
    // recovered, and committed 19,000 more would have claimed all 19,000
    // landed "before it stopped".
    expect(partial).not.toContain("before it stopped");
  });

  it("names both causes rather than sending everyone to the database", () => {
    // The memory layer answers 500 for a saturated ArangoDB AND for a patch
    // body it will not accept -- verified against the released image -- so the
    // CLI cannot tell them apart. Asserting the database is the cause sends a
    // user with a rejected patch to `docker stats` and `/_api/query/current`.
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("500: {\"error\":\"internal_error\"}"));
    b.recordSkipped(2);

    const msg = describeCommitCutoff(b, "http://localhost:8090", 5);
    expect(msg).toContain("Either the database cannot keep up");
    expect(msg).toContain("rejecting these");
    expect(msg).toContain("says which");
  });

  it("drops the unsent line entirely when the drain placed everything", () => {
    // The banner prints whenever the cutoff FIRED, and the drain may since have
    // sent every patch it held. Saying "0 patches were not sent", or claiming
    // the run stopped committing, would both be false on the one message whose
    // job is saying what happened.
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("500: transaction begin timeout"));

    const msg = describeCommitCutoff(b, "http://localhost:8090", 12);
    expect(b.skipped()).toBe(0);
    expect(msg).not.toContain("not sent");
    expect(msg).not.toContain("Stopped committing");
    expect(msg).toContain("kept failing");
    expect(msg).toContain("transaction begin timeout");
  });

  it("drops the unsent attribution when the run also ran out of time", () => {
    // The deadline branch of describeCommitOutcome owns what to do about the
    // missing patches, and the two must not contradict. A cutoff that fired
    // BEFORE the clock has already called recordSkipped, so without this the
    // banner printed "N were not sent - sending them one at a time would have
    // added load to a backend that is already the reason they fail" directly
    // above "Ingest ran out of time: raise IX_MAP_DEADLINE_MS". The diagnosis
    // is still worth printing; the attribution of the count is not.
    const b = createCommitBreaker(1);
    b.recordFailure(new Error("500: transaction begin timeout"));
    b.recordSkipped(400);

    const msg = describeCommitCutoff(b, "e", 0, true);
    expect(msg).not.toContain("added load");
    expect(msg).toContain("transaction begin timeout");
    // But it still NAMES the count. Dropping the line entirely handed the
    // cutoff's 400 to the clock, and the deadline message that prints next
    // points at IX_MAP_DEADLINE_MS -- the wrong fix for patches deliberately
    // withheld from a refusing backend.
    expect(msg).toContain("400 of them were withheld by this cutoff");
    expect(describeCommitCutoff(b, "e", 0, false)).toContain("400 patches were not sent");
  });

  it("says 'patch was' for one and 'patches were' for many", () => {
    const one = createCommitBreaker(1);
    one.recordFailure(new Error("x"));
    one.recordSkipped(1);
    expect(describeCommitCutoff(one, "e")).toContain("1 patch was not sent");
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
