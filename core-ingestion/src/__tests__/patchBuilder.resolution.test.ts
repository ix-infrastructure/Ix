// Copyright 2026 Ix Infrastructure Inc.

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

  it('keeps same-named PHP constructor and function calls distinct', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\Helper;
function Helper(): void {}
function run(): void { new Helper(); Helper(); }
      `,
    )!;
    const provider = parseFile(
      '/repo/Vendor/Package/Helper.php',
      '<?php namespace Vendor\\Package; class Helper {}',
    )!;
    const resolved = resolveEdges([consumer, provider]);
    const patch = buildPatchWithResolution(consumer, 'hash', '', resolved);
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toHaveLength(2);
    expect(callEdges).toContainEqual(expect.objectContaining({
      dst: nodeId('/repo/Vendor/Package/Helper.php', 'Helper'),
    }));
    expect(callEdges).toContainEqual(expect.objectContaining({
      dst: nodeId('/repo/Consumer.php', 'Helper'),
    }));
  });

  it('does not link a PHP static call to a same-named method of the calling class', () => {
    const consumer = parseFile(
      '/repo/app/ItemService.php',
      `<?php
namespace App;
use App\\Repo\\ItemRepository;
class ItemService
{
    public function findByOwner(int $id): array
    {
        return ItemRepository::findByOwner($id);
    }
}
      `,
    )!;
    const provider = parseFile(
      '/repo/app/Repo/ItemRepository.php',
      '<?php namespace App\\Repo; class ItemRepository { public static function findByOwner(int $id): array { return []; } }',
    )!;
    const patch = buildPatchWithResolution(consumer, 'hash', '', resolveEdges([consumer, provider]));
    const callEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toEqual([expect.objectContaining({
      src: nodeId('/repo/app/ItemService.php', 'ItemService.findByOwner'),
      dst: nodeId('/repo/app/Repo/ItemRepository.php', 'ItemRepository.findByOwner'),
    })]);
  });

  it('materialises external stub node for unresolved :: package calls', () => {
    const file = '/repo/model.R';
    const externalNodeId = nodeId('external://dplyr', 'dplyr::filter');
    const result = fileResult(
      file,
      SupportedLanguages.R,
      [entity('fitModel', SupportedLanguages.R), entity('localHelper', SupportedLanguages.R)],
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
    // Not externalised -- and with no node to point at, not written at all.
    // The caller records the name instead.
    expect(rPatch.ops).not.toContainEqual(expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS' }));
    expect(rPatch.ops).toContainEqual(expect.objectContaining({
      type: 'UpsertNode', name: 'validate',
      attrs: expect.objectContaining({ unresolved_calls: ['is.null'], unresolved_call_count: 1 }),
    }));

    const goFile = '/repo/main.go';
    const goResult = fileResult(
      goFile,
      SupportedLanguages.Go,
      [entity('run', SupportedLanguages.Go)],
      [{ srcName: 'run', dstName: 'fmt.Println', predicate: 'CALLS' }],
    );
    const goPatch = buildPatchWithResolution(goResult, 'hash', '', []);
    expect(goPatch.ops.filter(op => op.type === 'UpsertNode' && String((op as any).id).startsWith('external://'))).toEqual([]);
    expect(goPatch.ops).not.toContainEqual(expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS' }));
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
      tier: 'import',
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
      [entity('fitModel', SupportedLanguages.R), entity('localHelper', SupportedLanguages.R)],
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

// Ix#225 Path 1: a repo's node/edge IDENTITY must be byte-identical whether it is
// ingested standalone or as a member of a multi-repo system. Identity is folded over
// the MEMBER-relative path (repo-dir prefix stripped) paired with the member's own
// workspace_id, so `ix map svc-a` and `ix map <parent-of-svc-a>` produce the same
// node and edge ids; a cross-repo edge resolves onto the very node the target repo's
// own ingest creates. PROVENANCE (source_uri / patch id) deliberately stays
// workspace-relative (repo-prefixed in a co-ingest) so reads reconstruct the right
// absolute path under the workspace root — it is NOT expected to converge.
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

  it('produces byte-identical node and edge ids solo vs co-ingested', () => {
    // Solo: filePath is already member-relative; no multiRepo context.
    const solo = buildPatchWithResolution(svcAResult('src/index.ts'), 'h', WS_A, [], undefined, undefined);
    // Co-ingest: filePath is repo-prefixed, multiRepo present, same member workspace_id.
    const co = buildPatchWithResolution(
      svcAResult('svc-a/src/index.ts'), 'h', WS_A, [],
      undefined, { systemId: 'sys', repoId: 'svc-a', repoWorkspaceOf });

    // Identity converges (folded over the member-relative path).
    expect(ids(co, 'UpsertNode')).toEqual(ids(solo, 'UpsertNode'));
    expect(ids(co, 'UpsertEdge')).toEqual(ids(solo, 'UpsertEdge'));
    // Provenance stays workspace-relative — repo-prefixed in the co-ingest so `ix read`
    // resolves parent/svc-a/src/index.ts, not parent/src/index.ts.
    expect(co.source.uri).toBe('svc-a/src/index.ts');
    expect(solo.source.uri).toBe('src/index.ts');
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

  it('emits one edge when two PHP call kinds resolve to the same node', () => {
    // `log()` and `Logger::log()` are two relationships once phpCallKind splits
    // the dedup key. Both resolve to the same member here, so salting the edge
    // id by call kind would mint two ids for one edge — and the dedup
    // downstream keys on id, so both would commit.
    const consumer = parseFile(
      '/repo/Caller.php',
      `<?php
use Vendor\\Package\\Logger;
function handler(): void { log(); Logger::log(); }
`,
    )!;
    const logger = parseFile(
      '/repo/Vendor/Package/Logger.php',
      '<?php namespace Vendor\\Package; class Logger { public static function log(): void {} }',
    )!;

    const patch = buildPatchWithResolution(consumer, 'hash', '', resolveEdges([consumer, logger]));
    const callEdges = patch.ops.filter(
      (op) => op.type === 'UpsertEdge' && op.predicate === 'CALLS',
    );

    expect(callEdges).toHaveLength(1);
  });

  it('emits one claim when two PHP call kinds name the same callee', () => {
    // Same root cause as the edge case above, and it fires on ordinary untyped
    // PHP: `handle()` and `$obj->handle()` are two relationships once
    // phpCallKind splits the key, but a claim carries no kind, so the two ops
    // are byte-identical.
    const consumer = parseFile(
      '/repo/Caller.php',
      `<?php
function handler($obj): void { handle(); $obj->handle(); }
`,
    )!;

    const patch = buildPatchWithResolution(consumer, 'hash', '', []);
    const claims = patch.ops.filter(
      (op) => op.type === 'AssertClaim' && op.field === 'calls:handle',
    );

    expect(claims).toHaveLength(1);
  });
});

describe('colliding edge ids (#554)', () => {
  // `resolveKey` collapses an ambiguous or unknown name to the bare name, so two
  // distinct caller names can share one `srcKey` — while `edgeResolution` is
  // keyed on the RAW name, so each caller still resolves its callee separately.
  // The edge id folds the unresolved `dstKey`, so both edges mint the same id
  // while carrying different `dst`. Before the fix `deduplicateUpsertEdges`
  // threw on that and the caller dropped the whole file.
  const sourceFile = '/repo/app.ts';

  function buildCollidingPatch() {
    const result = fileResult(
      sourceFile,
      SupportedLanguages.TypeScript,
      // A local `helper` too: an edge is only written to a node that exists.
      [entity('run', SupportedLanguages.TypeScript, 'function', 'A'), entity('helper', SupportedLanguages.TypeScript)],
      [
        { srcName: 'run', dstName: 'helper', predicate: 'CALLS' },
        { srcName: 'A.run', dstName: 'helper', predicate: 'CALLS' },
      ],
    );

    // Only the 'run' spelling resolves cross-file; 'A.run' falls through to the
    // local node. Same src, same predicate, two different destinations.
    const resolvedEdges: ResolvedEdge[] = [
      {
        srcFilePath: sourceFile,
        srcName: 'run',
        dstFilePath: '/repo/helpers.ts',
        dstName: 'helper',
        dstQualifiedKey: 'helper',
        predicate: 'CALLS',
        confidence: 0.9,
      },
    ];

    return buildPatchWithResolution(result, 'test-hash', '', resolvedEdges);
  }

  it('does not throw when one source key carries two resolved destinations', () => {
    expect(() => buildCollidingPatch()).not.toThrow();
  });

  it('commits both edges under distinct ids', () => {
    const callEdges = buildCollidingPatch().ops
      .filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(callEdges).toHaveLength(2);

    // Same source, genuinely different destinations.
    expect(new Set(callEdges.map((e: any) => e.src)).size).toBe(1);
    expect(new Set(callEdges.map((e: any) => e.dst)).size).toBe(2);
    expect(callEdges).toContainEqual(expect.objectContaining({
      dst: nodeId('/repo/helpers.ts', 'helper'),
    }));
    expect(callEdges).toContainEqual(expect.objectContaining({
      dst: nodeId(sourceFile, 'helper'),
    }));

    // The point of the fix: one id each, so neither is dropped.
    expect(new Set(callEdges.map((e: any) => e.id)).size).toBe(2);
  });

  it('leaves ids of non-colliding edges unsalted', () => {
    // A file with no collision must keep byte-identical ids, so the fix needs no
    // graph migration.
    const result = fileResult(
      '/repo/plain.ts',
      SupportedLanguages.TypeScript,
      [entity('alpha', SupportedLanguages.TypeScript), entity('beta', SupportedLanguages.TypeScript)],
      [{ srcName: 'alpha', dstName: 'beta', predicate: 'CALLS' }],
    );
    const edge: any = buildPatchWithResolution(result, 'test-hash', '', []).ops
      .find((op: any) => op.type === 'UpsertEdge' && op.predicate === 'CALLS');

    expect(edge.id).toBe(deterministicId('/repo/plain.ts:alpha:beta:CALLS'));
  });

  it('salts the patch id, and only the patch id, with a resolution hash (IN-11)', () => {
    const result = fileResult('src/a.ts', SupportedLanguages.TypeScript, [entity('alpha', SupportedLanguages.TypeScript)], []);
    const plain = buildPatchWithResolution(result, 'hash', 'ws', []);
    const salted = buildPatchWithResolution(result, 'hash', 'ws', [], undefined, undefined, 'abc123');
    const again = buildPatchWithResolution(result, 'hash', 'ws', [], undefined, undefined, 'abc123');
    const other = buildPatchWithResolution(result, 'hash', 'ws', [], undefined, undefined, 'def456');

    expect(salted.patchId).not.toBe(plain.patchId);
    expect(again.patchId).toBe(salted.patchId);
    expect(other.patchId).not.toBe(salted.patchId);
    expect(salted.ops).toEqual(plain.ops);
    expect(salted.source).toEqual(plain.source);
    expect(salted.replaces).toEqual(plain.replaces);
  });
});

// #1020: same-file fallback by name ignored the receiver, so `conn.validate()`
// landed on a module-level `validate`, and a call to a parameter on the
// module-level function the parameter shadows.
describe('same-file calls by receiver and scope (#1020)', () => {
  /** `caller -> callee` (qualified keys) of every CALLS edge in the patch, and the unresolved names. */
  function sameFileCalls(filePath: string, source: string): { edges: string[]; unresolved: Record<string, string[]> } {
    const result = parseFile(filePath, source, { budgetMs: 0 });
    expect(result).not.toBeNull();
    const patch = buildPatchWithResolution(result!, 'hash', 'ws', resolveEdges([result!]));
    const keyOf = new Map<string, string>();
    for (const e of result!.entities) {
      const key = e.container ? `${e.container}.${e.name}` : e.name;
      keyOf.set(deterministicId(`ws:${filePath.toLowerCase()}:${key}`), key);
    }
    const edges = patch.ops
      .filter((op): op is Extract<typeof op, { type: 'UpsertEdge' }> => op.type === 'UpsertEdge' && op.predicate === 'CALLS')
      .map(op => `${keyOf.get(op.src)} -> ${keyOf.get(op.dst) ?? op.dst}`)
      .sort();
    const unresolved: Record<string, string[]> = {};
    for (const op of patch.ops) {
      const names = op.type === 'UpsertNode' ? (op.attrs as { unresolved_calls?: string[] }).unresolved_calls : undefined;
      if (op.type === 'UpsertNode' && names) unresolved[op.name] = [...names].sort();
    }
    return { edges, unresolved };
  }

  it('Python: a member call on a parameter or self never lands on a module-level function', () => {
    const { edges, unresolved } = sameFileCalls('src/a.py', [
      'def validate(x):',
      '    return x',
      '',
      'def close():',
      '    pass',
      '',
      'class C:',
      '    def close(self):',
      '        pass',
      '    def run(self, conn):',
      '        conn.validate()',
      '        self.close()',
      '        close()',
      '',
    ].join('\n'));
    // `self.close()` reaches C.close once, and only the plain `close()` the
    // module-level function.
    expect(edges).toEqual(['C.run -> C.close', 'C.run -> close']);
    expect(unresolved.run).toEqual(['conn.validate', 'validate']);
  });

  it('Python: a member call on an unknown receiver still guesses the one method of that name', () => {
    const { edges } = sameFileCalls('src/a.py', [
      'def describe():',
      '    pass',
      '',
      'class Foo:',
      '    def describe(self):',
      '        pass',
      '',
      'def run(obj):',
      '    obj.describe()',
      '',
    ].join('\n'));
    expect(edges).toEqual(['run -> Foo.describe']);
  });

  it('Python: a module-scope receiver keeps name-based resolution', () => {
    const { edges } = sameFileCalls('src/a.py', [
      'import registry',
      'def validate(x):',
      '    return x',
      'api = registry.lookup()',
      'def run():',
      '    api.validate(1)',
      '',
    ].join('\n'));
    expect(edges).toEqual(['run -> validate']);
  });

  it('Python: a call to a parameter does not land on the function it shadows', () => {
    const { edges, unresolved } = sameFileCalls('src/a.py', 'def validate(x):\n    return x\n\ndef use(validate):\n    return validate(1)\n');
    expect(edges).toEqual([]);
    expect(unresolved.use).toEqual(['validate']);
  });

  it('TypeScript: a member call on a parameter or this never lands on a module-level function', () => {
    const { edges } = sameFileCalls('src/a.ts', [
      'export function validate(x: number) { return x; }',
      'export function use(conn: Conn) { conn.validate(1); }',
      'export class Svc {',
      '  check() {}',
      '  run() { this.validate(); this.check(); }',
      '}',
    ].join('\n'));
    expect(edges).toEqual(['Svc.run -> Svc.check']);
  });

  it('TypeScript: a member call on a module-level object keeps name-based resolution', () => {
    const { edges } = sameFileCalls('src/a.ts', [
      'function validate(x: number) { return x; }',
      'const api = { validate };',
      'export function use() { return api.validate(1); }',
    ].join('\n'));
    expect(edges).toEqual(['use -> validate']);
  });

  it('TypeScript: a call to a parameter or local does not land on the function it shadows', () => {
    const { edges } = sameFileCalls('src/a.ts', [
      'export function validate(x: number) { return x; }',
      'export function param(validate: (x: number) => number) { return validate(1); }',
      'export function local() { const validate = pick(); return validate(1); }',
      'export function plain() { return validate(1); }',
    ].join('\n'));
    expect(edges).toEqual(['plain -> validate']);
  });

  it('TypeScript: a call to a local arrow function still reaches it', () => {
    const { edges } = sameFileCalls('src/a.ts', 'export function outer() {\n  const helper = () => 1;\n  return helper();\n}\n');
    expect(edges).toEqual(['outer -> helper']);
  });

  it('Rust: a method call never lands on a free function', () => {
    const { edges } = sameFileCalls('src/a.rs', [
      'fn validate(x: i32) -> i32 { x }',
      'struct Conn;',
      'impl Conn { fn close(&self) {} }',
      'fn close() {}',
      'fn useit(conn: Conn) { conn.validate(); conn.close(); validate(1); }',
    ].join('\n'));
    expect(edges).toEqual(['useit -> Conn.close', 'useit -> validate']);
  });

  it('PHP: a function call and a -> call of one name keep their own cross-file targets', () => {
    // One file defines both a function `handle` and `Bar::handle`: the plain
    // call is the function, the member call the method. They are two
    // relationships of one name, so each needs its own resolution entry.
    const lib = parseFile('src/lib.php', '<?php\nfunction handle() {}\nclass Bar { public function handle() {} }\n', { budgetMs: 0 })!;
    const caller = parseFile('src/main.php', '<?php\nfunction t($obj) { handle(); $obj->handle(); }\n', { budgetMs: 0 })!;
    const patch = buildPatchWithResolution(caller, 'hash', 'ws', resolveEdges([lib, caller]));
    const dsts = patch.ops
      .filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')
      .map(op => (op as { dst: string }).dst)
      .sort();
    expect(dsts).toEqual([
      deterministicId('ws:src/lib.php:handle'),
      deterministicId('ws:src/lib.php:Bar.handle'),
    ].sort());
  });

  it('PHP: a -> call never lands on a function', () => {
    const { edges } = sameFileCalls('src/a.php', [
      '<?php',
      'function validate($x) { return $x; }',
      'function useit($conn) { $conn->validate(); }',
      '',
    ].join('\n'));
    expect(edges).toEqual([]);
  });

  /** Edge id by `src -> dst` for every CALLS edge in the patch. */
  function callIds(patch: ReturnType<typeof buildPatchWithResolution>): Map<string, string> {
    const ids = new Map<string, string>();
    for (const op of patch.ops) {
      if (op.type === 'UpsertEdge' && op.predicate === 'CALLS') ids.set(`${op.src} -> ${op.dst}`, op.id);
    }
    return ids;
  }

  /** The file as the parser saw it before #1020: no call carries the new flags. */
  function withoutScopeFlags(result: FileParseResult): FileParseResult {
    return {
      ...result,
      relationships: result.relationships.map(({ memberCall: _m, localCallee: _l, ...r }) => r),
    };
  }

  it('keeps the id of a member call edge that resolveEdges resolved across files', () => {
    // The member rule changes only the same-file fallback. An edge resolveEdges
    // already tied to its node keeps the id an existing graph holds for it.
    const lib = parseFile('src/lib.rs', 'pub struct Conn;\nimpl Conn { pub fn close(&self) {} }\n', { budgetMs: 0 })!;
    const caller = parseFile('src/main.rs', 'fn useit(conn: Conn) { conn.close(); }\n', { budgetMs: 0 })!;
    expect(caller.relationships.some(r => r.predicate === 'CALLS' && r.memberCall)).toBe(true);
    const resolved = resolveEdges([lib, caller]);
    const now = callIds(buildPatchWithResolution(caller, 'hash', 'ws', resolved));
    const before = callIds(buildPatchWithResolution(withoutScopeFlags(caller), 'hash', 'ws', resolved));
    expect([...now.keys()]).toEqual([`${deterministicId('ws:src/main.rs:useit')} -> ${deterministicId('ws:src/lib.rs:Conn.close')}`]);
    expect(now).toEqual(before);
  });

  it('keeps the id of an edge a PHP -> call reaches that another call already wrote', () => {
    // `$obj->handle()` used to land on the function `handle`; it now lands on
    // Foo::handle, an edge `Foo::handle()` already writes. Whichever call is
    // emitted first, that edge keeps its id.
    const result = parseFile('src/Foo.php', [
      '<?php',
      'class Foo {',
      '  function handle() { return 1; }',
      '  function run($obj) { handle(); $obj->handle(); Foo::handle(); }',
      '}',
      'function handle() {}',
      '',
    ].join('\n'), { budgetMs: 0 })!;
    const now = callIds(buildPatchWithResolution(result, 'hash', 'ws', resolveEdges([result])));
    const before = callIds(buildPatchWithResolution(withoutScopeFlags(result), 'hash', 'ws', resolveEdges([withoutScopeFlags(result)])));
    expect(now.size).toBe(2);
    expect(now).toEqual(before);
  });
});
