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
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    const filter = results.find(r => r.filePath.endsWith('TimeoutFilter.java'))!;
    expect(resolveEdges([filter], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === filter.filePath));
  });

  it('gives no typed edge, and no error, against summaries written without Java receiver facts', () => {
    const summaries = new Map(results.map(r => {
      const { receiverFactories: _f, receiverHeritage: _h, receiverPackage: _p, ...old } = summarizeParseResult(r);
      return [r.filePath, old];
    }));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
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
