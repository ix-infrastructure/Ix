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

    const patch = buildPatchWithResolution(result, 'test-hash', '', resolvedEdges);
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

  it('materialises external stub node for unresolved :: package calls', () => {
    const file = '/repo/model.R';
    const externalNodeId = nodeId('external://dplyr', 'dplyr::filter');
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('fitModel', SupportedLanguages.R)],
      [
        { srcName: 'fitModel', dstName: 'dplyr::filter', predicate: 'CALLS' },
        { srcName: 'fitModel', dstName: 'localHelper', predicate: 'CALLS' },
      ],
    );
    const patch = buildPatchWithResolution(result, 'hash', '', []);
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    const upsertNodes = patch.ops.filter(op => op.type === 'UpsertNode');

    // dplyr::filter edge must point to the external stub, not to a same-file phantom
    expect(callEdges).toContainEqual(
      expect.objectContaining({ src: nodeId(file, 'fitModel'), dst: externalNodeId }),
    );
    expect(callEdges).not.toContainEqual(
      expect.objectContaining({ dst: nodeId(file, 'dplyr::filter') }),
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

  it('splits multi-dot :: members on the namespace, not the last dot', () => {
    // utils::write.csv must externalise as pkg "utils" / func "write.csv",
    // not pkg "utils.write" / func "csv" (the old lastIndexOf('.') bug).
    const file = '/repo/io.R';
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('writeOut', SupportedLanguages.R)],
      [{ srcName: 'writeOut', dstName: 'utils::write.csv', predicate: 'CALLS' }],
    );
    const patch = buildPatchWithResolution(result, 'hash', '', []);
    const upsertNodes = patch.ops.filter(op => op.type === 'UpsertNode');

    expect(upsertNodes).toContainEqual(
      expect.objectContaining({
        id: nodeId('external://utils', 'utils::write.csv'),
        kind: 'function',
        name: 'write.csv',
      }),
    );
  });

  it('does NOT externalise plain dotted names (base-R / Go) — only :: namespace calls', () => {
    // A base-R dotted call (is.null) and a Go dotted call must keep main's
    // behavior: edge to a local nodeId, no external:// stub. Only genuine
    // :: namespace calls are externalised.
    const rFile = '/repo/check.R';
    const rResult = fileResult(
      rFile,
      SupportedLanguages.R,
      [entity('validate', SupportedLanguages.R)],
      [{ srcName: 'validate', dstName: 'is.null', predicate: 'CALLS' }],
    );
    const rPatch = buildPatchWithResolution(rResult, 'hash', '', []);
    expect(rPatch.ops.filter(op => op.type === 'UpsertNode' && String((op as any).id).startsWith('external://'))).toEqual([]);
    expect(rPatch.ops).toContainEqual(
      expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS', dst: nodeId(rFile, 'is.null') }),
    );

    const goFile = '/repo/main.go';
    const goResult = fileResult(
      goFile,
      SupportedLanguages.Go,
      [entity('run', SupportedLanguages.Go)],
      [{ srcName: 'run', dstName: 'fmt.Println', predicate: 'CALLS' }],
    );
    const goPatch = buildPatchWithResolution(goResult, 'hash', '', []);
    expect(goPatch.ops.filter(op => op.type === 'UpsertNode' && String((op as any).id).startsWith('external://'))).toEqual([]);
    expect(goPatch.ops).toContainEqual(
      expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS', dst: nodeId(goFile, 'fmt.Println') }),
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
    const patch = buildPatchWithResolution(result, 'hash', '', resolvedEdges);
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

    const patch = buildPatchWithResolution(importer!, 'test-hash', '', resolvedEdges);
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
  it('materialises external stub node for unresolved :: package calls', () => {
    const file = '/repo/model.R';
    const externalNodeId = nodeId('external://dplyr', 'dplyr::filter');
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('fitModel', SupportedLanguages.R)],
      [
        { srcName: 'fitModel', dstName: 'dplyr::filter', predicate: 'CALLS' },
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
      expect.objectContaining({ dst: nodeId(file, 'dplyr::filter') }),
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

// Ix#225 Path 1: a repo's persisted identity must be byte-identical whether it is
// ingested standalone or as a member of a multi-repo system. Identity is folded over
// the MEMBER-relative path (repo-dir prefix stripped) paired with the member's own
// workspace_id, so `ix map svc-a` and `ix map <parent-of-svc-a>` produce the same
// node ids, source_uri, and patch ids; and a cross-repo edge resolves onto the very
// node the target repo's own ingest creates.
describe('multi-repo co-ingest identity convergence', () => {
  const WS_A = 'aaaaaaaa'; // svc-a's path-based workspace_id (same value in both modes)
  const WS_B = 'bbbbbbbb';
  const repoWorkspaceOf = (fp: string): string | undefined => {
    const repo = fp.replace(/\\/g, '/').split('/')[0];
    return repo === 'svc-a' ? WS_A : repo === 'svc-b' ? WS_B : undefined;
  };
  const ids = (patch: { ops: { type: string; id: string }[] }, type: string): string[] =>
    patch.ops.filter(op => op.type === type).map(op => op.id).sort();

  const svcAResult = (filePath: string): FileParseResult =>
    fileResult(
      filePath,
      SupportedLanguages.TypeScript,
      [entity('handler', SupportedLanguages.TypeScript, 'function')],
      [{ srcName: 'handler', dstName: 'localHelper', predicate: 'CALLS' }],
    );

  it('produces byte-identical node/edge/patch ids and source_uri solo vs co-ingested', () => {
    // Solo: filePath is already member-relative; no multiRepo context.
    const solo = buildPatchWithResolution(svcAResult('src/index.ts'), 'h', WS_A, [], undefined, undefined);
    // Co-ingest: filePath is repo-prefixed, multiRepo present, same member workspace_id.
    const co = buildPatchWithResolution(
      svcAResult('svc-a/src/index.ts'), 'h', WS_A, [],
      undefined, { systemId: 'sys', repoId: 'svc-a', repoWorkspaceOf });

    expect(ids(co, 'UpsertNode')).toEqual(ids(solo, 'UpsertNode'));
    expect(ids(co, 'UpsertEdge')).toEqual(ids(solo, 'UpsertEdge'));
    expect(co.patchId).toBe(solo.patchId);
    expect(co.source.uri).toBe('src/index.ts'); // member-relative, NOT 'svc-a/src/index.ts'
    expect(co.source.uri).toBe(solo.source.uri);
  });

  it('stamps systemId/repoId only in co-ingest, never solo', () => {
    const solo = buildPatchWithResolution(svcAResult('src/index.ts'), 'h', WS_A, [], undefined, undefined);
    const co = buildPatchWithResolution(
      svcAResult('svc-a/src/index.ts'), 'h', WS_A, [],
      undefined, { systemId: 'sys', repoId: 'svc-a', repoWorkspaceOf });
    expect(co.source.systemId).toBe('sys');
    expect(co.source.repoId).toBe('svc-a');
    expect(solo.source.systemId).toBeUndefined();
    expect(solo.source.repoId).toBeUndefined();
  });

  it('folds a cross-repo edge onto the exact node the target repo ingests standalone', () => {
    // svc-a.handler CALLS util, resolved to svc-b/src/util.ts.
    const src = fileResult(
      'svc-a/src/index.ts', SupportedLanguages.TypeScript,
      [entity('handler', SupportedLanguages.TypeScript, 'function')],
      [{ srcName: 'handler', dstName: 'util', predicate: 'CALLS' }],
    );
    const resolved: ResolvedEdge[] = [{
      srcFilePath: 'svc-a/src/index.ts', srcName: 'handler', predicate: 'CALLS',
      dstName: 'util', dstFilePath: 'svc-b/src/util.ts', dstQualifiedKey: 'util',
    }];
    const co = buildPatchWithResolution(
      src, 'h', WS_A, resolved, undefined,
      { systemId: 'sys', repoId: 'svc-a', repoWorkspaceOf });
    const callsDst = co.ops.find(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')!.dst;

    // svc-b's OWN standalone ingest of util in src/util.ts:
    const svcbSolo = buildPatchWithResolution(
      fileResult('src/util.ts', SupportedLanguages.TypeScript,
        [entity('util', SupportedLanguages.TypeScript, 'function')], []),
      'h2', WS_B, [], undefined, undefined);
    const svcbUtilNode = svcbSolo.ops.find(op => op.type === 'UpsertNode' && op.name === 'util')!.id;

    expect(callsDst).toBe(svcbUtilNode);
  });
});
