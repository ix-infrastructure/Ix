// Copyright 2026 Ix Infrastructure Inc.

/**
 * Which files a read command (`ix read`, ...) may open. Security-relevant:
 * keep it small and reviewable. Split out of `config.ts` (#943); `config.ts`
 * re-exports everything here.
 */

import { resolve as resolvePath } from "node:path";
import { isPathInsideResolvedRoot } from "./path-containment.js";
import { loadWorkspaces, resolveWorkspaceRoot } from "./workspace.js";

/**
 * The roots a read command may open a file from: the workspace this invocation
 * resolves to, plus every workspace the user has registered with `ix init`.
 *
 * Registered workspaces are included because reads legitimately span them — a
 * stitched system, or `ix view --all` — and every one of them is a path the user
 * put in their own config. What is NOT in the list is the rest of the disk.
 */
export function readableRoots(explicitRoot?: string): string[] {
  const roots = [resolveWorkspaceRoot(explicitRoot), ...loadWorkspaces().map(w => w.root_path)];
  return [...new Set(roots.filter(Boolean).map(r => resolvePath(r)))];
}

/**
 * May `ix read` open this file?
 *
 * Symlinks are resolved on both sides before comparing, so a link planted inside
 * a workspace cannot be used to hand back a file outside it. Resolving both sides
 * is what keeps that from backfiring: workspace roots are themselves often
 * symlinks (macOS `/tmp`, a checkout reached through one), and comparing a real
 * path against a symlinked root would reject perfectly ordinary reads.
 * `realpathSync` is best-effort — if either side cannot be resolved, the lexical
 * path stands in, which is the same answer for everything that is not a link.
 */
export function isReadablePath(candidate: string, explicitRoot?: string): boolean {
  return readableRoots(explicitRoot).some(
    root => isPathInsideResolvedRoot(root, candidate),
  );
}
