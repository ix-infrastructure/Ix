import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

const names = (source: string) =>
  parseFile('/repo/script.ps1', source)!.entities
    .filter((entity) => entity.kind !== 'file')
    .map((entity) => `${entity.kind}:${entity.name}`);

const imports = (source: string, path = '/repo/script.ps1') =>
  parseFile(path, source)!.relationships
    .filter((relationship) => relationship.predicate === 'IMPORTS')
    .map((relationship) => relationship.dstName);

describe('PowerShell queries', () => {
  it('captures function, filter and workflow, which share one node type', () => {
    expect(names('function Get-Thing { }\nfilter Pick { $_ }\nworkflow Flow { }\n')).toEqual(
      expect.arrayContaining(['function:Get-Thing', 'function:Pick', 'function:Flow']),
    );
  });

  it('captures classes, their methods, and enums', () => {
    expect(names('class Installer {\n  [string]$Root\n  [void] Run() { }\n}\nenum Mode { Fast; Slow }\n')).toEqual(
      expect.arrayContaining(['class:Installer', 'method:Run', 'class:Mode']),
    );
  });

  it('records calls, including calls to functions defined in the same file', () => {
    const result = parseFile(
      '/repo/script.ps1',
      'function Write-Ok($m) { Write-Host $m }\nWrite-Ok "done"\n',
    );
    expect(
      result!.relationships
        .filter((relationship) => relationship.predicate === 'CALLS')
        .map((relationship) => relationship.dstName),
    ).toEqual(expect.arrayContaining(['Write-Host', 'Write-Ok']));
  });

  it('resolves all three ways a script pulls in code', () => {
    expect(imports('Import-Module Microsoft.PowerShell.Utility\n')).toEqual(['Microsoft.PowerShell.Utility']);
    expect(imports('using module Ix.Common\n')).toEqual(['Ix.Common']);
    expect(imports('using namespace System.IO\n')).toEqual(['System.IO']);
    expect(imports('. "$PSScriptRoot/common.ps1"\n')).toEqual(['common.ps1']);
  });

  it('does not mistake Import-Module arguments for further modules', () => {
    // `using module X` puts the scope keyword in a generic_token too, and
    // -RequiredVersion's value is one as well; both produced junk imports
    // ("module", "5.0") before the patterns were anchored.
    expect(imports('Import-Module Pester -RequiredVersion 5.0 -Force\n')).toEqual(['Pester']);
  });

  it('parses .psm1 modules and .psd1 manifests', () => {
    expect(names('function Get-Thing { }\n').length).toBeGreaterThan(0);
    expect(parseFile('/repo/mod.psm1', 'function Get-Thing { }\n')).not.toBeNull();
    expect(parseFile('/repo/mod.psd1', '@{ ModuleVersion = "1.0" }\n')).not.toBeNull();
  });
});
