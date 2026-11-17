// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';
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

describe('buildPatch', () => {
  // One builder emits every op (#962): buildPatch is the resolution builder run
  // over the file alone, so tests that call it exercise the code the CLI runs.
  it.each([
    ['PHP calls that differ only in call kind', 'src/Foo.php', [
      '<?php',
      'class Foo {',
      '  function handle() { return 1; }',
      '  function run($obj) { handle(); $obj->handle(); Foo::handle(); }',
      '}',
      'function handle() {}',
    ].join('\n')],
    ['an R package-qualified call', 'src/f.R', 'f <- function(x) { dplyr::filter(x); g(x) }\ng <- function(x) x\n'],
    ['a TypeScript typed receiver', 'src/b.ts', 'class A { m() { return 1 } }\nclass B { run() { const a = new A(); a.m(); } }\n'],
  ])('emits what buildPatchWithResolution emits for %s', (_name, filePath, source) => {
    const result = parseFile(filePath, source);
    expect(result).not.toBeNull();
    const strip = ({ timestamp: _t, ...rest }: ReturnType<typeof buildPatch>) => rest;
    expect(strip(buildPatch(result!, 'hash', 'ws', 'prev'))).toEqual(
      strip(buildPatchWithResolution(result!, 'hash', 'ws', resolveEdges([result!]), 'prev')),
    );
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
    const chunkNodeIds = patch.ops
      .filter(op => op.type === 'UpsertNode' && (op.kind === 'chunk' || op.kind === 'section'))
      .map(op => op.id);
    const containsChunkEdges = patch.ops.filter(
      op => op.type === 'UpsertEdge' && op.predicate === 'CONTAINS_CHUNK',
    );
    const definesEdges = patch.ops.filter(
      op => op.type === 'UpsertEdge' && op.predicate === 'DEFINES',
    );

    expect(edgeIds.length).toBeGreaterThan(0);
    expect(edgeIds).toHaveLength(new Set(edgeIds).size);
    expect(result!.chunks.every(chunk => chunk.name !== null)).toBe(true);
    expect(containsChunkEdges).toHaveLength(result!.chunks.length);
    expect(definesEdges).toHaveLength(result!.chunks.length);
    expect(new Set(containsChunkEdges.map(edge => edge.dst))).toEqual(new Set(chunkNodeIds));
    expect(new Set(definesEdges.map(edge => edge.src))).toEqual(new Set(chunkNodeIds));
  });

  it.each([
    ['buildPatch', (result: NonNullable<ReturnType<typeof parseFile>>) => buildPatch(result, 'source-hash')],
    ['buildPatchWithResolution', (result: NonNullable<ReturnType<typeof parseFile>>) =>
      buildPatchWithResolution(result, 'source-hash', '', [])],
  ])('keeps distinct NEXT edges between top-level overload chunks via %s', (_name, build) => {
    const result = parseFile('adapter.py', `
from typing import overload

@overload
def convert(value: int) -> int: ...

@overload
def convert(value: str) -> str: ...

def convert(value):
    return value
`);

    expect(result).not.toBeNull();
    const patch = build(result!);
    const nextEdges = patch.ops.filter(
      op => op.type === 'UpsertEdge' && op.predicate === 'NEXT',
    );

    expect(result!.chunks).toHaveLength(3);
    expect(nextEdges).toHaveLength(2);
    expect(new Set(nextEdges.map(edge => edge.id)).size).toBe(2);
    expect(nextEdges[0].dst).toBe(nextEdges[1].src);
  });
});
