// Copyright 2026 Ix Infrastructure Inc.

/**
 * `ix status --format json`: the backend, how current the workspace's graph
 * is, and the last `ix verify`.
 *
 * Fields are only added. A failure (the backend is not reachable) is the
 * shared failure record (envelope.ts) instead, exit 1.
 *
 * This is not the `--format llm` record: `stale`, `graph_health` and `rev` are
 * llm keys. In json the answers are `staleFiles`, `graphHealth.status` and
 * `currentRev`.
 */

import type { GraphHealthJson } from "../graph-health.js";
import type { VerifyGraphVerdict } from "../verify.js";

/**
 * The graph check. `status` is the verdict as `ix status` words it: a check
 * that could not run says `unverified`, not `unknown`.
 */
export type StatusGraphHealthJson = Omit<GraphHealthJson, "status"> & {
  status: "ok" | "degraded" | "empty" | "unverified";
};

/** The last whole-root `ix verify` (verify.ts), as status reports it. */
export interface StatusVerifyJson {
  at: string;
  graph: VerifyGraphVerdict;
  files: number;
  diverged: number;
  stale: number;
  unverified: number;
  /** The last ingest the verify saw. */
  lastIngestAt: string | null;
  /** The workspace was ingested after the verify ran: its counts are an earlier graph's. */
  outdated: boolean;
  fix: string | null;
}

export interface StatusJson {
  /** The backend's health word (`ok`, `degraded`). */
  backend: string;
  /** Null when the workspace's ingest state could not be read. */
  graphCompleted: boolean | null;
  mapCompleted: boolean | null;
  /** The map was deferred after an edit (CL-13). */
  mapStale: boolean;
  /** Why the last background map refresh failed, while the map is stale. */
  mapRefreshError: string | null;
  currentRev: number | null;
  lastIngestAt: string | null;
  /** Files changed since the last ingest; `sampleChangedFiles` names some of them. */
  staleFiles: number;
  sampleChangedFiles: string[];
  /** Changed files the last run could not get applied. */
  replayedFiles: string[];
  /** Files skipped because their parse ran past the budget. */
  parseTimeouts: string[];
  graphHealth: StatusGraphHealthJson;
  /** Null when no whole-root `ix verify` has run. */
  verify: StatusVerifyJson | null;
}
