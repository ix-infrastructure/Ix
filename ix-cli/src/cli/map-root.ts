import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { findWorkspaceForCwd, gitRootFor, resolveWorkspaceRoot } from "./config.js";

export function canonicalMapRoot(candidate: string): string {
  const resolved = resolve(candidate);
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`Map path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Map path is not a directory: ${resolved}`);
  }
  return realpathSync.native(resolved);
}

/**
 * Which root does a bare `ix map` ingest?
 *
 * Deliberately NOT `resolveWorkspaceRoot`'s cascade. That one answers "which
 * graph am I querying?", where a configured workspace outranking the current
 * directory is the point. `ix map` writes: it re-ingests a tree and rewrites
 * that workspace's baseline. Letting a configured default outrank the
 * repository the user is standing in means `ix map` inside repo A silently
 * re-ingests repo B, with nothing on screen naming B.
 *
 * So the local answer wins whenever there is one:
 *   1. an explicit path argument
 *   2. the registered workspace containing cwd
 *   3. cwd's own git root  <- ahead of the named/default workspace
 *   4. the named/default workspace, for a cwd with no local context at all
 *   5. cwd
 */
export function resolveMapRoot(pathArg?: string, cwd = process.cwd()): string {
  if (pathArg) return canonicalMapRoot(resolve(cwd, pathArg));

  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return canonicalMapRoot(nearest.root_path);

  const gitRoot = gitRootFor(cwd);
  if (gitRoot) return canonicalMapRoot(gitRoot);

  return canonicalMapRoot(resolveWorkspaceRoot(undefined, cwd));
}
