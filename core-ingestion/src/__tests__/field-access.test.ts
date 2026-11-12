// Copyright 2026 Ix Infrastructure Inc.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFile, resolveCallEdges, resolveEdges, summarizeParseResult, buildGlobalResolutionIndex } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';

const fixture = (file: string) => parseFile(file, readFileSync(new URL(`../../test-fixtures/field-access/${file}`, import.meta.url), 'utf8'))!;
const access = (p: string) => p === 'READS' || p === 'WRITES';

describe('field def-use', () => {
  it.each(['order.ts', 'order.js', 'order.py', 'order.go', 'Order.java'])('%s emits exact field endpoints and all sites (golden)', file => {
    const parsed = fixture(file);
    expect(parsed.hasParseErrors).toBeUndefined();
    const edges = resolveEdges([parsed]).filter(e => access(e.predicate));
    expect(edges.length).toBeGreaterThan(0);
    const ops = buildPatchWithResolution(parsed, 'hash', 'ws', edges).ops;
    const names = new Map(ops.filter(op => op.type === 'UpsertNode').map(op => [op.id, op.name]));
    const uses = ops.filter(op => op.type === 'UpsertEdge' && access(String(op.predicate)))
      .map(op => ({ src: names.get(op.src), dst: names.get(op.dst), predicate: op.predicate, attrs: op.attrs }));
    expect(uses.length).toBeGreaterThan(0);
    expect(uses).toMatchSnapshot();
    expect(edges.some(e => /unknown/.test(e.srcName))).toBe(false);
    expect(uses.every(op => Array.isArray((op.attrs as any).sites) && (op.attrs as any).sites.every((s: any) => s.line > 0))).toBe(true);
    expect(JSON.stringify(uses)).toContain('SHIPPED');
    const summaries = new Map([[parsed.filePath, summarizeParseResult(parsed)]]);
    const index = buildGlobalResolutionIndex([parsed.filePath], undefined, undefined, summaries);
    expect(resolveEdges([parsed], undefined, index).filter(e => access(e.predicate))).toEqual(edges);
  });
});


describe('conservative field resolution', () => {
  it('resolves imported aliases and keeps every transition through stored summaries', () => {
    const model = fixture('order.ts');
    const use = fixture('use.ts');
    const edges = resolveEdges([model, use]).filter(e => access(e.predicate) && e.srcFilePath === use.filePath);
    expect(edges).toHaveLength(2);
    expect(edges.every(e => e.dstFilePath === model.filePath && e.dstQualifiedKey === 'Order.status')).toBe(true);
    const summaries = new Map([model, use].map(p => [p.filePath, summarizeParseResult(p)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([use], undefined, index).filter(e => access(e.predicate))).toEqual(edges);
    const writes = buildPatchWithResolution(use, 'hash', 'ws', edges).ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'WRITES');
    expect(writes).toHaveLength(1);
    expect((writes[0].attrs as any).sites).toEqual([
      { line: 3, value: '"DONE"', value_kind: 'literal' },
      { line: 4, value: '"ARCHIVED"', value_kind: 'literal' },
    ]);
    expect(summarizeParseResult(use).refs).toContain('Purchase');
  });
  it.each(['shadow.py', 'shadow.ts'])('%s rejects shadowed/reassigned/unknown receivers and method destinations', file => {
    const parsed = fixture(file);
    expect(parsed.hasParseErrors).toBeUndefined();
    const edges = resolveEdges([parsed]).filter(e => access(e.predicate));
    expect(edges.filter(e => /shadow|reassigned|unknown|propertyNamedMethod/.test(e.srcName))).toEqual([]);
    if (file.endsWith('.ts')) {
      const writes = parsed.relationships.filter(r => r.predicate === 'WRITES' && r.srcName === 'Order.ship');
      expect(writes).toHaveLength(1);
      expect(writes[0].fieldSites).toEqual([{ line: 7 }, { line: 8 }]);
    }
  });
  it('Java implicit fields distinguish parameter shadowing and read-modify-write', () => {
    const parsed = fixture('Implicit.java');
    const edges = resolveEdges([parsed]).filter(e => access(e.predicate));
    expect(parsed.relationships.find(r => r.srcName === 'Implicit.ship' && r.predicate === 'READS' && r.dstName === 'Implicit.status')?.fieldSites).toEqual([{ line: 10 }, { line: 11 }, { line: 12 }]);
    expect(edges.map(e => `${e.srcName} ${e.predicate} ${e.dstQualifiedKey}`).sort()).toEqual([
      'Implicit.<init> WRITES Implicit.status',
      'Implicit.ship READS Implicit.count',
      'Implicit.ship READS Implicit.status',
      'Implicit.ship WRITES Implicit.count',
      'Implicit.ship WRITES Implicit.status',
    ]);
  });
  it.each([
    ['order.py', 'use.py', 'Order.status'],
    ['order.go', 'use.go', 'Order.Status'],
    ['shop/Model.java', 'Use.java', 'Model.status'],
  ])('%s fields resolve across files and stored summaries', (modelFile, useFile, key) => {
    const model = fixture(modelFile), use = fixture(useFile);
    const all = resolveEdges([model, use]);
    const edges = all.filter(e => access(e.predicate) && e.srcFilePath === use.filePath);
    expect(edges.map(e => e.predicate).sort()).toEqual(['READS', 'WRITES']);
    expect(edges.every(e => e.dstQualifiedKey === key && e.dstFilePath === model.filePath)).toBe(true);
    const summaries = new Map([model, use].map(p => [p.filePath, summarizeParseResult(p)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([use], undefined, index).filter(e => access(e.predicate))).toEqual(edges);
  });
  it('fields never become call targets and same-line methods keep their own accesses', () => {
    const parsed = fixture('collision.ts');
    const edges = resolveEdges([parsed]);
    const writes = edges.filter(e => e.predicate === 'WRITES');
    expect(writes.map(e => [e.srcName, e.dstQualifiedKey])).toEqual([
      ['First.run', 'First.status'], ['Second.run', 'Second.status'],
    ]);
    const ops = buildPatchWithResolution(parsed, 'hash', 'ws', edges).ops;
    expect(ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
    expect(summarizeParseResult(parsed).qkeys.some(([n]) => n === 'status')).toBe(false);
  });

  it('inherited TS fields keep the declaring owner and callback invocations read the field', () => {
    const parsed = fixture('inherited.ts');
    const edges = resolveEdges([parsed]).filter(e => access(e.predicate));
    expect(edges.map(e => [e.predicate, e.dstQualifiedKey])).toEqual([
      ['WRITES', 'Base.status'], ['READS', 'Base.callback'], ['READS', 'Base.status'],
    ]);
    expect(parsed.entities).toContainEqual(expect.objectContaining({ kind: 'field', container: 'Child', name: 'label' }));
  });

  it('the deprecated call-only API never presents field accesses as calls', () => {
    expect(resolveCallEdges([fixture('order.ts')]).some(e => /\.(status|count)$/.test(e.calleeQualifiedKey))).toBe(false);
  });

  it('merges sites when two type aliases resolve to the same field edge', () => {
    const model = fixture('order.ts'), use = fixture('aliases.ts');
    const edges = resolveEdges([model, use]);
    const writes = buildPatchWithResolution(use, 'hash', 'ws', edges).ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'WRITES');
    expect(writes).toHaveLength(1);
    expect((writes[0].attrs as any).sites).toEqual([
      { line: 3, value: '"DONE"', value_kind: 'literal' },
      { line: 4, value: '"ARCHIVED"', value_kind: 'literal' },
    ]);
  });

  it('keeps distinct Java receiver chains separate until their owners resolve', () => {
    const parsed = fixture('Chains.java');
    const edges = resolveEdges([parsed]).filter(e => e.predicate === 'WRITES');
    expect(edges.map(e => e.dstQualifiedKey)).toEqual(['Alpha.status', 'Beta.status']);
    const writes = buildPatchWithResolution(parsed, 'hash', 'ws', edges).ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'WRITES');
    expect(writes.map(op => (op.attrs as any).sites)).toEqual([
      [{ line: 9, value: '"A"', value_kind: 'literal' }],
      [{ line: 10, value: '"B"', value_kind: 'literal' }],
    ]);
  });

});
