// Copyright 2026 Ix Infrastructure Inc.

/**
 * Pure path containment checks, shared by workspace selection, the per-root
 * state-file keys and the read guard. No Ix imports, so none of those modules
 * import each other for these. Split out of `config.ts` (#943); `config.ts`
 * re-exports everything here.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath, sep } from "node:path";

/**
 * Is `candidate` `root` itself, or somewhere underneath it?
 *
 * The `relative()` form is the one this file already used to pick a workspace
 * for a cwd. It handles the two cases a `startsWith` prefix test gets wrong: a
 * `..` traversal comes back with leading `..` segments, and on Windows a path on
 * a different drive comes back absolute. Both sides are resolved first so a
 * relative input cannot slip past.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolvePath(root), resolvePath(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function canonicalWorkspacePath(input: string): string {
  const resolved = resolvePath(input);
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}

/**
 * Is a path contained by one specific root after resolving symlinks on both
 * sides? This is stricter than `isReadablePath`, which deliberately allows all
 * registered workspace roots for cross-workspace reads.
 */
export function isPathInsideResolvedRoot(root: string, candidate: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolvePath(p); } };
  return isPathInside(root, candidate) && isPathInside(real(root), real(candidate));
}
