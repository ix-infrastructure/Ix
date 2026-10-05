// Copyright 2026 Ix Infrastructure Inc.

import * as fs from "node:fs";
import * as path from "node:path";
import { ingestMtimeCachePath, ingestRebuildPath } from "./config.js";

interface SerializedIngestBaseline {
  root: string;
  files: Record<string, number>;
  deletedFiles?: Record<string, string[]>;
  currentRev?: number;
  lastIngestAt?: string;
  tracksMapBaseline?: boolean;
  extractor?: string;
  replayedFiles?: string[];
  pendingFiles?: string[];
  parseTimeouts?: string[];
}

export interface IngestBaseline {
  files: Map<string, number>;
  deletedFiles: Map<string, string[]>;
  currentRev: number;
  lastIngestAt: string;
  /**
   * Whether this baseline was written by a CLI that also maintains the
   * architecture-map marker.
   *
   * Absent on every baseline written before that marker existed, which is what
   * makes it usable as an upgrade signal: such a workspace has a clean source
   * ingest and no marker, and the CLI that produced it *reported that state as
   * map-complete*. Treating it as incomplete on the first run after an upgrade
   * would fail `ix doctor` on every existing workspace at once, for a claim
   * nothing has actually re-evaluated. See `hasCompletedMapFor`.
   */
  tracksMapBaseline: boolean;
  /**
   * The extractor (`extractorName()`) whose output the recorded files carry.
   * Null on a baseline written before this was recorded, which could have been
   * any extractor, so it counts as a change. See `extractorChanged`.
   */
  extractor: string | null;
  /**
   * Workspace-relative paths of changed files the last run sent and the
   * backend answered `Idempotent`: it already held that patch id and wrote
   * nothing, so the graph does not show these files as they are (F-01, a
   * revert or a restore). Empty when every change was applied. Their mtimes
   * are kept at the previous value, so the next run sends them again.
   */
  replayedFiles: string[];
  /**
   * Workspace-relative paths of changed files the last run could not ingest:
   * a read or build error, a failed commit, a parse lost to a dead worker.
   * Each keeps its previous mtime, so the next run retries it. A new file has
   * no previous mtime and is left out of `files`, and a file missing from
   * `files` is judged stale against `lastIngestAt`, which that same run moved
   * past the file's mtime -- so without this list `ix status` called the
   * graph current while the file was not in it.
   */
  pendingFiles: string[];
  /**
   * Workspace-relative paths of files whose parse ran past the per-file
   * budget (`IX_PARSE_BUDGET_MS`) on the last run, so they are not in the
   * graph. Not settled: like `pendingFiles` they keep their previous mtime
   * (or none) and every run tries them again, and `ix status` warns about
   * them rather than calling the graph current. A slow file times out on
   * every run, so recording it clean skipped it for good.
   */
  parseTimeouts: string[];
}

/** Per-file lists a baseline write records beside the mtimes. */
export interface BaselineFileNotes {
  /** See `IngestBaseline.replayedFiles`. */
  replayedFiles?: readonly string[];
  /** See `IngestBaseline.pendingFiles`. */
  pendingFiles?: readonly string[];
  /** See `IngestBaseline.parseTimeouts`. */
  parseTimeouts?: readonly string[];
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];

/**
 * What counts as a revision, for both sides of this file.
 *
 * The rev arrives off the backend's commit response, so it is response data
 * rather than anything this process computed, and `typeof` is not enough — the
 * read side has always insisted on a non-negative integer. One predicate so the
 * two sides cannot drift apart again; they were previously three lines apart
 * and disagreed.
 */
export function isRev(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function loadIngestBaseline(projectRoot: string): IngestBaseline | null {
  const cachePath = ingestMtimeCachePath(projectRoot);
  try {
    const data = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as SerializedIngestBaseline;
    if (data.root !== projectRoot || !data.files || typeof data.files !== "object") return null;

    const files = new Map<string, number>();
    for (const [filePath, mtime] of Object.entries(data.files)) {
      if (Number.isFinite(mtime)) files.set(filePath, mtime);
    }
    const deletedFiles = new Map<string, string[]>();
    for (const [filePath, dependents] of Object.entries(data.deletedFiles ?? {})) {
      if (!Array.isArray(dependents)) continue;
      deletedFiles.set(
        filePath,
        dependents.filter((dependent): dependent is string => typeof dependent === "string"),
      );
    }

    const parsedTimestamp = data.lastIngestAt ? Date.parse(data.lastIngestAt) : Number.NaN;
    const lastIngestAt = Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : fs.statSync(cachePath).mtime.toISOString();
    const currentRev = isRev(data.currentRev) ? data.currentRev : 0;

    return {
      files,
      deletedFiles,
      currentRev,
      lastIngestAt,
      tracksMapBaseline: data.tracksMapBaseline === true,
      extractor: typeof data.extractor === "string" ? data.extractor : null,
      replayedFiles: stringList(data.replayedFiles),
      pendingFiles: stringList(data.pendingFiles),
      parseTimeouts: stringList(data.parseTimeouts),
    };
  } catch {
    return null;
  }
}

export function saveIngestBaseline(
  projectRoot: string,
  mtimes: Map<string, number>,
  currentRev: number,
  now: Date = new Date(),
  deletedFiles: Map<string, string[]> = new Map(),
  extractor?: string | null,
  { replayedFiles = [], pendingFiles = [], parseTimeouts = [] }: BaselineFileNotes = {},
): void {
  try {
    // Keep the last good rev rather than writing a shape the read side will
    // reject. `ix status` is the only thing that reads this number, so a bad one
    // costs a wrong Revision line, not a re-ingest — incremental skipping runs
    // off the mtime map below and is unaffected either way. The lookup is lazy
    // because it parses the entire baseline for one integer, and the reject
    // branch is the only one that wants it: onCommitted calls this once per
    // deleted file, so an eager read would re-parse the whole map N times.
    const rev = isRev(currentRev) && currentRev > 0
      ? currentRev
      : (loadIngestBaseline(projectRoot)?.currentRev ?? 0);
    const data: SerializedIngestBaseline = {
      root: projectRoot,
      files: Object.fromEntries(mtimes),
      deletedFiles: Object.fromEntries(deletedFiles),
      currentRev: rev,
      lastIngestAt: now.toISOString(),
      // Written unconditionally from here on, so its absence dates a baseline
      // to before the map marker existed. The first ingest after an upgrade
      // sets it, which is what ends the grandfathering for this workspace.
      tracksMapBaseline: true,
      ...(extractor ? { extractor } : {}),
      ...(replayedFiles.length > 0 ? { replayedFiles: [...replayedFiles].sort() } : {}),
      ...(pendingFiles.length > 0 ? { pendingFiles: [...new Set(pendingFiles)].sort() } : {}),
      ...(parseTimeouts.length > 0 ? { parseTimeouts: [...new Set(parseTimeouts)].sort() } : {}),
    };
    const target = ingestMtimeCachePath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Via a temp file and rename: a process killed mid-write left a truncated
    // baseline, which reads as none, and the next map re-ingested everything.
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, target);
    } catch (err) {
      // A failed rename (a locked target on Windows, say) must not leave the
      // temp file behind; one would pile up per failing run.
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  } catch {
    // The cache is an optimization and freshness hint. Ingestion itself succeeded.
  }
}

/**
 * Whether the files in `baseline` were extracted by a different extractor.
 *
 * `ix map` skips a file whose mtime or source hash is unchanged, and neither
 * sees an extractor bump, so without this an unchanged file keeps the nodes and
 * edges the old extractor built until it is edited or `--force` runs. No
 * baseline means nothing was skipped anyway, so it is not a change.
 */
export function extractorChanged(baseline: IngestBaseline | null, current: string): boolean {
  return baseline !== null && baseline.extractor !== current;
}

/**
 * Files an unfinished re-ingest for `extractor` has already committed, with the
 * mtime each had then; null when there is none for this extractor.
 *
 * The re-ingest an extractor change forces takes about twice a first map, and
 * the mtime baseline is written only when a run finishes. So a run cut short --
 * an editor hook's timeout, a closed terminal -- used to leave nothing behind,
 * and every later run started over and could be cut short at the same point.
 * Recording progress as files land lets the next run skip what is done.
 */
export function loadRebuildProgress(projectRoot: string, extractor: string): Map<string, number> | null {
  try {
    const data = JSON.parse(fs.readFileSync(ingestRebuildPath(projectRoot), "utf-8")) as {
      root?: unknown; extractor?: unknown; files?: Record<string, unknown>;
    };
    if (data.root !== projectRoot || data.extractor !== extractor || !data.files || typeof data.files !== "object") {
      return null;
    }
    const files = new Map<string, number>();
    for (const [filePath, mtime] of Object.entries(data.files)) {
      if (typeof mtime === "number" && Number.isFinite(mtime)) files.set(filePath, mtime);
    }
    return files;
  } catch {
    return null;
  }
}

export function saveRebuildProgress(projectRoot: string, extractor: string, files: Map<string, number>): void {
  try {
    const target = ingestRebuildPath(projectRoot);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Via a temp file and rename: a process killed mid-write would otherwise
    // leave a truncated file, and the next run would start over.
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ root: projectRoot, extractor, files: Object.fromEntries(files) }));
    fs.renameSync(tmp, target);
  } catch {
    // Progress is an optimization; losing it costs a longer re-ingest, not data.
  }
}

export function clearRebuildProgress(projectRoot: string): void {
  try { fs.rmSync(ingestRebuildPath(projectRoot), { force: true }); } catch { /* non-critical */ }
}
