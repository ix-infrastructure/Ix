// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { buildGlobalResolutionIndex, parseFile, resolveEdges, type FileParseResult, type ParsedEntity, type ParsedRelationship } from '../index.js';
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

  it('resolves a typed PHP receiver call when the target is outside the parse batch', () => {
    const caller = fileResult(
      '/repo/UseCase.php',
      SupportedLanguages.PHP,
      [entity('create', SupportedLanguages.PHP, 'method', 'UseCase')],
      [
        {
          srcName: 'UseCase.php',
          dstName: 'DomainService',
          predicate: 'IMPORTS',
          importRaw: 'App\\Contracts\\DomainService',
        },
        { srcName: 'UseCase.create', dstName: 'DomainService.create', predicate: 'CALLS' },
      ],
    );
    const targetPath = '/repo/DomainService.php';
    const globalIndex = buildGlobalResolutionIndex(
      ['/repo/UseCase.php', targetPath],
      new Map([
        [
          targetPath,
          '<?php namespace App\\Contracts; interface DomainService { public function create(): void; }',
        ],
      ]),
    );

    expect(resolveEdges([caller], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/UseCase.php',
      srcName: 'UseCase.create',
      dstFilePath: targetPath,
      dstName: 'DomainService.create',
      dstQualifiedKey: 'DomainService.create',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('does not resolve an imported PHP class to the same name in another namespace', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\User;
function run(User $user): void { new User(); $user->save(); }
      `,
    )!;
    const wrong = parseFile(
      '/repo/App/User.php',
      `<?php
namespace App;
class User { public function save(): void {} }
      `,
    )!;

    expect(resolveEdges([consumer, wrong])).toEqual([]);
  });

  it('normalizes repeated namespace separators without regex backtracking', () => {
    const provider = parseFile(
      '/repo/src/Vendor/User.php',
      '<?php namespace Vendor\\Package; class User {}',
    )!;
    const entity = provider.entities.find((candidate) => candidate.name === 'User')!;
    entity.packageScope = `${'\\'.repeat(4096)}Vendor\\Package${'\\'.repeat(4096)}`;
    const consumer = parseFile(
      '/repo/src/Consumer.php',
      '<?php use Vendor\\Package\\User; function run(User $user): void { new User(); }',
    )!;

    const edges = resolveEdges([consumer, provider]).filter(
      (edge) => edge.dstFilePath === '/repo/src/Vendor/User.php',
    );

    expect(edges).toHaveLength(3);
  });

  it('does not emit a phantom import for a PHP alias name', () => {
    // The alias is a sibling (name) of the (qualified_name) inside the clause,
    // so an unanchored capture treated `Admin` as a second imported module and
    // matched it against an unrelated class of that name.
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\User as Admin;
function run(Admin $a): void { new Admin(); $a->save(); }
      `,
    )!;
    const unrelated = parseFile(
      '/repo/Admin.php',
      '<?php class Admin { public function save(): void {} }',
    )!;
    const intended = parseFile(
      '/repo/Vendor/Package/User.php',
      '<?php namespace Vendor\\Package; class User { public function save(): void {} }',
    )!;

    const edges = resolveEdges([consumer, unrelated, intended]);

    expect(
      edges.filter(
        (edge) => edge.predicate === 'IMPORTS' && edge.dstFilePath === '/repo/Admin.php',
      ),
    ).toEqual([]);
    expect(
      edges.filter((edge) => edge.dstFilePath === '/repo/Admin.php' && edge.confidence === 0.9),
    ).toEqual([]);
  });

  it('resolves an un-aliased clause in a comma-separated PHP use statement', () => {
    // `importAliased` was derived from the whole statement, so one alias
    // anywhere in the list disabled FQCN resolution for every clause.
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\One\\Alpha, Vendor\\Two\\Beta as Bee;
function run(Alpha $a): void { new Alpha(); }
      `,
    )!;
    const intended = parseFile(
      '/repo/Vendor/One/Alpha.php',
      '<?php namespace Vendor\\One; class Alpha {}',
    )!;
    const decoy = parseFile(
      '/repo/Other/Alpha.php',
      '<?php namespace Other\\Place; class Alpha {}',
    )!;

    const edges = resolveEdges([consumer, intended, decoy]);

    expect(
      edges.filter(
        (edge) => edge.predicate === 'IMPORTS'
          && edge.dstFilePath === '/repo/Vendor/One/Alpha.php'
          && edge.confidence === 0.9,
      ),
    ).toHaveLength(1);
    expect(edges.filter((edge) => edge.dstFilePath === '/repo/Other/Alpha.php')).toEqual([]);
  });

  it('does not leak a PHP use across braced namespace blocks', () => {
    // `use` is scoped to its namespace block. `go` lives in namespace B, which
    // declares its own Thing, so it must not resolve to the Thing imported by
    // namespace A.
    const consumer = parseFile(
      '/repo/Multi.php',
      `<?php
namespace A {
    use Vendor\\Package\\Thing;
    function run(Thing $t): void { new Thing(); }
}
namespace B {
    class Thing {}
    function go(Thing $t): void { new Thing(); }
}
`,
    )!;
    const vendor = parseFile(
      '/repo/Vendor/Package/Thing.php',
      '<?php namespace Vendor\\Package; class Thing {}',
    )!;

    const edges = resolveEdges([consumer, vendor]);

    expect(
      edges.filter(
        (edge) => edge.srcName === 'go' && edge.dstFilePath === '/repo/Vendor/Package/Thing.php',
      ),
    ).toEqual([]);
  });

  it('does not leak a PHP use across two blocks that declare the same namespace', () => {
    // Both blocks are `namespace A`, so every entity carries the one scope
    // string "A". Counting distinct packageScope values sees a single scope and
    // treats the file as safe to index per-file — but the blocks are still two
    // separate `use` scopes, and the second declares its own Thing.
    const consumer = parseFile(
      '/repo/SameName.php',
      `<?php
namespace A {
    use Vendor\\Package\\Thing;
    function run(Thing $t): void { new Thing(); }
}
namespace A {
    class Thing {}
    function go(Thing $t): void { new Thing(); }
}
`,
    )!;
    const vendor = parseFile(
      '/repo/Vendor/Package/Thing.php',
      '<?php namespace Vendor\\Package; class Thing {}',
    )!;

    expect(consumer.phpNamespaceBlocks).toBe(2);
    expect(
      resolveEdges([consumer, vendor]).filter(
        (edge) => edge.srcName === 'go' && edge.dstFilePath === '/repo/Vendor/Package/Thing.php',
      ),
    ).toEqual([]);
  });

  it('does not leak a PHP use out of a block that declares nothing else', () => {
    // Namespace A holds only the `use`, so it contributes no entity and no
    // packageScope at all. From the entity side the file looks like a plain
    // single-namespace B file, and A's import would be applied to B — where
    // Thing is locally declared.
    const consumer = parseFile(
      '/repo/UseOnly.php',
      `<?php
namespace A {
    use Vendor\\Package\\Thing;
}
namespace B {
    class Thing {}
    function go(Thing $t): void { new Thing(); }
}
`,
    )!;
    const vendor = parseFile(
      '/repo/Vendor/Package/Thing.php',
      '<?php namespace Vendor\\Package; class Thing {}',
    )!;

    expect(consumer.phpNamespaceBlocks).toBe(2);
    expect(
      resolveEdges([consumer, vendor]).filter(
        (edge) => edge.srcName === 'go' && edge.dstFilePath === '/repo/Vendor/Package/Thing.php',
      ),
    ).toEqual([]);
  });

  it('still indexes a single-namespace PHP file per file', () => {
    // The guard must stay off for the overwhelmingly common shape, otherwise
    // "skip the ambiguous file" quietly becomes "skip every file".
    const consumer = parseFile(
      '/repo/Single.php',
      `<?php
namespace A;
use Vendor\\Package\\Thing;
function go(Thing $t): void { new Thing(); }
`,
    )!;
    const vendor = parseFile(
      '/repo/Vendor/Package/Thing.php',
      '<?php namespace Vendor\\Package; class Thing {}',
    )!;

    expect(consumer.phpNamespaceBlocks).toBe(1);
    expect(
      resolveEdges([consumer, vendor]).filter(
        (edge) => edge.dstFilePath === '/repo/Vendor/Package/Thing.php',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('resolves PHP class imports, references, and calls by exact FQCN', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\User;
function run(User $user): void { new User(); $user->save(); }
      `,
    )!;
    const intended = parseFile(
      '/repo/Vendor/Package/User.php',
      `<?php
namespace Vendor\\Package;
class User { public function save(): void {} }
      `,
    )!;
    const wrong = parseFile(
      '/repo/App/User.php',
      `<?php
namespace App;
class User { public function save(): void {} }
      `,
    )!;

    const resolved = resolveEdges([consumer, intended, wrong]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/Consumer.php',
      srcName: 'Consumer.php',
      dstFilePath: '/repo/Vendor/Package/User.php',
      dstName: 'User',
      dstQualifiedKey: 'User.php',
      predicate: 'IMPORTS',
      confidence: 0.9,
    });
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/Consumer.php',
      dstFilePath: '/repo/Vendor/Package/User.php',
      dstName: 'User',
      dstQualifiedKey: 'User',
      predicate: 'REFERENCES',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/Consumer.php',
      dstFilePath: '/repo/Vendor/Package/User.php',
      dstName: 'User',
      dstQualifiedKey: 'User',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/Consumer.php',
      dstFilePath: '/repo/Vendor/Package/User.php',
      dstName: 'User.save',
      dstQualifiedKey: 'User.save',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved.some(edge => edge.dstFilePath === '/repo/App/User.php')).toBe(false);
  });

  it('resolves PHP class names case-insensitively', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use vendor\\package\\USER;
function run(user $user): void { new user(); $user->save(); }
      `,
    )!;
    const provider = parseFile(
      '/repo/Vendor/Package/User.php',
      `<?php
namespace Vendor\\Package;
class User { public function save(): void {} }
      `,
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved.filter(edge => edge.dstFilePath === '/repo/Vendor/Package/User.php')).toHaveLength(4);
  });

  it('keeps PHP function and constant imports on their existing resolution path', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use function Vendor\\Package\\helper;
use const Vendor\\Package\\FLAG;
function run(): void { helper(); }
      `,
    )!;
    const helper = parseFile(
      '/repo/Vendor/Package/helper.php',
      `<?php
namespace Vendor\\Package;
function helper(): void {}
      `,
    )!;
    const flag = parseFile('/repo/Vendor/Package/FLAG.php', '<?php const FLAG = 1;')!;

    const resolved = resolveEdges([consumer, helper, flag]);
    expect(resolved).toContainEqual(expect.objectContaining({
      dstFilePath: '/repo/Vendor/Package/helper.php',
      predicate: 'IMPORTS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      dstFilePath: '/repo/Vendor/Package/helper.php',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      dstFilePath: '/repo/Vendor/Package/FLAG.php',
      predicate: 'IMPORTS',
      confidence: 0.9,
    }));
  });

  it('does not treat a namespaced function as an imported class provider', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\User;
function run(): void { new User(); }
      `,
    )!;
    const functionOnly = parseFile(
      '/repo/Vendor/Package/User.php',
      `<?php
namespace Vendor\\Package;
function User(): void {}
      `,
    )!;

    expect(resolveEdges([consumer, functionOnly])).toEqual([]);
  });

  it('does not resolve a same-named PHP function call as an imported constructor', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\Helper;
function Helper(): void {}
function run(): void { Helper(); }
      `,
    )!;
    const provider = parseFile(
      '/repo/Vendor/Package/Helper.php',
      '<?php namespace Vendor\\Package; class Helper {}',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved.some(edge =>
      edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/Vendor/Package/Helper.php'
    )).toBe(false);
  });

  it('keeps a same-named PHP function import separate from a class import', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
use Vendor\\Package\\Helper;
use function Other\\helper;
function run(): void { helper(); }
      `,
    )!;
    const typeProvider = parseFile(
      '/repo/Vendor/Package/Helper.php',
      '<?php namespace Vendor\\Package; class Helper {}',
    )!;
    const functionProvider = parseFile(
      '/repo/Other/helper.php',
      '<?php namespace Other; function helper(): void {}',
    )!;

    const resolved = resolveEdges([consumer, typeProvider, functionProvider]);
    expect(resolved.filter(edge => edge.dstFilePath === '/repo/Other/helper.php')).toHaveLength(2);
    expect(resolved.some(edge =>
      edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/Vendor/Package/Helper.php'
    )).toBe(false);
  });

  it('resolves a PHP import from the global namespace exactly', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
namespace App;
use GlobalUser;
function run(GlobalUser $user): void { new GlobalUser(); $user->save(); }
      `,
    )!;
    const intended = parseFile(
      '/repo/GlobalUser.php',
      '<?php class GlobalUser { public function save(): void {} }',
    )!;
    const wrong = parseFile(
      '/repo/Other/GlobalUser.php',
      '<?php namespace Other; class GlobalUser { public function save(): void {} }',
    )!;

    const resolved = resolveEdges([consumer, intended, wrong]);
    expect(resolved.filter(edge => edge.dstFilePath === '/repo/GlobalUser.php')).toHaveLength(4);
    expect(resolved.some(edge => edge.dstFilePath === '/repo/Other/GlobalUser.php')).toBe(false);
  });

  it('does not exact-resolve duplicate PHP type names within one file', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      '<?php use Vendor\\Package\\User; function run(): void { new User(); }',
    )!;
    const provider = parseFile(
      '/repo/Types.php',
      `<?php
namespace Vendor\\Package { class User {} }
namespace Other { class User {} }
      `,
    )!;

    expect(resolveEdges([consumer, provider])).toEqual([]);
  });

  it('does not exact-resolve conflicting PHP imports scoped to different namespaces', () => {
    const consumer = parseFile(
      '/repo/Consumer.php',
      `<?php
namespace First {
    use Vendor\\One\\User;
    function run(User $user): void { new User(); $user->save(); }
}
namespace Second {
    use Vendor\\Two\\User;
    function execute(User $user): void { new User(); $user->save(); }
}
      `,
    )!;
    const first = parseFile(
      '/repo/Vendor/One/User.php',
      '<?php namespace Vendor\\One; class User { public function save(): void {} }',
    )!;
    const second = parseFile(
      '/repo/Vendor/Two/User.php',
      '<?php namespace Vendor\\Two; class User { public function save(): void {} }',
    )!;

    expect(resolveEdges([consumer, first, second])).toEqual([]);
  });

  it('resolves imports from a grouped PHP use statement', () => {
    const consumer = parseFile(
      '/repo/UseCase.php',
      `<?php
namespace App;

use Vendor\\Contracts\\{DomainService, Repo};

final class UseCase
{
    public function make(): void
    {
        $svc = new DomainService();
    }
}
      `,
    )!;
    const provider = parseFile(
      '/repo/DomainService.php',
      '<?php namespace Vendor\\Contracts; class DomainService {}',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(
      resolved.filter(
        (e) => e.predicate === 'IMPORTS' && e.dstFilePath === '/repo/DomainService.php',
      ),
    ).toHaveLength(1);
  });

  it('resolves a TypeScript call when the imported definition is outside the parse batch', () => {
    const caller = fileResult(
      '/repo/consumer.ts',
      SupportedLanguages.TypeScript,
      [entity('runCrossBatchTarget', SupportedLanguages.TypeScript)],
      [
        { srcName: 'consumer.ts', dstName: 'target', predicate: 'IMPORTS', importRaw: './target' },
        { srcName: 'runCrossBatchTarget', dstName: 'crossBatchTarget', predicate: 'CALLS' },
      ],
    );
    caller.importBindings = [
      { pkg: './target', local: 'crossBatchTarget', imported: 'crossBatchTarget' },
    ];

    const targetPath = '/repo/target.ts';
    const globalIndex = buildGlobalResolutionIndex(
      ['/repo/consumer.ts', targetPath],
      new Map([[targetPath, 'export function crossBatchTarget() {}\n']]),
    );

    expect(resolveEdges([caller], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'runCrossBatchTarget',
      dstFilePath: targetPath,
      dstName: 'crossBatchTarget',
      dstQualifiedKey: 'crossBatchTarget',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('prefers configured JS/TS module targets over unrelated stem matches', () => {
    const consumer = parseFile(
      '/repo/src/consumer.ts',
      'import { execute } from "@core";\nexport function run() { return execute(); }\n',
    )!;
    const intended = parseFile(
      '/repo/src/adapters/worker.ts',
      'export function execute() { return "worker"; }\n',
    )!;
    const unrelated = parseFile(
      '/repo/legacy/core.ts',
      'export function execute() { return "legacy"; }\n',
    )!;

    const resolved = resolveEdges([consumer, intended, unrelated], undefined, undefined, {
      resolveModuleSpecifier: (_source, specifier) =>
        specifier === '@core' ? ['/repo/src/adapters/worker.ts'] : undefined,
    });

    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/src/consumer.ts',
      dstFilePath: '/repo/src/adapters/worker.ts',
      predicate: 'IMPORTS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/src/consumer.ts',
      dstFilePath: '/repo/src/adapters/worker.ts',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved.some(edge => edge.dstFilePath === '/repo/legacy/core.ts')).toBe(false);
  });

  it('uses mapped runtime files for calls and declaration files for references', () => {
    const consumer = parseFile(
      '/repo/src/consumer.ts',
      'import { run, type Foo } from "@pkg";\n'
        + 'export function call() { return run(); }\n'
        + 'export function use(value: Foo) { return value; }\n',
    )!;
    const runtime = parseFile('/repo/lib/index.js', 'export function run() { return 1; }\n')!;
    const declarations = parseFile('/repo/lib/index.d.ts', 'export interface Foo { id: string; }\n')!;

    const resolved = resolveEdges([consumer, runtime, declarations], undefined, undefined, {
      resolveModuleSpecifier: (_source, _specifier, kind) =>
        kind === 'types' ? ['/repo/lib/index.d.ts'] : ['/repo/lib/index.js'],
    });

    expect(resolved).toContainEqual(expect.objectContaining({
      dstFilePath: '/repo/lib/index.js',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      dstFilePath: '/repo/lib/index.d.ts',
      predicate: 'REFERENCES',
      confidence: 0.9,
    }));
  });

  it('does not fall back to a stem when a configured JS/TS import is unresolved', () => {
    const consumer = parseFile(
      '/repo/src/consumer.ts',
      'import { execute } from "@core";\nexport function run() { return execute(); }\n',
    )!;
    const unrelated = parseFile(
      '/repo/legacy/core.ts',
      'export function execute() { return "legacy"; }\n',
    )!;

    expect(resolveEdges([consumer, unrelated], undefined, undefined, {
      resolveModuleSpecifier: () => [],
    })).toEqual([]);
  });

  it('keeps transitive resolution when a configured module target is a barrel', () => {
    const consumer = parseFile(
      '/repo/app/consumer.ts',
      'import { execute } from "@pkg";\nexport function run() { return execute(); }\n',
    )!;
    const barrel = parseFile(
      '/repo/pkg/index.ts',
      'export { execute } from "./worker.js";\n',
    )!;
    const worker = parseFile(
      '/repo/pkg/worker.ts',
      'export function execute() { return "worker"; }\n',
    )!;

    const resolved = resolveEdges([consumer, barrel, worker], undefined, undefined, {
      resolveModuleSpecifier: (_source, specifier) =>
        specifier === '@pkg' ? ['/repo/pkg/index.ts'] : undefined,
    });

    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/app/consumer.ts',
      dstFilePath: '/repo/pkg/index.ts',
      predicate: 'IMPORTS',
      confidence: 0.9,
    }));
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/app/consumer.ts',
      dstFilePath: '/repo/pkg/worker.ts',
      predicate: 'CALLS',
      confidence: 0.8,
    }));
  });

  it('resolves a call through a provider export alias', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function impl() { return 1; }\nexport { impl as publicFn };\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import { publicFn } from "./provider";\nexport function caller() { return publicFn(); }\n',
    )!;
    const unrelated = parseFile(
      '/repo/unrelated.ts',
      'export function publicFn() { return 2; }\n',
    )!;

    const resolved = resolveEdges([consumer, provider, unrelated]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'publicFn',
      dstQualifiedKey: 'impl',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(resolved.some(edge => edge.dstFilePath === '/repo/unrelated.ts')).toBe(false);
  });

  it('uses the relative provider path before resolving its public export name', () => {
    const consumer = parseFile(
      '/repo/a/consumer.ts',
      'import { publicFn } from "./provider";\nexport function caller() { return publicFn(); }\n',
    )!;
    const intendedProvider = parseFile(
      '/repo/a/provider.ts',
      'function impl() { return 1; }\nexport { impl as publicFn };\n',
    )!;
    const sameStemProvider = parseFile(
      '/repo/b/provider.ts',
      'function otherImpl() { return 2; }\nexport { otherImpl as publicFn };\n',
    )!;

    const calls = resolveEdges([consumer, intendedProvider, sameStemProvider])
      .filter(edge => edge.predicate === 'CALLS');
    expect(calls).toEqual([expect.objectContaining({
      srcFilePath: '/repo/a/consumer.ts',
      dstFilePath: '/repo/a/provider.ts',
      dstName: 'publicFn',
      dstQualifiedKey: 'impl',
    })]);
  });

  it('resolves a default import to the provider local symbol', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function actualName() { return 1; }\nexport default actualName;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import localName from "./provider";\nexport function caller() { return localName(); }\n',
    )!;
    const unrelated = parseFile(
      '/repo/unrelated.ts',
      'export function localName() { return 2; }\n',
    )!;

    const resolved = resolveEdges([consumer, provider, unrelated]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'localName',
      dstQualifiedKey: 'actualName',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(resolved.some(edge => edge.dstFilePath === '/repo/unrelated.ts')).toBe(false);
  });

  it('resolves provider public names from the global index', () => {
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import localName from "./provider";\nexport function caller() { return localName(); }\n',
    )!;
    const providerPath = '/repo/provider.ts';
    const globalIndex = buildGlobalResolutionIndex(
      ['/repo/consumer.ts', providerPath],
      new Map([[providerPath, 'function actualName() { return 1; }\nexport default actualName;\n']]),
    );

    expect(resolveEdges([consumer], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'caller',
      dstFilePath: providerPath,
      dstName: 'localName',
      dstQualifiedKey: 'actualName',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('does not resolve a shadowed import name to the provider', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function actualName() { return 1; }\nexport default actualName;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import localName from "./provider";\nexport function caller() { const localName = () => 2; return localName(); }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved.some(edge => edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/provider.ts')).toBe(false);
  });

  it('still resolves the import outside the scope that shadows it', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function Actual() { return 1; }\nexport default Actual;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import Local from "./provider";\nfunction shadow() {\n  const Local = () => 2;\n  return Local();\n}\nexport function caller() {\n  return Local();\n}\n',
    )!;

    const calls = resolveEdges([consumer, provider]).filter(edge => edge.predicate === 'CALLS');
    expect(calls).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'Local',
      dstQualifiedKey: 'Actual',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(calls.some(edge => edge.srcName === 'shadow' && edge.dstFilePath === '/repo/provider.ts')).toBe(false);
  });

  it('does not let a nested-function binding shadow an outer imported use', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function Actual() { return 1; }\nexport default Actual;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import Local from "./provider";\nexport function caller() {\n  function nested() {\n    const Local = () => 2;\n    return Local();\n  }\n  nested();\n  return Local();\n}\n',
    )!;

    const calls = resolveEdges([consumer, provider]).filter(edge => edge.predicate === 'CALLS');
    expect(calls).toContainEqual(expect.objectContaining({
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'Local',
      dstQualifiedKey: 'Actual',
    }));
    expect(calls.some(edge => edge.srcName === 'nested' && edge.dstFilePath === '/repo/provider.ts')).toBe(false);
  });

  it('does not resolve a parameter that shadows an imported name', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function Actual() { return 1; }\nexport default Actual;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import Local from "./provider";\nexport function caller(Local: () => number) { return Local(); }\n',
    )!;

    expect(resolveEdges([consumer, provider]).some(edge =>
      edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/provider.ts',
    )).toBe(false);
  });

  it('does not mistake an imported type annotation for a parameter binding', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'class Actual {}\nexport default Actual;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import Local from "./provider";\nexport function caller(value: Local) { return new Local(); }\n',
    )!;

    expect(resolveEdges([consumer, provider])).toContainEqual(expect.objectContaining({
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'Local',
      dstQualifiedKey: 'Actual',
      predicate: 'CALLS',
    }));
  });

  it('keeps TypeScript value and type shadowing separate', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'class Actual {}\nexport default Actual;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import Local from "./provider";\nexport function caller(Local: () => number, value: Local) { return Local(); }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved).toContainEqual(expect.objectContaining({
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'Local',
      dstQualifiedKey: 'Actual',
      predicate: 'REFERENCES',
    }));
    expect(resolved.some(edge => edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/provider.ts')).toBe(false);
  });

  it('keeps ordinary same-file calls ahead of imported provider symbols', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'export function other() {}\nexport function helper() {}\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import { other } from "./provider";\nfunction helper() {}\nexport function caller() { return helper(); }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved.some(edge => edge.predicate === 'CALLS' && edge.dstFilePath === '/repo/provider.ts')).toBe(false);
  });

  it('does not use a public export name to choose between ambiguous modules', () => {
    const consumer = parseFile(
      '/repo/a/consumer.ts',
      'import { publicFn } from "./provider";\nexport function caller() { return publicFn(); }\n',
    )!;
    const intendedProvider = parseFile(
      '/repo/a/provider.ts',
      'export function otherFn() { return 1; }\n',
    )!;
    const unrelatedProvider = parseFile(
      '/repo/b/provider.ts',
      'function impl() { return 2; }\nexport { impl as publicFn };\n',
    )!;

    const resolved = resolveEdges([consumer, intendedProvider, unrelatedProvider]);
    expect(resolved.some(edge => edge.predicate === 'CALLS')).toBe(false);
  });

  it('does not confuse a provider public name with a different local entity', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'function impl() { return 1; }\nexport { impl as publicFn };\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import { publicFn as localFn } from "./provider";\nfunction publicFn() { return 2; }\nexport function caller() { return localFn(); }\n',
    )!;

    expect(resolveEdges([consumer, provider])).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'caller',
      dstFilePath: '/repo/provider.ts',
      dstName: 'localFn',
      dstQualifiedKey: 'impl',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves default imports used in inheritance and type references', () => {
    const provider = parseFile(
      '/repo/provider.ts',
      'class ActualBase {}\nexport default ActualBase;\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import LocalBase from "./provider";\nexport class Child extends LocalBase {}\nexport function takes(value: LocalBase) { return value; }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'Child',
      dstFilePath: '/repo/provider.ts',
      dstName: 'LocalBase',
      dstQualifiedKey: 'ActualBase',
      predicate: 'EXTENDS',
      confidence: 0.9,
    });
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'takes',
      dstFilePath: '/repo/provider.ts',
      dstName: 'LocalBase',
      dstQualifiedKey: 'ActualBase',
      predicate: 'REFERENCES',
      confidence: 0.9,
    });
  });

  it('resolves renamed imports used in inheritance and type references', () => {
    const provider = parseFile(
      '/repo/types.ts',
      'export interface User { id: string; }\nexport class Base {}\n',
    )!;
    const consumer = parseFile(
      '/repo/consumer.ts',
      'import { type User as ExternalUser, Base as LocalBase } from "./types";\n'
        + 'export class Child extends LocalBase {}\n'
        + 'export function use(value: ExternalUser) { return value.id; }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'Child',
      dstFilePath: '/repo/types.ts',
      dstName: 'LocalBase',
      dstQualifiedKey: 'Base',
      predicate: 'EXTENDS',
      confidence: 0.9,
    });
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'use',
      dstFilePath: '/repo/types.ts',
      dstName: 'ExternalUser',
      dstQualifiedKey: 'User',
      predicate: 'REFERENCES',
      confidence: 0.9,
    });
  });

  it('does not bind a default import to a provider member named "default"', () => {
    // `imported` is the sentinel 'default' for `import run from "./m"`, not an
    // export name. Without the guard, the renamed-import fallback matches the
    // *method* `M.default` and emits a confident edge to the wrong member.
    const provider = parseFile(
      '/repo/m.ts',
      'export class M { default() { return 1; } }\nexport default new M();\n',
    )!;
    const consumer = parseFile(
      '/repo/n.ts',
      'import run from "./m";\nexport function go() { return run(); }\n',
    )!;

    const resolved = resolveEdges([consumer, provider]);
    expect(
      resolved.filter((e) => e.srcName === 'go' && e.dstQualifiedKey === 'M.default'),
    ).toEqual([]);
  });

  it('uses caller-supplied parse results instead of re-parsing', () => {
    // The CLI parses prescan sources on its worker pool and hands the results
    // in, so the index costs no main-thread parsing. Proven by supplying a
    // parse result whose entity does not appear in the source text: if the
    // index re-parsed, `fromPool` could not be resolved.
    const targetPath = '/repo/target.ts';
    const caller = fileResult(
      '/repo/consumer.ts',
      SupportedLanguages.TypeScript,
      [entity('run', SupportedLanguages.TypeScript)],
      [
        { srcName: 'consumer.ts', dstName: 'target', predicate: 'IMPORTS', importRaw: './target' },
        { srcName: 'run', dstName: 'fromPool', predicate: 'CALLS' },
      ],
    );
    caller.importBindings = [{ pkg: './target', local: 'fromPool', imported: 'fromPool' }];

    const poolResult = fileResult(
      targetPath,
      SupportedLanguages.TypeScript,
      [entity('fromPool', SupportedLanguages.TypeScript)],
      [],
    );

    const globalIndex = buildGlobalResolutionIndex(
      ['/repo/consumer.ts', targetPath],
      new Map([[targetPath, '// the pool result is authoritative, not this text\n']]),
      new Map([[targetPath, poolResult]]),
    );

    expect(resolveEdges([caller], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/consumer.ts',
      srcName: 'run',
      dstFilePath: targetPath,
      dstName: 'fromPool',
      dstQualifiedKey: 'fromPool',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves Elixir alias-qualified calls through the implicit short alias', () => {
  const caller = fileResult(
    '/repo/lib/my_app/accounts.ex',
    SupportedLanguages.Elixir,
    [entity('create_user', SupportedLanguages.Elixir)],
    [
      { srcName: 'accounts.ex', dstName: 'MyApp.Repo', predicate: 'IMPORTS' },
      { srcName: 'create_user', dstName: 'Repo.insert', predicate: 'CALLS' },
    ],
  );
  caller.importAliases = {
    Repo: 'MyApp.Repo',
  };

  const callee = fileResult(
    '/repo/lib/my_app/repo.ex',
    SupportedLanguages.Elixir,
    [
      entity('MyApp.Repo', SupportedLanguages.Elixir, 'class'),
      entity('insert', SupportedLanguages.Elixir, 'function', 'MyApp.Repo'),
    ],
  );

  expect(resolveEdges([caller, callee])).toContainEqual({
    srcFilePath: '/repo/lib/my_app/accounts.ex',
    srcName: 'create_user',
    dstFilePath: '/repo/lib/my_app/repo.ex',
    dstName: 'Repo.insert',
    dstQualifiedKey: 'MyApp.Repo.insert',
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

  it('uses a TypeScript relative import path to disambiguate duplicate file stems', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import { target } from "./utils";\nexport function caller() { return target(); }\n',
    )!;
    const localUtils = fileResult(
      '/repo/a/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );
    const unrelatedUtils = fileResult(
      '/repo/b/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    const resolved = resolveEdges([caller, localUtils, unrelatedUtils]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/a/caller.ts',
      srcName: 'caller.ts',
      dstFilePath: '/repo/a/utils.ts',
      dstName: 'utils',
      dstQualifiedKey: 'utils.ts',
      predicate: 'IMPORTS',
      confidence: 0.9,
    });
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/a/caller.ts',
      srcName: 'caller',
      dstFilePath: '/repo/a/utils.ts',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(resolved.some(edge => edge.dstFilePath === '/repo/b/utils.ts')).toBe(false);
  });

  it('resolves parent-relative JavaScript imports to TypeScript source files', () => {
    const caller = fileResult(
      '/repo/features/a/caller.ts',
      SupportedLanguages.TypeScript,
      [entity('caller', SupportedLanguages.TypeScript)],
      [
        { srcName: 'caller.ts', dstName: 'utils.js', predicate: 'IMPORTS', importRaw: '../../shared/utils.js' },
        { srcName: 'caller', dstName: 'target', predicate: 'CALLS' },
      ],
    );
    const target = fileResult(
      '/repo/shared/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );
    const runtimeTarget = fileResult(
      '/repo/shared/utils.js',
      SupportedLanguages.JavaScript,
      [entity('target', SupportedLanguages.JavaScript)],
    );
    const collision = fileResult(
      '/repo/other/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    const resolved = resolveEdges([caller, target, runtimeTarget, collision]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/features/a/caller.ts',
      srcName: 'caller',
      dstFilePath: '/repo/shared/utils.ts',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(resolved.some(edge => edge.dstFilePath === '/repo/shared/utils.js')).toBe(false);
  });

  it('prefers the runtime JavaScript file for a JavaScript caller', () => {
    const caller = parseFile(
      '/repo/a/caller.js',
      'import { target } from "./utils.js";\nexport function caller() { return target(); }\n',
    )!;
    const runtimeTarget = fileResult(
      '/repo/a/utils.js',
      SupportedLanguages.JavaScript,
      [entity('target', SupportedLanguages.JavaScript)],
    );
    const typeScriptTarget = fileResult(
      '/repo/a/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    const resolved = resolveEdges([caller, runtimeTarget, typeScriptTarget]);
    expect(resolved.some(edge => edge.dstFilePath === '/repo/a/utils.js')).toBe(true);
    expect(resolved.some(edge => edge.dstFilePath === '/repo/a/utils.ts')).toBe(false);
  });

  it('resolves relative JavaScript imports with URL query and fragment suffixes', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import { target } from "./utils.ts?worker#entry";\nexport function caller() { return target(); }\n',
    )!;
    const target = fileResult(
      '/repo/a/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, target])).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/a/caller.ts',
      dstFilePath: '/repo/a/utils.ts',
      predicate: 'CALLS',
    }));
  });

  it('does not emit a file self-edge for a relative self-import', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import "./caller";\nexport function caller() {}\n',
    )!;

    expect(resolveEdges([caller])).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('matches relative paths case-insensitively on Windows', () => {
    const caller = parseFile(
      'repo\\a\\caller.ts',
      'import { target } from "./Utils";\nexport function caller() { return target(); }\n',
    )!;
    const target = fileResult(
      'repo\\a\\utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, target])).toContainEqual(expect.objectContaining({
      srcFilePath: 'repo\\a\\caller.ts',
      dstFilePath: 'repo\\a\\utils.ts',
      predicate: 'CALLS',
    }));
  });

  it('does not fall back to an unrelated same-stem file when the relative target is missing', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import { target } from "./utils";\nexport function caller() { return target(); }\n',
    )!;
    const unrelatedUtils = fileResult(
      '/repo/b/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, unrelatedUtils])).toEqual([]);
  });

  it('resolves a relative import to a directory index', () => {
    const caller = fileResult(
      '/repo/a/caller.ts',
      SupportedLanguages.TypeScript,
      [entity('caller', SupportedLanguages.TypeScript)],
      [
        { srcName: 'caller.ts', dstName: 'services', predicate: 'IMPORTS', importRaw: './services' },
        { srcName: 'caller', dstName: 'target', predicate: 'CALLS' },
      ],
    );
    const index = fileResult(
      '/repo/a/services/index.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );
    const collision = fileResult(
      '/repo/b/services/index.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, index, collision])).toContainEqual({
      srcFilePath: '/repo/a/caller.ts',
      srcName: 'caller',
      dstFilePath: '/repo/a/services/index.ts',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('prefers a direct TypeScript module over its directory index', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import { target } from "./services";\nexport function caller() { return target(); }\n',
    )!;
    const direct = fileResult(
      '/repo/a/services.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );
    const index = fileResult(
      '/repo/a/services/index.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    const resolved = resolveEdges([caller, direct, index]);
    expect(resolved).toContainEqual({
      srcFilePath: '/repo/a/caller.ts',
      srcName: 'caller',
      dstFilePath: '/repo/a/services.ts',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
    expect(resolved.some(edge => edge.dstFilePath === '/repo/a/services/index.ts')).toBe(false);
  });

  it('uses a Python relative import path to disambiguate duplicate modules', () => {
    const caller = parseFile(
      '/repo/pkg/a/caller.py',
      'from .utils import target\n\ndef caller():\n    return target()\n',
    )!;
    const localUtils = fileResult(
      '/repo/pkg/a/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );
    const unrelatedUtils = fileResult(
      '/repo/pkg/b/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );

    expect(resolveEdges([caller, localUtils, unrelatedUtils])).toContainEqual({
      srcFilePath: '/repo/pkg/a/caller.py',
      srcName: 'caller',
      dstFilePath: '/repo/pkg/a/utils.py',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves a Python from-dot import to the local module', () => {
    const caller = parseFile(
      '/repo/pkg/a/caller.py',
      'from . import utils\n\ndef caller():\n    return utils.target()\n',
    )!;
    const localUtils = fileResult(
      '/repo/pkg/a/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );
    const unrelatedUtils = fileResult(
      '/repo/pkg/b/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );

    expect(resolveEdges([caller, localUtils, unrelatedUtils])).toContainEqual({
      srcFilePath: '/repo/pkg/a/caller.py',
      srcName: 'caller',
      dstFilePath: '/repo/pkg/a/utils.py',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves a Python relative import through its local alias', () => {
    const caller = parseFile(
      '/repo/pkg/a/caller.py',
      'from .utils import target as local\n\ndef caller():\n    return local()\n',
    )!;
    const localUtils = fileResult(
      '/repo/pkg/a/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );
    const unrelatedLocal = fileResult(
      '/repo/other/local.py',
      SupportedLanguages.Python,
      [entity('local', SupportedLanguages.Python)],
    );

    const resolved = resolveEdges([caller, localUtils, unrelatedLocal]);
    expect(resolved).toContainEqual(expect.objectContaining({
      srcFilePath: '/repo/pkg/a/caller.py',
      srcName: 'caller',
      dstFilePath: '/repo/pkg/a/utils.py',
      dstName: 'local',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    }));
    expect(resolved.some(edge => edge.dstFilePath === '/repo/other/local.py')).toBe(false);
  });

  it('does not globally resolve a missing Python relative import when other imports exist', () => {
    const caller = parseFile(
      '/repo/pkg/a/caller.py',
      'from .missing import target\nimport os\n\ndef caller():\n    return target()\n',
    )!;
    const unrelatedTarget = fileResult(
      '/repo/other/target.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );

    expect(resolveEdges([caller, unrelatedTarget])).toEqual([]);
  });

  it('keeps a Python imported symbol scoped to its relative module', () => {
    const caller = fileResult(
      '/repo/pkg/a/caller.py',
      SupportedLanguages.Python,
      [entity('caller', SupportedLanguages.Python)],
      [
        { srcName: 'caller.py', dstName: 'utils', predicate: 'IMPORTS', importRaw: '.utils' },
        { srcName: 'caller.py', dstName: 'target', predicate: 'IMPORTS' },
        { srcName: 'caller', dstName: 'target', predicate: 'CALLS' },
      ],
    );
    const localUtils = fileResult(
      '/repo/pkg/a/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );
    const unrelatedTarget = fileResult(
      '/repo/other/target.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );

    expect(resolveEdges([caller, localUtils, unrelatedTarget])).toContainEqual({
      srcFilePath: '/repo/pkg/a/caller.py',
      srcName: 'caller',
      dstFilePath: '/repo/pkg/a/utils.py',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('resolves a parent-relative Python import from its package path', () => {
    const caller = fileResult(
      '/repo/pkg/sub/caller.py',
      SupportedLanguages.Python,
      [entity('caller', SupportedLanguages.Python)],
      [
        { srcName: 'caller.py', dstName: 'shared.utils', predicate: 'IMPORTS', importRaw: '..shared.utils' },
        { srcName: 'caller', dstName: 'target', predicate: 'CALLS' },
      ],
    );
    const target = fileResult(
      '/repo/pkg/shared/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );
    const collision = fileResult(
      '/repo/other/shared/utils.py',
      SupportedLanguages.Python,
      [entity('target', SupportedLanguages.Python)],
    );

    expect(resolveEdges([caller, target, collision])).toContainEqual({
      srcFilePath: '/repo/pkg/sub/caller.py',
      srcName: 'caller',
      dstFilePath: '/repo/pkg/shared/utils.py',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('uses relative paths when candidates come from the global index', () => {
    const caller = parseFile(
      '/repo/a/caller.ts',
      'import { target } from "./utils";\nexport function caller() { return target(); }\n',
    )!;
    const localPath = '/repo/a/utils.ts';
    const unrelatedPath = '/repo/b/utils.ts';
    const globalIndex = buildGlobalResolutionIndex(
      [localPath, unrelatedPath],
      new Map([
        [localPath, 'export function target() { return 1; }\n'],
        [unrelatedPath, 'export function target() { return 2; }\n'],
      ]),
    );

    expect(resolveEdges([caller], undefined, globalIndex)).toContainEqual({
      srcFilePath: '/repo/a/caller.ts',
      srcName: 'caller',
      dstFilePath: '/repo/a/utils.ts',
      dstName: 'target',
      dstQualifiedKey: 'target',
      predicate: 'CALLS',
      confidence: 0.9,
    });
  });

  it('does not use path narrowing for bare module imports', () => {
    const caller = fileResult(
      '/repo/a/caller.ts',
      SupportedLanguages.TypeScript,
      [entity('caller', SupportedLanguages.TypeScript)],
      [
        { srcName: 'caller.ts', dstName: 'utils', predicate: 'IMPORTS', importRaw: 'utils' },
        { srcName: 'caller', dstName: 'target', predicate: 'CALLS' },
      ],
    );
    const first = fileResult(
      '/repo/a/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );
    const second = fileResult(
      '/repo/b/utils.ts',
      SupportedLanguages.TypeScript,
      [entity('target', SupportedLanguages.TypeScript)],
    );

    expect(resolveEdges([caller, first, second])).toEqual([]);
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

  it('Python: from X import ClassName resolves IMPORTS edge to the class node via Tier 2', () => {
    // `from models import Column` produces two IMPORTS edges: one for the module
    // (resolves to models.py as a file) and one for the symbol (dstName='Column',
    // no file match). The PascalCase fallthrough should bind Column to the class node.
    const consumer = fileResult(
      '/repo/consumer.py',
      SupportedLanguages.Python,
      [entity('use_column', SupportedLanguages.Python)],
      [
        { srcName: 'consumer.py', dstName: 'models', predicate: 'IMPORTS' },
        { srcName: 'consumer.py', dstName: 'Column', predicate: 'IMPORTS' },
      ],
    );
    const models = fileResult(
      '/repo/models.py',
      SupportedLanguages.Python,
      [entity('Column', SupportedLanguages.Python, 'class')],
    );

    expect(resolveEdges([consumer, models])).toContainEqual({
      srcFilePath: '/repo/consumer.py',
      srcName: 'consumer.py',
      dstFilePath: '/repo/models.py',
      dstName: 'Column',
      dstQualifiedKey: 'Column',
      predicate: 'IMPORTS',
      confidence: 0.9,
    });
  });

  it('Go: IMPORTS edge with PascalCase name and zero importMatches does not fall through to symbol resolution', () => {
    // An unresolvable external package (no matching file) with a PascalCase name
    // should not leak into Tier 2/3 and bind to an in-repo Go symbol of the same name.
    const consumer = fileResult(
      '/repo/main.go',
      SupportedLanguages.Go,
      [entity('main', SupportedLanguages.Go, 'function')],
      [{ srcName: 'main.go', dstName: 'HttpClient', predicate: 'IMPORTS' }],
    );
    const lib = fileResult(
      '/repo/lib/http.go',
      SupportedLanguages.Go,
      [entity('HttpClient', SupportedLanguages.Go, 'class')],
    );

    const resolved = resolveEdges([consumer, lib]);
    expect(resolved.filter(e => e.predicate === 'IMPORTS' && e.dstName === 'HttpClient')).toEqual([]);
  });

  // The R cross-batch index is parser-derived (not regex), so it captures every
  // definition form the parser does — including `= function` and string-keyed S3
  // method names that the old `<- function(` regex missed.
  it('R: cross-batch index captures <-, = and string-keyed S3 function defs', () => {
    const src = [
      'clean_data <- function(x) x',
      'fit_model = function(y) y',
      '"print.myClass" <- function(z) z',
    ].join('\n');
    const sources = new Map([['/repo/funcs.r', src]]);
    const index = buildGlobalResolutionIndex(['/repo/funcs.r'], sources);

    expect(index.symbolToFiles.get('clean_data')).toContain('/repo/funcs.r');     // <- form
    expect(index.symbolToFiles.get('fit_model')).toContain('/repo/funcs.r');      // = form (regex missed)
    expect(index.symbolToFiles.get('print.myClass')).toContain('/repo/funcs.r');  // string-keyed S3 (regex missed)
  });

  // SAS macro libraries define the same %macro name in many files. With no
  // %include to scope the call (which would resolve at Tier-2), the closest
  // definer by path prefix is preferred rather than dropping the edge.
  it('SAS: resolves a multiply-defined macro call to the closest definer by path proximity', () => {
    const caller = fileResult(
      '/repo/qis/a/call.sas',
      SupportedLanguages.SAS,
      [entity('driver', SupportedLanguages.SAS, 'macro')],
      [{ srcName: 'driver', dstName: 'mdx', predicate: 'CALLS' }],
    );
    const near = fileResult('/repo/qis/a/mdx_local.sas', SupportedLanguages.SAS, [entity('mdx', SupportedLanguages.SAS, 'macro')]);
    const far  = fileResult('/repo/other/mdx_lib.sas',   SupportedLanguages.SAS, [entity('mdx', SupportedLanguages.SAS, 'macro')]);

    expect(resolveEdges([caller, near, far])).toEqual([
      {
        srcFilePath: '/repo/qis/a/call.sas',
        srcName: 'driver',
        dstFilePath: '/repo/qis/a/mdx_local.sas',
        dstName: 'mdx',
        dstQualifiedKey: 'mdx',
        predicate: 'CALLS',
        confidence: 0.5,
      },
    ]);
  });

  it('SAS: still drops a multiply-defined macro call when definers are equidistant', () => {
    const caller = fileResult(
      '/repo/qis/a/call.sas',
      SupportedLanguages.SAS,
      [entity('driver', SupportedLanguages.SAS, 'macro')],
      [{ srcName: 'driver', dstName: 'mdx', predicate: 'CALLS' }],
    );
    // Both definers share the same prefix length with the caller (/repo/...),
    // so proximity can't disambiguate — conservative behavior is to emit nothing.
    const b = fileResult('/repo/qis/b/mdx.sas', SupportedLanguages.SAS, [entity('mdx', SupportedLanguages.SAS, 'macro')]);
    const c = fileResult('/repo/qis/c/mdx.sas', SupportedLanguages.SAS, [entity('mdx', SupportedLanguages.SAS, 'macro')]);

    expect(resolveEdges([caller, b, c])).toEqual([]);
  });

  // ── Multi-repo co-ingest dependency gate (Ix#225 Path 1) ──────────────────
  // A cross-repo edge survives only when the source repo imports the target
  // repo's package. The importRaw specifier is what lets the gate tell a relative
  // intra-repo import (./core) apart from a package import (@acme/core) that
  // flattens to the same stem ("core").
  describe('multi-repo dependency gate', () => {
    // repoOf: first path segment is the member repo (matches the CLI).
    const repoOf = (fp: string) => fp.split('/')[0];
    // packageOf mirrors the CLI: rejects relative specifiers; maps the full name
    // AND the bare stem to the publishing repo.
    const packageOf = (mod: string) => {
      if (!mod || mod.startsWith('.') || mod.startsWith('/')) return undefined;
      if (mod === '@acme/core' || mod === 'core') return 'repo-a';
      return undefined;
    };
    const coreFile = () =>
      fileResult('repo-a/src/core.ts', SupportedLanguages.TypeScript, [
        entity('coreFn', SupportedLanguages.TypeScript),
      ]);
    const caller = (importRaw: string) =>
      fileResult('repo-b/src/index.ts', SupportedLanguages.TypeScript,
        [entity('run', SupportedLanguages.TypeScript)],
        [
          { srcName: 'run', dstName: 'coreFn', predicate: 'CALLS' },
          { srcName: 'index.ts', dstName: 'core', predicate: 'IMPORTS', importRaw },
        ]);

    it('keeps a cross-repo edge when the import is a genuine package specifier', () => {
      const edges = resolveEdges([caller('@acme/core'), coreFile()], undefined, undefined, { repoOf, packageOf });
      const cross = edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath));
      expect(cross.find(e => e.predicate === 'CALLS')).toMatchObject({ srcName: 'run', dstName: 'coreFn' });
    });

    it('drops the cross-repo edge when the same-stem import is relative (./core)', () => {
      const edges = resolveEdges([caller('./core'), coreFile()], undefined, undefined, { repoOf, packageOf });
      const cross = edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath));
      expect(cross).toEqual([]);
    });

    it('keeps a cross-repo edge via the declared-dependency graph when import-matching cannot bridge it (e.g. Java artifactId vs package namespace)', () => {
      // packageOf can never resolve the import (simulates Maven artifactId vs
      // `import com.x.*`), but the manifest declares repo-b depends on repo-a.
      const onlyCall = fileResult('repo-b/src/index.ts', SupportedLanguages.TypeScript,
        [entity('run', SupportedLanguages.TypeScript)],
        [{ srcName: 'run', dstName: 'coreFn', predicate: 'CALLS' }]);
      const edges = resolveEdges([onlyCall, coreFile()], undefined, undefined,
        { repoOf, packageOf: () => undefined, declaredRepoDeps: { 'repo-b': ['repo-a'] } });
      const cross = edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath));
      expect(cross.find(e => e.predicate === 'CALLS')).toMatchObject({ srcName: 'run', dstName: 'coreFn' });
    });

    it('still drops it when neither import-matching nor declared deps back the dependency', () => {
      const onlyCall = fileResult('repo-b/src/index.ts', SupportedLanguages.TypeScript,
        [entity('run', SupportedLanguages.TypeScript)],
        [{ srcName: 'run', dstName: 'coreFn', predicate: 'CALLS' }]);
      const edges = resolveEdges([onlyCall, coreFile()], undefined, undefined,
        { repoOf, packageOf: () => undefined });
      expect(edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath))).toEqual([]);
    });

    // Ambiguous cross-repo symbol: `coreFn` is defined identically in repo-a AND
    // repo-c. A bare call from repo-b must fold onto the member repo-b DEPENDS on,
    // not be skipped as ambiguous (which left it unresolved and the patch builder
    // then fell back to a phantom same-file dst = a dangling edge). Ix#225.
    const coreFileIn = (repo: string) =>
      fileResult(`${repo}/src/core.ts`, SupportedLanguages.TypeScript, [
        entity('coreFn', SupportedLanguages.TypeScript),
      ]);
    const bareCaller = () =>
      fileResult('repo-b/src/index.ts', SupportedLanguages.TypeScript,
        [entity('run', SupportedLanguages.TypeScript)],
        [{ srcName: 'run', dstName: 'coreFn', predicate: 'CALLS' }]);

    it('disambiguates an ambiguous cross-repo symbol via the declared dependency (repo-b depends on repo-a, not repo-c)', () => {
      const edges = resolveEdges([bareCaller(), coreFileIn('repo-a'), coreFileIn('repo-c')], undefined, undefined,
        { repoOf, packageOf: () => undefined, declaredRepoDeps: { 'repo-b': ['repo-a'] } });
      const cross = edges.filter(e => e.predicate === 'CALLS' && repoOf(e.srcFilePath) !== repoOf(e.dstFilePath));
      expect(cross).toHaveLength(1);
      expect(cross[0]).toMatchObject({ srcName: 'run', dstName: 'coreFn', dstFilePath: 'repo-a/src/core.ts' });
    });

    it('stays under-connected (no cross-repo edge) when the source repo depends on BOTH defining repos (genuinely ambiguous)', () => {
      const edges = resolveEdges([bareCaller(), coreFileIn('repo-a'), coreFileIn('repo-c')], undefined, undefined,
        { repoOf, packageOf: () => undefined, declaredRepoDeps: { 'repo-b': ['repo-a', 'repo-c'] } });
      expect(edges.filter(e => e.predicate === 'CALLS' && repoOf(e.srcFilePath) !== repoOf(e.dstFilePath))).toEqual([]);
    });

    it('emits no cross-repo edge to an ambiguous symbol when the source repo depends on NEITHER defining repo', () => {
      const edges = resolveEdges([bareCaller(), coreFileIn('repo-a'), coreFileIn('repo-c')], undefined, undefined,
        { repoOf, packageOf: () => undefined });
      expect(edges.filter(e => e.predicate === 'CALLS' && repoOf(e.srcFilePath) !== repoOf(e.dstFilePath))).toEqual([]);
    });
  });

  // Recall: a genuine dependency that imports another member's PACKAGE must couple
  // the repos even when the consumer uses a dynamic/property API that resolves no
  // symbol call (the real-world ora -> chalk via `chalk[color]` case). The import
  // specifier IS the dependency, so emit a cross-repo IMPORTS edge to the dep
  // member's entry file. Precision: relative imports and non-member packages must
  // NOT couple, and single-repo resolution is a no-op.
  describe('package-import cross-repo edge', () => {
    const repoOf = (fp: string) => fp.split('/')[0];
    const packageOf = (mod: string) => {
      if (!mod || mod.startsWith('.') || mod.startsWith('/')) return undefined;
      return (mod === '@acme/widget' || mod === 'widget') ? 'lib' : undefined;
    };
    const lib = () => fileResult('lib/core.ts', SupportedLanguages.TypeScript, [entity('makeWidget', SupportedLanguages.TypeScript)]);
    // dstName 'widget' matches no in-repo file, so resolution falls to the package path.
    const consumer = (importRaw: string) =>
      fileResult('app/main.ts', SupportedLanguages.TypeScript,
        [entity('run', SupportedLanguages.TypeScript)],
        [{ srcName: 'main.ts', dstName: 'widget', predicate: 'IMPORTS', importRaw }]);

    it('couples a consumer to a dep member on a package import even with no resolved symbol call', () => {
      const edges = resolveEdges([consumer('@acme/widget'), lib()], undefined, undefined, { repoOf, packageOf });
      const cross = edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath));
      expect(cross).toEqual([expect.objectContaining({ srcFilePath: 'app/main.ts', dstFilePath: 'lib/core.ts', predicate: 'IMPORTS' })]);
    });

    it('does NOT couple on a relative import (./widget is intra-repo, not a member package)', () => {
      const edges = resolveEdges([consumer('./widget'), lib()], undefined, undefined, { repoOf, packageOf });
      expect(edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath))).toEqual([]);
    });

    it('does NOT couple on an import of a non-member package', () => {
      const edges = resolveEdges([consumer('left-pad'), lib()], undefined, undefined, { repoOf, packageOf });
      expect(edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath))).toEqual([]);
    });

    it('is a no-op for single-repo resolution (no co-ingest opts)', () => {
      const edges = resolveEdges([consumer('@acme/widget'), lib()]);
      expect(edges.filter(e => repoOf(e.srcFilePath) !== repoOf(e.dstFilePath) && e.predicate === 'IMPORTS')).toEqual([]);
    });
  });
});
