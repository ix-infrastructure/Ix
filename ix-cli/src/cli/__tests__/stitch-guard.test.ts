import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  admitStitch,
  admitStitchWaiting,
  clearStitchCooldown,
  connectionNeverEstablished,
  cooldownPathForTest,
  outcomeProvesNothingRunning,
  stitchKey,
} from "../stitch-guard.js";
import * as net from "node:net";
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

/**
 * Was the admission granted? Releases it either way.
 *
 * Every GRANTED admission holds a real lock handle, and single-flight arms
 * `exit`, `SIGINT` and `SIGTERM` listeners on each one. An assertion that reads
 * `.admitted` inline and drops the handle leaks all three, and enough of them
 * made this file print MaxListenersExceededWarning three times -- noise that
 * would hide a real listener leak the next time one appears.
 *
 * Settling as a clean success is the right release for these: every call below
 * is a terminal assertion, so clearing the marker changes nothing later read.
 */
function admitted(endpoint: string, now?: number): boolean {
  const a = now === undefined ? admitStitch(endpoint) : admitStitch(endpoint, now);
  if (a.admitted) a.settle({ ok: true, elapsedMs: 1 });
  return a.admitted;
}

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
    expect(admitted(ENDPOINT)).toBe(true);
  });

  it("is cleared by a 4xx, so an older backend with no /v1/stitch keeps working", () => {
    stitchOnce({ ok: false, elapsedMs: 40, status: 404 });
    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitted(ENDPOINT)).toBe(true);
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
    expect(admitted(ENDPOINT)).toBe(false);
  });
});

describe("cooldown expiry", () => {
  it("admits again once the cooldown has expired", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });

    expect(admitted(ENDPOINT, Date.now() + 500)).toBe(false);
    expect(admitted(ENDPOINT, Date.now() + 5_000)).toBe(true);
  });

  it("applies a changed IX_STITCH_COOLDOWN_MS to a cooldown already on disk", () => {
    // The refusal message tells the user 0 disables this, so it has to be true
    // of the cooldown they are looking at -- otherwise the only escape is
    // deleting a state file whose name they cannot compute.
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    expect(admitted(ENDPOINT)).toBe(false);

    process.env.IX_STITCH_COOLDOWN_MS = "0";
    expect(admitted(ENDPOINT)).toBe(true);
  });

  it("a lower value shortens an active cooldown", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    expect(admitted(ENDPOINT, Date.now() + 5_000)).toBe(true);
  });

  it("scopes the cooldown to one backend", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    expect(admitted(OTHER)).toBe(true);
  });

  it("fails open on an unreadable cooldown record rather than refusing forever", () => {
    writeFileSync(cooldownPathForTest(ENDPOINT), "{not json");
    expect(admitted(ENDPOINT)).toBe(true);
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
    expect(admitted(ENDPOINT)).toBe(true);
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
    expect(admitted("http://127.0.0.1:8090/")).toBe(false);

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

describe("connectionNeverEstablished", () => {
  // Driven with errors Node actually produced, never hand-built ones: a
  // classifier keyed on a shape nobody verified is the failure mode this
  // codebase keeps hitting, and it looks identical to a working one.

  async function failureOf(url: string): Promise<unknown> {
    try {
      await fetch(url, { method: "POST", body: "{}" });
      return new Error("expected the request to fail");
    } catch (err) {
      return err;
    }
  }

  it("is true for a port nothing is listening on — nothing was sent", async () => {
    // Bound and closed, so the port is real and free. A hardcoded low port is
    // not an option: fetch refuses the WHATWG "bad port" list outright, and
    // that failure has no code at all — which this correctly reads as no proof.
    const probe = net.createServer();
    await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    expect(connectionNeverEstablished(await failureOf(`http://127.0.0.1:${port}/v1/stitch`))).toBe(true);
  });

  it("is true for an unroutable address — a neighbouring errno, same phase", async () => {
    // 240.0.0.1 is reserved, so the stack refuses to route to it: ENETUNREACH
    // with syscall "connect". An enumerated code list missed exactly this, and
    // a VPN drop produces the same shape -- fifteen minutes of endpoint-wide
    // cooldown for a request that never left the machine.
    expect(connectionNeverEstablished(await failureOf("http://240.0.0.1:8090/v1/stitch"))).toBe(true);
  });

  it("is true for undici's connect timeout, which carries no syscall", () => {
    // Shape observed through IxClient.stitch against a blackholed address
    // (192.0.2.1, TEST-NET-1): ConnectTimeoutError / UND_ERR_CONNECT_TIMEOUT,
    // syscall undefined. Pinned from the observation rather than driven live,
    // because reproducing it costs undici's full 10s connect timeout.
    const observed = new TypeError("fetch failed");
    (observed as { cause?: unknown }).cause = Object.assign(
      new Error("Connect Timeout Error (attempted address: 192.0.2.1:8090)"),
      { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    expect(connectionNeverEstablished(observed)).toBe(true);
  });

  it("is false for a blocked port, whose failure carries no code", async () => {
    // fetch rejects port 1 before it opens anything, with a bare
    // `Error: bad port`. No code means no proof, which is the safe answer.
    expect(connectionNeverEstablished(await failureOf("http://127.0.0.1:1/v1/stitch"))).toBe(false);
  });

  it("is true for a host that does not resolve", async () => {
    expect(
      connectionNeverEstablished(await failureOf("http://ix-568-no-such-host.invalid/v1/stitch")),
    ).toBe(true);
  });

  it("is FALSE for a socket dropped after the request went out", async () => {
    // The ambiguous case, and the reason this is narrower than "a transport
    // error". Once the bytes are gone, a reset means either an upstream that
    // restarted (its join died with it) or a proxy that hung up (the join is
    // still running). Both spell UND_ERR_SOCKET, so the marker stays.
    const server = net.createServer(sock => {
      sock.once("data", () => setTimeout(() => sock.destroy(), 10));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const err = await failureOf(`http://127.0.0.1:${port}/v1/stitch`);
      expect(String(err)).toContain("fetch failed");
      expect(connectionNeverEstablished(err)).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("clears the marker, so a backend that went down mid-run is not blamed for 15 minutes", () => {
    const a = admitStitch(ENDPOINT);
    expect(a.admitted).toBe(true);
    if (a.admitted) a.settle({ ok: false, elapsedMs: 3, status: null, neverConnected: true });
    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitted(ENDPOINT)).toBe(true);
  });
});

describe("the cooldown runs from the end of the attempt, not its start", () => {
  it("does not expire mid-attempt when IX_STITCH_COOLDOWN_MS is shorter than the request", () => {
    // IxClient.post caps a request at two minutes, so before the restamp EVERY
    // setting under that bought nothing on the timeout path: the marker was
    // stamped at the start, the attempt outlived it, and the next map was
    // admitted immediately and stacked a second join.
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    const startedLongAgo = Date.now() - 60_000;

    const a = admitStitch(ENDPOINT, startedLongAgo);
    expect(a.admitted).toBe(true);
    if (a.admitted) a.settle({ ok: false, elapsedMs: 60_000, status: 500 });

    const next = admitStitch(ENDPOINT);
    expect(next.admitted, "a 1s cooldown must still be live the instant a 60s attempt ends").toBe(false);
    if (!next.admitted) expect(next.reason).toContain("60s");
  });

  it("still expires on schedule once the attempt has ended", () => {
    process.env.IX_STITCH_COOLDOWN_MS = "1000";
    const a = admitStitch(ENDPOINT, Date.now() - 60_000);
    if (a.admitted) a.settle({ ok: false, elapsedMs: 60_000, status: 500 });

    expect(admitted(ENDPOINT, Date.now() + 5_000)).toBe(true);
  });
});

describe("clearStitchCooldown, which is what `ix reset` calls", () => {
  it("releases an active cooldown so the re-ingest after a reset is admitted", () => {
    // A reset wipes the registration on the backend, and the full re-ingest
    // that follows is the ONE run that can put it back -- an incremental map
    // never reaches the stitch block. A live cooldown refusing exactly that run
    // leaves the workspace unregistered with nothing to retry, while this
    // file's own comments promise a post-reset re-map re-registers.
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    expect(admitStitch(ENDPOINT).admitted).toBe(false);

    clearStitchCooldown(ENDPOINT);

    expect(existsSync(cooldownPathForTest(ENDPOINT))).toBe(false);
    expect(admitted(ENDPOINT)).toBe(true);
  });

  it("leaves another backend's cooldown alone", () => {
    stitchOnce({ ok: false, elapsedMs: 62_000, status: 500 });
    clearStitchCooldown(OTHER);
    expect(admitStitch(ENDPOINT).admitted).toBe(false);
  });

  it("is a no-op when there is no cooldown, rather than throwing", () => {
    expect(() => clearStitchCooldown(ENDPOINT)).not.toThrow();
    expect(admitted(ENDPOINT)).toBe(true);
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
