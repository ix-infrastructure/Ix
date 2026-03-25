import * as crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { FileParseResult, ParsedEntity, ParsedRelationship, ResolvedEdge } from '../index.js';
import { SupportedLanguages } from '../languages.js';
import { buildPatchWithResolution } from '../patch-builder.js';

const defaultFileRole = { role: 'production' as const, role_confidence: 0.5, role_signals: [] };

function entity(
  name: string,
  language: SupportedLanguages,
  kind = 'function',
  container?: string,
): ParsedEntity {
  return {
    name,
    kind,
    lineStart: 1,
    lineEnd: 1,
    language,
    container,
  };
}

function fileResult(
  filePath: string,
  language: SupportedLanguages,
  entities: ParsedEntity[],
  relationships: ParsedRelationship[],
): FileParseResult {
  return {
    filePath,
    language,
    entities: [
      { name: filePath.split(/[\\/]/).pop() ?? filePath, kind: 'file', lineStart: 1, lineEnd: 1, language },
      ...entities,
    ],
    relationships,
    fileRole: defaultFileRole,
    chunks: [],
  };
}

function deterministicId(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

function nodeId(filePath: string, name: string): string {
  return deterministicId(`${filePath.replace(/\\/g, '/').toLowerCase()}:${name}`);
}

describe('buildPatchWithResolution', () => {
  it('keeps same-name callees distinct when different callers resolve to different files', () => {
    const sourceFile = '/repo/db_impl_compaction_flush.cc';
    const result = fileResult(
      sourceFile,
      SupportedLanguages.CPlusPlus,
      [
        entity('FlushMemTableToOutputFile', SupportedLanguages.CPlusPlus),
        entity('BackgroundCompaction', SupportedLanguages.CPlusPlus),
      ],
      [
        { srcName: 'FlushMemTableToOutputFile', dstName: 'Run', predicate: 'CALLS' },
        { srcName: 'BackgroundCompaction', dstName: 'Run', predicate: 'CALLS' },
      ],
    );

    const resolvedEdges: ResolvedEdge[] = [
      {
        srcFilePath: sourceFile,
        srcName: 'FlushMemTableToOutputFile',
        dstFilePath: '/repo/flush_job.cc',
        dstName: 'Run',
        dstQualifiedKey: 'FlushJob.Run',
        predicate: 'CALLS',
        confidence: 0.9,
      },
      {
        srcFilePath: sourceFile,
        srcName: 'BackgroundCompaction',
        dstFilePath: '/repo/compaction_job.cc',
        dstName: 'Run',
        dstQualifiedKey: 'CompactionJob.Run',
        predicate: 'CALLS',
        confidence: 0.9,
      },
    ];

    const patch = buildPatchWithResolution(result, 'test-hash', resolvedEdges);
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toHaveLength(2);
    expect(callEdges).toContainEqual(expect.objectContaining({
      src: nodeId(sourceFile, 'FlushMemTableToOutputFile'),
      dst: nodeId('/repo/flush_job.cc', 'FlushJob.Run'),
    }));
    expect(callEdges).toContainEqual(expect.objectContaining({
      src: nodeId(sourceFile, 'BackgroundCompaction'),
      dst: nodeId('/repo/compaction_job.cc', 'CompactionJob.Run'),
    }));
  });
});
