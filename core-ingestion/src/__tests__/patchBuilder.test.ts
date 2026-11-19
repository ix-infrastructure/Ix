// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import type { BehaviorV1 } from '../schema.js';
import { parseFile, resolveEdges } from '../index.js';
import {
  buildPatch,
  buildPatchWithResolution,
  buildDeletionPatch,
  extractorName,
  PREVIOUS_EXTRACTORS,
  sourcePatchIdCandidates,
  symbolNodeId,
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

describe('versioned behavioral attributes', () => {
  it('P10 binds a shared slot to its declaring graph node under solo and multi-repo identities', () => {
    function ownerWrites(path: string, workspace: string, member = false) {
      const parsed = parseFile(path, 'class Job { go(){this.phase="x"} stop(){this.phase="y"} }')!;
      const { ops } = buildPatch(parsed, 'hash', workspace, undefined, member ? { repoId: 'lib' } : undefined);
      return ['go', 'stop'].map(name => {
        const op = ops.find(op => op.type === 'UpsertNode' && op.id === symbolNodeId(workspace, 'src/j.ts', 'Job.' + name));
        if (op?.type !== 'UpsertNode') throw Error('missing method ' + name);
        return (op.attrs.behavior_v1 as BehaviorV1).writes[0];
      });
    }
    const solo = ownerWrites('src/j.ts', 'workspace-A');
    const other = ownerWrites('src/j.ts', 'workspace-B');
    const slot = createHash('sha256').update(JSON.stringify([
      'ix-slot/1', symbolNodeId('workspace-A', 'src/j.ts', 'Job'), 'instanceField', 'phase',
    ])).digest('hex');
    expect(solo.map(w => w.slotId)).toEqual([slot, slot]);
    expect(solo[0].id).not.toBe(solo[1].id);
    expect(ownerWrites('lib/src/j.ts', 'workspace-A', true)).toEqual(solo);
    expect(other[0].id).not.toBe(solo[0].id);
    expect(other[0].slotId).not.toBe(slot);
  });

  it('P5 bounds serialized attributes file-wide and omits envelopes for owners with zero verified sites', () => {
    const methods = Array.from({ length: 258 }, (_, i) =>
      `m${i}(){ if(ok) this.status="${'é'.repeat(110)}"; }`);
    const parsed = parseFile('job.ts', 'class Job { ' + methods.join('\n') + ' }', { budgetMs: 0 })!;
    expect(parsed.behavior).toMatchObject({ coverage: 'partial' });
    const patch = buildPatch(parsed, 'hash', 'ws');
    const { behavior, ...structural } = parsed;
    const bare = buildPatch(structural, 'hash', 'ws');
    const delta = Buffer.byteLength(JSON.stringify(patch.ops)) - Buffer.byteLength(JSON.stringify(bare.ops));
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(256 * 1024);
    const owners = patch.ops.filter(op => op.type === 'UpsertNode' && op.attrs.behavior_v1);
    expect(owners).toHaveLength(behavior!.writes.length);
    for (const op of owners) if (op.type === 'UpsertNode') {
      expect(op.attrs.behavior_v1).toMatchObject({ coverage: 'partial', cutReason: behavior!.coverage === 'partial' && behavior!.cutReason });
    }
    const zero = buildPatch({ ...structural, behavior: { coverage: 'partial', cutReason: 'depth', writes: [] } }, 'hash', 'ws');
    expect(zero.ops).toEqual(bare.ops);
  });
});
