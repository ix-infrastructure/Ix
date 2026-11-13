// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The script uses production parser patches, rather than hand-built wire nodes.
// @ts-expect-error Standalone evaluation scripts have no declaration files.
import { evaluateConfigSlice } from '../../../scripts/ranking-eval/config-slice.mjs';

it('retains detection failures in independently labeled and candidate slices', async () => {
  const source = readFileSync(new URL('../../../../core-ingestion/test-fixtures/config-bindings/undetected.py', import.meta.url), 'utf8');
  const row = { id: 'undetected', issue: 'APP_HOST is ignored', files: { 'src/service.py': source }, gold: ['src/service.py'] };
  for (const input of [row, { ...row, bindingMentions: ['APP_HOST'] }]) {
    const result = await evaluateConfigSlice([input]);
    expect(result).toMatchObject({ issues: 1, candidateIssues: 1, sliceIssues: 1, detectedSliceIssues: 0, share: 1 });
    expect(result.before_F_at_5).toBeTypeOf('number');
    expect(result.after_F_at_5).toBe(result.before_F_at_5);
  }
});

it('uses independent labels for negative controls and mentions the candidate extractor misses', async () => {
  const files = { 'src/service.py': 'def boot():\n    return 1\n' };
  const result = await evaluateConfigSlice([
    { id: 'negative', issue: 'HTTP response has an error', files, gold: ['src/service.py'], bindingMentions: [] },
    { id: 'positive', issue: 'the host value is ignored', files, gold: ['src/service.py'], bindingMentions: ['host'] },
  ]);
  expect(result).toMatchObject({ issues: 2, sliceIssues: 1, share: 0.5, sliceDefinition: 'independently labeled binding mentions' });
  expect(result.details.map((r: { id: string }) => r.id)).toEqual(['positive']);
});

it('measures the fixture slice before/after and checks negative-control graph edges', () => {
  const cwd = fileURLToPath(new URL('../../../', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'scripts/ranking-eval/config-slice.mjs', '--fixtures'], { cwd, encoding: 'utf8', timeout: 20_000 }));
  expect(result.corpus).toContain('not the localization benchmark');
  expect(result.issues).toBe(5);
  expect(result.sliceIssues).toBe(4);
  expect(result.share).toBe(0.8);
  expect(result.before_F_at_5).toBe(0);
  expect(result.after_F_at_5).toBe(1);
  expect(result.precision.testedEdges).toBeGreaterThan(0);
  expect(result.precision.negativeControlEdges).toBe(0);
});
