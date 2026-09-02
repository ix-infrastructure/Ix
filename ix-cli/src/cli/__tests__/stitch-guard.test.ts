import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  admitStitch,
  admitStitchWaiting,
  cooldownPathForTest,
  failureMayStillBeRunning,
  stitchKey,
} from "../stitch-guard.js";
import { namedLockPath } from "../single-flight.js";

const ENDPOINT = "http://localhost:8090";
const OTHER = "http://localhost:9999";

let lockDir: string;
let savedLockDir: string | undefined;
let savedCooldown: string | undefined;
let savedSlow: string | undefined;

beforeEach(() => {
  // IX_LOCK_DIR, not HOME: single-flight reads it from process.env on every
  // call, so the redirect actually takes effect. (Overriding HOME would not --
  // Windows os.homedir() reads USERPROFILE.)
  lockDir = mkdtempSync(join(tmpdir(), "ix-stitch-guard-"));
  savedLockDir = process.env.IX_LOCK_DIR;
  savedCooldown = process.env.IX_STITCH_COOLDOWN_MS;
  savedSlow = process.env.IX_STITCH_SLOW_FAILURE_MS;
  process.env.IX_LOCK_DIR = lockDir;
  delete process.env.IX_STITCH_COOLDOWN_MS;
  delete process.env.IX_STITCH_SLOW_FAILURE_MS;
});

afterEach(() => {
  const restore = (k: string, v: string | undefined): void => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore("IX_LOCK_DIR", savedLockDir);
  restore("IX_STITCH_COOLDOWN_MS", savedCooldown);
  restore("IX_STITCH_SLOW_FAILURE_MS", savedSlow);
  rmSync(lockDir, { recursive: true, force: true });
});

/** Take an admission and settle it, asserting it was granted. */
function stitchOnce(outcome: { ok: boolean; elapsedMs: number; aborted?: boolean }): void {
  const a = admitStitch(ENDPOINT);
  expect(a.admitted, "admitStitch refused when the test needed it granted").toBe(true);
  if (a.admitted) a.settle(outcome);
}

describe("failureMayStillBeRunning", () => {
  it("is false for success", () => {
    expect(failureMayStillBeRunning({ ok: true, elapsedMs: 90_000 }, 20_000)).toBe(false);
  });

  it("is false for a failure fast enough that the backend never started the join", () => {
    // The 404 an older backend answers with, and any 4xx from a proxy. Treating
    // these as "still running" would put every pre-stitch backend into a
    // 15-minute cooldown for a call it was never going to serve.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 40 }, 20_000)).toBe(false);
  });

  it("is true for a failure that took long enough to have been cut off mid-join", () => {
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000 }, 20_000)).toBe(true);
  });

  it("needs no separate rule for an abort: the clock already covers it", () => {
    // An abort that reached the backend always passes the elapsed test anyway --
    // the client's own timeout is 2 minutes, and a run deadline fires mid-flight.
    // A dedicated arm added nothing and cost a false cooldown when the abort
    // fired BEFORE the request left, which a deadline expiring during
    // JSON.stringify of a megabyte payload does in tens of milliseconds.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 40 }, 20_000)).toBe(false);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 120_000 }, 20_000)).toBe(true);
  });
});

describe("admitStitch single-flight", () => {
  it("refuses a second stitch against the same backend while one is unsettled", () => {
    const first = admitStitch(ENDPOINT);
    expect(first.admitted).toBe(true);

    const second = admitStitch(ENDPOINT);
    expect(second.admitted).toBe(false);
    if (!second.admitted) expect(second.reason).toContain("already stitching");

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
    stitchOnce({ ok: false, elapsedMs: 5 });
    expect(readdirSync(lockDir).filter(f => f.endsWith(".lock"))).toEqual([]);
  });
});

describe("admitStitch cooldown", () => {
  it("refuses the next stitch after one that may still be running, and says why", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000 });

    const next = admitStitch(ENDPOINT);
    expect(next.admitted).toBe(false);
    if (!next.admitted) {
      expect(next.reason).toContain("62s");
      expect(next.reason).toContain("may still be");
      expect(next.reason).toContain("IX_STITCH_COOLDOWN_MS=0");
    }
  });

  it("admits again once the cooldown has expired", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    stitchOnce({ ok: false, elapsedMs: 62_000 });

    expect(admitStitch(ENDPOINT, Date.now() + 500).admitted).toBe(false);
    expect(admitStitch(ENDPOINT, Date.now() + 5_000).admitted).toBe(true);
  });

  it("does not cool down after a failure fast enough to have started nothing", () => {
    stitchOnce({ ok: false, elapsedMs: 40 });

    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("clears a cooldown once a stitch succeeds", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "50";
    stitchOnce({ ok: false, elapsedMs: 62_000 });
    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(true);

    // Past the cooldown, the next stitch is admitted and succeeds.
    const after = admitStitch(ENDPOINT, Date.now() + 10_000);
    expect(after.admitted).toBe(true);
    if (after.admitted) after.settle({ ok: true, elapsedMs: 300 });

    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
  });

  it("scopes the cooldown to one backend", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000 });
    expect(admitStitch(OTHER).admitted).toBe(true);
  });

  it("writes no cooldown when IX_STITCH_COOLDOWN_MS is 0", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "0";
    stitchOnce({ ok: false, elapsedMs: 62_000 });

    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("fails open on an unreadable cooldown record rather than refusing forever", () => {
    writeFileSync(cooldownPathForTest(ENDPOINT), "{not json");
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("honours IX_STITCH_SLOW_FAILURE_MS", () => {
    process.env.IX_STITCH_SLOW_FAILURE_MS = "100";
    stitchOnce({ ok: false, elapsedMs: 500 });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);
  });
});

describe("stitchKey", () => {
  // One backend reaches admitStitch spelled however the process that called it
  // was configured: IX_ENDPOINT in an `ix mcp` unit, the config file in a shell.
  // Hashing the raw string gave each spelling its own lock, which permits
  // exactly the concurrency the guard exists to prevent.
  it("folds the spellings of one local backend together", () => {
    const canonical = stitchKey("http://localhost:8090");
    expect(stitchKey("http://localhost:8090/")).toBe(canonical);
    expect(stitchKey("http://127.0.0.1:8090")).toBe(canonical);
    expect(stitchKey("HTTP://LOCALHOST:8090")).toBe(canonical);
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

describe("changing IX_STITCH_COOLDOWN_MS applies to a cooldown already on disk", () => {
  // The refusal message tells the user IX_STITCH_COOLDOWN_MS=0 disables this.
  // If that only took effect prospectively, the instruction printed to someone
  // blocked for 15 minutes would do nothing, and their only escape would be
  // deleting a state file whose name they cannot compute.
  it("0 releases an active cooldown", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000 });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);

    process.env.IX_STITCH_COOLDOWN_MS = "0";
    expect(admitStitch(ENDPOINT).admitted).toBe(true);
  });

  it("a lower value shortens an active cooldown", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000 });  // default 15m
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    expect(admitStitch(ENDPOINT, Date.now() + 5_000).admitted).toBe(true);
  });
});

describe("settle never replaces the caller's error", () => {
  it("swallows a failure to write the cooldown record", () => {
    const a = admitStitch(ENDPOINT);
    expect(a.admitted).toBe(true);

    // Make the cooldown write fail: put the lock dir underneath a regular file,
    // so mkdirSync -p cannot create it (ENOTDIR). settle() runs inside
    // `catch (err) { settle(...); throw err; }`, so anything thrown here would
    // unwind INSTEAD of the stitch error -- losing the HTTP status
    // isStitchUnsupported reads, and describing the wrong failure to the user.
    const blocker = join(lockDir, "a-file-not-a-directory");
    writeFileSync(blocker, "");
    process.env.IX_LOCK_DIR = join(blocker, "locks");

    if (a.admitted) expect(() => a.settle({ ok: false, elapsedMs: 62_000 })).not.toThrow();
  });
});

describe("failureMayStillBeRunning: what the backend told us beats the clock", () => {
  it("does not cool down on a 4xx, however long it took to arrive", () => {
    // elapsed covers the UPLOAD too. On a large monorepo the stitch payload is
    // megabytes, so a 413 can come back well past the slow threshold -- and a
    // refused request is decisive evidence that no join started.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 25_000, status: 413 }, 20_000)).toBe(false);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 25_000, status: 400 }, 20_000)).toBe(false);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 25_000, status: 404 }, 20_000)).toBe(false);
  });

  it("still cools down on a slow 5xx, which is the reported case", () => {
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000, status: 500 }, 20_000)).toBe(true);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000, status: null }, 20_000)).toBe(true);
  });

  it("treats IX_STITCH_SLOW_FAILURE_MS=0 as off, not as 'everything is slow'", () => {
    // The literal reading of 0 for a threshold is the opposite of off, and 0 is
    // what a user reaches for because the sibling knob prints
    // "IX_STITCH_COOLDOWN_MS=0 disables". Off has to mean off in both, or the
    // instant 404 from an older backend gets a 15-minute cooldown.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 40 }, 0)).toBe(false);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000 }, 0)).toBe(false);
    // Nothing survives 0 now that the elapsed rule is the only rule.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000, status: 500 }, 0)).toBe(false);
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
    stitchOnce({ ok: false, elapsedMs: 62_000 });

    let slept = 0;
    const result = await admitStitchWaiting(ENDPOINT, 30_000, async (ms) => { slept += ms; });

    expect(result.admitted).toBe(false);
    expect(slept, "waited on a cooldown").toBe(0);
  });
});

describe("round 3: the refusal names its rule, and the clock is not the only witness", () => {
  it("labels each refusal so callers never have to read the prose", () => {
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);
    const contended = admitStitch(ENDPOINT);
    expect(contended.admitted).toBe(false);
    if (!contended.admitted) expect(contended.rule).toBe("in-flight");
    if (holder.admitted) holder.settle({ ok: false, elapsedMs: 62_000 });

    const cooling = admitStitch(ENDPOINT);
    expect(cooling.admitted).toBe(false);
    if (!cooling.admitted) expect(cooling.rule).toBe("cooling");
  });

  it("treats a proxy 408 as a timeout, not as a refusal", () => {
    // A 4xx normally proves the backend never ran the join. 408 is the one that
    // says the opposite: something gave up WAITING, which is this whole bug.
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000, status: 408 }, 20_000)).toBe(true);
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 60_000, status: 413 }, 20_000)).toBe(false);
  });

  it("stops waiting when the run deadline has already fired", async () => {
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);

    let slept = 0;
    const spent = { aborted: true };
    const result = await admitStitchWaiting(ENDPOINT, 30_000, async (ms) => { slept += ms; }, spent);

    expect(result.admitted).toBe(false);
    expect(slept, "slept past a budget that had already run out").toBe(0);
    if (holder.admitted) holder.settle({ ok: true, elapsedMs: 5 });
  });

  it("still waits while the run deadline is live", async () => {
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);
    const live = { aborted: false };

    let slept = 0;
    const sleep = async (ms: number): Promise<void> => {
      slept += ms;
      if (slept >= 500 && holder.admitted) holder.settle({ ok: true, elapsedMs: 30 });
    };

    const second = await admitStitchWaiting(ENDPOINT, 30_000, sleep, live);
    expect(second.admitted).toBe(true);
    if (second.admitted) second.settle({ ok: true, elapsedMs: 30 });
  });
});

describe("round 4: the cooldown is re-read after the lock is taken", () => {
  it("does not admit a waiter whose cooldown read went stale while it waited", () => {
    // The first read happens BEFORE acquisition, and a holder writes its
    // cooldown and THEN releases. A waiter that read "no cooldown" and then
    // acquired the lock the holder had just dropped would send the second
    // concurrent stitch this guard exists to prevent. Only the interleaving
    // shows it, so the seam puts the settle in exactly that window.
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);
    expect(existsSync(cooldownPathForTest(ENDPOINT)), "waiter must read no cooldown first").toBe(false);

    const waiter = admitStitch(ENDPOINT, Date.now(), () => {
      if (holder.admitted) holder.settle({ ok: false, elapsedMs: 62_000 });
    });

    expect(waiter.admitted).toBe(false);
    if (!waiter.admitted) expect(waiter.rule).toBe("cooling");
  });

  it("leaves no lock behind when it refuses on the second read", () => {
    const holder = admitStitch(ENDPOINT);
    expect(holder.admitted).toBe(true);

    admitStitch(ENDPOINT, Date.now(), () => {
      if (holder.admitted) holder.settle({ ok: false, elapsedMs: 62_000 });
    });

    expect(readdirSync(lockDir).filter(f => f.endsWith(".lock"))).toEqual([]);
  });
});
