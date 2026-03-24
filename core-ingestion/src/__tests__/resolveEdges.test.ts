import { describe, expect, it } from 'vitest';

import { resolveEdges, type FileParseResult, type ParsedEntity, type ParsedRelationship } from '../index.js';
import { SupportedLanguages } from '../languages.js';

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

const defaultFileRole = { role: 'production' as const, role_confidence: 0.5, role_signals: [] };

function fileResult(
  filePath: string,
  language: SupportedLanguages,
  entities: ParsedEntity[],
  relationships: ParsedRelationship[] = [],
): FileParseResult {
  return {
    filePath,
    language,
    entities: [
      { name: filePath.split(/[\\/]/).pop() ?? filePath, kind: 'file', lineStart: 1, lineEnd: 1, language },
      ...entities,
    ],
    chunks: [],
    relationships,
    fileRole: defaultFileRole,
  };
}

describe('resolveEdges', () => {
  it('blocks the registerDoctorCommand -> run false positive when only Scala defines run', () => {
    const doctor = fileResult(
      '/repo/doctor.ts',
      SupportedLanguages.TypeScript,
      [entity('registerDoctorCommand', SupportedLanguages.TypeScript)],
      [{ srcName: 'registerDoctorCommand', dstName: 'run', predicate: 'CALLS' }],
    );
    const main = fileResult(
      '/repo/Main.scala',
      SupportedLanguages.Scala,
      [entity('run', SupportedLanguages.Scala)],
    );

    expect(resolveEdges([doctor, main])).toEqual([]);
  });

  it('resolves tier-3 only to same-language files when both Scala and TypeScript define run', () => {
    const doctor = fileResult(
      '/repo/doctor.ts',
      SupportedLanguages.TypeScript,
      [entity('registerDoctorCommand', SupportedLanguages.TypeScript)],
      [{ srcName: 'registerDoctorCommand', dstName: 'run', predicate: 'CALLS' }],
    );
    const main = fileResult(
      '/repo/Main.scala',
      SupportedLanguages.Scala,
      [entity('run', SupportedLanguages.Scala)],
    );
    const helper = fileResult(
      '/repo/run-helper.ts',
      SupportedLanguages.TypeScript,
      [entity('run', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([doctor, main, helper])).toEqual([
      {
        srcFilePath: '/repo/doctor.ts',
        srcName: 'registerDoctorCommand',
        dstFilePath: '/repo/run-helper.ts',
        dstName: 'run',
        dstQualifiedKey: 'run',
        predicate: 'CALLS',
        confidence: 0.5,
      },
    ]);
  });

  it('skips same-file symbols in tier 1', () => {
    const file = fileResult(
      '/repo/helper.ts',
      SupportedLanguages.TypeScript,
      [
        entity('caller', SupportedLanguages.TypeScript),
        entity('helperFn', SupportedLanguages.TypeScript),
      ],
      [{ srcName: 'caller', dstName: 'helperFn', predicate: 'CALLS' }],
    );

    expect(resolveEdges([file])).toEqual([]);
  });

  it('resolves qualifier-assisted imports to a qualified member', () => {
    const caller = fileResult(
      '/repo/consumer.scala',
      SupportedLanguages.Scala,
      [entity('useNodeKind', SupportedLanguages.Scala)],
      [
        { srcName: 'consumer.scala', dstName: 'NodeKind', predicate: 'IMPORTS' },
        { srcName: 'useNodeKind', dstName: 'NodeKind.File', predicate: 'REFERENCES' },
      ],
    );
    const callee = fileResult(
      '/repo/NodeKind.scala',
      SupportedLanguages.Scala,
      [
        entity('NodeKind', SupportedLanguages.Scala, 'class'),
        entity('File', SupportedLanguages.Scala, 'class', 'NodeKind'),
      ],
    );

    expect(resolveEdges([caller, callee])).toContainEqual({
      srcFilePath: '/repo/consumer.scala',
      srcName: 'useNodeKind',
      dstFilePath: '/repo/NodeKind.scala',
      dstName: 'NodeKind.File',
      dstQualifiedKey: 'NodeKind.File',
      predicate: 'REFERENCES',
      confidence: 0.9,
    });
  });

  it('does not resolve qualifier-assisted edges when the member is missing or the qualifier is ambiguous', () => {
    const caller = fileResult(
      '/repo/consumer.scala',
      SupportedLanguages.Scala,
      [entity('useNodeKind', SupportedLanguages.Scala)],
      [{ srcName: 'useNodeKind', dstName: 'NodeKind.File', predicate: 'REFERENCES' }],
    );
    const noMember = fileResult(
      '/repo/NodeKind.scala',
      SupportedLanguages.Scala,
      [entity('NodeKind', SupportedLanguages.Scala, 'class')],
    );

    expect(resolveEdges([caller, noMember])).toEqual([]);

    const duplicateQualifierA = fileResult(
      '/repo/NodeKindA.scala',
      SupportedLanguages.Scala,
      [
        entity('NodeKind', SupportedLanguages.Scala, 'class'),
        entity('File', SupportedLanguages.Scala, 'class', 'NodeKind'),
      ],
    );
    const duplicateQualifierB = fileResult(
      '/repo/NodeKindB.scala',
      SupportedLanguages.Scala,
      [
        entity('NodeKind', SupportedLanguages.Scala, 'class'),
        entity('File', SupportedLanguages.Scala, 'class', 'NodeKind'),
      ],
    );

    expect(resolveEdges([caller, duplicateQualifierA, duplicateQualifierB])).toEqual([]);
  });

  it('resolves tier-2 import-scoped edges and rejects ambiguous imports', () => {
    const caller = fileResult(
      '/repo/consumer.ts',
      SupportedLanguages.TypeScript,
      [entity('consumer', SupportedLanguages.TypeScript)],
      [
        { srcName: 'consumer.ts', dstName: 'bar', predicate: 'IMPORTS' },
        { srcName: 'consumer', dstName: 'helperFn', predicate: 'CALLS' },
      ],
    );
    const imported = fileResult(
      '/repo/bar.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, imported])).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'consumer',
      dstFilePath: '/repo/bar.ts',
      dstName: 'helperFn',
      dstQualifiedKey: 'helperFn',
      predicate: 'CALLS',
      confidence: 0.9,
    });

    const ambiguousCaller = fileResult(
      '/repo/ambiguous.ts',
      SupportedLanguages.TypeScript,
      [entity('consumer', SupportedLanguages.TypeScript)],
      [
        { srcName: 'ambiguous.ts', dstName: 'bar', predicate: 'IMPORTS' },
        { srcName: 'ambiguous.ts', dstName: 'baz', predicate: 'IMPORTS' },
        { srcName: 'consumer', dstName: 'helperFn', predicate: 'CALLS' },
      ],
    );
    const baz = fileResult(
      '/repo/baz.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([ambiguousCaller, imported, baz])).toEqual([]);
  });

  it('resolves tier-2.5 transitive imports', () => {
    const caller = fileResult(
      '/repo/consumer.ts',
      SupportedLanguages.TypeScript,
      [entity('consumer', SupportedLanguages.TypeScript)],
      [
        { srcName: 'consumer.ts', dstName: 'index', predicate: 'IMPORTS' },
        { srcName: 'consumer', dstName: 'helperFn', predicate: 'CALLS' },
      ],
    );
    const index = fileResult(
      '/repo/index.ts',
      SupportedLanguages.TypeScript,
      [],
      [{ srcName: 'index.ts', dstName: 'helpermod', predicate: 'IMPORTS' }],
    );
    const helper = fileResult(
      '/repo/helpermod.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, index, helper])).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'consumer',
      dstFilePath: '/repo/helpermod.ts',
      dstName: 'helperFn',
      dstQualifiedKey: 'helperFn',
      predicate: 'CALLS',
      confidence: 0.8,
    });
  });

  it('does not emit tier-2.5 edges when transitive matches are ambiguous', () => {
    const caller = fileResult(
      '/repo/consumer.ts',
      SupportedLanguages.TypeScript,
      [entity('consumer', SupportedLanguages.TypeScript)],
      [
        { srcName: 'consumer.ts', dstName: 'index', predicate: 'IMPORTS' },
        { srcName: 'consumer', dstName: 'helperFn', predicate: 'CALLS' },
      ],
    );
    const index = fileResult(
      '/repo/index.ts',
      SupportedLanguages.TypeScript,
      [],
      [
        { srcName: 'index.ts', dstName: 'helper-a', predicate: 'IMPORTS' },
        { srcName: 'index.ts', dstName: 'helper-b', predicate: 'IMPORTS' },
      ],
    );
    const helperA = fileResult(
      '/repo/helper-a.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );
    const helperB = fileResult(
      '/repo/helper-b.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, index, helperA, helperB])).toEqual([]);
  });

  it('keeps tier-3 same-language fallback working for TypeScript and Scala and rejects ambiguous globals', () => {
    const tsCaller = fileResult(
      '/repo/app.ts',
      SupportedLanguages.TypeScript,
      [entity('caller', SupportedLanguages.TypeScript)],
      [{ srcName: 'caller', dstName: 'helperFn', predicate: 'CALLS' }],
    );
    const tsTarget = fileResult(
      '/repo/helper.ts',
      SupportedLanguages.TypeScript,
      [entity('helperFn', SupportedLanguages.TypeScript)],
    );
    const scalaCaller = fileResult(
      '/repo/App.scala',
      SupportedLanguages.Scala,
      [entity('caller', SupportedLanguages.Scala)],
      [{ srcName: 'caller', dstName: 'helperFn', predicate: 'CALLS' }],
    );
    const scalaTarget = fileResult(
      '/repo/Helper.scala',
      SupportedLanguages.Scala,
      [entity('helperFn', SupportedLanguages.Scala)],
    );

    expect(resolveEdges([tsCaller, tsTarget])).toEqual([
      {
        srcFilePath: '/repo/app.ts',
        srcName: 'caller',
        dstFilePath: '/repo/helper.ts',
        dstName: 'helperFn',
        dstQualifiedKey: 'helperFn',
        predicate: 'CALLS',
        confidence: 0.5,
      },
    ]);
    expect(resolveEdges([scalaCaller, scalaTarget])).toEqual([
      {
        srcFilePath: '/repo/App.scala',
        srcName: 'caller',
        dstFilePath: '/repo/Helper.scala',
        dstName: 'helperFn',
        dstQualifiedKey: 'helperFn',
        predicate: 'CALLS',
        confidence: 0.5,
      },
    ]);

    const ambiguousGlobal = fileResult(
      '/repo/ambiguous.ts',
      SupportedLanguages.TypeScript,
      [entity('caller', SupportedLanguages.TypeScript)],
      [{ srcName: 'caller', dstName: 'helperFn', predicate: 'CALLS' }],
    );
    const helperA = fileResult('/repo/helper-a.ts', SupportedLanguages.TypeScript, [entity('helperFn', SupportedLanguages.TypeScript)]);
    const helperB = fileResult('/repo/helper-b.ts', SupportedLanguages.TypeScript, [entity('helperFn', SupportedLanguages.TypeScript)]);

    expect(resolveEdges([ambiguousGlobal, helperA, helperB])).toEqual([]);
  });
});
