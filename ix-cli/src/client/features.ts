// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which optional backend routes and fields this CLI relies on, and the one
 * place that decides whether a backend has them (Ix#942).
 *
 * The CLI talks to several Ix-memory releases. A route a backend does not
 * serve is found out by calling it: the commands that call an optional route
 * ask `routeMissing` what a failure means instead of reading statuses out of
 * the error themselves, and a decision worth remembering goes through
 * `featureOff` / `markFeatureOff`. A feature that is gated by the release the
 * backend reports (`/v1/health` `release_version`) uses `releaseAtLeast`.
 *
 * Every feature names the release that introduced it (`since`) and where its
 * fallback lives (`fallbackAt`). A fallback can be deleted once
 * `MIN_BACKEND_VERSION` reaches its `since`: `fallbackRemovable` answers that,
 * and the unit test of this module fails when the floor is raised past a
 * feature whose fallback is still listed here.
 *
 * Not solved here: a 404 from a proxy in front of the backend still reads as
 * "route missing". Telling the two apart needs the backend to list its
 * features in `/v1/capabilities`, which it does not do yet.
 */

/**
 * The oldest Ix-memory release this CLI supports. `ix doctor` warns about a
 * backend that reports an older one.
 *
 * 1.0.30 is the oldest release this CLI's code was checked against (the graph
 * health and context notes cite measurements on it), and every release-gated
 * fallback below targets something newer, so this states what the code already
 * does rather than dropping anyone. Raising it is how a fallback becomes
 * removable.
 */
export const MIN_BACKEND_VERSION = "1.0.30";

/** The first release whose bulk route applies DeleteNode/DeleteEdge (Ix-memory #211, #237). */
export const BULK_DELETES_SINCE = "1.0.32";

/** The first release that serves `POST /v1/nodes` (Ix-memory batch reads). */
export const BATCH_NODE_READS_SINCE = "1.0.33";

export type BackendFeature =
  | "searchScope"
  | "bulkDeletes"
  | "batchNodes"
  | "degree"
  | "databaseHealth"
  | "stitch"
  | "workspaceSystem"
  | "asyncReset";

export interface BackendFeatureSpec {
  /** Short description, for people. */
  readonly label: string;
  /** The route or field the feature is. */
  readonly surface: string;
  /**
   * The first Ix-memory release that has it; its fallback is removable once
   * `MIN_BACKEND_VERSION` reaches it. Null when this repository does not
   * record the release: the CLI started calling the route before it tracked
   * backend releases, so the fallback is removable once that release is looked
   * up, recorded here, and the floor is at or above it.
   */
  readonly since: string | null;
  /**
   * HTTP statuses that mean "this backend has no such route". Empty when the
   * feature is decided by release or by a field being absent, never by probing.
   */
  readonly missingStatuses: readonly number[];
  /** What the CLI does on a backend without it. */
  readonly fallback: string;
  /** The file holding that fallback. */
  readonly fallbackAt: string;
}

export const BACKEND_FEATURES: Readonly<Record<BackendFeature, BackendFeatureSpec>> = {
  searchScope: {
    label: "search path filter",
    surface: "POST /v1/search `scope`",
    since: "1.0.31",
    missingStatuses: [],
    fallback: "older backends drop the field; callers widen their candidate window and filter by path themselves",
    fallbackAt: "src/cli/commands/search.ts",
  },
  bulkDeletes: {
    label: "deletes on the bulk route",
    surface: "POST /v1/patches/bulk with DeleteNode/DeleteEdge",
    since: BULK_DELETES_SINCE,
    missingStatuses: [],
    fallback: "delete-bearing patches commit one /v1/patch per file",
    fallbackAt: "src/cli/commands/ingest.ts",
  },
  batchNodes: {
    label: "batched node reads",
    surface: "POST /v1/nodes",
    since: BATCH_NODE_READS_SINCE,
    // 405 and 501 too: a backend may route the path but not the method.
    missingStatuses: [404, 405, 501],
    fallback: "the same-hash orphan sweep turns itself off for the run",
    fallbackAt: "src/cli/commands/ingest.ts",
  },
  degree: {
    label: "degree counts",
    surface: "POST /v1/degree",
    since: "1.0.33",
    missingStatuses: [404, 405],
    fallback: "rank scores every candidate by expanding it",
    fallbackAt: "src/cli/commands/rank.ts",
  },
  databaseHealth: {
    label: "database state in health",
    surface: "the `database` field of the health answer",
    since: "1.0.33",
    missingStatuses: [],
    fallback: "the database is probed with a revision read",
    fallbackAt: "src/cli/database-probe.ts",
  },
  stitch: {
    label: "cross-workspace stitch",
    surface: "POST /v1/stitch",
    since: null,
    missingStatuses: [404, 501],
    fallback: "the stitch step is skipped and not counted as a failure",
    fallbackAt: "src/cli/commands/ingest.ts",
  },
  workspaceSystem: {
    label: "workspace system lookup",
    surface: "GET /v1/stitch/system/:workspaceId",
    since: null,
    missingStatuses: [404],
    fallback: "the workspace is treated as belonging to no system",
    fallbackAt: "src/client/api.ts",
  },
  asyncReset: {
    label: "asynchronous reset",
    surface: "POST /v1/reset/async, /v1/reset/code/async",
    since: null,
    missingStatuses: [404],
    fallback: "a remote reset uses the synchronous route",
    fallbackAt: "src/client/api.ts",
  },
};

/**
 * The HTTP status `IxClient` put at the front of its `${status}: ${body}`
 * error, when there is one. Anchored, so a three-digit run anywhere else in the
 * message (a port, a byte count, a body that quotes "404: Not Found") is never
 * read as a status.
 */
export function httpStatus(error: unknown): number | null {
  const text = error instanceof Error ? error.message : String(error);
  const match = /^(?:Error:\s*)?(\d{3}):/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Does this failure (an `IxClient` error, or a raw response status) mean the
 * backend does not serve `feature`'s route? False for any other failure, which
 * the caller handles as it would any failed request.
 */
export function routeMissing(feature: BackendFeature, failure: unknown): boolean {
  const status = typeof failure === "number" ? failure : httpStatus(failure);
  return status !== null && BACKEND_FEATURES[feature].missingStatuses.includes(status);
}

/**
 * Features (per endpoint) not to use again until the time stored (epoch ms).
 * Process-local and bounded by a TTL, so a long-lived `ix mcp` server tries
 * again after a backend upgrade.
 */
const offUntil = new Map<string, number>();

const memoKey = (feature: BackendFeature, endpoint: string): string => `${feature}\u0000${endpoint}`;

/** Stop using `feature` against `endpoint` for `ttlMs`. */
export function markFeatureOff(feature: BackendFeature, endpoint: string, ttlMs: number): void {
  offUntil.set(memoKey(feature, endpoint), Date.now() + ttlMs);
}

/** Whether `feature` was marked off for `endpoint` and the mark has not expired. */
export function featureOff(feature: BackendFeature, endpoint: string): boolean {
  const key = memoKey(feature, endpoint);
  const until = offUntil.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  offUntil.delete(key);
  return false;
}

function parseRelease(value: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether a reported release is at least `min`: null when there is none, or
 * one that does not parse.
 */
export function releaseAtLeast(release: unknown, min: string): boolean | null {
  if (typeof release !== "string") return null;
  const have = parseRelease(release);
  const need = parseRelease(min);
  if (have === null || need === null) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

/** Whether a reported release is older than `MIN_BACKEND_VERSION`; null when unknown. */
export function backendBelowMinimum(release: unknown): boolean | null {
  const atLeast = releaseAtLeast(release, MIN_BACKEND_VERSION);
  return atLeast === null ? null : !atLeast;
}

/**
 * The features a reported release is known to lack, in table order. Empty when
 * the release is unknown: that proves nothing either way.
 */
export function missingFeatures(release: unknown): BackendFeature[] {
  return (Object.keys(BACKEND_FEATURES) as BackendFeature[]).filter((feature) => {
    const since = BACKEND_FEATURES[feature].since;
    return since !== null && releaseAtLeast(release, since) === false;
  });
}

/**
 * Can `feature`'s fallback be deleted with `min` as the supported floor? Null
 * when the release that introduced it is not recorded.
 */
export function fallbackRemovable(feature: BackendFeature, min: string = MIN_BACKEND_VERSION): boolean | null {
  const since = BACKEND_FEATURES[feature].since;
  return since === null ? null : releaseAtLeast(min, since);
}
