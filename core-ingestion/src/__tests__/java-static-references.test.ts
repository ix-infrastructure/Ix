// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult, type FileParseResult } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';

const parse = (file: string, source: string): FileParseResult => {
  const result = parseFile(`/repo/${file}`, source)!;
  expect(result).not.toBeNull();
  expect(result.hasParseErrors).toBeUndefined();
  return result;
};

function graph(files: FileParseResult[], resolved = resolveEdges(files)) {
  const patches = files.map(file => buildPatchWithResolution(file, 'hash', 'workspace', resolved));
  const names = new Map<string, string>();
  patches.forEach((patch, i) => {
    for (const op of patch.ops) {
      if (op.type === 'UpsertNode') names.set(op.id, `${files[i].filePath}::${op.name}`);
    }
  });
  return patches.flatMap(patch => patch.ops.flatMap(op => op.type === 'UpsertEdge'
    ? [{ src: names.get(op.src), dst: names.get(op.dst), predicate: op.predicate }]
    : []));
}

const gate = (pkg = 'demo.a') => parse(`${pkg.replaceAll('.', '/')}/Gate.java`, `package ${pkg};
public final class Gate {
  private Gate() {}
  public static boolean matches(String request) { return request != null; }
  public static boolean matches(Integer request) { return request != null; }
}`);

describe('Java static receiver class references (#1137)', () => {
  it.each([
    ['same package', 'demo.a', ''],
    ['single-type import', 'demo.b', 'import demo.a.Gate;'],
    ['wildcard import', 'demo.b', 'import demo.a.*;'],
  ])('writes a method call and a reference to the class via %s', (_label, pkg, imports) => {
    const use = parse('Evaluator.java', `package ${pkg};
${imports}
public class Evaluator {
  public void evaluate(String request) {
    if (!Gate.matches(request)) throw new IllegalStateException("context is empty.");
    Gate.matches(request);
  }
  public void evaluate(Integer request) {
    Gate.matches(request);
  }
}`);
    const edges = graph([gate(), use]);
    const src = '/repo/Evaluator.java::evaluate';
    expect(edges).toContainEqual({ src, dst: '/repo/demo/a/Gate.java::matches', predicate: 'CALLS' });
    expect(edges.filter(edge => edge.src === src && edge.predicate === 'REFERENCES')).toEqual([
      { src, dst: '/repo/demo/a/Gate.java::Gate', predicate: 'REFERENCES' },
    ]);
  });

  it('references a static-only class declared in the same file', () => {
    const file = parse('Evaluator.java', `package demo.a;
final class Gate { static boolean matches() { return true; } }
class Evaluator {
  void evaluate() { Gate.matches(); }
}`);
    expect(graph([file])).toContainEqual({
      src: '/repo/Evaluator.java::evaluate', dst: '/repo/Evaluator.java::Gate', predicate: 'REFERENCES',
    });
  });

  it.each([
    ['demo.a', '', 'demo.a'],
    ['demo.a', 'import demo.b.Gate;', 'demo.b'],
    ['demo.c', 'import demo.b.*;', 'demo.b'],
  ])('resolves the receiver class by package/import scope: %s %s', (pkg, imports, target) => {
    const use = parse('Evaluator.java', `package ${pkg};
${imports}
class Evaluator {
  void evaluate() { Gate.matches("request"); }
}`);
    expect(graph([gate(), gate('demo.b'), use]).filter(edge => edge.predicate === 'REFERENCES')).toEqual([
      { src: '/repo/Evaluator.java::evaluate', dst: `/repo/${target.replaceAll('.', '/')}/Gate.java::Gate`, predicate: 'REFERENCES' },
    ]);
  });

  it('does not resolve a receiver class outside the caller package/import scope', () => {
    const use = parse('Evaluator.java', `package demo.b;
class Evaluator {
  void evaluate() { Gate.matches("request"); }
}`);
    expect(graph([gate(), use]).filter(edge => edge.predicate === 'REFERENCES')).toEqual([]);
  });

  it('resolves against summaries when the receiver class is in another ingestion batch', () => {
    const use = parse('Evaluator.java', `package demo.a;
class Evaluator {
  void evaluate() { Gate.matches("request"); }
}`);
    const files = [gate(), use];
    const summaries = new Map(files.map(file => [file.filePath, summarizeParseResult(file)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], summaries);
    expect(graph(files, resolveEdges([use], undefined, index))).toEqual(graph(files));
  });

  it('keeps one class edge when an annotation and static call name the same type', () => {
    const use = parse('Evaluator.java', `package demo.a;
class Evaluator {
  void evaluate(Gate unused) { Gate.matches("request"); }
}`);
    expect(graph([gate(), gate('demo.b'), use]).filter(edge => edge.predicate === 'REFERENCES')).toEqual([
      { src: '/repo/Evaluator.java::evaluate', dst: '/repo/demo/a/Gate.java::Gate', predicate: 'REFERENCES' },
    ]);
  });

  it.each([
    'Object Gate = null; Gate.toString();',
    'Gate Gate = null; Gate.matches(null);',
    'var Gate = unknown(); Gate.matches(null);',
    'this.evaluate(); evaluate();',
  ])('does not infer a class reference from a bound or implicit receiver: %s', body => {
    const use = parse('Evaluator.java', `package demo.a;
class Evaluator {
  void evaluate() { ${body} }
}`);
    // A declaration's type reference is legitimate; the call must add none.
    const declarationOnly = parse('Evaluator.java', `package demo.a;
class Evaluator {
  void evaluate() { ${body.split(';')[0]}; }
}`);
    expect(use.relationships.filter(rel => rel.predicate === 'REFERENCES'))
      .toEqual(declarationOnly.relationships.filter(rel => rel.predicate === 'REFERENCES'));
  });
});
