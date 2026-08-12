import { mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";

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
// stale lock (dead holder, or older than IX_MAP_LOCK_MAX_MS) is stolen so a
// crashed map never wedges future runs.
//
// Keeping the authority in the CLI (rather than only in a shell-hook lock)
// means even an external watcher, an old hook, or two manual runs cannot stack.
// ---------------------------------------------------------------------------

// Lock directory. Overridable via IX_LOCK_DIR (used by tests, and handy if
// ~/.ix is read-only). Read per call so the override can change between runs.
function lockDir(): string {
  return process.env.IX_LOCK_DIR || join(homedir(), ".ix", "locks");
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
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LOCK_MAX_MS;
}

function lockPathFor(key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(lockDir(), `map-${h}.lock`);
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

/** A held lock is stale if its holder is gone, on another host, or too old. */
function isStale(meta: LockMeta | null): boolean {
  if (!meta) return true; // unparseable/empty → treat as abandoned
  if (meta.host === hostname() && !pidAlive(meta.pid)) return true;
  if (Date.now() - meta.startedAt > lockMaxMs()) return true;
  return false;
}

/**
 * Try to acquire the single-flight lock for `key` (the workspace root).
 *
 * Returns a LockHandle on success, or null if another live invocation already
 * holds it — in which case the caller should coalesce (skip its own run).
 *
 * Acquisition is atomic via O_CREAT|O_EXCL ('wx'); the classic create-exclusive
 * lockfile. On contention we inspect the holder: a stale lock is removed and
 * acquisition retried once.
 */
export function acquireMapLock(workspaceRoot: string, label: string): LockHandle | null {
  try { mkdirSync(lockDir(), { recursive: true }); } catch { /* best effort */ }
  const path = lockPathFor(workspaceRoot);
  const meta: LockMeta = { pid: process.pid, host: hostname(), startedAt: Date.now(), label };

  const tryCreate = (): boolean => {
    try {
      // 'wx' = O_CREAT | O_EXCL: fails if the file already exists. mode 0600 —
      // the lock carries no secrets but matches the rest of ~/.ix.
      const fd = openSync(path, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(meta)); } finally { closeSync(fd); }
      return true;
    } catch (err: any) {
      if (err?.code === "EEXIST") return false;
      // Any other error (e.g. permission, read-only FS): fail open rather than
      // block the user's map. Single-flight is an optimization, not correctness.
      return true;
    }
  };

  if (tryCreate()) return makeHandle(path);

  // Contended — is the holder still alive?
  if (isStale(readMeta(path))) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
    if (tryCreate()) return makeHandle(path);
  }
  return null; // a live holder owns it — caller should coalesce
}

// Locks this process still holds. `ix mcp` runs commands in-process, so "the
// process exits" is no longer the end of a command — see releaseHeldLocks.
const held = new Set<() => void>();

function makeHandle(path: string): LockHandle {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    held.delete(release);
    // Both listeners are removed with the lock. A long-lived process that maps
    // repeatedly would otherwise accumulate one set per map and trip Node's
    // max-listeners warning.
    process.off("exit", release);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  };
  const onSigint = (): void => { release(); process.exit(130); };
  const onSigterm = (): void => { release(); process.exit(143); };

  held.add(release);
  // Release on normal exit and on the common termination signals so a killed
  // map (hook timeout, Ctrl-C) does not leave a lock that blocks the next run
  // until it ages out.
  process.once("exit", release);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return { release };
}

/**
 * Release every lock this process still holds.
 *
 * `ix map` takes its lock and leaves it to process exit, which was the end of
 * the command until `ix mcp` began running commands in-process. There, the
 * holder PID is the server's own and stays alive, so the lock never reads as
 * stale: the first ix_map works and every later one coalesces into an empty
 * success while the graph is never refreshed. The MCP runner calls this when a
 * command finishes, restoring the boundary the process used to provide.
 */
export function releaseHeldLocks(): void {
  for (const release of [...held]) release();
}

// ── Test-only surface ──────────────────────────────────────────────────────
// Exported for unit tests; not part of the public CLI API.
export function lockPathForTest(workspaceRoot: string): string {
  return lockPathFor(workspaceRoot);
}
export function isStaleForTest(path: string): boolean {
  return isStale(readMeta(path));
}
