import { describe, expect, it, vi } from 'vitest';
import {
  commitBulkWithPayloadSplit,
  isAbortError,
  isPayloadTooLargeError,
  isRetryableCommitConflict,
} from '../commands/ingest.js';

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

describe('isPayloadTooLargeError', () => {
  it.each([
    Object.assign(new Error('proxy rejected the request'), { status: 413 }),
    Object.assign(new Error('proxy rejected the request'), { statusCode: 413 }),
    new Error('413: request rejected'),
    new Error('Payload Too Large'),
    new Error('Request Entity Too Large'),
    new Error('Content Too Large'),
  ])('recognises payload limit failures', error => {
    expect(isPayloadTooLargeError(error)).toBe(true);
  });

  it('does not mistake an unrelated error for a payload limit', () => {
    expect(isPayloadTooLargeError(new Error('500: internal server error'))).toBe(false);
    expect(isPayloadTooLargeError(new Error('patch 413 failed validation'))).toBe(false);
  });
});

describe('commitBulkWithPayloadSplit', () => {
  it('bisects rejected payloads until every smaller bulk commit succeeds', async () => {
    const bulkCalls: number[][] = [];
    const committed: number[] = [];
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit([1, 2, 3, 4, 5], {
      commitBulk: async batch => {
        bulkCalls.push([...batch]);
        if (batch.length > 2) throw new Error('413: payload too large');
        return batch.length;
      },
      onBulkCommitted: batch => committed.push(...batch),
      commitIndividually,
    });

    expect(bulkCalls).toEqual([
      [1, 2, 3, 4, 5],
      [1, 2, 3],
      [1, 2],
      [3],
      [4, 5],
    ]);
    expect(committed).toEqual([1, 2, 3, 4, 5]);
    expect(commitIndividually).not.toHaveBeenCalled();
  });

  it('keeps the per-file path for a single rejected patch', async () => {
    const error = new Error('413: payload too large');
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit([1], {
      commitBulk: async () => { throw error; },
      onBulkCommitted: vi.fn(),
      commitIndividually,
    });

    expect(commitIndividually).toHaveBeenCalledOnce();
    expect(commitIndividually).toHaveBeenCalledWith([1], error);
  });

  it('keeps the existing per-file fallback for non-payload bulk failures', async () => {
    const error = new Error('500: internal server error');
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit([1, 2, 3], {
      commitBulk: async () => { throw error; },
      onBulkCommitted: vi.fn(),
      commitIndividually,
    });

    expect(commitIndividually).toHaveBeenCalledOnce();
    expect(commitIndividually).toHaveBeenCalledWith([1, 2, 3], error);
  });
});
