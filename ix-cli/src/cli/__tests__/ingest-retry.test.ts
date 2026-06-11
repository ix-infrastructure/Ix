import { describe, expect, it } from 'vitest';
import { isAbortError, isRetryableCommitConflict } from '../commands/ingest.js';

describe('isAbortError', () => {
  it('detects AbortError and TimeoutError by name', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    expect(isAbortError(abort)).toBe(true);
    expect(isAbortError(timeout)).toBe(true);
  });

  it('detects an abort by message when the name is generic', () => {
    expect(isAbortError(new Error('This operation was aborted'))).toBe(true);
  });

  it('is false for ordinary errors', () => {
    expect(isAbortError(new Error('500: internal error'))).toBe(false);
    expect(isAbortError('write-write conflict')).toBe(false);
  });
});

describe('isRetryableCommitConflict', () => {
  it('still retries Arango lock conflicts and transport drops', () => {
    expect(isRetryableCommitConflict('write-write conflict')).toBe(true);
    expect(isRetryableCommitConflict(new Error('Error: 1200 timeout waiting to lock key'))).toBe(true);
    expect(isRetryableCommitConflict(new Error('fetch failed'))).toBe(true);
    expect(isRetryableCommitConflict(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does NOT retry a deadline/timeout abort (the deadline must stop work)', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('signal timed out'), { name: 'TimeoutError' });
    expect(isRetryableCommitConflict(abort)).toBe(false);
    expect(isRetryableCommitConflict(timeout)).toBe(false);
  });

  it('does not retry a plain 500', () => {
    expect(isRetryableCommitConflict(new Error('500: internal server error'))).toBe(false);
  });
});
