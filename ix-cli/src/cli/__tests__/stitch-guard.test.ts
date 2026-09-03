import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  admitStitch,
  admitStitchWaiting,
  cooldownPathForTest,
  outcomeProvesNothingRunning,
  stitchKey,
} from "../stitch-guard.js";
import { namedLockPath } from "../single-flight.js";

const ENDPOINT = "http://localhost:8090";
const OTHER = "http://localhost:9999";

let lockDir: string;
let savedLockDir: string | undefined;
let savedCooldown: string | undefined;

beforeEach(() => {
  // IX_LOCK_DIR, not HOME: single-flight reads it from process.env on every
  // call, so the redirect actually takes effect. (Overriding HOME would not --
  // Windows os.homedir() reads USERPROFILE.)
  lockDir = mkdtempSync(join(tmpdir(), "ix-stitch-guard-"));
  savedLockDir = process.env.IX_LOCK_DIR;
  savedCooldown = process.env.IX_STITCH_COOLDOWN_MS;
  process.env.IX_LOCK_DIR = lockDir;
  delete process.env.IX_STITCH_COOLDOWN_MS;
});

afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("IX_LOCK_DIR", savedLockDir);
  restore("IX_STITCH_COOLDOWN_MS", savedCooldown);
  rmSync(lockDir, { recursive: true, force: true });
});

/** Take an admission and settle it, asserting it was granted. */
function stitchOnce(outcome: { ok: boolean; elapsedMs: number; status?: number | null }): void {
  const a = admitStitch(ENDPOINT);
  expect(a.admitted, "admitStitch refused when the test needed it granted").toBe(true);
  if (a.admitted) a.settle(outcome);
}

describe("outcomeProvesNothingRunning", () => {
  // The guard writes the cooldown when the stitch STARTS, so this function does
  // not decide whether to cool down -- it decides whether we have PROOF that we
  // need not. Only two facts qualify, and neither is an inference from the
  // shape of a failure.

  it("is true for a success", () => {
    expect(outcomeProvesNothingRunning({ ok: true, elapsedMs: 90_000 })).toBe(true);
  });

  it("is true for 501, which is how this codebase spells 'no /v1/stitch'", () => {
    // isStitchUnsupported treats 404 AND 501 as "this backend has no stitch",
    // and the run swallows that silently -- so a marker left behind would refuse
    // every map for 15 minutes claiming a join may still be running, against a
    // backend that has never had one.
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 30, status: 501 })).toBe(true);
  });

  it("is true for a 4xx: the backend refused it rather than ran it", () => {
    // Including a SLOW one. Elapsed covers the request upload, and the stitch
    // payload is megabytes on a large monorepo, so a 413 can arrive tens of
    // seconds in -- the old elapsed rule read that as "cut off mid-join".
    for (const status of [400, 404, 413, 422]) {
      expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 25_000, status })).toBe(true);
    }
  });

  it("is false for 408, which is a proxy saying IT gave up waiting", () => {
    // Says nothing about whether the backend did, and that is the whole bug.
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 60_000, status: 408 })).toBe(false);
  });

  it("is false for a 5xx, a transport error, and an abort alike", () => {
    // The reported case is a 500 at 60s. The others reach here with no status
    // at all, and none of them proves the join stopped.
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 60_000, status: 500 })).toBe(false);
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 60_000, status: 504 })).toBe(false);
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 40, status: null })).toBe(false);
    expect(outcomeProvesNothingRunning({ ok: false, elapsedMs: 40 })).toBe(false);
  });

  it("does not consult the clock at all", () => {
    // Four review rounds of an elapsed-based rule each broke the previous
    // round's version of it. Same status, opposite ends of the clock, one answer.
    for (const elapsedMs of [0, 40, 25_000, 600_000]) {
      expect(outcomeProvesNothingRunning({ ok: false, elapsedMs, status: 413 })).toBe(true);
      expect(outcomeProvesNothingRunning({ ok: false, elapsedMs, status: 500 })).toBe(false);
    }
  });
});

describe("the cooldown is written when the stitch starts", () => {
  it("is on disk before the caller has sent anything", () => {
    // This is the whole design. Every way an attempt can end without a definite
    // refusal -- timeout, abort, deadline, SIGTERM, power cut -- leaves it in
    // place, because leaving it is the default rather than something a dying
    // process must still manage to do.
    const a = admitStitch(ENDPOINT);
    expect(a.admitted).toBe(true);
    expect(existsSync(cooldownPathForTest(ENDPOINT)), "marker must exist before the request").toBe(true);
    if (a.admitted) a.settle({ ok: true, elapsedMs: 30 });
  });

  it("survives a process that is killed mid-stitch and never settles", () => {
    // A hook whose timeout is shorter than the stitch. single-flight's
    // SIGINT/SIGTERM handlers release the lock and exit, so the NEXT map finds
    // the lock free -- and before this design there was no cooldown either,
    // because writing one was something the dying process still had to do. It
    // was admitted, and pushed a second join onto the one still running.
    const killed = admitStitch(ENDPOINT);
    expect(killed.admitted).toBe(true);
    // The signal handler's release(), and then nothing. No settle() call.
    rmSync(namedLockPath("stitch", stitchKey(ENDPOINT)), { force: true });

    const next = admitStitch(ENDPOINT);
    expect(next.admitted).toBe(false);
    if (!next.admitted) {
      expect(next.rule).toBe("cooling");
      expect(next.reason).toContain("never reported back");
    }
  });

  it("is cleared by a success", () => {
    stitchOnce({ ok: true, elapsedMs: 300 });
    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("is cleared by a 4xx, so an older backend with no /v1/stitch keeps working", () => {
    stitchOnce({ ok: false, elapsedMs: 40, status: 404 });
    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("is kept by a 500, and says how long the attempt ran", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });

    const next = admitStitch(ENDPOINT);
    expect(next.admitted).toBe(false);
    if (!next.admitted) {
      expect(next.reason).toContain("62s");
      expect(next.reason).toContain("may still be running");
      expect(next.reason).toContain("IX_STITCH_COOLDOWN_MS=0");
    }
  });

  it("is kept when the run deadline aborts before the request even left", () => {
    // Conservative by construction: no status, so no proof, so the marker
    // stays. The old rules had to distinguish this from a mid-flight abort and
    // got it wrong in both directions across rounds 2, 3 and 4.
    stitchOnce({ ok: false, elapsedMs: 0, status: null });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);
  });
});

describe("cooldown expiry", () => {
  it("admits again once the cooldown has expired", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });

    expect(admitStitch(ENDPOINT, Date.now() + 500).admitted).toBe(false);
    expect(admitStitch(ENDPOINT, Date.now() + 5_000).admitted).toBe(true);
  });

  it("applies a changed IX_STITCH_COOLDOWN_MS to a cooldown already on disk", () => {
    // The refusal message tells the user 0 disables this, so it has to be true
    // of the cooldown they are looking at -- otherwise the only escape is
    // deleting a state file whose name they cannot compute.
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);

    process.env.IX_STITCH_COOLDOWN_MS = "0";
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("a lower value shortens an active cooldown", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    expect(admitStitch(ENDPOINT, Date.now() + 5_000).admitted).toBe(true);
  });

  it("scopes the cooldown to one backend", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    expect(admitStitch(OTHER).admitted).toBe(true);
  });

  it("fails open on an unreadable cooldown record rather than refusing forever", () => {
    writeFileSync(cooldownPathForTest(ENDPOINT), "{not json");
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });
});

describe("admitStitch single-flight", () => {
  it("refuses a second stitch against the same backend while one is unsettled", () => {
    const first = admitStitch(ENDPOINT);
    expect(first.admitted).toBe(true);

    const second = admitStitch(ENDPOINT);
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.rule).toBe("in-flight");

    if (first.admitted) first.settle({ ok: true, elapsedMs: 10 });
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("does not let one backend's in-flight stitch block another backend", () => {
    const first = admitStitch(ENDPOINT);
    expect(first.admitted).toBe(true);
    const other = admitStitch(OTHER);
    expect(other.admitted).toBe(true);

    if (first.admitted) first.settle({ ok: true, elapsedMs: 1 });
    if (other.admitted) other.settle({ ok: true, elapsedMs: 1 });
  });

  it("keys the lock on the endpoint text, not on the directory the command runs in", () => {
    // The map lock canonicalises its key with realpath because it IS a path.
    // An endpoint is not: realpath fails and the fallback resolve() would join
    // it to process.cwd(), so `ix map` run from two directories would take two
    // different "single-flight" locks and stitch twice at once.
    const cwd = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), "ix-stitch-cwd-"));
    try {
      const here = namedLockPath("stitch", ENDPOINT);
      process.chdir(elsewhere);
      expect(namedLockPath("stitch", ENDPOINT)).toBe(here);
    } finally {
      process.chdir(cwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("releases the lock even when the outcome is a failure", () => {
    stitchOnce({ ok: false, elapsedMs: 5, status: 500 });
    expect(readdirSync(lockDir).filter(f => f.endsWith(".lock"))).toEqual([]);
  });
});

describe("stitchKey", () => {
  it("folds the spellings of one local backend together", () => {
    const canonical = stitchKey("http://localhost:8090");
    expect(stitchKey("http://localhost:8090/")).toBe(canonical);
    expect(stitchKey("http://127.0.0.1:8090")).toBe(canonical);
    expect(stitchKey("HTTP://LOCALHOST:8090")).toBe(canonical);
  });

  it("treats a default port and an explicit one as one backend", () => {
    // The WHATWG URL parser strips a default port, so both spellings give
    // port === "" and this needs no defaults table of its own. Pinned because
    // the absence of one reads like an omission -- and because if the parser
    // ever stopped doing it, one backend would get two locks and two cooldowns,
    // which is exactly the concurrency stitchKey exists to prevent.
    expect(stitchKey("https://ix.example")).toBe(stitchKey("https://ix.example:443"));
    expect(stitchKey("http://ix.example")).toBe(stitchKey("http://ix.example:80"));
    expect(stitchKey("http://ix.example")).not.toBe(stitchKey("https://ix.example"));
  });

  it("keeps genuinely different backends apart", () => {
    expect(stitchKey("http://localhost:8090")).not.toBe(stitchKey("http://localhost:9090"));
    expect(stitchKey("http://localhost:8090")).not.toBe(stitchKey("http://ix.example:8090"));
    expect(stitchKey("http://localhost:8090/a")).not.toBe(stitchKey("http://localhost:8090/b"));
  });

  it("passes through something that is not a URL rather than refusing to guard", () => {
    expect(stitchKey("not a url")).toBe("not a url");
  });

  it("gives two spellings of one backend one lock", () => {
    const first = admitStitch("http://localhost:8090");
    expect(first.admitted).toBe(true);
    expect(admitStitch("http://127.0.0.1:8090/").admitted).toBe(false);

    if (first.admitted) first.settle({ ok: true, elapsedMs: 1 });
  });
});

describe("the cooldown is read while holding the lock, not before it", () => {
  it("has no window in which a stale read can admit a second stitch", () => {
    // A read-then-lock order leaves a gap: a waiter reads "no cooldown", the
    // holder writes one and releases, the waiter takes the freed lock and
    // sends the second concurrent stitch. Reading under the lock closes it by
    // construction -- there is no interleaving to test, which is the point.
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);
    if (holder.admitted) holder.settle({ ok: false, elapsedMs: 62_000, status: 500 });

    const waiter = admitStitch(ENDPOINT);
    expect(waiter.admitted).toBe(false);
    if (!waiter.admitted) expect(waiter.rule).toBe("cooling");
    expect(readdirSync(lockDir).filter(f => f.endsWith(".lock")), "refusal must not leak a lock").toEqual([]);
  });

  it("tells a LIVE holder apart from a finished one, which is what the lock is for", () => {
    // Both states have a marker on disk. Only the lock distinguishes them, and
    // they want opposite answers: wait for the first, refuse the second.
    const live = admitStitch(ENDPOINT);
    expect(live.admitted).toBe(true);

    const duringFlight = admitStitch(ENDPOINT);
    expect(duringFlight.admitted).toBe(false);
    if (!duringFlight.admitted) expect(duringFlight.rule).toBe("in-flight");

    if (live.admitted) live.settle({ ok: false, elapsedMs: 62_000, status: 500 });

    const afterFlight = admitStitch(ENDPOINT);
    expect(afterFlight.admitted).toBe(false);
    if (!afterFlight.admitted) expect(afterFlight.rule).toBe("cooling");
  });
});

describe("admitStitchWaiting", () => {
  it("waits out a stitch that is merely in flight rather than shedding it", async () => {
    // On a healthy backend a stitch is over in tens of milliseconds, and two
    // maps overlapping by that much is ordinary. Shedding there loses that
    // workspace's registration until somebody re-ingests every file.
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);

    let slept = 0;
    const sleep = async (ms: number): Promise<void> => {
      slept += ms;
      if (slept >= 500 && holder.admitted) holder.settle({ ok: true, elapsedMs: 30 });
    };

    const second = await admitStitchWaiting(ENDPOINT, 30_000, sleep);
    expect(second.admitted, "should have waited for the holder to finish").toBe(true);
    if (second.admitted) second.settle({ ok: true, elapsedMs: 30 });
  });

  it("gives up once the budget is spent, so an unhealthy backend still sheds", async () => {
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);

    const second = await admitStitchWaiting(ENDPOINT, 1_000, async () => {});
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.reason).toContain("already stitching");
  });

  it("never waits on a cooldown — outlasting the last stitch is the point", async () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });

    let slept = 0;
    const result = await admitStitchWaiting(ENDPOINT, 30_000, async (ms) => { slept += ms; });

    expect(result.admitted).toBe(false);
    expect(slept, "waited on a cooldown").toBe(0);
  });

  it("refuses outright when the run deadline has ALREADY fired, without marking", async () => {
    // Admission writes the cooldown marker and fetch then rejects instantly on
    // the aborted signal -- so admitting here blocks the backend for 15 minutes
    // over a request that never left the process. And it repeats: the stitch is
    // the last thing an ingest does, so a run that routinely overruns would
    // block its own next attempt every time and never stitch again.
    const result = await admitStitchWaiting(ENDPOINT, 30_000, async () => {}, { aborted: true });

    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.rule).toBe("deadline");
    expect(existsSync(cooldownPathForTest(ENDPOINT)), "must not mark the backend").toBe(false);
    expect(readdirSync(lockDir).filter(f => f.endsWith(".lock"))).toEqual([]);
  });

  it("stops waiting when the run deadline fires WHILE it is waiting", async () => {
    // The signal flips mid-wait, which is the case the in-loop check is for --
    // and the reason it has to be read through a call rather than a property
    // access TypeScript will narrow to a constant.
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);
    const budget = { aborted: false };

    let slept = 0;
    const result = await admitStitchWaiting(ENDPOINT, 30_000, async (ms) => {
      slept += ms;
      budget.aborted = true;       // the run runs out mid-wait
      if (holder.admitted) holder.settle({ ok: true, elapsedMs: 5 });  // ...and the holder frees the lock
    }, budget);

    // Admitting here would mark the backend for 15 minutes over a request that
    // cannot leave: fetch rejects instantly on the aborted deadline, with no
    // status, so the marker stays. The refusal must also name the real cause --
    // reporting "in-flight" sends the user to the wrong remedy entirely.
    expect(result.admitted).toBe(false);
    if (!result.admitted) expect(result.rule).toBe("deadline");
    expect(existsSync(cooldownPathForTest(ENDPOINT)), "must not mark the backend").toBe(false);
    expect(slept, "should have stopped after the first poll").toBeLessThan(1_000);
  });
});
