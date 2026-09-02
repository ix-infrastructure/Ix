import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireLockAt, namedLockPath, type LockHandle } from "./single-flight.js";

// ---------------------------------------------------------------------------
// Admission control for POST /v1/stitch.
//
// Background (Ix#568): the cross-workspace stitch is a single unbounded AQL
// join over `symbol_consumes x provides x consumes x exports`. On a large
// multi-workspace graph it runs for minutes. The HTTP call in front of it gives
// up long before the query does — the reported case is a proxy answering 500 at
// ~60s — and ArangoDB keeps executing the query regardless. The client learning
// "that failed" is therefore NOT the same as the work having stopped.
//
// `ix map` already single-flights per workspace, and that does not help here
// for two independent reasons:
//
//   * The stitch is cross-workspace, so two maps of two DIFFERENT workspaces
//     hold two different locks and issue two stitches at once. Reproduced: two
//     concurrent `ix map` runs put two stitch queries in flight together.
//   * Copies mostly do not need concurrency at all. An auto-map hook fires one
//     `ix map` per change; each completes, releases its workspace lock, and the
//     next one starts a fresh stitch. Reproduced: five sequential maps, five
//     stitch queries, every one started after the previous had already answered
//     500 — i.e. while its server-side join was still running.
//
// Two rules, both enforced from the client because the cancel and the indexed
// join that would fix this properly live in the backend:
//
//   1. One stitch at a time per backend endpoint (not per workspace).
//   2. After a stitch whose failure means the server may still be working, do
//      not start another until a cooldown expires.
//
// Rule 2 is the one that actually stops the pile-up, and its classification is
// deliberately NOT a match on the error text. Message shapes vary with whatever
// proxy is in front of the backend, and a classifier built from guessed strings
// is inert in exactly the deployments it was written for. What is measurable is
// how long the client waited: a stitch that failed FAST failed before the
// backend committed to the query (404 from an old backend, a 400, a refused
// connection) and nothing is running; a stitch that failed only after tens of
// seconds was cut off mid-join, and the join outlives the answer.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_SLOW_FAILURE_MS = 20 * 1000;
/**
 * Below this, a request cannot have reached the backend and come back.
 * Generous by an order of magnitude — the local memory layer answers a stitch
 * in tens of milliseconds — because the only thing it has to separate is a
 * real round trip from an abort that rejected before the socket was used.
 */
const REACHED_BACKEND_MS = 5;
/** Budget for waiting out a stitch that is merely in flight. */
const DEFAULT_WAIT_MS = 30 * 1000;
/** Poll interval while waiting. Short: a healthy stitch is over in ~30ms. */
const POLL_MS = 250;

function positiveEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  // 0 is meaningful (disable), so only a negative or unparseable value falls
  // back. `Number.isFinite` alone would let "" and "abc" through as NaN.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** How long to refuse a new stitch after one that may still be running. 0 disables. */
export function stitchCooldownMs(): number {
  return positiveEnvMs("IX_STITCH_COOLDOWN_MS", DEFAULT_COOLDOWN_MS);
}

/**
 * A failure at or past this wall-clock is treated as "the server is still
 * working". 0 turns the elapsed rule OFF; only an abort cools down.
 *
 * Read that sentence twice, because the literal reading of 0 for a threshold
 * is the opposite: `elapsedMs >= 0` is true of every failure, so 0 would cool
 * down on the instant 404 from an older backend -- exactly the deployment the
 * fast-failure carve-out exists to leave alone. And 0 is what someone reaches
 * for, because the sibling knob prints "IX_STITCH_COOLDOWN_MS=0 disables" in
 * the refusal message. Off means off in both.
 */
export function stitchSlowFailureMs(): number {
  return positiveEnvMs("IX_STITCH_SLOW_FAILURE_MS", DEFAULT_SLOW_FAILURE_MS);
}

/**
 * One key per backend, however the endpoint was spelled.
 *
 * `getEndpoint()` returns `IX_ENDPOINT` or the config file verbatim, so the
 * same backend reaches this function as `http://localhost:8090`,
 * `http://localhost:8090/` and `http://127.0.0.1:8090` depending on which of
 * those a given process was started with. Hashing the raw string gives each
 * spelling its own lock, and the guard then permits exactly the concurrency it
 * exists to prevent -- an `ix mcp` server launched with an IP and a shell
 * `ix map` reading the config both stitching at once.
 *
 * Loopback spellings are folded together deliberately. `localhost`,
 * `127.0.0.1` and `::1` are not the same host in general -- and the endpoint
 * is not always local either; `IxClient.isLocalEndpoint` exists precisely
 * because a remote backend is supported. The folding is justified by its cost,
 * not by a claim about deployments: two loopback spellings that really did
 * name different backends cost one deferred stitch, while not folding them
 * costs the concurrency this guard exists to prevent.
 */
export function stitchKey(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const host = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname.toLowerCase())
      ? "localhost"
      : u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol.toLowerCase()}//${host}:${u.port}${path}`;
  } catch {
    // Not a URL. Nothing to normalise, and refusing to guard is worse than
    // guarding on the raw text.
    return endpoint;
  }
}

/** Cooldown record. Sits beside the lock so IX_LOCK_DIR redirects both. */
function cooldownPath(endpoint: string): string {
  return namedLockPath("stitch", stitchKey(endpoint)).replace(/\.lock$/, ".cooldown");
}

interface Cooldown {
  until: number;   // epoch ms
  elapsedMs: number; // how long the failing stitch ran before the client gave up
  at: number;      // epoch ms the failure was recorded
}

function readCooldown(endpoint: string): Cooldown | null {
  try {
    const parsed = JSON.parse(readFileSync(cooldownPath(endpoint), "utf-8")) as Cooldown;
    return typeof parsed?.until === "number" ? parsed : null;
  } catch {
    // Missing, unreadable, or corrupt: no cooldown. Failing open here is right
    // — a lost cooldown costs one extra stitch, and refusing to stitch because
    // a state file cannot be parsed would break the feature outright.
    return null;
  }
}

/** How the stitch attempt ended, as the guard needs to see it. */
export interface StitchOutcome {
  ok: boolean;
  /** Wall-clock the client spent on the request. Ignored when `ok`. */
  elapsedMs: number;
  /** True for an AbortError/TimeoutError — the client hung up, the server did not. */
  aborted?: boolean;
  /** HTTP status the backend answered with, when it answered at all. */
  status?: number | null;
}

/**
 * Should a failure with this shape hold off the next stitch?
 *
 * Exported for tests and because the rule is the substance of this module.
 */
export function failureMayStillBeRunning(outcome: StitchOutcome, slowMs = stitchSlowFailureMs()): boolean {
  if (outcome.ok) return false;

  // A 4xx is the backend REFUSING the request, not working on it. That is
  // decisive whatever the clock says, and the clock can say a lot: elapsed
  // covers the upload too, and on a large monorepo the stitch payload
  // (provides + consumes + exports + symbolConsumes) is megabytes, so a 413
  // or a 400 can arrive well past the slow threshold. Cooling down there
  // would hold off 15 minutes for a query that never ran, and say so.
  const status = outcome.status;
  if (typeof status === "number" && status >= 400 && status < 500) return false;

  // An abort is the client's own timeout firing, so the request was open.
  // Except when it was not: `AbortSignal.any` rejects immediately if the
  // run deadline fires between the caller sampling it and fetch checking it,
  // and no request that reached a backend returns in single-digit ms.
  if (outcome.aborted) return outcome.elapsedMs >= REACHED_BACKEND_MS;

  // 0 disables the elapsed rule; see stitchSlowFailureMs.
  return slowMs > 0 && outcome.elapsedMs >= slowMs;
}

export type StitchAdmission =
  | { admitted: true; settle: (outcome: StitchOutcome) => void }
  | { admitted: false; reason: string };

function formatMs(ms: number): string {
  // Seconds up to two minutes: the numbers that matter here are request
  // durations near the proxy timeout, and rounding 62s or 90s to whole minutes
  // loses exactly the detail the reader needs.
  return ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * Ask permission to POST /v1/stitch against `endpoint`.
 *
 * Returns `{ admitted: false, reason }` when another process is stitching this
 * backend, or when the previous stitch is presumed still running server-side.
 * `reason` is written for a user who has just been told their cross-repo edges
 * are incomplete and needs to know why nothing was even attempted.
 *
 * On `{ admitted: true }` the caller MUST call `settle` exactly once. Failing
 * to (a crash, a kill) leaves the lock behind, which the shared staleness rule
 * clears, so a lost settle costs a delay and never a permanent wedge.
 */
export function admitStitch(endpoint: string, now = Date.now()): StitchAdmission {
  const cooldown = readCooldown(endpoint);
  // Re-derive the expiry from the CURRENT setting rather than trusting the
  // one stamped into the record. The refusal below tells the user that
  // IX_STITCH_COOLDOWN_MS=0 disables the cooldown, and that has to be true
  // for the cooldown they are looking at -- otherwise the only escape from a
  // 15-minute block is deleting a state file whose name they cannot compute.
  // Clamping (rather than only special-casing 0) means lowering the value
  // shortens an active cooldown too, which is the same expectation.
  // The clamp alone covers 0: `at` is when the failure was recorded, always in
  // the past, so a configured 0 makes `until` expire immediately. An explicit
  // `configured > 0` arm here changes no outcome, and a guard that cannot fail
  // reads as protection that is not there.
  const until = cooldown === null ? 0 : Math.min(cooldown.until, cooldown.at + stitchCooldownMs());
  if (cooldown && until > now) {
    return {
      admitted: false,
      reason:
        `the last stitch was cut off after ${formatMs(cooldown.elapsedMs)} and may still be ` +
        `running on the backend; next attempt in ${formatMs(until - now)} ` +
        `(IX_STITCH_COOLDOWN_MS=0 disables)`,
    };
  }

  const lock: LockHandle | null = acquireLockAt(namedLockPath("stitch", stitchKey(endpoint)), `ix stitch ${endpoint}`);
  if (!lock) {
    return {
      admitted: false,
      reason: `another ix map is already stitching ${endpoint}`,
    };
  }

  return admittedWith(lock, endpoint);
}

/** How long to wait for the in-flight stitch to finish before shedding. */
export function stitchWaitMs(): number {
  return positiveEnvMs("IX_STITCH_WAIT_MS", DEFAULT_WAIT_MS);
}

/**
 * [[admitStitch]], but waits out a stitch that is merely in flight.
 *
 * Shedding on contention is right when the backend is struggling and wrong
 * when it is not. On a healthy backend the stitch takes tens of milliseconds,
 * and two `ix map` runs for two workspaces overlapping by that much is
 * ordinary in a multi-repo setup with a per-repo hook. Dropping one there
 * loses that workspace's registration until somebody re-ingests every file,
 * because the stitch block is gated on `filesSkipped === 0` and an
 * incremental map never reaches it.
 *
 * So wait, briefly. A healthy holder is gone long before the budget; an
 * unhealthy one is still holding when it runs out, which is the case worth
 * shedding. The cooldown — which is what actually stops the Ix#568 pile-up —
 * is checked first and never waited on.
 */
export async function admitStitchWaiting(
  endpoint: string,
  waitMs = stitchWaitMs(),
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<StitchAdmission> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const admission = admitStitch(endpoint);
    // Only contention is worth waiting out. A cooldown means the backend may
    // still be running the last one, and outlasting THAT is the whole point.
    if (admission.admitted || !admission.reason.startsWith("another ix map")) return admission;
    if (Date.now() >= deadline) return admission;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

function admittedWith(lock: LockHandle, endpoint: string): StitchAdmission {

  return {
    admitted: true,
    settle: (outcome) => {
      try {
        if (failureMayStillBeRunning(outcome)) {
          const ms = stitchCooldownMs();
          if (ms > 0) {
            const record: Cooldown = { until: Date.now() + ms, elapsedMs: outcome.elapsedMs, at: Date.now() };
            try {
              mkdirSync(dirname(cooldownPath(endpoint)), { recursive: true });
              writeFileSync(cooldownPath(endpoint), JSON.stringify(record), { mode: 0o600 });
            } catch {
              // An unwritable lock dir or a full disk must not become the
              // error the caller reports. settle() runs inside `catch (err) {
              // settle(...); throw err; }`, so anything thrown here would
              // unwind INSTEAD of the stitch failure -- losing the status
              // isStitchUnsupported needs and describing the wrong problem.
              // Losing a cooldown costs one extra stitch.
            }
          }
        } else {
          // A clean result, or a failure fast enough that nothing can be
          // running, clears any cooldown a previous run left.
          try { rmSync(cooldownPath(endpoint), { force: true }); } catch { /* best effort */ }
        }
      } finally {
        // Always, even if writing the cooldown threw: holding the lock past the
        // request would block every later stitch until it aged out.
        lock.release();
      }
    },
  };
}

// ── Test-only surface ──────────────────────────────────────────────────────
export function cooldownPathForTest(endpoint: string): string {
  return cooldownPath(endpoint);
}
