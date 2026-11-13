// Copyright 2026 Ix Infrastructure Inc.

/**
 * Workspace selection: the registered workspaces, the one a directory belongs
 * to, linked-worktree detection, and the root a command works in. Split out of
 * `config.ts` (#943); `config.ts` re-exports everything here.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, type WorkspaceConfig } from "./config-store.js";
import { canonicalWorkspacePath, isPathInside } from "./path-containment.js";

export function loadWorkspaces(): WorkspaceConfig[] {
  const config = loadConfig();
  return config.workspaces ?? []; // workspace_id already normalized to string in loadConfig
}

/**
 * Is `dir` the root of a linked git worktree (`git worktree add`)? Its `.git`
 * is a file pointing at the main repository's `.git/worktrees/<name>`, a git
 * directory that holds a `commondir` file -- git's own mark of a linked
 * worktree. A submodule's `.git` file points at a full git directory with no
 * `commondir`, even when it lives under `.git/worktrees/<wt>/modules/` (a
 * submodule checked out in a worktree), and is not one: a submodule is part
 * of the repository that contains it.
 */
export function isLinkedWorktreeRoot(dir: string): boolean {
  try {
    // Read, not stat-then-read: a .git directory throws EISDIR here, which is
    // the "not a linked worktree" answer anyway.
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(join(dir, ".git"), "utf-8"))?.[1];
    // Relative when written with worktree.useRelativePaths (git 2.48+).
    return !!gitdir && existsSync(join(resolvePath(dir, gitdir), "commondir"));
  } catch {
    return false;
  }
}

export function selectWorkspaceForCwd(
  workspaces: WorkspaceConfig[],
  cwd: string,
): WorkspaceConfig | undefined {
  const canonicalCwd = canonicalWorkspacePath(cwd);
  const match = workspaces
    .map(workspace => ({ workspace, root: canonicalWorkspacePath(workspace.root_path) }))
    .filter(({ root }) => isPathInside(root, canonicalCwd))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!match) return undefined;
  // A linked worktree nested inside a registered repository (Claude Code puts
  // them at <repo>/.claude/worktrees/<name>) is a separate checkout, usually
  // on another branch. Answering for it from the enclosing repo's workspace
  // read and mapped the wrong tree; it is unmapped until it is registered,
  // exactly like a sibling worktree. Lexically below the match, so a few stats.
  for (let dir = canonicalCwd; dir !== match.root; dir = dirname(dir)) {
    if (isLinkedWorktreeRoot(dir)) return undefined;
    if (dirname(dir) === dir) break;
  }
  return match.workspace;
}

export function findWorkspaceForCwd(cwd: string): WorkspaceConfig | undefined {
  return selectWorkspaceForCwd(loadWorkspaces(), cwd);
}

export function getDefaultWorkspace(): WorkspaceConfig | undefined {
  return loadWorkspaces().find(w => w.default);
}

// Resolve a source_uri from the graph (which is now a workspace-relative
// POSIX path under the client-agnostic backend design) back to an absolute
// host filesystem path. If the input is already absolute (e.g. legacy graphs
// or external absolute paths), it is returned as-is. Used by any command that
// needs to actually open a file off disk (ix read, ix explain, ...).
export function absoluteFromSourceUri(sourceUri: string, explicitRoot?: string): string {
  if (!sourceUri) return sourceUri;
  // Treat both POSIX abs (`/`) and Windows abs (`C:\`) as already resolved.
  if (sourceUri.startsWith("/") || /^[A-Za-z]:[\\/]/.test(sourceUri)) return sourceUri;
  const root = resolveWorkspaceRoot(explicitRoot);
  // POSIX-normalize the relative segment before joining.
  const normalized = sourceUri.replace(/\\/g, "/");
  return resolvePath(root, normalized);
}

export function resolveWorkspaceRoot(explicitRoot?: string, cwd = process.cwd()): string {
  // 1. Explicit --root
  if (explicitRoot) return explicitRoot;
  // 2. Nearest initialized workspace containing cwd
  const nearest = findWorkspaceForCwd(cwd);
  if (nearest) return nearest.root_path;
  // 3. Named workspace from `ix config set workspace <name>`
  const cfg = loadConfig();
  if (cfg.workspace) {
    const named = loadWorkspaces().find(w => w.workspace_name === cfg.workspace);
    if (named) return named.root_path;
  }
  // 4. Git root: the repository the caller is standing in. Ahead of the
  //    default workspace for the reason `resolveMapRoot` gives: `default: true`
  //    marks whichever repo was mapped first, so ranking it above a local
  //    repository made `ix text` in an unmapped checkout search an unrelated
  //    one. (Graph reads from such a directory refuse outright; see
  //    `requireReadWorkspaceId`.)
  const gitRoot = gitRootFor(cwd);
  if (gitRoot) return gitRoot;
  // 5. Configured default workspace, for a cwd with no local context at all
  const defaultWs = getDefaultWorkspace();
  if (defaultWs) return defaultWs.root_path;
  // 6. cwd fallback
  return cwd;
}

/**
 * The git top-level containing `cwd`, or undefined outside a repository.
 *
 * stderr is discarded: outside a repo git writes "fatal: not a git repository"
 * to it, and this is a probe, not a failure the user needs to see.
 */
export function gitRootFor(cwd: string): string | undefined {
  try {
    // -c: never run a core.fsmonitor command the repository's config names.
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch { return undefined; }
}
