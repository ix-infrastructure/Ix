// Copyright 2026 Ix Infrastructure Inc.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';

import { acquireMapLock, isStaleForTest, lockPathForTest, requestMapRerun, takeMapRerun } from '../single-flight.js';

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

  it('steals a lock whose holder has not touched it for the max age, even if its pid looks alive', () => {
    // A wedged holder, or a pid reused by an unrelated process.
    process.env.IX_MAP_LOCK_MAX_MS = '1000';
    const path = lockPathForTest('/work/repo');
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() - 60_000, label: 'old' }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const h = acquireMapLock('/work/repo', 'm');
    expect(h).not.toBeNull(); // silent for longer than the max → stolen
    h!.release();
  });

  it('does not steal a live holder that started long ago but is still working', () => {
    // It was measured from startedAt: a map running longer than the max was
    // taken over and a second map ran beside it.
    process.env.IX_MAP_LOCK_MAX_MS = '1000';
    const path = lockPathForTest('/work/repo');
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() - 60_000, label: 'long' }));
    expect(acquireMapLock('/work/repo', 'm')).toBeNull();
  });

  it('treats an unparseable lockfile as abandoned once it has sat for a moment', () => {
    const path = lockPathForTest('/work/repo');
    writeFileSync(path, 'not json');
    // Locks are now linked into place whole, so a fresh empty or torn file is
    // not a holder mid-write -- but it is still given a few seconds.
    expect(isStaleForTest(path)).toBe(false);
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    expect(isStaleForTest(path)).toBe(true);
    const h = acquireMapLock('/work/repo', 'm');
    expect(h).not.toBeNull();
    h!.release();
  });

  it('a release does not delete a lock that is no longer its own', () => {
    // The holder was taken over as stale; letting go must not free the
    // successor's lock and admit a third runner.
    const path = lockPathForTest('/work/repo');
    const first = acquireMapLock('/work/repo', 'first')!;
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() + 1, label: 'successor' }));
    first.release();
    expect(existsSync(path)).toBe(true);
    expect(acquireMapLock('/work/repo', 'third')).toBeNull();
  });

  it('a coalesced map leaves a rerun request the holder takes once', () => {
    expect(takeMapRerun('/work/repo')).toBe(false);
    requestMapRerun('/work/repo');
    requestMapRerun('/work/repo');
    expect(takeMapRerun('/work/repo')).toBe(true);
    expect(takeMapRerun('/work/repo')).toBe(false);
  });

  it('does not leak across a missing lock dir (fail-open is best-effort)', () => {
    // Sanity: a brand-new dir yields a clean acquire.
    expect(existsSync(dir)).toBe(true);
    const h = acquireMapLock('/work/fresh', 'm');
    expect(h).not.toBeNull();
    h!.release();
  });
});
