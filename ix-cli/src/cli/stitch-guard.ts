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
// ── The rule ───────────────────────────────────────────────────────────────
//
// The cooldown marker is written when a stitch STARTS, and removed only on
// proof that nothing is running: a clean answer, or a refusal the backend
// issued without doing the work.
//
// This is deliberately the opposite way round from the obvious design, which
// inspects the FAILURE and writes a cooldown when it looks like a timeout.
// Four review rounds of that classifier each broke the previous round's rule,
// because it has to answer "did the backend start the join?" from an error, and
// the evidence for that keeps not being there:
//
//   * the message is whatever proxy sits in front (a 500 here, a 504 with an
//     HTML body in #528), so text matching is inert in the deployment it was
//     written for;
//   * elapsed time cannot tell a slow join from a slow UPLOAD, and the stitch
//     payload is megabytes on a large monorepo;
//   * "the client aborted" cannot tell a mid-flight hang-up from a run deadline
//     that fired before the request was even serialized;
//   * and none of it survives the process being killed, which is the ordinary
//     end of a hook that timed out.
//
// Writing the marker up front needs none of those answers. Every way a stitch
// can end without a definite refusal — a timeout, an abort, a deadline, SIGTERM,
// a power cut — leaves the marker exactly where it was written, because leaving
// it is the default rather than something the dying process must still do.
//
// The cost is that a stitch which failed for an unclassified reason cools down
// when it need not have. That errs toward skipping one stitch rather than
// stacking joins on a database that is already the reason, which is the safe
// direction here: a skipped stitch leaves the previous registration in place,
// and #568 is a report of 10–16 concurrent copies at 800–1200% CPU.
// ---------------------------------------------------------------------------

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
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

/** How long to wait for the in-flight stitch to finish before shedding. */
export function stitchWaitMs(): number {
  return positiveEnvMs("IX_STITCH_WAIT_MS", DEFAULT_WAIT_MS);
}

/**
 * One key per backend, however the endpoint was spelled.
 *
 * `getEndpoint()` returns `IX_ENDPOINT` or the config file verbatim, so the
 * same backend reaches this function as `http://localhost:8090`,
 * `http://localhost:8090/` and `http://127.0.0.1:8090` depending on which of
 * those a given process was started with. Hashing the raw string gives each
 * spelling its own lock, and the guard then permits exactly the concurrency it
 * exists to prevent — an `ix mcp` server launched with an IP and a shell
 * `ix map` reading the config both stitching at once.
 *
 * Loopback spellings are folded together deliberately. `localhost`,
 * `127.0.0.1` and `::1` are not the same host in general — and the endpoint
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
    // `u.port` is deliberately used raw. The WHATWG parser already strips a
    // DEFAULT port, so `https://h` and `https://h:443` both give "" and key
    // identically -- adding a defaults table here would be dead code. Verified,
    // and pinned by a test, because it looks like an omission.
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
  /**
   * Epoch ms the cooldown runs from.
   *
   * Written as the attempt's START time, and rewritten to its END time when it
   * reports back without proving anything stopped. Both matter:
   *
   *   - the start-time write is what survives a kill, and is the whole reason
   *     the marker goes down before the request rather than after it;
   *   - but leaving it AT the start time would make any IX_STITCH_COOLDOWN_MS
   *     shorter than the attempt itself already expired by the time the attempt
   *     ends. `IxClient.post` caps a request at two minutes, so every setting
   *     under that silently bought nothing on the timeout path -- the next map
   *     was admitted immediately and stacked a second join, which is the bug.
   *
   * A process that is killed keeps the start stamp, so a cooldown shorter than
   * the attempt is still expired there; that residue is noted in docs/api.
   */
  at: number;
  /** Set when the attempt reported back without clearing. Message only. */
  elapsedMs?: number;
}

function readCooldown(endpoint: string): Cooldown | null {
  try {
    const parsed = JSON.parse(readFileSync(cooldownPath(endpoint), "utf-8")) as Cooldown;
    return typeof parsed?.at === "number" ? parsed : null;
  } catch {
    // Missing, unreadable, or corrupt: no cooldown. Failing open here is right
    // — a lost cooldown costs one extra stitch, and refusing to stitch because
    // a state file cannot be parsed would break the feature outright.
    return null;
  }
}

/**
 * Did the request fail before the connection was ever established?
 *
 * This is the one transport fact that is a positive PROOF rather than an
 * inference about a failure: if we never connected, no bytes reached the
 * backend, so there is no join to wait out. Without it a backend that goes down
 * mid-run takes a full 15-minute endpoint-wide cooldown for a request it never
 * received.
 *
 * The codes are DERIVED, not guessed -- `IxClient` flattens HTTP errors into
 * `"NNN: ..."` strings but rethrows transport failures intact, so what arrives
 * here is Node's `TypeError: fetch failed` with the real error on `.cause`.
 * Observed through `IxClient.stitch` itself:
 *
 *   closed port      -> cause { name: "Error",       code: "ECONNREFUSED" }
 *   unresolvable DNS -> cause { name: "Error",       code: "ENOTFOUND"    }
 *   reset AFTER send -> cause { name: "SocketError", code: "UND_ERR_SOCKET" }
 *
 * The third is the one deliberately NOT accepted. "Other side closed" happens
 * after the request bytes are gone, so it is exactly the ambiguous case this
 * guard exists for: an upstream that restarted killed its join, but a proxy
 * that dropped the connection did not. Both spell UND_ERR_SOCKET, so it stays
 * on the conservative side and keeps the marker.
 */
export function connectionNeverEstablished(error: unknown): boolean {
  // Walk the cause chain: undici nests, and a wrapper may add a level later.
  for (let e: unknown = error, depth = 0; e !== null && e !== undefined && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** How the stitch attempt ended, as the guard needs to see it. */
export interface StitchOutcome {
  ok: boolean;
  /** Wall-clock the client spent. Message only — never part of the decision. */
  elapsedMs: number;
  /** HTTP status the backend answered with, when it answered at all. */
  status?: number | null;
  /** Set when the connection was never established — see the function above. */
  neverConnected?: boolean;
}

/**
 * Did this outcome PROVE that no join is running?
 *
 * Two proofs are available, and both are positive facts rather than inferences
 * drawn from the shape of a failure:
 *
 *   - the stitch succeeded, so the backend is done with it;
 *   - the backend answered 4xx, which is it refusing the request rather than
 *     executing it. 408 is excluded: a proxy reporting that IT gave up waiting
 *     says nothing about whether the backend did, and that is this whole bug.
 *   - the backend answered 501. `isStitchUnsupported` already treats 404 AND
 *     501 as "this backend has no /v1/stitch", and the run swallows it
 *     silently for exactly that reason -- so leaving a marker behind would
 *     refuse every map for 15 minutes, claiming a join may still be running,
 *     against a backend that has never had one.
 *
 *   - the connection was never established, so nothing was sent. See
 *     `connectionNeverEstablished` for why that is narrower than "a transport
 *     error" and why the narrowing matters.
 *
 * Anything else — another 5xx, a timeout, an abort, a socket dropped after the
 * request went out, or the process being killed before it could say anything —
 * leaves the marker.
 */
export function outcomeProvesNothingRunning(outcome: StitchOutcome): boolean {
  if (outcome.ok) return true;
  if (outcome.neverConnected === true) return true;
  const status = outcome.status;
  if (typeof status !== "number") return false;
  if (status === 501) return true;
  return status >= 400 && status < 500 && status !== 408;
}

/** Which rule refused. Callers branch on this, never on the prose. */
export type StitchRefusal = "in-flight" | "cooling" | "deadline";

export type StitchAdmission =
  | { admitted: true; settle: (outcome: StitchOutcome) => void }
  | { admitted: false; rule: StitchRefusal; reason: string };

function formatMs(ms: number): string {
  // Seconds up to two minutes: the numbers that matter here are request
  // durations near the proxy timeout, and rounding 62s or 90s to whole minutes
  // loses exactly the detail the reader needs.
  return ms >= 120_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/**
 * Expiry of a cooldown under the CURRENT setting.
 *
 * Re-derived rather than stamped into the record, so that lowering
 * IX_STITCH_COOLDOWN_MS — or setting it to 0, which the refusal message tells
 * the user disables this — takes effect on the cooldown they are looking at.
 * Otherwise the only escape from a 15-minute block is deleting a state file
 * whose name they cannot compute.
 */
function coolingUntil(cooldown: Cooldown): number {
  return cooldown.at + stitchCooldownMs();
}

function refuseForCooldown(cooldown: Cooldown, now: number): StitchAdmission {
  // No elapsed means the attempt never reported back at all -- killed, crashed,
  // or still running in another process right now. Worth saying differently:
  // the reader's next question is different in each case.
  const how =
    cooldown.elapsedMs === undefined
      ? "a stitch was started and never reported back"
      : `the last stitch was cut off after ${formatMs(cooldown.elapsedMs)}`;
  return {
    admitted: false,
    rule: "cooling",
    reason:
      `${how} and may still be running on the backend; ` +
      `next attempt in ${formatMs(coolingUntil(cooldown) - now)} ` +
      `(IX_STITCH_COOLDOWN_MS=0 disables)`,
  };
}

function writeCooldown(endpoint: string, record: Cooldown): void {
  try {
    mkdirSync(dirname(cooldownPath(endpoint)), { recursive: true });
    writeFileSync(cooldownPath(endpoint), JSON.stringify(record), { mode: 0o600 });
  } catch (err) {
    // An unwritable lock dir is the one way this guard goes silently inert, so
    // say so rather than leaving the user to wonder why it never engages. Never
    // rethrow: settle() runs inside a catch that must unwind with the ORIGINAL
    // stitch error, not with this one.
    process.stderr.write(
      `  Warning: could not record the cross-workspace stitch cooldown (${err}). ` +
        `The guard against stacking stitch queries (Ix#568) is not active.\n`,
    );
  }
}

/**
 * Ask permission to POST /v1/stitch against `endpoint`.
 *
 * On `{ admitted: true }` the cooldown marker is ALREADY on disk — see the note
 * at the top of this file. The caller should call `settle` when the attempt
 * ends; NOT calling it (a crash, a kill, a hook timeout) is a supported outcome
 * and leaves the marker in place, which is the conservative answer.
 */
export function admitStitch(endpoint: string, now = Date.now()): StitchAdmission {
  // The lock FIRST, and the cooldown only while holding it.
  //
  // Order matters, and not for the reason it first appears. Because the marker
  // is written at the START of an attempt, a marker on disk means either "an
  // attempt is running right now" or "an attempt ended without proving it
  // stopped" -- and those want opposite answers: the first should be WAITED
  // for (a healthy stitch is over in milliseconds, and shedding it loses that
  // workspace's registration), the second refused outright.
  //
  // The lock is exactly that distinction, so it is the thing to ask first. It
  // also means the cooldown is only ever read while holding the lock, which
  // removes the stale-read race a read-then-lock order has: no window exists in
  // which a holder can write a marker between our read and our acquisition.
  const lock: LockHandle | null = acquireLockAt(namedLockPath("stitch", stitchKey(endpoint)), `ix stitch ${endpoint}`);
  if (!lock) {
    return {
      admitted: false,
      rule: "in-flight",
      reason: `another ix run is already stitching ${endpoint}`,
    };
  }

  const cooldown = readCooldown(endpoint);
  if (cooldown !== null && coolingUntil(cooldown) > now) {
    lock.release();
    return refuseForCooldown(cooldown, now);
  }

  // The marker goes down BEFORE the caller sends. Everything after this point
  // is about REMOVING it, never about deciding whether to write it.
  writeCooldown(endpoint, { at: now });

  let alreadySettled = false;
  return {
    admitted: true,
    settle: (outcome) => {
      if (alreadySettled) return;
      alreadySettled = true;
      try {
        if (outcomeProvesNothingRunning(outcome)) {
          try { rmSync(cooldownPath(endpoint), { force: true }); } catch { /* best effort */ }
        } else {
          // Keep the marker, restamped to NOW so the cooldown runs from the
          // end of the attempt rather than its start -- see `Cooldown.at`. The
          // elapsed figure is message data only; it decides nothing.
          writeCooldown(endpoint, { at: Date.now(), elapsedMs: Math.round(outcome.elapsedMs) });
        }
      } finally {
        // Always, even if the state write threw: holding the lock past the
        // request would block every later stitch until it aged out.
        lock.release();
      }
    },
  };
}

/**
 * [[admitStitch]], but waits out a stitch that is merely in flight.
 *
 * Shedding on contention is right when the backend is struggling and wrong
 * when it is not. On a healthy backend the stitch takes tens of milliseconds,
 * and two `ix map` runs for two workspaces overlapping by that much is
 * ordinary in a multi-repo setup with a per-repo hook. Dropping one there
 * loses that workspace's registration until somebody re-ingests every file,
 * because the stitch block is gated on nothing having been skipped as
 * unchanged (nor left unparsed), and an incremental map never reaches it.
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
  /**
   * The run's own wall-clock budget. Waiting past it is pure delay: every
   * request after it is aborted before it leaves, so the stitch this is
   * queueing for cannot be sent even if the lock frees.
   */
  runDeadline?: { readonly aborted: boolean },
): Promise<StitchAdmission> {
  // Refuse outright if the run's budget is ALREADY gone. Admission writes
  // the cooldown marker, and `fetch` rejects instantly on an aborted signal --
  // so admitting here marks the backend as maybe-busy for 15 minutes over a
  // request that never left the process. Worse, it repeats: the stitch is the
  // last thing an ingest does, so a run that routinely overruns would block
  // its own next attempt every time and never stitch again.
  // Read through a call, not a property access: after the early return below,
  // TypeScript narrows `runDeadline.aborted` to false for the rest of the
  // function and flags the in-loop check as unreachable -- but the whole point
  // of that check is that the signal flips WHILE we wait.
  const deadlineFired = (): boolean => runDeadline?.aborted === true;
  const refuseForDeadline = (): StitchAdmission => ({
    admitted: false,
    rule: "deadline",
    reason: `the map ran out of time before the stitch could start`,
  });


  const deadline = Date.now() + waitMs;
  for (;;) {
    // Re-checked at the TOP of every iteration, before admitStitch. Checking it
    // only after admission is granted is too late: the holder can release while
    // we wait, and then we take the lock, write the marker, and `fetch` rejects
    // instantly on the already-aborted deadline -- marking the backend for 15
    // minutes over a request that never left. The pre-loop check alone does not
    // cover it, because the deadline can fire DURING the wait.
    if (deadlineFired()) return refuseForDeadline();

    const admission = admitStitch(endpoint);
    // Only contention is worth waiting out. A cooldown means the backend may
    // still be running the last one, and outlasting THAT is the whole point.
    if (admission.admitted || admission.rule !== "in-flight") return admission;
    if (Date.now() >= deadline) return admission;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Drop the cooldown for an endpoint, so the next stitch is admitted.
 *
 * For `ix reset`, and only for it. A reset wipes the registration on the
 * backend, and the full re-ingest that follows is the one run that can put it
 * back -- so a live cooldown refusing exactly that run leaves the workspace
 * unregistered with no automatic retry, while this file's own comments promise
 * that "a post-reset re-map re-registers". The reset also removes whatever
 * graph the outstanding join was building, so there is nothing left to protect.
 *
 * Best-effort: a cooldown that cannot be removed costs one skipped stitch, and
 * failing `ix reset` over it would be worse.
 */
export function clearStitchCooldown(endpoint: string): void {
  try {
    rmSync(cooldownPath(endpoint), { force: true });
  } catch { /* best effort */ }
}

// ── Test-only surface ──────────────────────────────────────────────────────
export function cooldownPathForTest(endpoint: string): string {
  return cooldownPath(endpoint);
}
