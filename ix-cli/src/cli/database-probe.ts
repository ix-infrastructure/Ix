// Copyright 2026 Ix Infrastructure Inc.

// ---------------------------------------------------------------------------
// "Can the backend reach its database?", asked quickly, for a run whose
// commits are failing (IN-19C, the CL-17 breaker follow-up).
//
// The commit cutoff (commit-breaker.ts) judges the backend by behaviour: a
// streak of refused commits. That is right when the cause is unknown, and slow
// when it is not: with ArangoDB down, every commit waits out its own failure
// and the drain spends its whole failure budget, three passes over, before the
// run stops. The backend knows the answer already. Since Ix-memory 1.0.33,
// `/v1/health` reports `database: "reachable" | "unreachable"`, and answers 503
// `degraded` while the database is down. An older backend never touched the
// database for health, so a read that does (`/v1/revisions/current`) stands in.
//
// Only an explicit answer counts. A probe that fails, times out, or is refused
// for want of the local token is `unknown`, and the caller then does exactly
// what it would have done without one.
// ---------------------------------------------------------------------------

import type { IxClient } from "../client/api.js";
import type { HealthResponse } from "../client/types.js";

/**
 * A health answer, including the 503 a backend sends while it cannot reach its
 * database: that is a server that answered, and the body says what is wrong.
 * Thrown for anything else.
 */
export function healthFromError(err: unknown): HealthResponse | null {
  const m = /^503:\s*(\{.*\})\s*$/s.exec((err as Error)?.message ?? "");
  if (!m) return null;
  try {
    const body = JSON.parse(m[1]!) as HealthResponse;
    return typeof body?.status === "string" ? body : null;
  } catch {
    return null;
  }
}

export type DatabaseVerdict = "reachable" | "unreachable" | "unknown";

/** How long a probe may take. It runs on a failing run's critical path. */
export const DATABASE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Ask the backend whether it can reach its database.
 *
 * `unreachable` only on the backend's own word: health reporting
 * `database: "unreachable"` (with a 200, or the 503 `degraded` answer);
 * anything else, including a failed fallback read on an older backend, is
 * `unknown`.
 */
export async function probeDatabase(
  client: Pick<IxClient, "health" | "currentRevision">,
  opts: { timeoutMs?: number } = {},
): Promise<DatabaseVerdict> {
  const timeoutMs = opts.timeoutMs ?? DATABASE_PROBE_TIMEOUT_MS;
  let health: HealthResponse;
  try {
    health = await client.health(timeoutMs);
  } catch (err) {
    const degraded = healthFromError(err);
    if (!degraded) return "unknown";
    health = degraded;
  }
  if (health.database === "unreachable") return "unreachable";
  if (health.database === "reachable") return "reachable";
  // A backend older than 1.0.33: health says nothing about the database.
  try {
    await client.currentRevision(timeoutMs);
    return "reachable";
  } catch {
    // A failed read proves nothing about the database: a 5xx may be a saturated
    // Arango, a proxy or a restarting pod. Without health's own word, stay quiet.
    return "unknown";
  }
}

/**
 * One probe shared by every caller that asks within `minIntervalMs` of the
 * last answer, and by everyone who asks while one is in flight. A failing run
 * reaches the probe once per failed commit, and concurrency 8 means eight at
 * a time; the backend should be asked once.
 */
export function createDatabaseProbe(
  probe: () => Promise<DatabaseVerdict>,
  minIntervalMs = 5_000,
  now: () => number = Date.now,
): () => Promise<DatabaseVerdict> {
  let pending: Promise<DatabaseVerdict> | undefined;
  let last: DatabaseVerdict | undefined;
  let answeredAt = 0;
  return () => {
    if (pending) return pending;
    if (last !== undefined && now() - answeredAt < minIntervalMs) return Promise.resolve(last);
    pending = probe()
      .catch((): DatabaseVerdict => "unknown")
      .then(verdict => {
        last = verdict;
        answeredAt = now();
        pending = undefined;
        return verdict;
      });
    return pending;
  };
}
