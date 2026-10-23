// Copyright 2026 Ix Infrastructure Inc.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { canonicalWorkspacePath, findWorkspaceForCwd, gitRootFor, isPathInside, resolveWorkspaceRoot } from "./config.js";

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

  const local = localRootFor(cwd);
  if (local) return canonicalMapRoot(local);

  return canonicalMapRoot(resolveWorkspaceRoot(undefined, cwd));
}

/**
 * Steps 2 and 3 of both cascades in this file: the registered workspace
 * containing `dir`, else the git root of `dir`. Undefined when `dir` has
 * neither. The nearest registration wins, so a repo registered inside another
 * (a member of a multi-repo system mapped on its own) keeps its own root.
 */
export function localRootFor(dir: string): string | undefined {
  return findWorkspaceForCwd(dir)?.root_path ?? gitRootFor(dir);
}

/**
 * Which workspace does `ix ingest <path>` write to?
 *
 * Not simply the path. Treating it as its own root made `ix ingest src/a.ts`
 * inside a mapped repo register `repo/src` as a second workspace, emit
 * `a.ts` instead of `src/a.ts` under that workspace's id, and from then on
 * route every read under `src/` to it. A path is a part of a workspace far
 * more often than it is one, so:
 *
 *   1. an explicit `--root` (the path must be inside it)
 *   2. the registered workspace containing the path
 *   3. the path's git root, unless that is the home directory
 *   4. the path itself for a directory, its directory for a file -- a path
 *      in no workspace and no repository is ingested under its own path id.
 *      A directory is then registered after the commit (the user named it); a
 *      loose FILE is never registered, so ingesting one file cannot make its
 *      whole directory readable. Over MCP a loose path is refused outright.
 *
 * Step 3 skips a git root at `$HOME` (a dotfiles repo): registering the whole
 * home directory as a workspace would route every later read under it there.
 * A workspace the user registered at `$HOME` is still honoured by step 2.
 *
 * The same local-first order as `resolveMapRoot`, minus its named/default
 * workspace step: that one answers "which repo is cwd in", and a path the
 * user named outside every workspace and repository belongs to none of them.
 *
 * A path below the returned root is a partial ingest of that workspace; see
 * `ingestFiles`. Returned canonical (realpath'd), like the path ingest hands in.
 */
export function resolveIngestRoot(target: string, isDirectory: boolean, explicitRoot?: string): string {
  return resolveIngestRootWithSource(target, isDirectory, explicitRoot).root;
}

/** Which step of {@link resolveIngestRootWithSource} chose the root; 'loose' is step 4 (and a git root at $HOME). */
export type IngestRootSource = 'explicit' | 'workspace' | 'git' | 'loose';

/** {@link resolveIngestRoot}, also saying which step chose the root. */
export function resolveIngestRootWithSource(
  target: string, isDirectory: boolean, explicitRoot?: string,
): { root: string; source: IngestRootSource } {
  const canonicalTarget = canonicalWorkspacePath(target);
  if (explicitRoot) {
    const root = canonicalWorkspacePath(explicitRoot);
    let rootIsDirectory = false;
    try { rootIsDirectory = statSync(root).isDirectory(); } catch { /* reported below */ }
    if (!rootIsDirectory) throw new Error(`--root is not a directory: ${root}`);
    if (!isPathInside(root, canonicalTarget)) {
      throw new Error(`${canonicalTarget} is outside --root ${root}. Pass a path inside the root, or drop --root.`);
    }
    return { root, source: 'explicit' };
  }
  const probe = isDirectory ? canonicalTarget : dirname(canonicalTarget);
  const registered = findWorkspaceForCwd(probe)?.root_path;
  if (registered) return { root: canonicalWorkspacePath(registered), source: 'workspace' };
  const gitRoot = gitRootFor(probe);
  if (gitRoot && canonicalWorkspacePath(gitRoot) !== canonicalWorkspacePath(homedir())) {
    return { root: canonicalWorkspacePath(gitRoot), source: 'git' };
  }
  return { root: probe, source: 'loose' };
}
