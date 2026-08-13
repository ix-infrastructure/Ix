import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import {
  buildPatch,
  buildPatchWithResolution,
  buildDeletionPatch,
  extractorName,
  PREVIOUS_EXTRACTORS,
  sourcePatchIdCandidates,
} from '../patch-builder.js';

describe('patch-builder extractor policy', () => {
  it('tracks the immediate predecessor when the extractor version is bumped', () => {
    const current = extractorName();
    const match = /^tree-sitter\/(\d+)\.(\d+)$/.exec(current);

    expect(match).not.toBeNull();

    const major = Number(match![1]);
    const minor = Number(match![2]);
    const previous = `tree-sitter/${major}.${minor - 1}`;

    expect(PREVIOUS_EXTRACTORS).toContain(previous);
    expect(PREVIOUS_EXTRACTORS).not.toContain(current);
    expect(PREVIOUS_EXTRACTORS.every(version => /^tree-sitter\/\d+\.\d+$/.test(version))).toBe(true);
  });

  it('builds a deterministic tombstone for every supported prior patch id', () => {
    const filePath = 'src/removed.ts';
    const sourceHash = 'previous-source-hash';
    const workspaceId = 'deadbeef';
    const candidates = sourcePatchIdCandidates(filePath, sourceHash, workspaceId);
    const ops = [{ type: 'DeleteNode', id: '00000000-0000-0000-0000-000000000001' }];

    const patch = buildDeletionPatch(filePath, sourceHash, 'baseline-1', workspaceId, ops);
    const retry = buildDeletionPatch(filePath, sourceHash, 'baseline-1', workspaceId, ops);
    const nextDeletion = buildDeletionPatch(filePath, sourceHash, 'baseline-2', workspaceId, ops);

    expect(new Set(candidates).size).toBe(PREVIOUS_EXTRACTORS.length + 2);
    expect(patch.patchId).toBe(retry.patchId);
    expect(patch.patchId).not.toBe(nextDeletion.patchId);
    expect(patch.source).toMatchObject({
      uri: filePath,
      extractor: extractorName(),
      sourceType: 'code',
      workspaceId,
    });
    expect(patch.source.sourceHash).not.toBe(sourceHash);
    expect(patch.ops).toEqual(ops);
    expect(patch.replaces).toEqual(candidates);
  });
});

describe('patch-builder edge identity', () => {
  it.each([
    ['buildPatch', (result: NonNullable<ReturnType<typeof parseFile>>) => buildPatch(result, 'source-hash')],
    ['buildPatchWithResolution', (result: NonNullable<ReturnType<typeof parseFile>>) =>
      buildPatchWithResolution(result, 'source-hash', '', [])],
  ])('emits each deterministic edge once for Python overloads via %s', (_name, build) => {
    const result = parseFile('backend/tests/unit/test_exir_adapter.py', `
from typing import overload

class Adapter:
    @overload
    def convert(self, value: int) -> int: ...

    @overload
    def convert(self, value: str) -> str: ...

    def convert(self, value):
        return value
`);

    expect(result).not.toBeNull();
    const patch = build(result!);
    const edgeIds = patch.ops
      .filter(op => op.type === 'UpsertEdge')
      .map(op => op.id);

    expect(edgeIds.length).toBeGreaterThan(0);
    expect(edgeIds).toHaveLength(new Set(edgeIds).size);
  });
});
