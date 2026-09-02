import { describe, expect, it, vi } from 'vitest';
import {
  commitBulkWithPayloadSplit,
  isAbortError,
  isBulkPartiallyCommittedError,
  isPayloadTooLargeError,
  isRetryableCommitConflict,
  stitchAbortReachedBackend,
  parseBulkCommittedPatchIds,
} from '../commands/ingest.js';

// Verbatim from a backend that refused a bulk save of a >1,000-file repo (Ix#516).
// A bulk commit runs as one exclusive Arango transaction, and Arango caps that at
// 512MB; the driver error is relayed by ErrorHandler's catch-all arm, so it reaches
// the CLI as a 500 body rather than the 413 the proxy limits produce.
const ARANGO_TRANSACTION_LIMIT_ERROR = new Error(
  '500: {"error":"internal_error","message":"Response: 500, Error: 32 - AQL: ' +
    'Maximal transaction size limit of 536870912 bytes is reached ' +
    '[node #5: InsertNode] (while executing)"}',
);

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

describe('stitchAbortReachedBackend', () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });

  it('does not read a backend error whose BODY says "aborted" as a client abort', () => {
    // isAbortError falls back to matching "aborted" anywhere in the stringified
    // error, which is right for the retry decision it was written for. Here it
    // would give a 20ms `500 {"error":"AQL: transaction aborted"}` a 15-minute
    // cooldown and report it as "cut off after 0s and may still be running".
    const backendSaidAborted = new Error('500: {"error":"AQL: transaction aborted"}');
    expect(isAbortError(backendSaidAborted)).toBe(true);
    expect(stitchAbortReachedBackend(backendSaidAborted, false)).toBe(false);
  });

  it('is true for an abort while the deadline was still live: the request was open', () => {
    expect(stitchAbortReachedBackend(abort, false)).toBe(true);
  });

  it('is false when the run deadline was already spent before the request', () => {
    // fetch rejects synchronously on an already-aborted signal, so the backend
    // never saw the query. Treating it as "cut off mid-join" would cool the
    // stitch down for 15 minutes and report it was cut off after 0s.
    expect(stitchAbortReachedBackend(abort, true)).toBe(false);
  });

  it('is false for an ordinary error either way', () => {
    const err = new Error('500: internal server error');
    expect(stitchAbortReachedBackend(err, false)).toBe(false);
    expect(stitchAbortReachedBackend(err, true)).toBe(false);
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

  it("recognises Arango's transaction size ceiling, which arrives as a 500", () => {
    expect(isPayloadTooLargeError(ARANGO_TRANSACTION_LIMIT_ERROR)).toBe(true);
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

  it('bisects an over-limit Arango transaction instead of degrading to per-file', async () => {
    // The regression behind Ix#516: this error was unrecognised, so a whole chunk
    // took the per-file path — 1,000 patches committed one at a time, serialized
    // behind the fallback mutex, with the progress bar parked on the last chunk
    // boundary. Splitting the group puts each half in its own transaction instead.
    const bulkCalls: number[][] = [];
    const committed: number[] = [];
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit([1, 2, 3, 4], {
      commitBulk: async batch => {
        bulkCalls.push([...batch]);
        if (batch.length > 2) throw ARANGO_TRANSACTION_LIMIT_ERROR;
        return batch.length;
      },
      onBulkCommitted: batch => committed.push(...batch),
      commitIndividually,
    });

    expect(bulkCalls).toEqual([
      [1, 2, 3, 4],
      [1, 2],
      [3, 4],
    ]);
    expect(committed).toEqual([1, 2, 3, 4]);
    expect(commitIndividually).not.toHaveBeenCalled();
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

// The body the server actually sends, as the client stringifies it:
// `throw new Error(`${status}: ${text}`)`.
const partialBody = (ids: string[], expected: number) =>
  new Error(
    `409: ${JSON.stringify({
      error: 'conflict',
      message: `bulk request is partially committed (${ids.length}/${expected} patch IDs)`,
      committed_patch_ids: ids,
      committed_count: ids.length,
      expected_count: expected,
    })}`
  );

const item = (id: string) => ({ patch: { patchId: id } });

describe('partly-committed bulk groups', () => {
  it('recognises the 409 and reads the ids that landed', () => {
    const err = partialBody(['p1', 'p2'], 5);
    expect(isBulkPartiallyCommittedError(err)).toBe(true);
    expect(parseBulkCommittedPatchIds(err)).toEqual(new Set(['p1', 'p2']));
  });

  it('does not mistake an ordinary conflict for a partial commit', () => {
    expect(isBulkPartiallyCommittedError(new Error('409: {"error":"conflict"}'))).toBe(false);
  });

  // Undefined must mean "fall back", never "nothing landed" — an empty set
  // would re-send patches the server already has and fail the same way.
  it('returns undefined when the backend does not name the ids', () => {
    const old = new Error('409: {"error":"conflict","message":"bulk request is partially committed (6/498 patch IDs)"}');
    expect(isBulkPartiallyCommittedError(old)).toBe(true);
    expect(parseBulkCommittedPatchIds(old)).toBeUndefined();
  });

  it('returns undefined for a body it cannot trust', () => {
    expect(parseBulkCommittedPatchIds(new Error('409: not json at all'))).toBeUndefined();
    expect(parseBulkCommittedPatchIds(new Error('409: {"committed_patch_ids":"p1"}'))).toBeUndefined();
    expect(parseBulkCommittedPatchIds(new Error('409: {"committed_patch_ids":["p1",7]}'))).toBeUndefined();
  });

  it('replays what landed and re-bulks only what is missing', async () => {
    const items = ['p1', 'p2', 'p3', 'p4', 'p5'].map(item);
    const bulkCalls: string[][] = [];
    const committed: string[] = [];
    const commitIndividually =
      vi.fn(async (_batch: ReturnType<typeof item>[], _error: unknown) => {});

    await commitBulkWithPayloadSplit(items, {
      commitBulk: async batch => {
        bulkCalls.push(batch.map(b => b.patch.patchId));
        if (batch.length === items.length) throw partialBody(['p1', 'p2'], items.length);
        return batch.length;
      },
      onBulkCommitted: batch => committed.push(...batch.map(b => b.patch.patchId)),
      commitIndividually,
      patchIdOf: b => b.patch.patchId,
    });

    // The retry carries only the three that did not land, which is a different
    // id set and therefore a different bulk group on the server.
    expect(bulkCalls).toEqual([
      ['p1', 'p2', 'p3', 'p4', 'p5'],
      ['p3', 'p4', 'p5'],
    ]);
    expect(committed).toEqual(['p3', 'p4', 'p5']);
    // The two that landed are replayed individually — idempotent no-ops that
    // return their original revision, so counters and baseline stay right.
    expect(commitIndividually).toHaveBeenCalledOnce();
    const [replayed, replayError] = commitIndividually.mock.calls[0];
    expect(replayed.map(b => b.patch.patchId)).toEqual(['p1', 'p2']);
    // No bulk error passed for the replay: it is not a failure being reported.
    expect(replayError).toBeUndefined();
  });

  it('falls back whole when the backend named no ids', async () => {
    const items = ['p1', 'p2'].map(item);
    const error = new Error('409: {"error":"conflict","message":"bulk request is partially committed (1/2 patch IDs)"}');
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit(items, {
      commitBulk: async () => { throw error; },
      onBulkCommitted: vi.fn(),
      commitIndividually,
      patchIdOf: b => b.patch.patchId,
    });

    expect(commitIndividually).toHaveBeenCalledOnce();
    expect(commitIndividually).toHaveBeenCalledWith(items, error);
  });

  // Guards the recursion: re-bulking a set identical to the one just rejected
  // would land on the same group and repeat this call forever.
  it('falls back whole when every id is claimed as landed', async () => {
    const items = ['p1', 'p2'].map(item);
    const error = partialBody(['p1', 'p2'], 2);
    const commitIndividually = vi.fn(async () => {});
    const commitBulk = vi.fn(async () => { throw error; });

    await commitBulkWithPayloadSplit(items, {
      commitBulk,
      onBulkCommitted: vi.fn(),
      commitIndividually,
      patchIdOf: b => b.patch.patchId,
    });

    expect(commitBulk).toHaveBeenCalledOnce();
    expect(commitIndividually).toHaveBeenCalledWith(items, error);
  });

  it('keeps the old whole-batch fallback when the caller cannot identify patches', async () => {
    const error = partialBody(['p1'], 2);
    const commitIndividually = vi.fn(async () => {});

    await commitBulkWithPayloadSplit([1, 2], {
      commitBulk: async () => { throw error; },
      onBulkCommitted: vi.fn(),
      commitIndividually,
    });

    expect(commitIndividually).toHaveBeenCalledWith([1, 2], error);
  });
});
