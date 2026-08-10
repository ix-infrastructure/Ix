import * as fs from "node:fs";
import * as path from "node:path";
import { ingestMtimeCachePath } from "./config.js";

interface SerializedIngestBaseline {
  root: string;
  files: Record<string, number>;
  deletedFiles?: Record<string, string[]>;
  currentRev?: number;
  lastIngestAt?: string;
}

export interface IngestBaseline {
  files: Map<string, number>;
  deletedFiles: Map<string, string[]>;
  currentRev: number;
  lastIngestAt: string;
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
    const currentRev =
      typeof data.currentRev === "number" &&
      Number.isInteger(data.currentRev) &&
      data.currentRev >= 0
        ? data.currentRev
        : 0;

    return { files, deletedFiles, currentRev, lastIngestAt };
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
    const previousRev = loadIngestBaseline(projectRoot)?.currentRev ?? 0;
    // The rev reaches us straight off the backend's commit response, and until
    // now only the read side checked its shape. That asymmetry is a quiet trap:
    // a non-integer rev (an older backend answering with a string, say) sails
    // through a bare `> 0`, gets written, and is then rejected by
    // loadIngestBaseline on the next run — which resets the rev to 0 and costs a
    // full re-ingest, every run, with nothing said. Insist on the same shape
    // both sides already agree on.
    const rev = Number.isInteger(currentRev) && currentRev > 0 ? currentRev : previousRev;
    const data: SerializedIngestBaseline = {
      root: projectRoot,
      files: Object.fromEntries(mtimes),
      deletedFiles: Object.fromEntries(deletedFiles),
      currentRev: rev,
      lastIngestAt: now.toISOString(),
    };
    fs.mkdirSync(path.dirname(ingestMtimeCachePath(projectRoot)), { recursive: true });
    fs.writeFileSync(ingestMtimeCachePath(projectRoot), JSON.stringify(data));
  } catch {
    // The cache is an optimization and freshness hint. Ingestion itself succeeded.
  }
}
