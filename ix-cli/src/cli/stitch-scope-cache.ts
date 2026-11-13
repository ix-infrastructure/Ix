// Copyright 2026 Ix Infrastructure Inc.

/**
 * The on-disk cache of "is this workspace stitched into a System?". Split out
 * of `config.ts` (#943); `config.ts` re-exports everything here.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ixHome } from "./ix-home.js";

/**
 * Path to the cached answer to "is this workspace stitched into a System?".
 *
 * Kept beside the ingest mtime cache and keyed the same way. See
 * `readStitchScope` for why this is on disk rather than in memory.
 */
export function stitchScopeCachePath(workspaceId: string): string {
  const key = createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
  return join(ixHome(), `stitch_scope_${key}.json`);
}

/**
 * The stitched system for a workspace, as last answered by the backend.
 *
 * `ensureReadScope` memoized this per process, which is no cache at all for a
 * CLI: every `ix` invocation is a fresh process, so every aggregate read paid
 * the lookup again. On a large graph that lookup is ~1.5 s — for `ix smells`,
 * three times the cost of the work it precedes.
 *
 * Returns `undefined` when there is nothing usable on disk, which is also what
 * a malformed or unreadable file returns: this is a cache, so every failure
 * means "ask the backend", never "fail the command".
 *
 * There is deliberately no TTL. A workspace's system changes when it is mapped
 * or ingested, and both of those clear this file (`clearStitchScopeCache`), so
 * a timer would only add a window in which the answer is wrong for no reason.
 */
export function readStitchScope(workspaceId: string): { systemId: string | null } | undefined {
  try {
    const raw = JSON.parse(readFileSync(stitchScopeCachePath(workspaceId), "utf-8"));
    if (raw?.workspaceId !== workspaceId) return undefined; // hash collision or hand-edit
    if (raw.systemId !== null && typeof raw.systemId !== "string") return undefined;
    return { systemId: raw.systemId };
  } catch {
    return undefined;
  }
}

/** Record the backend's answer. Best-effort: a cache that cannot be written is not an error. */
export function writeStitchScope(workspaceId: string, systemId: string | null): void {
  try {
    const path = stitchScopeCachePath(workspaceId);
    mkdirSync(ixHome(), { recursive: true });
    writeFileSync(path, JSON.stringify({ workspaceId, systemId }) + "\n", "utf8");
  } catch { /* non-critical */ }
}

/** Drop the cached stitch answer. Called wherever the mtime cache is cleared. */
export function clearStitchScopeCache(workspaceId: string): void {
  try { rmSync(stitchScopeCachePath(workspaceId), { force: true }); } catch { /* non-critical */ }
}
