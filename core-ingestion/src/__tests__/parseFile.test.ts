import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function snapshotParse(relativePath: string) {
  const source = readRepoFile(relativePath);
  const result = parseFile(relativePath, source);

  expect(result).not.toBeNull();
  expect(result).toMatchSnapshot();
}

describe('parseFile snapshots', () => {
  it('snapshots Node.scala', () => {
    snapshotParse('memory-layer/src/main/scala/ix/memory/model/Node.scala');
  });

  it('snapshots Identifiers.scala', () => {
    snapshotParse('memory-layer/src/main/scala/ix/memory/model/Identifiers.scala');
  });

  it('snapshots doctor.ts', () => {
    snapshotParse('ix-cli/src/cli/commands/doctor.ts');
  });
});

describe('mixed-language fixture integration', () => {
  it('never resolves a TypeScript run() call to Scala when a TypeScript target exists', () => {
    const fixtureRoot = path.join(repoRoot, 'core-ingestion/test-fixtures/mini-repo/src');
    const files = ['foo.ts', 'Main.scala', 'Bar.ts']
      .map(name => path.join(fixtureRoot, name))
      .map(filePath => {
        const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
        const result = parseFile(relativePath, readFileSync(filePath, 'utf8'));
        expect(result).not.toBeNull();
        return result!;
      });

    const resolved = resolveEdges(files);
    expect(resolved).toContainEqual({
      srcFilePath: 'core-ingestion/test-fixtures/mini-repo/src/foo.ts',
      srcName: 'callRun',
      dstFilePath: 'core-ingestion/test-fixtures/mini-repo/src/Bar.ts',
      dstName: 'run',
      dstQualifiedKey: 'run',
      predicate: 'CALLS',
      confidence: 0.5,
    });
    expect(
      resolved.some(edge => edge.srcFilePath.endsWith('.ts') && edge.dstFilePath.endsWith('.scala')),
    ).toBe(false);
  });
});
