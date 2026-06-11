import * as fs from "node:fs";
import * as path from "node:path";
import { IxClient } from "../client/api.js";
import { SUPPORTED_EXTENSIONS } from "./supported-extensions.js";

export interface StaleInfo {
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

/**
 * Detect files that have been modified since the last ingest.
 * Uses mtime comparison against the latest patch timestamp.
 */
export async function detectStaleFiles(
  client: IxClient,
  root: string,
  maxSamples: number = 5
): Promise<StaleInfo> {
  // Get latest patch to determine last ingest time
  const patches = await client.listPatches({ limit: 1 });
  const stats = await client.stats();

  const lastPatch = patches[0];
  const lastIngestAt = lastPatch?.timestamp ?? null;
  const currentRev = lastPatch?.rev ?? 0;

  if (!lastIngestAt) {
    return { lastIngestAt: null, currentRev: 0, staleFiles: 0, sampleChangedFiles: [] };
  }

  const lastIngestTime = new Date(lastIngestAt).getTime();
  const files = collectFiles(root);
  const changedFiles: string[] = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > lastIngestTime) {
        // Make path relative to root for display
        const relative = path.relative(root, filePath);
        changedFiles.push(relative);
      }
    } catch {
      // skip inaccessible files
    }
  }

  return {
    lastIngestAt,
    currentRev,
    staleFiles: changedFiles.length,
    sampleChangedFiles: changedFiles.slice(0, maxSamples),
  };
}

/**
 * Check if a specific file path is stale (modified since last ingest).
 */
export async function isFileStale(
  client: IxClient,
  filePath: string
): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;

  const patches = await client.listPatches({ limit: 1 });
  const lastPatch = patches[0];
  if (!lastPatch?.timestamp) return false;

  const lastIngestTime = new Date(lastPatch.timestamp).getTime();
  try {
    const stat = fs.statSync(filePath);
    return stat.mtimeMs > lastIngestTime;
  } catch {
    return false;
  }
}
