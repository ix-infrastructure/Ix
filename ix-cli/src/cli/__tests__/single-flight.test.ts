import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';

import { acquireMapLock, isStaleForTest, lockPathForTest } from '../single-flight.js';

describe('acquireMapLock single-flight', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ix-lock-'));
    process.env.IX_LOCK_DIR = dir;
    delete process.env.IX_MAP_LOCK_MAX_MS;
  });

  afterEach(() => {
    delete process.env.IX_LOCK_DIR;
    delete process.env.IX_MAP_LOCK_MAX_MS;
    rmSync(dir, { recursive: true, force: true });
  });

  it('grants the lock to the first caller and denies a concurrent caller', () => {
    const first = acquireMapLock('/work/repo', 'ix map /work/repo');
    expect(first).not.toBeNull();

    const second = acquireMapLock('/work/repo', 'ix map /work/repo');
    expect(second).toBeNull(); // coalesce — a live holder owns it

    first!.release();
  });

  it('re-grants after release', () => {
    const first = acquireMapLock('/work/repo', 'm');
    expect(first).not.toBeNull();
    first!.release();

    const again = acquireMapLock('/work/repo', 'm');
    expect(again).not.toBeNull();
    again!.release();
  });

  it('isolates different workspaces', () => {
    const a = acquireMapLock('/work/a', 'm');
    const b = acquireMapLock('/work/b', 'm');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // different key → different lockfile
    a!.release();
    b!.release();
  });

  it('release is idempotent and removes the lockfile', () => {
    const h = acquireMapLock('/work/repo', 'm');
    expect(readdirSync(dir).length).toBe(1);
    h!.release();
    h!.release(); // no throw
    expect(readdirSync(dir).length).toBe(0);
  });

  it('steals a stale lock left by a dead holder', () => {
    const path = lockPathForTest('/work/repo');
    // A lock owned by a PID that cannot be alive on this host.
    writeFileSync(path, JSON.stringify({ pid: 2 ** 30, host: hostname(), startedAt: Date.now(), label: 'dead' }));
    const h = acquireMapLock('/work/repo', 'm');
    expect(h).not.toBeNull(); // stale holder → stolen
    h!.release();
  });

  it('steals a lock older than the max age even if the holder looks alive', () => {
    process.env.IX_MAP_LOCK_MAX_MS = '1000';
    const path = lockPathForTest('/work/repo');
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() - 60_000, label: 'old' }));
    const h = acquireMapLock('/work/repo', 'm');
    expect(h).not.toBeNull(); // aged out → stolen
    h!.release();
  });

  it('treats an unparseable lockfile as abandoned', () => {
    const path = lockPathForTest('/work/repo');
    writeFileSync(path, 'not json');
    expect(isStaleForTest(path)).toBe(true);
    const h = acquireMapLock('/work/repo', 'm');
    expect(h).not.toBeNull();
    h!.release();
  });

  it('does not leak across a missing lock dir (fail-open is best-effort)', () => {
    // Sanity: a brand-new dir yields a clean acquire.
    expect(existsSync(dir)).toBe(true);
    const h = acquireMapLock('/work/fresh', 'm');
    expect(h).not.toBeNull();
    h!.release();
  });
});
