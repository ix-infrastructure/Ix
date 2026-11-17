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
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const fixtureRoot = path.join(repoRoot, 'core-ingestion/test-fixtures');

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

describe('buildPatchWithResolution golden output (the CLI path)', () => {
  const repos = readdirSync(fixtureRoot)
    .filter((name) => statSync(path.join(fixtureRoot, name)).isDirectory())
    .sort();

  it('covers every fixture repo that has source', () => {
    expect(repos).toEqual(expect.arrayContaining(['java-receivers', 'mini-repo', 'scala-repo', 'typescript']));
  });

  for (const repo of repos) {
    it(`is unchanged for ${repo}`, () => {
      const results = parseRepo(path.join(fixtureRoot, repo), repoRoot);
      if (results.length === 0) return;
      expect(buildRepo(results, () => 'ws')).toMatchSnapshot();
    });
  }

  it('is unchanged for a co-ingest of two fixture repos', () => {
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
    expect(buildRepo(results, workspaceOf, multiRepo)).toMatchSnapshot();
  });

  it('is unchanged for PHP calls that differ only in call kind', () => {
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
    expect(buildRepo([result!], () => 'ws')).toMatchSnapshot();
  });
});
