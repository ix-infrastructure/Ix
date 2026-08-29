import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWorkspaceRoot } from "./config.js";
import { loadIngestBaseline } from "./ingest-baseline.js";
import { hasCompletedMapFor } from "./map-baseline.js";
import { SUPPORTED_EXTENSIONS } from "./supported-extensions.js";

export interface StaleInfo {
  graphCompleted: boolean;
  mapCompleted: boolean;
  lastIngestAt: string | null;
  currentRev: number;
  staleFiles: number;
  sampleChangedFiles: string[];
}

const SUPPORTED_NAMES = new Set([
  ".gitignore", ".gitattributes", ".editorconfig", ".env",
  ".eslintrc", ".prettierrc", ".babelrc",
  "Makefile", "Dockerfile", "Procfile", "Gemfile", "Rakefile",
  "BUILD", "WORKSPACE",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next",
  ".cache", "__pycache__", ".ix", ".claude",
]);

/**
 * Walk a directory and collect file paths with supported extensions.
 * Bounded to prevent runaway on huge repos.
 */
function collectFiles(dir: string, limit: number = 5000): string[] {
  const results: string[] = [];
  const stack = [dir];

  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext) || SUPPORTED_NAMES.has(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
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
  maxSamples: number = 5
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
    };
  }

  const files = collectFiles(workspaceRoot);
  const currentFiles = new Set(files.map((filePath) => path.resolve(filePath)));
  const changedFiles: string[] = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (
        differsFromIngestBaseline(filePath, stat.mtimeMs, baseline.files, baseline.lastIngestAt)
      ) {
        // Make path relative to root for display
        const relative = path.relative(workspaceRoot, filePath);
        changedFiles.push(relative);
      }
    } catch {
      // skip inaccessible files
    }
  }

  for (const ingestedPath of baseline.files.keys()) {
    const absolutePath = path.isAbsolute(ingestedPath)
      ? path.resolve(ingestedPath)
      : path.resolve(workspaceRoot, ingestedPath);
    if (!currentFiles.has(absolutePath) && !fs.existsSync(absolutePath)) {
      changedFiles.push(path.relative(workspaceRoot, absolutePath));
    }
  }

  return {
    graphCompleted: true,
    mapCompleted: hasCompletedMapFor(workspaceRoot, baseline),
    lastIngestAt: baseline.lastIngestAt,
    currentRev: baseline.currentRev,
    staleFiles: changedFiles.length,
    sampleChangedFiles: changedFiles.slice(0, maxSamples),
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
