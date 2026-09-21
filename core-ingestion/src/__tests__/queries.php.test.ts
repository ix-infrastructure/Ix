// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('PHP queries', () => {
  it('normalizes namespace imports to the imported class name', () => {
    const result = parseFile(
      '/repo/UseCase.php',
      `<?php
namespace App;

use Vendor\\Contracts\\DomainService;
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'UseCase.php',
      dstName: 'DomainService',
      predicate: 'IMPORTS',
      importRaw: 'Vendor\\Contracts\\DomainService',
    });
  });

  it('records PHP namespace scope for semicolon and braced declarations', () => {
    const result = parseFile(
      '/repo/Types.php',
      `<?php
namespace First\\Space;
class FirstType {}
namespace Second\\Space;
class SecondType {}
      `,
    );
    const braced = parseFile(
      '/repo/Braced.php',
      `<?php
namespace Vendor\\Package { class User {} }
namespace { class GlobalThing {} }
      `,
    );

    expect(result?.entities.find(entity => entity.name === 'FirstType')?.packageScope).toBe('First\\Space');
    expect(result?.entities.find(entity => entity.name === 'SecondType')?.packageScope).toBe('Second\\Space');
    expect(braced?.entities.find(entity => entity.name === 'User')?.packageScope).toBe('Vendor\\Package');
    expect(braced?.entities.find(entity => entity.name === 'GlobalThing')?.packageScope).toBe('');
  });

  it('distinguishes function and constant imports from class imports', () => {
    const result = parseFile(
      '/repo/Imports.php',
      `<?php
use Vendor\\Package\\User;
use function Vendor\\Package\\helper;
use const Vendor\\Package\\FLAG;
      `,
    );

    expect(result?.relationships.filter(rel => rel.predicate === 'IMPORTS')).toEqual([
      {
        srcName: 'Imports.php',
        dstName: 'User',
        predicate: 'IMPORTS',
        importRaw: 'Vendor\\Package\\User',
      },
      {
        srcName: 'Imports.php',
        dstName: 'helper',
        predicate: 'IMPORTS',
        importRaw: 'Vendor\\Package\\helper',
        importKind: 'function',
      },
      {
        srcName: 'Imports.php',
        dstName: 'FLAG',
        predicate: 'IMPORTS',
        importRaw: 'Vendor\\Package\\FLAG',
        importKind: 'const',
      },
    ]);
  });

  it('distinguishes PHP constructors from function and member calls', () => {
    const result = parseFile(
      '/repo/Calls.php',
      `<?php
function run(Service $service): void {
    new Service();
    helper();
    $service->execute();
}
      `,
    );

    expect(result?.relationships.filter(rel => rel.predicate === 'CALLS')).toEqual([
      { srcName: 'run', dstName: 'Service', predicate: 'CALLS', phpCallKind: 'constructor' },
      { srcName: 'run', dstName: 'helper', predicate: 'CALLS', phpCallKind: 'function' },
      { srcName: 'run', dstName: 'Service.execute', predicate: 'CALLS', phpCallKind: 'member' },
    ]);
  });

  it('captures every member of a grouped namespace use', () => {
    const result = parseFile(
      '/repo/UseCase.php',
      `<?php
namespace App;

use Vendor\\Contracts\\{DomainService, Repo};
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'UseCase.php',
      dstName: 'DomainService',
      predicate: 'IMPORTS',
      importRaw: 'Vendor\\Contracts\\DomainService',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'UseCase.php',
      dstName: 'Repo',
      predicate: 'IMPORTS',
      importRaw: 'Vendor\\Contracts\\Repo',
    });
  });

  it('captures grouped use members with the shared prefix, never the alias', () => {
    const result = parseFile(
      '/repo/UseCase.php',
      `<?php
namespace App;

use Vendor\\Contracts\\{DomainService as DS, Repo};
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'UseCase.php',
      dstName: 'DomainService',
      predicate: 'IMPORTS',
      importRaw: 'Vendor\\Contracts\\DomainService',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'UseCase.php',
      dstName: 'Repo',
      predicate: 'IMPORTS',
      importRaw: 'Vendor\\Contracts\\Repo',
    });
    // The `as DS` alias is a local name, never an imported symbol.
    expect(result!.relationships.filter((r) => r.predicate === 'IMPORTS' && r.dstName === 'DS')).toEqual([]);
  });

  it('resolves calls through typed properties and method parameters', () => {
    const result = parseFile(
      '/repo/UseCase.php',
      `<?php
interface DomainService
{
    public function create(): void;
}

interface Repository
{
    public function create(): void;
}

final class UseCase
{
    private AuditLogger $auditLogger;

    public function __construct(
        private DomainService $domainService,
        private Repository $repository,
    ) {}

    public function create(Logger $logger): void
    {
        $this->domainService->create();
        $this->repository?->create();
        $this->auditLogger->write();
        $logger->write();
        $this->finish();
    }

    private function finish(): void {}
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toEqual(
      expect.arrayContaining([
        { srcName: 'UseCase.create', dstName: 'DomainService.create', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'UseCase.create', dstName: 'Repository.create', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'UseCase.create', dstName: 'AuditLogger.write', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'UseCase.create', dstName: 'Logger.write', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'UseCase.create', dstName: 'UseCase.finish', predicate: 'CALLS', phpCallKind: 'member' },
      ]),
    );
    expect(result!.relationships).not.toContainEqual({
      srcName: 'UseCase.create',
      dstName: 'create',
      predicate: 'CALLS',
      phpCallKind: 'member',
    });
    expect(result!.relationships).not.toContainEqual({
      srcName: 'UseCase.create',
      dstName: 'UseCase.create',
      predicate: 'CALLS',
      phpCallKind: 'member',
    });
  });

  it('preserves bare-name fallback when the receiver type is unknown', () => {
    const result = parseFile(
      '/repo/Runner.php',
      `<?php
function run($service): void
{
    $service->create();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'create',
      predicate: 'CALLS',
      phpCallKind: 'member',
    });
  });

  it('resolves nullable declared types', () => {
    // `?Service` parses as (optional_type (named_type (name))), not named_type.
    // Matching only the latter dropped every nullable dependency to a bare name.
    const result = parseFile(
      '/repo/Nullable.php',
      `<?php
final class Nullable
{
    private ?Service $service;

    public function __construct(private ?Repository $repository) {}

    public function run(?Logger $logger): void
    {
        $this->service->create();
        $this->repository->find();
        $logger->write();
    }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toEqual(
      expect.arrayContaining([
        { srcName: 'Nullable.run', dstName: 'Service.create', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'Nullable.run', dstName: 'Repository.find', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'Nullable.run', dstName: 'Logger.write', predicate: 'CALLS', phpCallKind: 'member' },
      ]),
    );
  });

  it('resolves typed parameters on plain functions, not just methods', () => {
    // function_definition is a separate node from method_declaration; rooting the
    // parameter query at the latter alone left top-level functions untyped.
    const result = parseFile(
      '/repo/Standalone.php',
      `<?php
function run(Service $service, ?Logger $logger): void
{
    $service->create();
    $logger->write();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toEqual(
      expect.arrayContaining([
        { srcName: 'run', dstName: 'Service.create', predicate: 'CALLS', phpCallKind: 'member' },
        { srcName: 'run', dstName: 'Logger.write', predicate: 'CALLS', phpCallKind: 'member' },
      ]),
    );
  });

  it('leaves union-typed receivers as bare names', () => {
    // A union has no single receiver type to attribute the call to, so the bare
    // name is the honest answer rather than an arbitrary pick of one member.
    const result = parseFile(
      '/repo/Union.php',
      `<?php
final class Union
{
    public function run(Service|Repository $either): void
    {
        $either->create();
    }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Union.run',
      dstName: 'create',
      predicate: 'CALLS',
      phpCallKind: 'member',
    });
  });

  it(
    'scopes every declaration in a large file without rescanning the top level',
    { timeout: 3_000 },
    () => {
      // Resolving each definition's namespace by rescanning the file's top-level
      // nodes is O(definitions x nodes). This file is ordinary, valid PSR-12 and
      // well under the 1 MB ingest cap, but took ~13s to parse that way against
      // ~150ms now — and a 16k-declaration file took over three minutes, which
      // pins a parse worker with no per-file timeout.
      const count = 4_000;
      let source = '<?php\nnamespace App\\Support;\n';
      for (let i = 0; i < count; i += 1) source += `function helper${i}($a) { return $a; }\n`;

      const result = parseFile('/repo/big.php', source)!;

      const scoped = result.entities.filter((e) => e.packageScope === 'App\\Support');
      expect(scoped).toHaveLength(count);
    },
  );

  it('scopes declarations by the nearest preceding unbraced namespace', () => {
    // The binary search must land on the *last* declaration starting before the
    // node, not the first or the nearest by distance.
    const result = parseFile(
      '/repo/Sequential.php',
      `<?php
namespace First;
function alpha() {}
namespace Second;
function beta() {}
namespace Third;
function gamma() {}
`,
    )!;

    const scopeOf = (name: string) =>
      result.entities.find((e) => e.name === name)?.packageScope;
    expect(scopeOf('alpha')).toBe('First');
    expect(scopeOf('beta')).toBe('Second');
    expect(scopeOf('gamma')).toBe('Third');
  });
});
