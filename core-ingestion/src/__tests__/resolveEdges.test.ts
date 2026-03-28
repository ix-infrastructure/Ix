import { describe, expect, it } from 'vitest';

import { buildGlobalResolutionIndex, resolveEdges, type FileParseResult, type ParsedEntity, type ParsedRelationship } from '../index.js';
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

  it('resolves Go alias-qualified package calls through the aliased import path', () => {
    const caller = fileResult(
      '/repo/cmd/kube-apiserver/app/server.go',
      SupportedLanguages.Go,
      [entity('CreateServerChain', SupportedLanguages.Go)],
      [
        { srcName: 'server.go', dstName: 'k8s.io/kubernetes/pkg/controlplane/apiserver', predicate: 'IMPORTS' },
        { srcName: 'CreateServerChain', dstName: 'controlplaneapiserver.CreateAggregatorServer', predicate: 'CALLS' },
      ],
    );
    caller.importAliases = {
      controlplaneapiserver: 'k8s.io/kubernetes/pkg/controlplane/apiserver',
    };
    const callee = fileResult(
      '/repo/pkg/controlplane/apiserver/server.go',
      SupportedLanguages.Go,
      [entity('CreateAggregatorServer', SupportedLanguages.Go)],
    );

    expect(resolveEdges([caller, callee])).toContainEqual({
      srcFilePath: '/repo/cmd/kube-apiserver/app/server.go',
      srcName: 'CreateServerChain',
      dstFilePath: '/repo/pkg/controlplane/apiserver/server.go',
      dstName: 'controlplaneapiserver.CreateAggregatorServer',
      dstQualifiedKey: 'CreateAggregatorServer',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves Go alias-qualified package calls when using the global index anchor path', () => {
    const caller = fileResult(
      '/repo/cmd/kube-apiserver/app/server.go',
      SupportedLanguages.Go,
      [entity('CreateServerChain', SupportedLanguages.Go)],
      [
        { srcName: 'server.go', dstName: 'k8s.io/kubernetes/pkg/controlplane/apiserver', predicate: 'IMPORTS' },
        { srcName: 'CreateServerChain', dstName: 'controlplaneapiserver.CreateAggregatorServer', predicate: 'CALLS' },
      ],
    );
    caller.importAliases = {
      controlplaneapiserver: 'k8s.io/kubernetes/pkg/controlplane/apiserver',
    };

    const apiserverDoc = fileResult(
      '/repo/pkg/controlplane/apiserver/apiserver.go',
      SupportedLanguages.Go,
      [entity('Config', SupportedLanguages.Go, 'class')],
    );
    const aggregator = fileResult(
      '/repo/pkg/controlplane/apiserver/aggregator.go',
      SupportedLanguages.Go,
      [entity('CreateAggregatorServer', SupportedLanguages.Go)],
    );

    const sources = new Map<string, string>([
      ['/repo/pkg/controlplane/apiserver/apiserver.go', 'package apiserver\ntype Config struct{}\n'],
      ['/repo/pkg/controlplane/apiserver/aggregator.go', 'package apiserver\nfunc CreateAggregatorServer() {}\n'],
    ]);
    const globalIndex = buildGlobalResolutionIndex(
      ['/repo/pkg/controlplane/apiserver/apiserver.go', '/repo/pkg/controlplane/apiserver/aggregator.go'],
      sources,
    );

    expect(resolveEdges([caller], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/cmd/kube-apiserver/app/server.go',
      srcName: 'CreateServerChain',
      dstFilePath: '/repo/pkg/controlplane/apiserver/aggregator.go',
      dstName: 'controlplaneapiserver.CreateAggregatorServer',
      dstQualifiedKey: 'CreateAggregatorServer',
      predicate: 'CALLS',
      confidence: 0.9,
    });

    // Keep the extra parsed files here to mirror production more closely and ensure
    // the same answer still wins when batch data and global index are both present.
    expect(resolveEdges([caller, apiserverDoc, aggregator], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/cmd/kube-apiserver/app/server.go',
      srcName: 'CreateServerChain',
      dstFilePath: '/repo/pkg/controlplane/apiserver/aggregator.go',
      dstName: 'controlplaneapiserver.CreateAggregatorServer',
      dstQualifiedKey: 'CreateAggregatorServer',
      predicate: 'CALLS',
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

    const resolved = resolveEdges([ambiguousCaller, imported, baz]);
    expect(resolved.filter(edge => edge.predicate === 'CALLS')).toEqual([]);
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

    const resolved = resolveEdges([caller, index, helperA, helperB]);
    expect(resolved.filter(edge => edge.predicate === 'CALLS')).toEqual([]);
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

  // BUG-2: struct references in C that come from system headers (<net/if.h>)
  // must not be linked to an in-repo definition of the same struct name via
  // global tier-3 fallback.
  it('does not create a false REFERENCES edge for a C struct from a system header', () => {
    // CurlTests.c: includes system <net/if.h> (not in batch) and uses struct ifreq
    const curlTests = fileResult(
      '/repo/CMake/CurlTests.c',
      SupportedLanguages.C,
      [],
      [
        { srcName: 'CurlTests.c', dstName: 'net/if.h', predicate: 'IMPORTS' },
        { srcName: 'CurlTests.c', dstName: 'ifreq',    predicate: 'REFERENCES' },
      ],
    );

    // if2ip.h: defines its own struct ifreq as a platform shim
    const if2ip = fileResult(
      '/repo/lib/if2ip.c',
      SupportedLanguages.C,
      [entity('ifreq', SupportedLanguages.C, 'class')],
      [],
    );

    const resolved = resolveEdges([curlTests, if2ip]);
    const refEdges = resolved.filter(e => e.predicate === 'REFERENCES');
    expect(refEdges).toEqual([]);
  });

  it('resolves qualified C++ member calls even when the source file defines a same-named method', () => {
    const caller = fileResult(
      '/repo/db_impl.cc',
      SupportedLanguages.CPlusPlus,
      [
        entity('Open', SupportedLanguages.CPlusPlus, 'method', 'DBImpl'),
        entity('Recover', SupportedLanguages.CPlusPlus, 'method', 'DBImpl'),
      ],
      [{ srcName: 'DBImpl.Open', dstName: 'VersionSet.Recover', predicate: 'CALLS' }],
    );
    const callee = fileResult(
      '/repo/version_set.cc',
      SupportedLanguages.CPlusPlus,
      [entity('Recover', SupportedLanguages.CPlusPlus, 'method', 'VersionSet')],
    );

    expect(resolveEdges([caller, callee])).toContainEqual({
      srcFilePath: '/repo/db_impl.cc',
      srcName: 'DBImpl.Open',
      dstFilePath: '/repo/version_set.cc',
      dstName: 'VersionSet.Recover',
      dstQualifiedKey: 'VersionSet.Recover',
      predicate: 'CALLS',
      confidence: 0.7,
    });
  });

  it('resolves Go package imports to the package anchor and uses them for cross-file type references', () => {
    const caller = fileResult(
      '/repo/cmd/kube-scheduler/app/server.go',
      SupportedLanguages.Go,
      [entity('Run', SupportedLanguages.Go)],
      [
        { srcName: 'server.go', dstName: 'k8s.io/kubernetes/pkg/scheduler', predicate: 'IMPORTS' },
        { srcName: 'Run', dstName: 'Scheduler', predicate: 'REFERENCES' },
      ],
    );
    const nearbyFalseMatch = fileResult(
      '/repo/cmd/kube-scheduler/app/scheduler.go',
      SupportedLanguages.Go,
      [entity('LocalHelper', SupportedLanguages.Go)],
    );
    const scheduler = fileResult(
      '/repo/pkg/scheduler/scheduler.go',
      SupportedLanguages.Go,
      [entity('Scheduler', SupportedLanguages.Go, 'class')],
      Array.from({ length: 10 }, (_, i) => ({
        srcName: 'scheduler.go',
        dstName: `dep${i}`,
        predicate: 'IMPORTS',
      })),
    );
    const eventhandlers = fileResult(
      '/repo/pkg/scheduler/eventhandlers.go',
      SupportedLanguages.Go,
      [entity('registerHandlers', SupportedLanguages.Go)],
      [{ srcName: 'eventhandlers.go', dstName: 'dep', predicate: 'IMPORTS' }],
    );

    expect(resolveEdges([caller, nearbyFalseMatch, scheduler, eventhandlers])).toEqual(
      expect.arrayContaining([
        {
          srcFilePath: '/repo/cmd/kube-scheduler/app/server.go',
          srcName: 'server.go',
          dstFilePath: '/repo/pkg/scheduler/scheduler.go',
          dstName: 'k8s.io/kubernetes/pkg/scheduler',
          dstQualifiedKey: 'scheduler.go',
          predicate: 'IMPORTS',
          confidence: 0.9,
        },
        {
          srcFilePath: '/repo/cmd/kube-scheduler/app/server.go',
          srcName: 'Run',
          dstFilePath: '/repo/pkg/scheduler/scheduler.go',
          dstName: 'Scheduler',
          dstQualifiedKey: 'Scheduler',
          predicate: 'REFERENCES',
          confidence: 0.9,
        },
      ]),
    );
  });

  it('chooses the highest-signal Go package anchor when a package directory has multiple files', () => {
    const caller = fileResult(
      '/repo/cmd/kube-apiserver/app/server.go',
      SupportedLanguages.Go,
      [entity('Run', SupportedLanguages.Go)],
      [{ srcName: 'server.go', dstName: 'k8s.io/kubernetes/pkg/controlplane', predicate: 'IMPORTS' }],
    );
    const doc = fileResult('/repo/pkg/controlplane/doc.go', SupportedLanguages.Go, []);
    const versions = fileResult(
      '/repo/pkg/controlplane/import_known_versions.go',
      SupportedLanguages.Go,
      [entity('KnownVersions', SupportedLanguages.Go)],
      Array.from({ length: 4 }, (_, i) => ({
        srcName: 'import_known_versions.go',
        dstName: `dep${i}`,
        predicate: 'IMPORTS',
      })),
    );
    const instance = fileResult(
      '/repo/pkg/controlplane/instance.go',
      SupportedLanguages.Go,
      [entity('Config', SupportedLanguages.Go, 'class')],
      Array.from({ length: 8 }, (_, i) => ({
        srcName: 'instance.go',
        dstName: `dep${i}`,
        predicate: 'IMPORTS',
      })),
    );

    expect(resolveEdges([caller, doc, versions, instance])).toContainEqual({
      srcFilePath: '/repo/cmd/kube-apiserver/app/server.go',
      srcName: 'server.go',
      dstFilePath: '/repo/pkg/controlplane/instance.go',
      dstName: 'k8s.io/kubernetes/pkg/controlplane',
      dstQualifiedKey: 'instance.go',
      predicate: 'IMPORTS',
      confidence: 0.9,
    });
  });
});
