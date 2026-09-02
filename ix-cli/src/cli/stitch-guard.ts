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

/** A failure at or past this wall-clock is treated as "the server is still working". */
export function stitchSlowFailureMs(): number {
  return positiveEnvMs("IX_STITCH_SLOW_FAILURE_MS", DEFAULT_SLOW_FAILURE_MS);
}

/** Cooldown record. Sits beside the lock so IX_LOCK_DIR redirects both. */
function cooldownPath(endpoint: string): string {
  return namedLockPath("stitch", endpoint).replace(/\.lock$/, ".cooldown");
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
}

/**
 * Should a failure with this shape hold off the next stitch?
 *
 * Exported for tests and because the rule is the substance of this module.
 */
export function failureMayStillBeRunning(outcome: StitchOutcome, slowMs = stitchSlowFailureMs()): boolean {
  if (outcome.ok) return false;
  // An abort is the client's own timeout firing. By construction the request
  // was still open, so the backend never finished it — regardless of elapsed.
  if (outcome.aborted) return true;
  return outcome.elapsedMs >= slowMs;
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
  if (cooldown && cooldown.until > now) {
    return {
      admitted: false,
      reason:
        `the last stitch was cut off after ${formatMs(cooldown.elapsedMs)} and may still be ` +
        `running on the backend; next attempt in ${formatMs(cooldown.until - now)} ` +
        `(IX_STITCH_COOLDOWN_MS=0 disables)`,
    };
  }

  const lock: LockHandle | null = acquireLockAt(namedLockPath("stitch", endpoint), `ix stitch ${endpoint}`);
  if (!lock) {
    return {
      admitted: false,
      reason: `another ix map is already stitching ${endpoint}`,
    };
  }

  return {
    admitted: true,
    settle: (outcome) => {
      try {
        if (failureMayStillBeRunning(outcome)) {
          const ms = stitchCooldownMs();
          if (ms > 0) {
            const record: Cooldown = { until: Date.now() + ms, elapsedMs: outcome.elapsedMs, at: Date.now() };
            try { mkdirSync(dirname(cooldownPath(endpoint)), { recursive: true }); } catch { /* best effort */ }
            writeFileSync(cooldownPath(endpoint), JSON.stringify(record), { mode: 0o600 });
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
