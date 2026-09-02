import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  admitStitch,
  cooldownPathForTest,
  failureMayStillBeRunning,
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

  it("is true for an abort regardless of elapsed, because the request was still open", () => {
    expect(failureMayStillBeRunning({ ok: false, elapsedMs: 5, aborted: true }, 20_000)).toBe(true);
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
    expect(admitStitch(OTHER).admitted).toBe(true);
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

  it("cools down after a client-side abort even though it returned instantly", () => {
    stitchOnce({ ok: false, elapsedMs: 5, aborted: true });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);
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
