// Copyright 2026 Ix Infrastructure Inc.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { namedLockPath } from "./single-flight.js";

/**
 * The lock every write of config.yaml holds.
 *
 * A write is a read-modify-write: read the file, change it, rename a new copy
 * over it. Two processes doing that at once each rename their own copy over the
 * other's, and one of the two changes is gone -- eight parallel `ix map` runs
 * registering eight repositories kept one or two of them. So nothing writes the
 * file without this lock, ever: a writer that cannot get it waits, breaks it if
 * its holder is gone, and otherwise fails with {@link ConfigLockError}. There is
 * no "go ahead unlocked after a while"; that fallback is the race it exists to
 * prevent, and on a slow machine it was taken.
 *
 * The critical section is synchronous and a few milliseconds long, so a holder
 * cannot be interrupted part-way by anything short of the process dying, and a
 * dead holder is recognised by its pid. A lock older than the bound is stale
 * too, which covers a pid on another host, a reused pid, and a holder that was
 * stopped and never resumed.
 *
 * Re-entrant within a process: `saveConfig` takes the lock itself, and
 * `updateConfig` calls it while already holding it.
 */

/** config.yaml could not be locked for a write, and nothing was written. */
export class ConfigLockError extends Error {
  constructor(readonly configPath: string, readonly lockPath: string, readonly detail: string) {
    super(`Could not lock ${configPath} to write it: ${detail}`);
    this.name = "ConfigLockError";
  }
}

interface LockMeta {
  pid: number;
  host: string;
  /** Absent in a lock an older Ix wrote. */
  token?: string;
  startedAt: number;
  label: string;
}

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_STALE_MS = 30_000;
/** A lock file with no readable meta yet is being written; give it this long. */
const UNREADABLE_GRACE_MS = 5_000;

/** A positive whole number of ms from the environment, or the default. Digits only: "30s" is not 30 ms. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return n > 0 ? n : fallback;
}

/** How long a writer waits for the lock before failing. */
function waitMs(): number { return envMs("IX_CONFIG_LOCK_WAIT_MS", DEFAULT_WAIT_MS); }
/** A lock untouched for this long is presumed abandoned. */
function staleMs(): number { return envMs("IX_CONFIG_LOCK_STALE_MS", DEFAULT_STALE_MS); }

const pause = new Int32Array(new SharedArrayBuffer(4));
/** A synchronous sleep: config writes run inside synchronous callers. */
function sleepSync(ms: number): void {
  Atomics.wait(pause, 0, 0, Math.max(1, Math.floor(ms)));
}

/** Windows reports a file that is open elsewhere, or pending deletion, as these. Transient there. */
function isTransientWindowsError(err: unknown): boolean {
  if (process.platform !== "win32") return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

interface Observed {
  meta: LockMeta | null;
  /** Identity of the file observed, so a breaker removes only what it judged. */
  id: string;
  mtimeMs: number;
}

function observe(path: string): Observed | null {
  let st;
  try { st = statSync(path); } catch { return null; }
  let meta: LockMeta | null = null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    // An older Ix wrote this lock without a token; its pid still tells.
    if (parsed && typeof parsed === "object" && typeof parsed.pid === "number") meta = parsed as LockMeta;
  } catch { /* being written, or not ours */ }
  return { meta, id: `${meta?.token ?? ""}:${st.ino}:${st.mtimeMs}:${st.size}`, mtimeMs: st.mtimeMs };
}

/** Why the observed holder is gone, or undefined while it may still be working. */
function staleReason(o: Observed): string | undefined {
  const age = Date.now() - o.mtimeMs;
  if (!o.meta) return age > Math.min(UNREADABLE_GRACE_MS, staleMs()) ? "an unreadable lock file" : undefined;
  if (o.meta.host === hostname() && !pidAlive(o.meta.pid)) return `its holder, pid ${o.meta.pid}, is gone`;
  if (age > staleMs()) return `it is ${Math.round(age / 1000)}s old`;
  return undefined;
}

/**
 * Create `path` exclusively with `meta` in it. True when created, false when it
 * already exists (or, on Windows, is still being deleted); anything else throws.
 */
function createExclusive(path: string, meta: LockMeta): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "EEXIST" || isTransientWindowsError(err)) return false;
    throw err;
  }
  try { writeSync(fd, JSON.stringify(meta)); } finally { closeSync(fd); }
  return true;
}

function removeIfSame(path: string, id: string): void {
  const now = observe(path);
  if (now && now.id === id) rmSync(path, { force: true });
}

/**
 * Remove the lock at `path` if it is still the one judged stale. Serialised by
 * a second, short-lived lock, so that two waiters that both judged the same
 * dead holder cannot have one of them delete the lock the other just took.
 */
function breakStale(path: string, judged: Observed, meta: LockMeta): void {
  const breaker = `${path}.break`;
  if (!createExclusive(breaker, meta)) {
    // Another waiter is breaking it. Its own breaker is abandoned only if that
    // waiter died in the few syscalls it holds it for.
    const b = observe(breaker);
    if (b && staleReason(b)) {
      try { removeIfSame(breaker, b.id); } catch { /* next round */ }
    }
    return;
  }
  try {
    removeIfSame(path, judged.id);
  } catch { /* retried by the caller's loop */ } finally {
    try { rmSync(breaker, { force: true }); } catch { /* broken as stale later */ }
  }
}

function release(path: string, token: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      const o = observe(path);
      if (o?.meta?.token !== undefined && o.meta.token === token) rmSync(path, { force: true });
      return;
    } catch (err) {
      // Left behind, it is broken as soon as this process exits.
      if (!isTransientWindowsError(err) || attempt >= 20) return;
      sleepSync(10 + attempt * 10);
    }
  }
}

function acquire(configPath: string, label: string): () => void {
  const path = namedLockPath("config", configPath);
  try {
    // 0700, like saveConfig's: this can be what creates ~/.ix itself.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new ConfigLockError(configPath, path, `the lock directory ${dirname(path)} cannot be created (${(err as Error).message})`);
  }
  const token = randomBytes(12).toString("hex");
  const meta: LockMeta = {
    pid: process.pid,
    host: hostname(),
    token,
    startedAt: Date.now(),
    label,
  };
  const deadline = Date.now() + waitMs();
  let delay = 5;
  let last: Observed | null = null;
  for (;;) {
    let created: boolean;
    try {
      created = createExclusive(path, meta);
    } catch (err) {
      throw new ConfigLockError(configPath, path, `the lock file ${path} cannot be created (${(err as Error).message})`);
    }
    if (created) return () => release(path, token);

    const held = observe(path);
    if (held) {
      last = held;
      if (staleReason(held)) {
        breakStale(path, held, meta);
        continue;
      }
    }
    if (Date.now() >= deadline) {
      const holder = last?.meta
        ? `pid ${last.meta.pid} on ${last.meta.host}${last.meta.label ? ` (${last.meta.label})` : ""}`
        : "another process";
      throw new ConfigLockError(
        configPath, path,
        `${holder} has held its lock for more than ${Math.round(waitMs() / 1000)}s. Nothing was written. ` +
        `If no other ix command is running, delete ${path} and run the command again.`,
      );
    }
    sleepSync(Math.min(delay + Math.random() * delay, Math.max(1, deadline - Date.now())));
    delay = Math.min(delay * 1.5, 250);
  }
}

let depth = 0;

/**
 * Run `fn` holding the config lock. Synchronous only: the lock is released
 * when `fn` returns, so a promise it returned would run unlocked.
 */
export function withConfigLock<T>(configPath: string, label: string, fn: () => T): T {
  if (depth > 0) {
    depth++;
    try { return fn(); } finally { depth--; }
  }
  const releaseLock = acquire(configPath, label);
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    releaseLock();
  }
}

/**
 * Rename `from` over `to`, retrying the errors Windows gives while another
 * process has `to` open (a reader, an indexer, an antivirus scan). Elsewhere a
 * rename either works or fails for good.
 */
export function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 5_000;
  let delay = 10;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!isTransientWindowsError(err) || Date.now() >= deadline) throw err;
      sleepSync(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}
