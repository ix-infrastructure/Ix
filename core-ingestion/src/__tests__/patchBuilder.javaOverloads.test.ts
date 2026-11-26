// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';
import type { PatchOp } from '../types.js';

/**
 * Java overloads share a name and a class, so they used to share one node id:
 * the first overload's lines, holding every overload's calls (#1139).
 */

const OVER = [
  'package demo;',
  '',
  'class Over {',
  '  void handle(String s) {',
  '    First.one();',
  '  }',
  '',
  '  void handle(int n) {',
  '    Second.two();',
  '  }',
  '',
  '  <T extends Comparable<T>> void handle(java.util.List<String> xs, T bound, int[] ns, Object... rest) {',
  '    Third.three();',
  '  }',
  '',
  '  void run() {',
  '    handle(1);',
  '  }',
  '}',
  '',
].join('\n');

const callee = (cls: string, method: string) =>
  [`package demo;`, ``, `class ${cls} {`, `  static void ${method}() {}`, `}`, ``].join('\n');

function parse(filePath: string, source: string): FileParseResult {
  const result = parseFile(filePath, source, { budgetMs: 0 });
  expect(result).not.toBeNull();
  return result!;
}

function build(results: FileParseResult[]) {
  const resolved = resolveEdges(results);
  return results.map((r) => buildPatchWithResolution(r, `hash:${r.filePath}`, 'ws', resolved));
}

type NodeOp = Extract<PatchOp, { type: 'UpsertNode' }>;
type EdgeOp = Extract<PatchOp, { type: 'UpsertEdge' }>;

describe('Java overloads (#1139)', () => {
  const results = [
    parse('demo/Over.java', OVER),
    parse('demo/First.java', callee('First', 'one')),
    parse('demo/Second.java', callee('Second', 'two')),
    parse('demo/Third.java', callee('Third', 'three')),
  ];
  const patches = build(results);
  const over = patches[0];
  const nodes = over.ops.filter((op): op is NodeOp => op.type === 'UpsertNode');
  const edges = over.ops.filter((op): op is EdgeOp => op.type === 'UpsertEdge');
  const nodeName = new Map<string, string>();
  for (const p of patches) for (const op of p.ops) if (op.type === 'UpsertNode') nodeName.set(op.id, op.name);

  const handles = nodes.filter((n) => n.name === 'handle' && n.kind === 'method');

  it('gives each overload with a different signature its own node and lines', () => {
    expect(handles.map((n) => [n.attrs.line_start, n.attrs.line_end])).toEqual([[4, 6], [8, 10], [12, 14]]);
    expect(new Set(handles.map((n) => n.id)).size).toBe(3);
  });

  it('keys overloads after the first by their erased parameter types', () => {
    const entities = results[0].entities.filter((e) => e.name === 'handle');
    expect(entities.map((e) => e.signature)).toEqual([undefined, '(int)', '(List,Comparable,int[],Object[])']);
    const chunks = results[0].chunks.filter((c) => c.name === 'handle');
    expect(chunks.map((c) => c.signature)).toEqual([undefined, '(int)', '(List,Comparable,int[],Object[])']);
  });

  it('attributes each call to the overload that makes it', () => {
    const callsFrom = (src: string) => edges
      .filter((e) => e.predicate === 'CALLS' && e.src === src)
      .map((e) => nodeName.get(e.dst));
    expect(handles.map((n) => callsFrom(n.id))).toEqual([['one'], ['two'], ['three']]);
  });

  it('links every overload to its class and its own chunk', () => {
    const cls = nodes.find((n) => n.name === 'Over' && n.kind === 'class')!;
    const contained = edges.filter((e) => e.predicate === 'CONTAINS' && e.src === cls.id).map((e) => e.dst);
    for (const h of handles) expect(contained).toContain(h.id);
    const defined = edges.filter((e) => e.predicate === 'DEFINES').map((e) => e.dst);
    for (const h of handles) expect(defined.filter((d) => d === h.id)).toHaveLength(1);
  });

  it('still lands a same-file call to the name on the first overload', () => {
    const run = nodes.find((n) => n.name === 'run')!;
    const calls = edges.filter((e) => e.predicate === 'CALLS' && e.src === run.id).map((e) => e.dst);
    expect(calls).toEqual([handles[0].id]);
  });

  it('keeps the ids of the first overload and of non-overloaded methods', () => {
    const before = build([parse('demo/Over.java', OVER.replace(/\n {2}void handle\(int n\)[\s\S]*?\n {2}}\n\n {2}<T[\s\S]*?\n {2}}\n/, '\n'))])[0];
    const ids = new Set(before.ops.filter((op): op is NodeOp => op.type === 'UpsertNode').map((op) => op.id));
    expect(ids.has(handles[0].id)).toBe(true);
    expect(ids.has(nodes.find((n) => n.name === 'run')!.id)).toBe(true);
  });

  it('keeps overloads with the same erased signature on one node', () => {
    const source = [
      'class Same {',
      '  <T> void put(T value) { A.a(); }',
      '  void put(Object value) { B.b(); }',
      '  void put(java.util.List<String> xs) {}',
      '  void put(List<Integer> xs) {}',
      '}',
      '',
    ].join('\n');
    const result = parse('Same.java', source);
    expect(result.entities.filter((e) => e.name === 'put').map((e) => e.signature)).toEqual([undefined, undefined, '(List)', '(List)']);
    const puts = buildPatchWithResolution(result, 'h', 'ws', resolveEdges([result])).ops
      .filter((op): op is NodeOp => op.type === 'UpsertNode' && op.name === 'put' && op.kind === 'method');
    expect(puts.map((n) => n.attrs.line_start)).toEqual([2, 4]);
  });

  it('leaves constructors keyed as before', () => {
    // A constructor has no container, so it shares the class's key; giving
    // constructor overloads their own nodes is a separate change.
    const source = [
      'class Box {',
      '  Box() { this(0); }',
      '  Box(int size) { Alloc.make(); }',
      '}',
      '',
    ].join('\n');
    const result = parse('Box.java', source);
    expect(result.entities.filter((e) => e.name === 'Box').map((e) => e.signature)).toEqual([undefined, undefined, undefined]);
    expect(result.relationships.filter((r) => r.predicate === 'CONTAINS').map((r) => r.dstName)).toEqual(['Box', 'Box', 'Box']);
  });
});
