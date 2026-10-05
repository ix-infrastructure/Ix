// Copyright 2026 Ix Infrastructure Inc.

import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, linkSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { ixHome } from "./ix-home.js";

// ---------------------------------------------------------------------------
// CLI-level single-flight lock for `ix map` / ingest.
//
// Background: a graph-refresh hook or watcher can fire `ix map` many times in
// quick succession (e.g. once per change). If a map is slow, or the backend is
// unhealthy and requests stall on their long per-request timeouts, those
// invocations stack: many concurrent `ix map` processes each hold a connection
// and retry, overwhelming the backend and wasting local resources.
//
// The robust fix is to make `ix map` single-flight at the CLI layer, so the
// guarantee holds no matter what launches it (hook, watcher, manual, CI). The
// first invocation for a workspace takes the lock; any concurrent invocation
// sees a live holder and exits quietly (coalesces) instead of piling on. A
// stale lock (dead holder, or untouched for IX_MAP_LOCK_MAX_MS) is stolen so a
// crashed map never wedges future runs.
//
// Keeping the authority in the CLI (rather than only in a shell-hook lock)
// means even an external watcher, an old hook, or two manual runs cannot stack.
// ---------------------------------------------------------------------------

// Lock directory. Overridable via IX_LOCK_DIR (used by tests, and handy if
// ~/.ix is read-only). Read per call so the override can change between runs.
function lockDir(): string {
  return process.env.IX_LOCK_DIR || join(ixHome(), "locks");
}

// Default: a held lock older than this is presumed stale (its holder crashed
// without cleanup, or is a zombie). Generous enough to outlast a legitimately
// slow map on a large repo, short enough that a wedge self-heals within a turn.
const DEFAULT_LOCK_MAX_MS = 20 * 60 * 1000;

interface LockMeta {
  pid: number;
  host: string;
  startedAt: number; // epoch ms
  label: string;     // e.g. "ix map <workspaceRoot>"
}

export interface LockHandle {
  /** Release the lock. Idempotent; safe to call from multiple exit paths. */
  release(): void;
}

function lockMaxMs(): number {
  const raw = process.env.IX_MAP_LOCK_MAX_MS;
  if (!raw) return DEFAULT_LOCK_MAX_MS;
  // Matched, not parsed. `Number.parseInt` reads any prefix, so an operator
  // following the env table and writing `20m` got TWENTY MILLISECONDS: every
  // held lock reads as abandoned on the next process's first look, and
  // single-flight goes inert for the map lock and the stitch lock alike. The
  // stitch cooldown backstops one of those; the map lock has nothing.
  if (!/^\d+$/.test(raw)) return DEFAULT_LOCK_MAX_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_MAX_MS;
}

function lockPathFor(key: string): string {
  let canonicalKey: string;
  try { canonicalKey = realpathSync.native(key); }
  catch { canonicalKey = resolve(key); }
  return namedLockPath("map", canonicalKey);
}

/**
 * Lock file for an arbitrary key, hashed verbatim.
 *
 * The map lock canonicalises its key first because it is a filesystem path and
 * two spellings of one directory must take the same lock. A key that is not a
 * path -- a backend endpoint, say -- must NOT go through realpath: it does not
 * name a file, so realpath fails and the fallback `resolve()` would join it to
 * the current working directory, giving one endpoint a different lock per
 * directory the command happens to run from.
 */
export function namedLockPath(namespace: string, key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(lockDir(), `${namespace}-${h}.lock`);
}

/** True when a PID is alive on this host. signal 0 = existence check, no-op. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but is owned by another user — alive.
    return err?.code === "EPERM";
  }
}

function readMeta(path: string): LockMeta | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LockMeta;
  } catch {
    return null;
  }
}

/** How often a holder touches its lock file to show it is still working. */
const HEARTBEAT_MS = 30_000;

/** When the lock file was last written or touched by its holder. */
function lastHeartbeat(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * A held lock is stale when its holder is gone: a dead pid on this host, or a
 * holder that has not touched the file for `IX_MAP_LOCK_MAX_MS` -- on another
 * host, where the pid cannot be checked, or on this one, where the pid may
 * have been reused by an unrelated process.
 *
 * Age alone no longer makes a lock stale. It used to be measured from
 * `startedAt`, so a live map running longer than 20 minutes was stolen, and a
 * second map ran beside it.
 */
function isStale(meta: LockMeta | null, path?: string): boolean {
  const heartbeat = path ? lastHeartbeat(path) : null;
  const silentFor = Date.now() - (heartbeat ?? meta?.startedAt ?? 0);
  // Unreadable meta: written whole via link(), so a holder never leaves one
  // behind mid-write. Give a foreign or truncated file a moment before
  // taking it.
  if (!meta) return silentFor > 5_000;
  if (meta.host === hostname() && !pidAlive(meta.pid)) return true;
  return silentFor > lockMaxMs();
}

/**
 * Try to acquire the single-flight lock for `key` (the workspace root).
 *
 * Returns a LockHandle on success, or null if another live invocation already
 * holds it — in which case the caller should coalesce (skip its own run).
 *
 * Acquisition is atomic via link(): the meta is written to a private file and
 * hard-linked into place, which fails if the lock exists, like O_EXCL. On
 * contention we inspect the holder: a stale lock is removed and acquisition
 * retried once.
 */
export function acquireMapLock(workspaceRoot: string, label: string): LockHandle | null {
  return acquireLockAt(lockPathFor(workspaceRoot), label);
}

/**
 * Acquire the lock stored at `path`, with the same semantics as
 * [[acquireMapLock]]: a LockHandle on success, null when a live holder owns it.
 *
 * Split out so a caller that is not keyed by a workspace root -- the stitch
 * guard, which is keyed by backend endpoint because the stitch join is
 * cross-workspace -- gets the identical, already-proven acquisition, staleness
 * and release behaviour instead of a second implementation of it.
 */
export function acquireLockAt(path: string, label: string): LockHandle | null {
  try { mkdirSync(lockDir(), { recursive: true }); } catch { /* best effort */ }
  const meta: LockMeta = { pid: process.pid, host: hostname(), startedAt: Date.now(), label };

  const tryCreate = (): boolean => {
    // The meta is written to a private file first and linked into place.
    // link() fails if the lock exists, like O_EXCL, but the lock appears
    // complete: creating it empty and then writing left a window in which
    // another process read an empty lock as abandoned and took it.
    const tmp = `${path}.${process.pid}.${meta.startedAt}.tmp`;
    try {
      // mode 0600 — the lock carries no secrets but matches the rest of ~/.ix.
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      linkSync(tmp, path);
      return true;
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      // Any other error (e.g. permission, read-only FS): fail open rather than
      // block the user's map. Single-flight is an optimization, not correctness.
      return true;
    } finally {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  };

  if (tryCreate()) return makeHandle(path, meta);

  // Contended — is the holder still alive?
  if (isStale(readMeta(path), path)) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
    if (tryCreate()) return makeHandle(path, meta);
  }
  return null; // a live holder owns it — caller should coalesce
}

// Locks this process still holds. `ix mcp` runs commands in-process, so "the
// process exits" is no longer the end of a command — see releaseLocksOwnedBy.
/**
 * Whatever the caller uses to identify the command taking a lock.
 *
 * Opaque here: single-flight only ever compares it by identity.
 */
export type LockOwner = unknown;

let resolveOwner: () => LockOwner = () => null;

/**
 * Teach single-flight how to tell which command is acquiring a lock.
 *
 * "The process holds this lock" stopped meaning "this command holds it" when
 * `ix mcp` began running many commands in one process. Without an owner the
 * only available release is "drop everything", which either takes a still-
 * running command's lock away or, if held back to avoid that, never releases
 * the finished command's at all. The MCP runner installs a resolver backed by
 * its async-context store; the plain CLI leaves this unset and keeps releasing
 * on process exit, exactly as before.
 */
export function setLockOwnerResolver(resolve: () => LockOwner): void {
  resolveOwner = resolve;
}

const held = new Map<() => void, LockOwner>();

/** The lock at `path` is still the one `meta` describes -- not a successor's. */
function stillOurs(path: string, meta: LockMeta): boolean {
  const current = readMeta(path);
  return current !== null && current.pid === meta.pid && current.startedAt === meta.startedAt && current.host === meta.host;
}

function makeHandle(path: string, meta: LockMeta): LockHandle {
  let released = false;
  // Touch the file while the lock is held: `isStale` reads its mtime, so a
  // live holder is never mistaken for an abandoned one however long it runs.
  const heartbeat = setInterval(() => {
    if (!stillOurs(path, meta)) return;
    const now = new Date();
    try { utimesSync(path, now, now); } catch { /* best effort */ }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const release = (): void => {
    if (released) return;
    released = true;
    held.delete(release);
    clearInterval(heartbeat);
    // Both listeners are removed with the lock. A long-lived process that maps
    // repeatedly would otherwise accumulate one set per map and trip Node's
    // max-listeners warning.
    process.off("exit", release);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    // Only our own lock. If it was taken over as stale, deleting it would
    // free a lock someone else now holds and let a third runner in.
    if (!stillOurs(path, meta)) return;
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  };
  const onSigint = (): void => { release(); process.exit(130); };
  const onSigterm = (): void => { release(); process.exit(143); };

  held.set(release, resolveOwner());
  // Release on normal exit and on the common termination signals so a killed
  // map (hook timeout, Ctrl-C) does not leave a lock that blocks the next run
  // until it ages out.
  process.once("exit", release);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return { release };
}

/**
 * Release the locks one command took, and only those.
 *
 * `ix map` takes its lock and leaves it to process exit, which was the end of
 * the command until `ix mcp` began running commands in-process. There, the
 * holder PID is the server's own and stays alive, so the lock never reads as
 * stale: the first ix_map works and every later one coalesces into an empty
 * success while the graph is never refreshed. The MCP runner calls this when a
 * command finishes, restoring the boundary the process used to provide.
 *
 * Scoped by owner rather than releasing everything, so a command that outlived
 * its timeout keeps the lock it is still using while a *different* command that
 * has genuinely finished still gives its own up.
 */
export function releaseLocksOwnedBy(owner: LockOwner): void {
  for (const [release, heldBy] of [...held]) if (heldBy === owner) release();
}

/**
 * Ask the process holding the map lock for `workspaceRoot` to run once more.
 *
 * A map that coalesces used to exit and tell nobody: an edit made after the
 * holder had read that file reached the graph only on a third invocation.
 * The marker sits beside the lock; the holder takes it before it lets go.
 */
export function requestMapRerun(workspaceRoot: string): void {
  try {
    mkdirSync(lockDir(), { recursive: true });
    writeFileSync(`${lockPathFor(workspaceRoot)}.rerun`, String(Date.now()), { mode: 0o600 });
  } catch { /* best effort: without it the next edit's map catches up */ }
}

/** True, and the request consumed, when a coalesced map asked for a rerun. */
export function takeMapRerun(workspaceRoot: string): boolean {
  const marker = `${lockPathFor(workspaceRoot)}.rerun`;
  try {
    rmSync(marker);
    return true;
  } catch {
    return false;
  }
}

// ── Test-only surface ──────────────────────────────────────────────────────
// Exported for unit tests; not part of the public CLI API.
export function lockPathForTest(workspaceRoot: string): string {
  return lockPathFor(workspaceRoot);
}
export function isStaleForTest(path: string): boolean {
  return isStale(readMeta(path), path);
}
