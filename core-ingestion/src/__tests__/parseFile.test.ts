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

// Every file snapshotted here is a frozen fixture, deliberately.
//
// These three used to read live paths: two from `memory-layer/`, which #120
// extracted to a separate private repo in April 2026 (so they threw ENOENT for
// everyone from then on), and one from ix-cli/src/cli/commands/doctor.ts, a
// source file under active development whose every edit broke the snapshot.
// A snapshot test needs an input that only changes when someone means to
// change it. See #557.
const SCALA_FIXTURES = 'core-ingestion/test-fixtures/scala-repo/src/main/scala/ix/sample';

describe('parseFile snapshots', () => {
  it('snapshots Node.scala', () => {
    snapshotParse(`${SCALA_FIXTURES}/model/Node.scala`);
  });

  it('snapshots Identifiers.scala', () => {
    snapshotParse(`${SCALA_FIXTURES}/model/Identifiers.scala`);
  });

  it('snapshots a TypeScript command module', () => {
    snapshotParse('core-ingestion/test-fixtures/typescript/sample-command.ts');
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

  it('captures C++ out-of-line method containers and qualifier-based calls', () => {
    const source = `
class VersionSet {
 public:
  void Recover();
};

class Version {
 public:
  void Get();
};

class DBImpl {
 public:
  VersionSet* versions_;
  Version* current_;
  void Open();
  void Read();
};

void DBImpl::Open() {
  versions_->Recover();
}

void DBImpl::Read() {
  Version* current = current_;
  current->Get();
}
`;
    const result = parseFile('leveldb/db/db_impl.cc', source);
    expect(result).not.toBeNull();

    expect(result!.entities).toContainEqual(expect.objectContaining({
      name: 'Open',
      kind: 'method',
      container: 'DBImpl',
    }));
    expect(result!.relationships).toContainEqual({
      srcName: 'DBImpl.Open',
      dstName: 'VersionSet.Recover',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'DBImpl.Read',
      dstName: 'Version.Get',
      predicate: 'CALLS',
    });
  });
});
