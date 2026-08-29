import * as fs from "node:fs";
import * as path from "node:path";
import { ingestMtimeCachePath } from "./config.js";

interface SerializedIngestBaseline {
  root: string;
  files: Record<string, number>;
  deletedFiles?: Record<string, string[]>;
  currentRev?: number;
  lastIngestAt?: string;
  tracksMapBaseline?: boolean;
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
}

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
    };
    fs.mkdirSync(path.dirname(ingestMtimeCachePath(projectRoot)), { recursive: true });
    fs.writeFileSync(ingestMtimeCachePath(projectRoot), JSON.stringify(data));
  } catch {
    // The cache is an optimization and freshness hint. Ingestion itself succeeded.
  }
}
