// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWorkspaceRoot } from "./config.js";
import { loadIngestBaseline } from "./ingest-baseline.js";
import { hasCompletedMapFor } from "./map-baseline.js";
import { canonicalizeDiscoveredFilePath, discoverSourceFiles } from "./file-discovery.js";

export interface StaleInfo {
  graphCompleted: boolean;
  mapCompleted: boolean;
  lastIngestAt: string | null;
  currentRev: number;
  staleFiles: number;
  sampleChangedFiles: string[];
  /** Changed files the last run could not get applied (F-01); see `IngestBaseline.replayedFiles`. */
  replayedFiles: string[];
  /**
   * Files the last run skipped because their parse ran past the budget, still
   * on disk; see `IngestBaseline.parseTimeouts`. Not counted in `staleFiles`:
   * another run will not fix them, a larger IX_PARSE_BUDGET_MS will.
   */
  parseTimeouts: string[];
}

/**
 * Most files `ix status` reads when the workspace is not a git work tree; the
 * cap the old status walk had. A walk has no bound of its own, and status runs
 * on every agent turn: from a home directory it would read the whole disk.
 * Files past the cap are not checked for changes. They do not look deleted:
 * a baseline entry counts as deleted only when the file is gone from disk.
 */
const STATUS_WALK_LIMIT = 5000;

/**
 * The files `ix map` would discover (see `file-discovery.ts`), so "changed
 * since the last ingest" is judged over the same set the ingest recorded. A
 * git listing is complete; a walk stops at `walkLimit`.
 */
function collectFiles(dir: string, walkLimit: number): string[] {
  return discoverSourceFiles(dir, { walkLimit });
}

function differsFromIngestBaseline(
  filePath: string,
  mtimeMs: number,
  ingestedMtimes: Map<string, number>,
  lastIngestAt: string,
): boolean {
  const ingestedMtime = ingestedMtimes.get(filePath);
  return ingestedMtime === undefined
    ? mtimeMs > Date.parse(lastIngestAt)
    : ingestedMtime !== mtimeMs;
}

/**
 * Absolute paths for a baseline's list of files the last run could not
 * ingest. They count as changed whatever their mtime: a new one is absent from
 * `files` with an mtime older than `lastIngestAt`, which would otherwise read
 * as current.
 */
function absoluteSet(workspaceRoot: string, relPaths: readonly string[]): Set<string> {
  return new Set(relPaths.map((rel) => path.resolve(workspaceRoot, rel)));
}

/**
 * Detect files that have been modified since the last ingest.
 * Uses the workspace-local ingest baseline so another workspace cannot advance it.
 *
 * Takes no client and is not async, by construction rather than by discipline.
 * Staleness used to be decided from `listPatches({ limit: 1 })`, which carries
 * no workspace, so it answered with whatever repo was mapped most recently
 * anywhere on the machine (#353). Keeping an unused client parameter around
 * left the door open to reaching for it again; without one there is nothing to
 * reach for, and the local-only property holds because it is the only thing the
 * signature permits.
 */
export function detectStaleFiles(
  root: string,
  maxSamples: number = 5,
  walkLimit: number = STATUS_WALK_LIMIT,
): StaleInfo {
  const workspaceRoot = path.resolve(root);
  const baseline = loadIngestBaseline(workspaceRoot);
  if (!baseline) {
    return {
      graphCompleted: false,
      mapCompleted: false,
      lastIngestAt: null,
      currentRev: 0,
      staleFiles: 0,
      sampleChangedFiles: [],
      replayedFiles: [],
      parseTimeouts: [],
    };
  }

  // Discovery returns canonical paths (macOS `/var` is `/private/var`, a
  // Windows 8.3 name is expanded), while the baseline's keys sit under the root
  // as it was given. Compare and display both under the canonical root.
  const canonicalRoot = canonicalizeDiscoveredFilePath(workspaceRoot);
  const underCanonicalRoot = (absolutePath: string): string =>
    canonicalRoot !== workspaceRoot && absolutePath.startsWith(workspaceRoot + path.sep)
      ? canonicalRoot + absolutePath.slice(workspaceRoot.length)
      : absolutePath;
  const ingestedMtimes = new Map<string, number>();
  for (const [ingestedPath, mtime] of baseline.files) {
    const absolutePath = path.isAbsolute(ingestedPath)
      ? path.resolve(ingestedPath)
      : path.resolve(workspaceRoot, ingestedPath);
    ingestedMtimes.set(underCanonicalRoot(absolutePath), mtime);
  }

  const files = collectFiles(workspaceRoot, walkLimit).map(underCanonicalRoot);
  const currentFiles = new Set(files);
  const changedFiles: string[] = [];
  // Under the canonical root, like everything else compared here.
  const canonicalSet = (relPaths: readonly string[]): Set<string> =>
    new Set([...absoluteSet(workspaceRoot, relPaths)].map(underCanonicalRoot));
  const pending = canonicalSet(baseline.pendingFiles);
  // Canonical path -> the baseline's own workspace-relative spelling, which is
  // what status reports: POSIX separators on every platform, as the ingest
  // summary names them.
  const timedOut = new Map(
    baseline.parseTimeouts.map((rel) => [underCanonicalRoot(path.resolve(workspaceRoot, rel)), rel]),
  );
  const parseTimeouts: string[] = [];

  for (const filePath of files) {
    const timedOutAs = timedOut.get(filePath);
    if (timedOutAs !== undefined) {
      parseTimeouts.push(timedOutAs);
      continue;
    }
    try {
      const stat = fs.statSync(filePath);
      if (
        pending.has(filePath)
        || differsFromIngestBaseline(filePath, stat.mtimeMs, ingestedMtimes, baseline.lastIngestAt)
      ) {
        // Make path relative to root for display
        changedFiles.push(path.relative(canonicalRoot, filePath));
      }
    } catch {
      // skip inaccessible files
    }
  }

  for (const absolutePath of ingestedMtimes.keys()) {
    if (!currentFiles.has(absolutePath) && !fs.existsSync(absolutePath)) {
      changedFiles.push(path.relative(canonicalRoot, absolutePath));
    }
  }

  return {
    graphCompleted: true,
    mapCompleted: hasCompletedMapFor(workspaceRoot, baseline),
    lastIngestAt: baseline.lastIngestAt,
    currentRev: baseline.currentRev,
    staleFiles: changedFiles.length,
    sampleChangedFiles: changedFiles.slice(0, maxSamples),
    replayedFiles: baseline.replayedFiles,
    parseTimeouts,
  };
}

/**
 * Whether the active workspace has a completed map baseline.
 *
 * The marker is written only after a non-empty hierarchy response and is tied
 * to the source revision it mapped. A later clean ingest therefore leaves the
 * source graph usable while making the prior hierarchy incomplete for the new
 * revision.
 */
export function hasCompletedMapBaseline(root?: string): boolean {
  try {
    const workspaceRoot = path.resolve(root ?? resolveWorkspaceRoot());
    const baseline = loadIngestBaseline(workspaceRoot);
    return baseline !== null && hasCompletedMapFor(workspaceRoot, baseline);
  } catch {
    return false;
  }
}

/** Whether source ingestion completed cleanly for the active workspace. */
export function hasCompletedSourceGraphBaseline(root?: string): boolean {
  try {
    return loadIngestBaseline(path.resolve(root ?? resolveWorkspaceRoot())) !== null;
  } catch {
    return false;
  }
}

/**
 * Check if a specific file path differs from the active workspace's ingest baseline.
 *
 * Synchronous now that it reads a local file instead of the patch log. It is
 * called per result on `ix explain`, `ix locate` and `ix read`, so the `await`
 * this used to need was once a backend round-trip per file.
 */
export function isFileStale(filePath: string): boolean {
  return createStaleProbe()(filePath);
}

/**
 * A staleness predicate that loads the ingest baseline once.
 *
 * `isFileStale` re-reads and re-parses the whole mtime cache on every call,
 * which is fine for the handful of results `ix explain` / `ix locate` /
 * `ix read` check but not for a caller asking about many files at once — that
 * turns one JSON parse of a file holding every ingested path into N of them.
 * Callers with a list should take a probe and reuse it.
 */
export function createStaleProbe(): (filePath: string) => boolean {
  const workspaceRoot = path.resolve(resolveWorkspaceRoot());
  const baseline = loadIngestBaseline(workspaceRoot);
  const pending = baseline
    ? absoluteSet(workspaceRoot, [...baseline.pendingFiles, ...baseline.parseTimeouts])
    : new Set<string>();

  return (filePath: string): boolean => {
    // No baseline means the question this probe answers — "did this file change
    // since it was ingested?" — has no answer, not that the answer is yes. The
    // baseline is absent for a cloud-ingested workspace and for any workspace
    // whose ingest never completed cleanly, so answering `true` reported every
    // result of every command as modified in repos that were perfectly current.
    // That unverified state is carried by `ix context`'s freshness
    // classification instead, which can say so without claiming a file changed.
    if (!baseline) return false;

    const absolutePath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(workspaceRoot, filePath);
    if (!fs.existsSync(absolutePath)) {
      return baseline.files.has(absolutePath) || baseline.files.has(filePath);
    }
    if (pending.has(absolutePath)) return true;

    try {
      return differsFromIngestBaseline(
        absolutePath,
        fs.statSync(absolutePath).mtimeMs,
        baseline.files,
        baseline.lastIngestAt,
      );
    } catch {
      return false;
    }
  };
}
