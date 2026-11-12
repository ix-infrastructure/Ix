// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult } from '../index.js';
import { buildPatchWithResolution, symbolNodeId } from '../patch-builder.js';

const cases = [
  ['calc.ts', 'behavior.test.ts', 'double', 'behavior.test.ts'],
  ['calc.js', 'behavior.spec.js', 'doubleJs', 'behavior.spec.js'],
  ['calc.py', 'test_behavior.py', 'double', 'test_doubles'],
  ['calc.go', 'behavior_test.go', 'Double', 'TestDoubles'],
  ['Calc.java', 'src/test/BehaviorTest.java', 'Calc.twice', 'BehaviorTest.doubles'],
  ['ScalaCalc.scala', 'BehaviorSpec.scala', 'ScalaCalc.twice', 'BehaviorSpec.scala'],
];

describe('TESTS edges from real source fixtures', () => {
  it.each(cases)('%s is exercised by %s', (production, test, target, source) => {
    const files = [production, test].map(file => parseFile(file,
      readFileSync(new URL(`../../test-fixtures/test-reach/${/\.[jt]s$/.test(file) && /\.(test|spec)\./.test(file) ? file + '.fixture' : file}`, import.meta.url), 'utf8'))!);
    expect(files.every(Boolean)).toBe(true);
    const edges = resolveEdges(files);
    const patch = buildPatchWithResolution(files[1], 'hash', 'ws', edges);
    const tests = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'TESTS');
    expect(tests).toContainEqual(expect.objectContaining({
      src: symbolNodeId('ws', test, source), dst: symbolNodeId('ws', production, target),
      attrs: expect.objectContaining({ via: 'CALLS', confidence: expect.any(Number) }),
    }));
    expect(tests.every(op => Number(op.attrs?.confidence) > 0 && Number(op.attrs?.confidence) <= 1)).toBe(true);
    const prodPatch = buildPatchWithResolution(files[0], 'hash', 'ws', edges);
    expect(prodPatch.ops.some(op => op.predicate === 'TESTS')).toBe(false);
  });

  it('keeps framework-only test destinations out of TESTS, also with stored summaries', () => {
    const load = (file: string) => parseFile(file, readFileSync(new URL(`../../test-fixtures/test-reach/${file}.fixture`, import.meta.url), 'utf8'))!;
    const checks = load('checks.ts');
    const driver = load('driver.test.ts');
    expect(checks.entities.find(e => e.kind === 'file')?.isTest).toBe(true);
    const index = buildGlobalResolutionIndex([checks.filePath], undefined, undefined,
      new Map([[checks.filePath, summarizeParseResult(checks)]]));
    const edges = resolveEdges([driver], undefined, index);
    expect(edges.some(e => e.dstFilePath === checks.filePath && e.dstIsTest)).toBe(true);
    const patch = buildPatchWithResolution(driver, 'hash', 'ws', edges);
    expect(patch.ops.some(op => op.predicate === 'TESTS')).toBe(false);
  });

  it('ignores framework calls in comments and strings', () => {
    const source = readFileSync(new URL('../../test-fixtures/test-reach/examples.ts.fixture', import.meta.url), 'utf8');
    const parsed = parseFile('examples.ts', source)!;
    expect(parsed.entities.some(e => e.isTest)).toBe(false);
  });

  it('marks decorated pytest methods and annotation-only JUnit methods', () => {
    const py = parseFile('test_cases.py', readFileSync(new URL('../../test-fixtures/test-reach/test_cases.py', import.meta.url), 'utf8'))!;
    expect(py.entities.find(e => e.name === 'test_cases')?.isTest).toBe(true);
    const java = parseFile('Checks.java', readFileSync(new URL('../../test-fixtures/test-reach/Checks.java', import.meta.url), 'utf8'))!;
    expect(java.entities.find(e => e.name === 'verifiesArithmetic')?.isTest).toBe(true);
  });

  it('does not bind Go functions from a different directory or package', () => {
    const source = readFileSync(new URL('../../test-fixtures/test-reach/calc.go', import.meta.url), 'utf8');
    const test = parseFile('behavior_test.go', readFileSync(new URL('../../test-fixtures/test-reach/behavior_test.go', import.meta.url), 'utf8'))!;
    for (const other of [parseFile('other/calc.go', source)!, parseFile('calc.go', source.replace('package arithmetic', 'package unrelated'))!]) {
      expect(resolveEdges([test, other]).some(e => e.dstName === 'arithmetic.Double')).toBe(false);
    }
  });
});
