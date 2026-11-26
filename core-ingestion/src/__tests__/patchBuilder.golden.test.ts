// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult } from '../index.js';
import {
  buildPatchWithResolution,
  extractorName,
  sourcePatchIdCandidates,
  type MultiRepoContext,
} from '../patch-builder.js';
import type { GraphPatchPayload } from '../types.js';
import {
  compareExtractorOutput,
  extractorOutputFailure,
  outputDigest,
  readExtractorOutputRecord,
  UPDATE_ENV,
  writeExtractorOutputRecord,
} from './helpers/extractor-output.js';
import { parserDependencyVersions } from './helpers/grammars.js';

/**
 * Golden output of the patch builder the CLI calls (`buildPatchWithResolution`)
 * over the fixture repos, resolved across each repo the way an ingest resolves
 * them. Node, edge and chunk ids are graph identity: if one of these ops
 * changes, every graph already ingested holds the old one until a re-extract.
 * A change here must be deliberate; update the snapshot only alongside one.
 *
 * The extractor name is masked, and the patch id is checked against
 * `sourcePatchIdCandidates` rather than snapshotted, so an extractor version
 * bump does not rewrite this file.
 *
 * A snapshot can be refreshed with `-u` under the same extractor name, so the
 * last test also checks a digest of each case, and the lockfile version of
 * every grammar, against test-fixtures/extractor-output.json: either changing
 * under the name recorded there fails until the name is bumped (#964).
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const fixtureRoot = path.join(repoRoot, 'core-ingestion/test-fixtures');
const recordFile = path.join(fixtureRoot, 'extractor-output.json');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (!name.endsWith('.json')) out.push(full);
  }
  return out;
}

function parseRepo(dir: string, relativeTo: string): FileParseResult[] {
  return sourceFiles(dir)
    .map((abs) => parseFile(path.relative(relativeTo, abs).replace(/\\/g, '/'), readFileSync(abs, 'utf8'), { budgetMs: 0 }))
    .filter((r): r is FileParseResult => r !== null);
}

/** The patch with what varies per run or per extractor version taken out. */
function stable(patch: GraphPatchPayload, workspaceId: string): Record<string, unknown> {
  const candidates = sourcePatchIdCandidates(patch.source.uri, patch.source.sourceHash, workspaceId);
  expect(patch.patchId).toBe(candidates[0]);
  // replaces = [the previous patch (here: the legacy id), ...older extractors]
  expect(patch.replaces).toEqual([candidates[candidates.length - 1], ...candidates.slice(1, -1)]);
  const extractor = extractorName();
  const mask = (value: unknown) => JSON.stringify(value).split(JSON.stringify(extractor)).join('"<extractor>"');
  const { patchId: _id, timestamp: _ts, replaces: _r, ops, ...rest } = patch;
  // One line per op, in emission order: byte-exact, and a diff names the op.
  return { ...JSON.parse(mask(rest)), ops: ops.map(mask) };
}

function buildRepo(results: FileParseResult[], workspaceOf: (filePath: string) => string, multiRepo?: (filePath: string) => MultiRepoContext) {
  const resolved = resolveEdges(results);
  return results.map((r) => stable(
    buildPatchWithResolution(r, `hash:${r.filePath}`, workspaceOf(r.filePath), resolved, undefined, multiRepo?.(r.filePath)),
    workspaceOf(r.filePath),
  ));
}

const repos = readdirSync(fixtureRoot)
  .filter((name) => statSync(path.join(fixtureRoot, name)).isDirectory())
  .sort();

function fixtureRepo(repo: string): Record<string, unknown>[] | null {
  const results = parseRepo(path.join(fixtureRoot, repo), repoRoot);
  return results.length === 0 ? null : buildRepo(results, () => 'ws');
}

function coIngest(): Record<string, unknown>[] {
  // Paths repo-prefixed, as a system ingest passes them; each member keeps
  // its own workspace id, so cross-repo dsts fold the other member's id.
  const members = ['mini-repo', 'scala-repo'];
  const results = members.flatMap((m) => parseRepo(path.join(fixtureRoot, m), fixtureRoot));
  const workspaceOf = (filePath: string) => `ws-${filePath.split('/')[0]}`;
  const multiRepo = (filePath: string): MultiRepoContext => ({
    systemId: 'sys',
    repoId: filePath.split('/')[0],
    repoWorkspaceOf: workspaceOf,
  });
  return buildRepo(results, workspaceOf, multiRepo);
}

function phpCallKinds(): Record<string, unknown>[] {
  const source = [
    '<?php',
    'class Foo {',
    '  function handle() { return 1; }',
    '  function run($obj) { handle(); $obj->handle(); Foo::handle(); }',
    '}',
    'function handle() {}',
    '',
  ].join('\n');
  const result = parseFile('src/Foo.php', source, { budgetMs: 0 });
  expect(result).not.toBeNull();
  return buildRepo([result!], () => 'ws');
}

function javaOverloads(): Record<string, unknown>[] {
  // #1139: the first overload keeps `Over.handle`; the others fold their
  // erased signature, and each holds only its own calls.
  const source = [
    'class Over {',
    '  void handle(String s) { First.one(); }',
    '  void handle(int n) { Second.two(); }',
    '  <T extends Comparable<T>> void handle(java.util.List<T> xs, T... rest) { Third.three(); }',
    '  void run() { handle(1); }',
    '}',
    '',
  ].join('\n');
  const results = [
    ['Over.java', source],
    ['First.java', 'class First { static void one() {} }\n'],
    ['Second.java', 'class Second { static void two() {} }\n'],
    ['Third.java', 'class Third { static void three() {} }\n'],
  ].map(([filePath, text]) => parseFile(`src/${filePath}`, text, { budgetMs: 0 }));
  expect(results.every((r) => r !== null)).toBe(true);
  return buildRepo(results as FileParseResult[], () => 'ws');
}

/** Every golden case by the name extractor-output.json records it under. */
const CASES: ReadonlyArray<readonly [string, () => Record<string, unknown>[] | null]> = [
  ...repos.map((repo) => [repo, () => fixtureRepo(repo)] as const),
  ['co-ingest of mini-repo and scala-repo', coIngest],
  ['PHP calls that differ only in call kind', phpCallKinds],
  ['Java overloads', javaOverloads],
];

describe('buildPatchWithResolution golden output (the CLI path)', () => {
  it('covers every fixture repo that has source', () => {
    expect(repos).toEqual(expect.arrayContaining(['java-receivers', 'mini-repo', 'scala-repo', 'typescript']));
  });

  for (const repo of repos) {
    it(`is unchanged for ${repo}`, () => {
      const output = fixtureRepo(repo);
      if (output === null) return;
      expect(output).toMatchSnapshot();
    });
  }

  it('is unchanged for a co-ingest of two fixture repos', () => {
    expect(coIngest()).toMatchSnapshot();
  });

  it('is unchanged for PHP calls that differ only in call kind', () => {
    expect(phpCallKinds()).toMatchSnapshot();
  });

  it('is unchanged for Java overloads', () => {
    expect(javaOverloads()).toMatchSnapshot();
  });
});

describe('extractor output record (#964)', () => {
  it('changes only together with the extractor name', () => {
    const outputs: Record<string, string> = {};
    for (const [name, build] of CASES) {
      const output = build();
      // stable() writes each op as a JSON string; digest the op itself.
      if (output !== null) outputs[name] = outputDigest(output.map((p) => ({ ...p, ops: (p.ops as string[]).map((op) => JSON.parse(op)) })));
    }
    const current = { extractor: extractorName(), parserDependencies: parserDependencyVersions(), outputs };
    const check = compareExtractorOutput(readExtractorOutputRecord(recordFile), current);
    const updating = process.env[UPDATE_ENV] === '1';
    const failure = extractorOutputFailure(check, updating);
    if (failure === null && updating && check.stale.length > 0) writeExtractorOutputRecord(recordFile, current);
    expect(failure, failure ?? '').toBeNull();
  });
});
