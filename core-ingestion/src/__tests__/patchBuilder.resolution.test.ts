import * as crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult, type ParsedEntity, type ParsedRelationship, type ResolvedEdge } from '../index.js';
import { SupportedLanguages } from '../languages.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';

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

  it('materialises external stub node for unresolved qualified CALLS', () => {
    const file = '/repo/model.R';
    const externalNodeId = nodeId('external://dplyr', 'dplyr.filter');
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('fitModel', SupportedLanguages.R)],
      [
        { srcName: 'fitModel', dstName: 'dplyr.filter', predicate: 'CALLS' },
        { srcName: 'fitModel', dstName: 'localHelper', predicate: 'CALLS' },
      ],
    );
    const patch = buildPatchWithResolution(result, 'hash', []);
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    const upsertNodes = patch.ops.filter(op => op.type === 'UpsertNode');

    // dplyr.filter edge must point to the external stub, not to a same-file phantom
    expect(callEdges).toContainEqual(
      expect.objectContaining({ src: nodeId(file, 'fitModel'), dst: externalNodeId }),
    );
    expect(callEdges).not.toContainEqual(
      expect.objectContaining({ dst: nodeId(file, 'dplyr.filter') }),
    );
    // External stub node must be materialised with correct attrs
    expect(upsertNodes).toContainEqual(
      expect.objectContaining({ id: externalNodeId, kind: 'function', name: 'filter' }),
    );
    // Unqualified same-file call still resolves within the file
    expect(callEdges).toContainEqual(
      expect.objectContaining({ src: nodeId(file, 'fitModel'), dst: nodeId(file, 'localHelper') }),
    );
  });

  it('keeps resolved qualified CALLS that cross-file resolution found', () => {
    const file = '/repo/utils.R';
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('myFunc', SupportedLanguages.R)],
      [{ srcName: 'myFunc', dstName: 'pkg.helper', predicate: 'CALLS' }],
    );
    const resolvedEdges: ResolvedEdge[] = [
      {
        srcFilePath: file,
        srcName: 'myFunc',
        dstFilePath: '/repo/pkg.R',
        dstName: 'pkg.helper',
        dstQualifiedKey: 'helper',
        predicate: 'CALLS',
        confidence: 0.9,
      },
    ];
    const patch = buildPatchWithResolution(result, 'hash', resolvedEdges);
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toContainEqual(
      expect.objectContaining({
        src: nodeId(file, 'myFunc'),
        dst: nodeId('/repo/pkg.R', 'helper'),
      }),
    );
  });

  it('rewrites resolved C++ imports to the imported file node', () => {
    const importer = parseFile(
      '/repo/include/KimeraRPGO/outlier/Pcm.h',
      `
#include "KimeraRPGO/utils/GraphUtils.h"

class Pcm {};
      `,
    );
    const imported = parseFile(
      '/repo/include/KimeraRPGO/utils/GraphUtils.h',
      `
struct Trajectory {};
      `,
    );

    expect(importer).not.toBeNull();
    expect(imported).not.toBeNull();

    const resolvedEdges = resolveEdges([importer!, imported!]);
    expect(resolvedEdges).toContainEqual({
      srcFilePath: '/repo/include/KimeraRPGO/outlier/Pcm.h',
      srcName: 'Pcm.h',
      dstFilePath: '/repo/include/KimeraRPGO/utils/GraphUtils.h',
      dstName: 'KimeraRPGO/utils/GraphUtils.h',
      dstQualifiedKey: 'GraphUtils.h',
      predicate: 'IMPORTS',
      confidence: 0.9,
    });

    const patch = buildPatchWithResolution(importer!, 'test-hash', resolvedEdges);
    const importEdge = patch.ops.find(
      (op) => op.type === 'UpsertEdge' && op.predicate === 'IMPORTS',
    );

    expect(importEdge).toEqual(expect.objectContaining({
      src: nodeId('/repo/include/KimeraRPGO/outlier/Pcm.h', 'Pcm.h'),
      dst: nodeId('/repo/include/KimeraRPGO/utils/GraphUtils.h', 'GraphUtils.h'),
    }));
  });
});

describe('buildPatch', () => {
  it('materialises external stub node for unresolved qualified CALLS', () => {
    const file = '/repo/model.R';
    const externalNodeId = nodeId('external://dplyr', 'dplyr.filter');
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('fitModel', SupportedLanguages.R)],
      [
        { srcName: 'fitModel', dstName: 'dplyr.filter', predicate: 'CALLS' },
        { srcName: 'fitModel', dstName: 'localHelper', predicate: 'CALLS' },
      ],
    );
    const patch = buildPatch(result, 'hash');
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    const upsertNodes = patch.ops.filter(op => op.type === 'UpsertNode');

    expect(callEdges).toContainEqual(
      expect.objectContaining({ src: nodeId(file, 'fitModel'), dst: externalNodeId }),
    );
    expect(callEdges).not.toContainEqual(
      expect.objectContaining({ dst: nodeId(file, 'dplyr.filter') }),
    );
    expect(upsertNodes).toContainEqual(
      expect.objectContaining({ id: externalNodeId, kind: 'function', name: 'filter' }),
    );
    expect(callEdges).toContainEqual(
      expect.objectContaining({ src: nodeId(file, 'fitModel'), dst: nodeId(file, 'localHelper') }),
    );
  });

  it('keeps same-file qualified CALLS where qualifier is a defined class', () => {
    const file = '/repo/models.py';
    const result = fileResult(
      file,
      SupportedLanguages.Python,
      [
        entity('MyClass', SupportedLanguages.Python, 'class'),
        entity('process', SupportedLanguages.Python, 'function', 'MyClass'),
        entity('run', SupportedLanguages.Python, 'function'),
      ],
      [{ srcName: 'run', dstName: 'MyClass.process', predicate: 'CALLS' }],
    );
    const patch = buildPatch(result, 'hash');
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toContainEqual(
      expect.objectContaining({
        src: nodeId(file, 'run'),
        dst: nodeId(file, 'MyClass.process'),
      }),
    );
  });
});
