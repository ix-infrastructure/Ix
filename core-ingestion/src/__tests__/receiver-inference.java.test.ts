// Copyright 2026 Ix Infrastructure Inc.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult, type FileParseResult } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/java-receivers');

const parse = (filePath: string, source: string): FileParseResult => {
  const result = parseFile(filePath, source)!;
  expect(result).not.toBeNull();
  expect(result.hasParseErrors).toBeUndefined();
  return result;
};

function fixture(): FileParseResult[] {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  return walk(FIXTURE).filter(f => f.endsWith('.java')).sort()
    .map(f => parse(`/repo/${path.relative(FIXTURE, f).split(path.sep).join('/')}`, fs.readFileSync(f, 'utf8')));
}

/** Every CALLS edge the patches write, as `file::name` of both ends. */
function callEdges(results: FileParseResult[], edges = resolveEdges(results)): Array<{ src: string; dst: string; tier?: string }> {
  const patches = results.map(r => buildPatchWithResolution(r, 'hash', 'workspace', edges));
  const names = new Map<string, string>();
  results.forEach((r, i) => {
    for (const op of patches[i].ops as any[]) if (op.type === 'UpsertNode') names.set(op.id, `${r.filePath.replace('/repo/', '')}::${op.name}`);
  });
  return patches.flatMap(p => (p.ops as any[]).filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')
    .map(op => ({ src: names.get(op.src) ?? op.src, dst: names.get(op.dst) ?? op.dst, tier: op.attrs?.tier })));
}

const typedEdges = (edges: ReturnType<typeof resolveEdges>, srcName?: string) =>
  edges.filter(e => e.tier === 'type' && (srcName === undefined || e.srcName === srcName));

// Provider and caller in different packages; `Other` declares a same-named member.
const provider = (extra = '') => [
  parse('/repo/p/Target.java', `package p;\npublic class Target {\n  public void run() {}\n  public Target self() { return this; }\n${extra}}\n`),
  parse('/repo/p/Other.java', 'package p;\npublic class Other {\n  public void run() {}\n}\n'),
];
const caller = (body: string, members = '') => parse('/repo/q/Use.java',
  `package q;\nimport p.Target;\nimport p.Other;\nimport java.util.List;\npublic class Use {\n${members}  void use(Target param, List<Target> list) {\n    ${body}\n  }\n}\n`);

describe('Java typed receivers (fixture)', () => {
  const results = fixture();
  const edges = resolveEdges(results);

  it('resolves a member call through a typed local, parameter, field and this.field to the declared class', () => {
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstName: 'URL.getMethodParameter',
      dstFilePath: '/repo/com/acme/common/URL.java', dstQualifiedKey: 'URL.getMethodParameter', tier: 'type', confidence: 0.95,
    }));
  });

  it('resolves a call through an interface-typed field to the interface method', () => {
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstFilePath: '/repo/com/acme/common/Node.java', dstQualifiedKey: 'Node.isAvailable', tier: 'type',
    }));
  });

  it('resolves a method only a superclass declares, two levels up', () => {
    // `var service = new ServiceUrl(..)`: ServiceUrl -> URL -> AbstractURL.
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstName: 'ServiceUrl.getProtocol',
      dstFilePath: '/repo/com/acme/common/AbstractURL.java', dstQualifiedKey: 'AbstractURL.getProtocol', tier: 'type',
    }));
  });

  it('resolves super.m() to the superclass, never the overriding method itself', () => {
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'ServiceUrl.getMethodParameter', dstFilePath: '/repo/com/acme/common/URL.java', dstQualifiedKey: 'URL.getMethodParameter', tier: 'type',
    }));
    expect(callEdges(results, edges)).not.toContainEqual(expect.objectContaining({
      src: 'com/acme/rpc/ServiceUrl.java::getMethodParameter', dst: 'com/acme/rpc/ServiceUrl.java::getMethodParameter',
    }));
  });

  it('resolves this.m() and a bare m() through the enclosing class and its supertypes', () => {
    expect(typedEdges(edges, 'ServiceUrl.describe').map(e => e.dstQualifiedKey).sort()).toEqual(['AbstractURL.getProtocol', 'URL.getHost']);
    expect(edges).toContainEqual(expect.objectContaining({ srcName: 'URL.isAvailable', dstQualifiedKey: 'URL.getMethodParameter', tier: 'type' }));
  });

  it('resolves static Type.m() calls on an imported and a same-package class', () => {
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstName: 'URL.valueOf', dstQualifiedKey: 'URL.valueOf', tier: 'type',
    }));
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstName: 'RpcUtils.methodName',
      dstFilePath: '/repo/com/acme/rpc/RpcUtils.java', dstQualifiedKey: 'RpcUtils.methodName', tier: 'type',
    }));
  });

  it('resolves a chained call through the declared return type of the first call', () => {
    // `invoker.getUrl()` is Invoker.getUrl, declared to return URL.
    expect(edges).toContainEqual(expect.objectContaining({
      srcName: 'TimeoutFilter.invoke', dstName: 'Invoker.getUrl().getMethodParameter',
      dstFilePath: '/repo/com/acme/common/URL.java', dstQualifiedKey: 'URL.getMethodParameter', tier: 'type',
    }));
  });

  it('writes one edge per caller to a method with several overloads', () => {
    const toUrl = callEdges(results, edges).filter(e => e.src === 'com/acme/rpc/TimeoutFilter.java::invoke' && e.dst === 'com/acme/common/URL.java::getMethodParameter');
    expect(toUrl).toEqual([{ src: 'com/acme/rpc/TimeoutFilter.java::invoke', dst: 'com/acme/common/URL.java::getMethodParameter', tier: 'type' }]);
  });

  it('no longer lets the same-file method claim calls typed as another class', () => {
    const calls = callEdges(results, edges);
    expect(calls).not.toContainEqual(expect.objectContaining({
      src: 'com/acme/rpc/TimeoutFilter.java::invoke', dst: 'com/acme/rpc/TimeoutFilter.java::getMethodParameter',
    }));
  });

  it('keeps every CALLS edge the name-based resolution wrote before, except the corrected same-file ones', () => {
    // What resolution wrote for this fixture before Java receivers were inferred.
    const before: Array<[string, string]> = [
      ['com/acme/common/URL.java::isAvailable', 'com/acme/common/URL.java::getMethodParameter'],
      ['com/acme/common/URL.java::valueOf', 'com/acme/common/URL.java::URL'],
      ['com/acme/rpc/ServiceUrl.java::describe', 'com/acme/common/AbstractURL.java::getProtocol'],
      ['com/acme/rpc/ServiceUrl.java::describe', 'com/acme/common/URL.java::getHost'],
      ['com/acme/rpc/TimeoutFilter.java::invoke', 'com/acme/common/AbstractURL.java::getProtocol'],
      ['com/acme/rpc/TimeoutFilter.java::invoke', 'com/acme/common/URL.java::valueOf'],
      ['com/acme/rpc/TimeoutFilter.java::invoke', 'com/acme/rpc/Invoker.java::getUrl'],
      ['com/acme/rpc/TimeoutFilter.java::invoke', 'com/acme/rpc/RpcUtils.java::methodName'],
      ['com/acme/rpc/TimeoutFilter.java::invoke', 'com/acme/rpc/ServiceUrl.java::ServiceUrl'],
    ];
    const now = new Set(callEdges(results, edges).map(e => `${e.src} -> ${e.dst}`));
    for (const [src, dst] of before) expect(now).toContain(`${src} -> ${dst}`);
  });

  it('resolves a batch against summaries exactly as the full run does', () => {
    const summaries = new Map(results.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], summaries);
    const filter = results.find(r => r.filePath.endsWith('TimeoutFilter.java'))!;
    expect(resolveEdges([filter], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === filter.filePath));
  });

  it('gives no typed edge, and no error, against summaries written without Java receiver facts', () => {
    const summaries = new Map(results.map(r => {
      const { receiverFactories: _f, receiverHeritage: _h, receiverPackage: _p, ...old } = summarizeParseResult(r);
      return [r.filePath, old];
    }));
    const index = buildGlobalResolutionIndex([...summaries.keys()], summaries);
    const filter = results.find(r => r.filePath.endsWith('TimeoutFilter.java'))!;
    const batch = resolveEdges([filter], undefined, index);
    expect(typedEdges(batch)).toEqual([]);
    // The name-based edges are the ones resolution writes without receiver types.
    const untyped = { ...filter, relationships: filter.relationships.filter(r => !r.receiverOnly), receiverTypedCalls: undefined };
    expect(batch).toEqual(resolveEdges([untyped], undefined, index));
  });
});

describe('Java typed receivers', () => {
  it.each([
    ['a local', 'Target t = new Target(); t.run();'],
    ['a var local', 'var t = new Target(); t.run();'],
    ['a parameter', 'param.run();'],
    ['an enhanced-for variable', 'for (Target t : list) { t.run(); }'],
    ['a catch parameter', 'try { } catch (Target e) { e.run(); }'],
    ['a try resource', 'try (Target t = new Target()) { t.run(); }'],
    ['a cast', '((Target) list.get(0)).run();'],
    ['a typed lambda parameter', 'list.forEach((Target t) -> t.run());'],
    ['a field', 'field.run();', '  private Target field;\n'],
    ['this.field', 'this.field.run();', '  private Target field;\n'],
    ['a reassigned local (its declared type stays)', 'Target t = null; t = param; t.run();'],
  ])('resolves a call through %s', (_label, body, members = '') => {
    const files = [...provider(), caller(body, members)];
    expect(typedEdges(resolveEdges(files), 'Use.use')).toEqual([expect.objectContaining({
      dstFilePath: '/repo/p/Target.java', dstQualifiedKey: 'Target.run', tier: 'type',
    })]);
  });

  it.each([
    ['a lambda parameter', 'list.forEach(field -> field.run());'],
    ['a var local of unknown type', 'var field = list.get(0); field.run();'],
    ['a pattern variable', 'Object o = param; if (o instanceof Other field) { field.run(); }'],
  ])('gives no typed edge when %s shadows a typed field', (_label, body) => {
    const files = [...provider(), caller(body, '  private Target field;\n')];
    expect(typedEdges(resolveEdges(files), 'Use.use')).toEqual([]);
  });

  it('gives no typed edge for a receiver whose type is not in the repository', () => {
    const files = [...provider(), caller('StringBuilder b = new StringBuilder(); b.run();')];
    const edges = resolveEdges(files);
    expect(typedEdges(edges)).toEqual([]);
    const use = files[2];
    expect(edges).toEqual(resolveEdges([...provider(), { ...use, relationships: use.relationships.filter(r => !r.receiverOnly), receiverTypedCalls: undefined }]));
  });

  it('gives no typed edge through a generic container element', () => {
    const files = [...provider(), caller('list.get(0).run(); for (var t : list) { t.run(); }')];
    expect(typedEdges(resolveEdges(files))).toEqual([]);
  });

  it('gives no typed edge for a receiver typed by a type parameter', () => {
    const files = [...provider(), parse('/repo/q/Box.java',
      'package q;\nimport p.Target;\npublic class Box<T extends Target> {\n  private T item;\n  <U extends Target> void use(U u) {\n    item.run();\n    u.run();\n  }\n}\n')];
    expect(typedEdges(resolveEdges(files))).toEqual([]);
  });

  it('gives no typed edge when two classes in scope share the simple name', () => {
    const files = [
      parse('/repo/a/Dup.java', 'package a;\npublic class Dup {\n  public void run() {}\n}\n'),
      parse('/repo/b/Dup.java', 'package b;\npublic class Dup {\n  public void run() {}\n}\n'),
      parse('/repo/q/Use.java', 'package q;\nimport a.*;\nimport b.*;\npublic class Use {\n  void use(Dup d) {\n    d.run();\n    Dup.run();\n  }\n}\n'),
    ];
    const edges = resolveEdges(files);
    expect(typedEdges(edges)).toEqual([]);
    const use = files[2];
    expect(edges).toEqual(resolveEdges([files[0], files[1], { ...use, relationships: use.relationships.filter(r => !r.receiverOnly), receiverTypedCalls: undefined }]));
  });

  it('prefers a single-type import over a same-named class in the package', () => {
    const files = [
      ...provider(),
      parse('/repo/q/Target.java', 'package q;\npublic class Target {\n  public void run() {}\n}\n'),
      caller('param.run();'),
    ];
    expect(typedEdges(resolveEdges(files), 'Use.use')).toEqual([expect.objectContaining({ dstFilePath: '/repo/p/Target.java' })]);
  });

  it('does not treat a lowercase or bound name as a static type receiver', () => {
    const files = [...provider(), caller('Object Target = null; Target.run();')];
    expect(typedEdges(resolveEdges(files), 'Use.use')).toEqual([]);
  });

  it('gives no typed edge for this.m() inside an anonymous class', () => {
    const files = [...provider(), parse('/repo/p/Use.java',
      'package p;\npublic class Use extends Target {\n  void use() {\n    new Object() {\n      void inner() { this.run(); run(); }\n    };\n  }\n}\n')];
    expect(typedEdges(resolveEdges(files))).toEqual([]);
  });

  it('stops a chain at a step whose result is not a class type', () => {
    const files = [...provider('  public int count() { return 0; }\n'), caller('param.self().run(); param.count().run();')];
    const edges = typedEdges(resolveEdges(files), 'Use.use');
    // `count()` itself resolves; nothing is chained through its int result.
    expect(edges.map(e => e.dstName).sort()).toEqual(['Target.count', 'Target.self', 'Target.self().run']);
  });

  it('keeps the same-file claim when the typed receiver does not resolve', () => {
    const use = parse('/repo/q/Use.java',
      'package q;\npublic class Use {\n  void run() {}\n  void use(Missing m) {\n    m.run();\n  }\n}\n');
    expect(callEdges([use])).toContainEqual(expect.objectContaining({ src: 'q/Use.java::use', dst: 'q/Use.java::run' }));
  });

  it('records heritage, package and class-returning method results as summary facts', () => {
    const result = fixture().find(r => r.filePath.endsWith('/URL.java'))!;
    expect(result.receiverPackage).toBe('com.acme.common');
    expect(result.receiverHeritage).toEqual([['URL', 'AbstractURL'], ['URL', 'Node']]);
    // The int overload blocks chaining through getMethodParameter.
    expect(result.receiverFactories).toEqual([
      ['URL.valueOf', 'URL'], ['URL.getMethodParameter', 'String'], ['URL.getMethodParameter', ''], ['URL.getHost', 'String'],
    ]);
    expect(summarizeParseResult(result)).toMatchObject({ receiverPackage: 'com.acme.common' });
  });
});

/** Every REFERENCES edge the patches write, as `file::name` of both ends. */
function referenceEdges(results: FileParseResult[], edges = resolveEdges(results)): Array<{ src: string; dst: string; tier?: string; confidence?: number }> {
  const patches = results.map(r => buildPatchWithResolution(r, 'hash', 'workspace', edges));
  const names = new Map<string, string>();
  results.forEach((r, i) => {
    for (const op of patches[i].ops as any[]) if (op.type === 'UpsertNode') names.set(op.id, `${r.filePath.replace('/repo/', '')}::${op.kind}:${op.name}`);
  });
  return patches.flatMap(p => (p.ops as any[]).filter(op => op.type === 'UpsertEdge' && op.predicate === 'REFERENCES')
    .map(op => ({ src: names.get(op.src) ?? op.src, dst: names.get(op.dst) ?? op.dst, tier: op.attrs?.tier, confidence: op.attrs?.confidence })));
}

const references = (edges: ReturnType<typeof resolveEdges>) => edges.filter(e => e.predicate === 'REFERENCES');
const staticRefs = (result: FileParseResult) => result.relationships.filter(r => r.predicate === 'REFERENCES' && r.receiverType);

// #1137: a class used only through static calls had no incoming edge.
describe('Java static-call receivers reference their class (#1137)', () => {
  const GATE = `package demo.a;

final class Gate {
    private Gate() {
    }

    static boolean matches(String request) {
        return request != null;
    }

    static boolean matches(Integer request) {
        return request != null;
    }
}
`;
  const EVALUATOR = `package demo.a;

public class Evaluator {
    public void evaluate(String request) {
        if (!Gate.matches(request)) {
            throw new IllegalStateException("context is empty.");
        }
    }

    public void evaluate(Integer request) {
        if (!Gate.matches(request)) {
            throw new IllegalStateException("context is empty.");
        }
    }
}
`;
  const gate = () => parse('/repo/demo/a/Gate.java', GATE);
  const evaluator = () => parse('/repo/demo/a/Evaluator.java', EVALUATOR);

  it('links the caller to a same-package class with no import, and writes the edge', () => {
    const files = [gate(), evaluator()];
    expect(staticRefs(files[1])).toEqual([
      { srcName: 'Evaluator.evaluate', dstName: 'Gate', predicate: 'REFERENCES', receiverType: 'Gate', receiverOnly: true },
    ]);
    const edges = resolveEdges(files);
    expect(references(edges)).toEqual([expect.objectContaining({
      srcFilePath: '/repo/demo/a/Evaluator.java', srcName: 'Evaluator.evaluate', dstName: 'Gate',
      dstFilePath: '/repo/demo/a/Gate.java', dstQualifiedKey: 'Gate', tier: 'type', confidence: 0.95,
    })]);
    // The class node, not its same-named constructor.
    expect(referenceEdges(files, edges)).toEqual([
      { src: 'demo/a/Evaluator.java::method:evaluate', dst: 'demo/a/Gate.java::class:Gate', tier: 'type', confidence: 0.95 },
    ]);
    // The method-to-method call is still there.
    expect(callEdges(files, edges)).toContainEqual(expect.objectContaining({ src: 'demo/a/Evaluator.java::evaluate', dst: 'demo/a/Gate.java::matches' }));
  });

  it('resolves the same way when the class is only in the index, not the batch', () => {
    const results = [gate(), evaluator()];
    const summaries = new Map(results.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], summaries);
    expect(summaries.get('/repo/demo/a/Evaluator.java')!.refs).toContain('Gate');
    expect(references(resolveEdges([results[1]], undefined, index))).toEqual([expect.objectContaining({
      dstFilePath: '/repo/demo/a/Gate.java', dstQualifiedKey: 'Gate', tier: 'type',
    })]);
  });

  it('resolves to the class key, for a top-level and a nested class with explicit constructors', () => {
    // A class and its constructor share one qualified key, so the name maps to a single key (what bestQKey needs).
    const outer = parse('/repo/demo/a/Outer.java',
      'package demo.a;\npublic class Outer {\n  public static class Inner {\n    Inner() {}\n    static void go() {}\n  }\n}\n');
    const use = parse('/repo/demo/a/Use.java',
      'package demo.a;\nimport demo.a.Outer.Inner;\npublic class Use {\n  void use() {\n    Gate.matches("x");\n    Inner.go();\n  }\n}\n');
    const qkeys = (r: FileParseResult, name: string) => [...new Set(summarizeParseResult(r).qkeys.filter(([n]) => n === name).map(([, key]) => key))];
    expect(qkeys(gate(), 'Gate')).toEqual(['Gate']);
    expect(qkeys(outer, 'Inner')).toEqual(['Outer.Inner']);
    const files = [gate(), outer, use];
    const edges = resolveEdges(files);
    expect(references(edges).map(e => [e.dstName, e.dstFilePath, e.dstQualifiedKey]).sort()).toEqual([
      ['Gate', '/repo/demo/a/Gate.java', 'Gate'],
      ['Inner', '/repo/demo/a/Outer.java', 'Outer.Inner'],
    ]);
    expect(referenceEdges(files, edges).map(e => e.dst).sort()).toEqual(['demo/a/Gate.java::class:Gate', 'demo/a/Outer.java::class:Inner']);
  });

  it('links a nested class in the same file', () => {
    const file = parse('/repo/demo/a/Host.java',
      'package demo.a;\npublic class Host {\n  void use() { Util.go(); }\n  static class Util {\n    static void go() {}\n  }\n}\n');
    expect(references(resolveEdges([file]))).toEqual([expect.objectContaining({
      srcName: 'Host.use', dstFilePath: '/repo/demo/a/Host.java', dstQualifiedKey: 'Host.Util', tier: 'type',
    })]);
    expect(referenceEdges([file])).toEqual([expect.objectContaining({ src: 'demo/a/Host.java::method:use', dst: 'demo/a/Host.java::class:Util' })]);
  });

  it('resolves an imported class in another package; a single-type import beats a same-package class', () => {
    const files = [
      parse('/repo/lib/Gate.java', 'package lib;\npublic final class Gate {\n  public static boolean matches(String s) { return true; }\n}\n'),
      gate(),
      parse('/repo/demo/a/Use.java', 'package demo.a;\nimport lib.Gate;\npublic class Use {\n  void use() { Gate.matches("x"); }\n}\n'),
    ];
    const edges = resolveEdges(files);
    expect(references(edges)).toEqual([expect.objectContaining({ srcName: 'Use.use', dstFilePath: '/repo/lib/Gate.java', dstQualifiedKey: 'Gate', tier: 'type' })]);
    expect(referenceEdges(files, edges)).toEqual([expect.objectContaining({ src: 'demo/a/Use.java::method:use', dst: 'lib/Gate.java::class:Gate' })]);
  });

  it('writes no edge when two on-demand imports both provide the class', () => {
    const dup = (pkg: string) => parse(`/repo/${pkg}/Dup.java`, `package ${pkg};\npublic class Dup {\n  public static void go() {}\n}\n`);
    const files = [dup('a'), dup('b'),
      parse('/repo/q/Use.java', 'package q;\nimport a.*;\nimport b.*;\npublic class Use {\n  void use() { Dup.go(); }\n}\n')];
    expect(staticRefs(files[2])).toHaveLength(1);
    const edges = resolveEdges(files);
    expect(references(edges)).toEqual([]);
    expect(referenceEdges(files, edges)).toEqual([]);
  });

  it('writes nothing for a receiver the repo does not define (JDK classes)', () => {
    const use = parse('/repo/q/Use.java',
      'package q;\nimport java.util.Objects;\npublic class Use {\n  int use(Object o) {\n    Objects.requireNonNull(o);\n    return Math.max(1, 2);\n  }\n}\n');
    expect(staticRefs(use).map(r => r.dstName).sort()).toEqual(['Math', 'Objects']);
    // A same-named class elsewhere in the repo is not in scope either.
    const elsewhere = parse('/repo/other/Objects.java', 'package other;\npublic class Objects {\n  public static void requireNonNull(Object o) {}\n}\n');
    const files = [use, elsewhere];
    const edges = resolveEdges(files);
    expect(references(edges)).toEqual([]);
    const ops = buildPatchWithResolution(use, 'hash', 'workspace', edges).ops as any[];
    expect(ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'REFERENCES')).toEqual([]);
    expect(JSON.stringify(ops)).not.toMatch(/references:(Math|Objects)/);
    // Identical to the patch of the same file without the receiver references.
    const stripped = { ...use, relationships: use.relationships.filter(r => !(r.predicate === 'REFERENCES' && r.receiverOnly)) };
    expect(ops).toEqual(buildPatchWithResolution(stripped, 'hash', 'workspace', edges).ops);
  });

  it('writes no edge when one file nests two classes of that name', () => {
    const file = parse('/repo/demo/a/Host.java',
      'package demo.a;\npublic class Host {\n  static class A { static class Util { static void go() {} } }\n  static class B { static class Util {} }\n  void use() { Util.go(); }\n}\n');
    expect(staticRefs(file)).toHaveLength(1);
    expect(references(resolveEdges([file]))).toEqual([]);
    expect(referenceEdges([file])).toEqual([]);
  });

  it('skips java.lang type names', () => {
    const use = parse('/repo/q/Use.java',
      'package q;\npublic class Use {\n  String use(int i) { return String.valueOf(Integer.parseInt("1") + i + Integer.MAX_VALUE); }\n  Object f() { return (java.util.function.Function<Object, String>) String::valueOf; }\n}\n');
    expect(staticRefs(use)).toEqual([]);
  });

  // Names the shared builtin list drops as type references (`List`, `Result`, `Map`).
  describe('a repo class with a builtin-listed name', () => {
    const list = (pkg: string) => parse(`/repo/${pkg.replace('.', '/')}/List.java`, `package ${pkg};\npublic final class List {\n  public static List of() { return null; }\n}\n`);
    const use = (imports: string) => parse('/repo/demo/a/Use.java', `package demo.a;\n${imports}public class Use {\n  Object use() { return List.of(); }\n}\n`);

    it('is referenced by a static use in its package', () => {
      const files = [list('demo.a'), use('')];
      expect(staticRefs(files[1])).toEqual([
        { srcName: 'Use.use', dstName: 'List', predicate: 'REFERENCES', receiverType: 'List', receiverOnly: true },
      ]);
      expect(referenceEdges(files)).toEqual([
        { src: 'demo/a/Use.java::method:use', dst: 'demo/a/List.java::class:List', tier: 'type', confidence: 0.95 },
      ]);
    });

    it('is not referenced when a single-type import names a class outside the repo', () => {
      const files = [list('demo.a'), use('import java.util.List;\n')];
      expect(staticRefs(files[1])).toHaveLength(1);
      expect(references(resolveEdges(files))).toEqual([]);
      expect(referenceEdges(files)).toEqual([]);
    });

    it('is referenced beside an on-demand import: the package comes before java.util.*', () => {
      const files = [list('demo.a'), use('import java.util.*;\n')];
      expect(referenceEdges(files)).toEqual([expect.objectContaining({ dst: 'demo/a/List.java::class:List', tier: 'type' })]);
    });

    it('is not referenced from another package that does not import it', () => {
      const files = [list('other'), use(''), use('import java.util.*;\n'), use('import java.util.List;\n')];
      for (const user of files.slice(1)) {
        expect(references(resolveEdges([files[0], user]))).toEqual([]);
        expect(referenceEdges([files[0], user])).toEqual([]);
      }
    });

    it('is referenced through its own single-type or on-demand import', () => {
      for (const imports of ['import other.List;\n', 'import other.*;\n']) {
        expect(referenceEdges([list('other'), use(imports)])).toEqual([expect.objectContaining({ dst: 'other/List.java::class:List', tier: 'type' })]);
      }
    });

    // Another file's nested type is not in scope by its bare name, whatever it is called.
    it('is not referenced when it is nested in another class', () => {
      const nested = (pkg: string, name: string) => parse(`/repo/${pkg.replace('.', '/')}/Outer.java`,
        `package ${pkg};\npublic class Outer {\n  public static final class ${name} {\n    public static Object of() { return null; }\n  }\n}\n`);
      const user = (imports: string, name: string) => parse('/repo/demo/a/Use.java',
        `package demo.a;\n${imports}public class Use {\n  Object use() { return ${name}.of(); }\n}\n`);
      for (const name of ['List', 'Gate']) {
        for (const [pkg, imports] of [['demo.a', ''], ['demo.a', 'import java.util.*;\n'], ['other', 'import other.*;\n']]) {
          const files = [nested(pkg, name), user(imports, name)];
          expect(references(resolveEdges(files))).toEqual([]);
          expect(referenceEdges(files)).toEqual([]);
        }
      }
    });

    it('is referenced when nested and named through a single-type import or its outer class', () => {
      const outer = parse('/repo/other/Outer.java',
        'package other;\npublic class Outer {\n  public static final class List {\n    public static List of() { return null; }\n  }\n}\n');
      const imported = parse('/repo/demo/a/Use.java',
        'package demo.a;\nimport other.Outer.List;\npublic class Use {\n  Object use() { return List.of(); }\n}\n');
      expect(referenceEdges([outer, imported])).toEqual([expect.objectContaining({ dst: 'other/Outer.java::class:List', tier: 'type' })]);
    });

    it('still gets no plain type reference, as before', () => {
      const typed = parse('/repo/demo/a/Typed.java', 'package demo.a;\npublic class Typed {\n  List field;\n  void use(List p) { List l = p; }\n}\n');
      expect(typed.relationships.filter(r => r.predicate === 'REFERENCES')).toEqual([]);
    });
  });

  describe('static fields and method references', () => {
    const UTIL = 'package demo.a;\npublic final class Util {\n  public static final int MAX = 1;\n  public static final Object INSTANCE = new Object();\n  public static int parse(String s) { return 0; }\n  void run() {}\n}\n';
    const util = () => parse('/repo/demo/a/Util.java', UTIL);
    const ref = (src: string) => ({ srcName: src, dstName: 'Util', predicate: 'REFERENCES', receiverType: 'Util', receiverOnly: true });
    const edge = { dst: 'demo/a/Util.java::class:Util', tier: 'type', confidence: 0.95 };

    it('links a static field access to its class, wherever the expression sits', () => {
      const use = parse('/repo/demo/a/Use.java', `package demo.a;
public class Use {
  static final int LIMIT = Util.MAX;
  int plain() { return Util.MAX; }
  void argument() { System.out.println(Util.MAX + 1); }
  void chained() { Util.INSTANCE.toString(); }
  @Deprecated
  int[] array() { return new int[Util.MAX]; }
}
`);
      expect(staticRefs(use).filter(r => r.dstName === 'Util')).toEqual([ref('Use'), ref('Use.plain'), ref('Use.argument'), ref('Use.chained'), ref('Use.array')]);
      expect(referenceEdges([util(), use])).toEqual([
        { src: 'demo/a/Use.java::class:Use', ...edge },
        ...['plain', 'argument', 'chained', 'array'].map(m => ({ src: `demo/a/Use.java::method:${m}`, ...edge })),
      ]);
    });

    it('links a method reference and a constructor reference to the class', () => {
      const use = parse('/repo/demo/a/Use.java', `package demo.a;
import java.util.function.Function;
import java.util.function.Supplier;
public class Use {
  Function<String, Integer> method() { return Util::parse; }
  Supplier<Object> constructor() { return Util::new; }
}
`);
      expect(staticRefs(use)).toEqual([ref('Use.method'), ref('Use.constructor')]);
      expect(referenceEdges([util(), use]).filter(e => e.dst.endsWith(':Util'))).toEqual([
        { src: 'demo/a/Use.java::method:method', ...edge }, { src: 'demo/a/Use.java::method:constructor', ...edge },
      ]);
    });

    it('shares one reference per scope with a static call and a type reference', () => {
      const calls = parse('/repo/demo/a/Use.java', 'package demo.a;\npublic class Use {\n  int use() { return Util.parse("1") + Util.MAX + java.util.List.of("1").stream().mapToInt(Util::parse).sum(); }\n}\n');
      expect(calls.relationships.filter(r => r.predicate === 'REFERENCES')).toEqual([ref('Use.use')]);
      const typed = parse('/repo/demo/a/Use.java', 'package demo.a;\npublic class Use {\n  int use() {\n    Util u = null;\n    return Util.MAX;\n  }\n}\n');
      expect(typed.relationships.filter(r => r.predicate === 'REFERENCES')).toEqual([
        { srcName: 'Use.use', dstName: 'Util', predicate: 'REFERENCES', receiverType: 'Util' },
      ]);
      expect(referenceEdges([util(), typed])).toEqual([{ src: 'demo/a/Use.java::method:use', ...edge }]);
    });

    it('takes no variable, lowercase name, qualified name, this or generic type as a class', () => {
      const use = parse('/repo/demo/a/Use.java', `package demo.a;
import java.util.ArrayList;
import java.util.function.Supplier;
public class Use {
  Util Field;
  int own;
  int variables(Util Param) {
    Util Local = Param;
    Supplier<Object> s = Local::toString;
    return Param.MAX + Local.MAX + Field.MAX + this.Field.MAX + this.own + Use.this.own;
  }
  int qualified(Util util) { return demo.a.Util.MAX + util.MAX; }
  Supplier<Object> generic() { return ArrayList<String>::new; }
  Supplier<Object> viaThis() { return this::toString; }
}
`);
      expect(staticRefs(use)).toEqual([]);
    });

    it('writes nothing for a JDK class, an ambiguous name, or a same-named class out of scope', () => {
      const dup = (pkg: string) => parse(`/repo/${pkg}/Dup.java`, `package ${pkg};\npublic class Dup {\n  public static final int MAX = 1;\n  public static void go() {}\n}\n`);
      const use = parse('/repo/q/Use.java',
        'package q;\nimport a.*;\nimport b.*;\nimport java.util.Collections;\npublic class Use {\n  Object use() { Runnable r = Dup::go; return Dup.MAX + Collections.EMPTY_LIST.size() + Util.MAX; }\n}\n');
      expect(staticRefs(use).map(r => r.dstName).sort()).toEqual(['Collections', 'Dup', 'Util']);
      const files = [dup('a'), dup('b'), util(), use];
      const edges = resolveEdges(files);
      expect(references(edges)).toEqual([]);
      expect(referenceEdges(files, edges)).toEqual([]);
      const stripped = { ...use, relationships: use.relationships.filter(r => !(r.predicate === 'REFERENCES' && r.receiverOnly)) };
      expect(buildPatchWithResolution(use, 'hash', 'workspace', edges).ops).toEqual(buildPatchWithResolution(stripped, 'hash', 'workspace', edges).ops);
    });

    it('gives a class no reference to itself, nested and anonymous code included', () => {
      const self = parse('/repo/demo/a/Util.java', `package demo.a;
public final class Util {
  public static final int MAX = 1;
  static int parse(String s) { return Util.MAX; }
  java.util.function.Function<String, Integer> f = Util::parse;
  static class Nested {
    int viaOuter() { return Util.MAX; }
  }
  Runnable anon() {
    return new Runnable() {
      public void run() { int x = Util.MAX; }
    };
  }
}
`);
      expect(staticRefs(self)).toEqual([]);
      expect(referenceEdges([self])).toEqual([]);
    });

    it('references the outer class of a nested receiver, not the nested class', () => {
      const outer = parse('/repo/demo/a/Outer.java',
        'package demo.a;\npublic class Outer {\n  public static class Inner {\n    public static final int MAX = 1;\n    static void go() {}\n  }\n}\n');
      const use = parse('/repo/demo/a/Use.java', 'package demo.a;\npublic class Use {\n  int use() { Outer.Inner.go(); return Outer.Inner.MAX; }\n}\n');
      expect(staticRefs(use)).toEqual([{ srcName: 'Use.use', dstName: 'Outer', predicate: 'REFERENCES', receiverType: 'Outer', receiverOnly: true }]);
      expect(referenceEdges([outer, use])).toEqual([
        { src: 'demo/a/Use.java::method:use', dst: 'demo/a/Outer.java::class:Outer', tier: 'type', confidence: 0.95 },
      ]);
    });

    it('adds no reference for a static-import call or a package-qualified receiver (known gaps)', () => {
      const use = parse('/repo/q/Use.java',
        'package q;\nimport static demo.a.Util.parse;\npublic class Use {\n  int use() { return parse("1") + demo.a.Util.parse("2") + demo.a.Util.MAX; }\n}\n');
      expect(staticRefs(use)).toEqual([]);
      expect(referenceEdges([util(), use])).toEqual([]);
    });
  });

  it('gives a class no reference to itself for its own static calls', () => {
    const self = parse('/repo/demo/a/Gate.java', `package demo.a;
final class Gate {
  static boolean helper() { return true; }
  static boolean matches() { return Gate.helper(); }
  static class Nested {
    boolean viaOuter() { return Gate.helper(); }
  }
  Runnable anon() {
    return new Runnable() {
      public void run() { Gate.helper(); }
    };
  }
}
`);
    expect(staticRefs(self)).toEqual([]);
    expect(references(resolveEdges([self]))).toEqual([]);
    expect(referenceEdges([self])).toEqual([]);
    // The typed call itself is unaffected.
    expect(self.relationships).toContainEqual(expect.objectContaining({ srcName: 'Gate.matches', predicate: 'CALLS', receiverType: 'Gate' }));
  });

  it('marks only a bare type name: not variables, this, super, chains or qualified receivers', () => {
    const base = parse('/repo/demo/a/Base.java', 'package demo.a;\npublic class Base {\n  void run() {}\n  static Gate make() { return null; }\n}\n');
    const use = parse('/repo/demo/a/Use.java', `package demo.a;
public class Use extends Base {
  Gate field;
  void own() {}
  void use(Gate param) {
    Gate local = param;
    param.matches("a");
    local.matches("b");
    field.matches("c");
    this.field.matches("d");
    this.own();
    own();
    super.run();
    Base.make().matches("e");
    demo.a.Gate.matches("f");
    lower.matches("g");
    new Gate().matches("h");
  }
  void shadow() {
    Object Gate = null;
    Gate.toString();
  }
}
`);
    // `Base.make()` is itself a static call on Base; the chained `.matches` adds nothing.
    expect(staticRefs(use)).toEqual([
      { srcName: 'Use.use', dstName: 'Base', predicate: 'REFERENCES', receiverType: 'Base', receiverOnly: true },
    ]);
    // The `Gate` type references in `use` are plain, as before.
    expect(use.relationships.filter(r => r.predicate === 'REFERENCES' && r.dstName === 'Gate')
      .every(r => r.receiverType === undefined && r.receiverOnly === undefined)).toBe(true);
    void base;
  });

  it('merges with a type reference to the same class in the same scope, in either order', () => {
    const before = parse('/repo/demo/a/Use.java',
      'package demo.a;\npublic class Use {\n  void use() {\n    Gate g = null;\n    Gate.matches("x");\n  }\n}\n');
    const after = parse('/repo/demo/a/Use.java',
      'package demo.a;\npublic class Use {\n  void use() {\n    Gate.matches("x");\n    Gate g = null;\n  }\n}\n');
    for (const use of [before, after]) {
      // One relationship: a type reference in its own right, so not receiver-only.
      expect(use.relationships.filter(r => r.predicate === 'REFERENCES' && r.dstName === 'Gate')).toEqual([
        { srcName: 'Use.use', dstName: 'Gate', predicate: 'REFERENCES', receiverType: 'Gate' },
      ]);
      const files = [gate(), use];
      const edges = resolveEdges(files);
      expect(references(edges)).toEqual([expect.objectContaining({ dstFilePath: '/repo/demo/a/Gate.java', dstQualifiedKey: 'Gate', tier: 'type' })]);
      expect(referenceEdges(files, edges)).toEqual([
        { src: 'demo/a/Use.java::method:use', dst: 'demo/a/Gate.java::class:Gate', tier: 'type', confidence: 0.95 },
      ]);
    }
  });

  it('keeps a merged type reference resolving by name when the receiver type is out of scope', () => {
    // `Dup` is ambiguous as a receiver; the plain type reference behaves as it did before.
    const dup = (pkg: string) => parse(`/repo/${pkg}/Dup.java`, `package ${pkg};\npublic class Dup {\n  public static void go() {}\n}\n`);
    const source = (call: string) => `package q;\nimport a.*;\nimport b.*;\npublic class Use {\n  void use() {\n    Dup d = null;\n    ${call}\n  }\n}\n`;
    const withCall = [dup('a'), dup('b'), parse('/repo/q/Use.java', source('Dup.go();'))];
    const without = [dup('a'), dup('b'), parse('/repo/q/Use.java', source(''))];
    expect(references(resolveEdges(withCall))).toEqual(references(resolveEdges(without)));
    expect(referenceEdges(withCall)).toEqual(referenceEdges(without));
  });

  it('leaves a same-file type reference as it was when a static call joins it', () => {
    const source = (call: string) => `package demo.a;\npublic class Host {\n  void use() {\n    Util u = null;\n    ${call}\n  }\n  static class Util {\n    static void go() {}\n  }\n}\n`;
    const withCall = parse('/repo/demo/a/Host.java', source('Util.go();'));
    const without = parse('/repo/demo/a/Host.java', source(''));
    expect(referenceEdges([withCall])).toEqual(referenceEdges([without]));
    expect(referenceEdges([withCall])).toEqual([expect.objectContaining({ dst: 'demo/a/Host.java::class:Util' })]);
  });

  it('emits one reference per caller however many static calls it makes', () => {
    const use = parse('/repo/demo/a/Use.java',
      'package demo.a;\npublic class Use {\n  void one() { Gate.matches("a"); Gate.matches(1); }\n  void two() { Gate.matches("b"); }\n}\n');
    expect(staticRefs(use).map(r => r.srcName)).toEqual(['Use.one', 'Use.two']);
  });

  it('adds no reference in other languages', () => {
    const ts = parseFile('/repo/use.ts', 'class Gate { static matches(): boolean { return true; } }\nexport function use() { return Gate.matches(); }\n')!;
    expect(ts.relationships.filter(r => r.predicate === 'REFERENCES' && (r.receiverType || r.receiverOnly))).toEqual([]);
    const fieldUse = parseFile('/repo/use2.ts', 'class Gate { static MAX = 1; }\nexport function use() { return Gate.MAX; }\n')!;
    expect(fieldUse.relationships.filter(r => r.predicate === 'REFERENCES' && (r.receiverType || r.receiverOnly))).toEqual([]);
    const scala = parseFile('/repo/Use.scala', 'package q\nobject Gate { val Max = 1 }\nobject Use { def use(): Int = Gate.Max }\n')!;
    expect(scala.relationships.filter(r => r.predicate === 'REFERENCES' && (r.receiverType || r.receiverOnly))).toEqual([]);
  });
});
