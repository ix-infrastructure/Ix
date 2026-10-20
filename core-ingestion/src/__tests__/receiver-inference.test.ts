// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';
import { buildGlobalResolutionIndex, parseFile, resolveEdges, summarizeParseResult } from '../index.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';
import labelledCases from '../../test-fixtures/receiver-inference/cases.json';

const parse = (ext: string, source: string, name = 'use') => {
  const result = parseFile(`/repo/${name}.${ext}`, source.replaceAll(';', ';\n').replaceAll('} ', '}\n'))!;
  expect(result).not.toBeNull();
  expect(result.hasParseErrors).toBeUndefined();
  return result;
};
const methods = (ext: string, body: string) => ext === 'scala'
  ? `class Target { def run() = () }; class Other { def run() = () }; ${body}`
  : ext === 'ts'
    ? `class Target { run() {} } class Other { run() {} } ${body}`
    : `package p\ntype Target struct{}; type Other struct{}; func (t Target) Run() {}; func (o Other) Run() {}; ${body}`;

const typedEdgeOps = (ops: Array<{ type: string; attrs?: unknown }>) =>
  ops.filter(op => op.type === 'UpsertEdge' && (op.attrs as { tier?: string } | undefined)?.tier === 'type');

describe('typed local receivers', () => {
  it('Go resolves a receiver method declared in another package file', () => {
    const files = [
      parse('go', 'package p\ntype Target struct{}\n', 'types'),
      parse('go', 'package p\nfunc (t Target) Run() {}\n', 'methods'),
      parse('go', 'package p\nfunc use(t Target) { t.Run() }\n'),
    ];
    const edges = resolveEdges(files);
    expect(edges).toContainEqual(expect.objectContaining({
      srcFilePath: files[2].filePath, dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run', tier: 'type',
    }));
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([files[2]], undefined, index)).toEqual(edges.filter(e => e.srcFilePath === files[2].filePath));
    expect(buildPatchWithResolution(files[2], 'hash', 'workspace', edges).ops).toContainEqual(
      expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS', attrs: { confidence: 0.95, tier: 'type' } }),
    );
  });

  it.each(['dep := Target{}', 'dep := &Target{}', 'var dep Target', 'dep := NewTarget()'])('Go finds split-file methods for %s', (binding) => {
    const files = [
      parse('go', 'package p\ntype Target struct{}\nfunc NewTarget() Target { return Target{} }\n', 'types'),
      parse('go', 'package p\nfunc (t Target) Run() {}\n', 'methods'),
      parse('go', `package p\nfunc use() { ${binding}; dep.Run() }\n`),
    ];
    expect(resolveEdges(files)).toContainEqual(expect.objectContaining({ dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run', tier: 'type' }));
  });

  it('counts type-tier resolutions separately from qualifier ones', () => {
    const stats = { importLookups: 0, transitiveLookups: 0, globalFallbacks: 0, globalCandidateTotal: 0, resolvedImport: 0,
      resolvedTransitive: 0, resolvedGlobal: 0, resolvedQualifier: 0, resolvedType: 0, skippedSameFile: 0, skippedAmbiguous: 0 };
    resolveEdges([parse('ts', methods('ts', 'function use(dep: Target) { dep.run(); }'))], stats);
    expect(stats).toMatchObject({ resolvedType: 1, resolvedQualifier: 0 });
  });

  it('Go does not borrow methods from the external test package in the same directory', () => {
    const files = [
      parse('go', 'package p\ntype Target struct{}\n', 'types'),
      parse('go', 'package p_test\ntype Target struct{}\nfunc (t Target) Run() {}\n', 'methods_test'),
      parse('go', 'package p\nfunc use(t Target) { t.Run() }\n'),
    ];
    expect(resolveEdges(files).filter(e => e.tier === 'type')).toEqual([]);
  });

  it('Go rejects multiple method definitions across package files', () => {
    const files = [
      parse('go', 'package p\ntype Target struct{}\n', 'types'),
      parse('go', 'package p\nfunc (t Target) Run() {}\n', 'methods'),
      parse('go', 'package p\nfunc (t Target) Run() {}\n', 'duplicate'),
      parse('go', 'package p\nfunc use(t Target) { t.Run() }\n'),
    ];
    expect(resolveEdges(files).filter(e => e.tier === 'type')).toEqual([]);
  });

  it('Go resolves imported receiver types and factories with methods in another file', () => {
    const files = [
      parse('go', 'package model\ntype Target struct{}\nfunc NewTarget() Target { return Target{} }\n', 'model/types'),
      parse('go', 'package model\nfunc (t Target) Run() {}\n', 'model/methods'),
      parse('go', 'package app\nimport model "example/model"\nfunc typed(t model.Target) { t.Run() }; func factory() { dep := model.NewTarget(); dep.Run() }\n'),
    ];
    const calls = resolveEdges(files).filter(e => e.tier === 'type');
    expect(calls).toEqual([
      expect.objectContaining({ srcName: 'typed', dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run' }),
      expect.objectContaining({ srcName: 'factory', dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run' }),
    ]);
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([files[2]], undefined, index).filter(e => e.tier === 'type')).toEqual(calls);
  });

  it('Go does not use a package factory return for a shadowing local function', () => {
    const result = parse('go', methods('go', 'func NewTarget() Target { return Target{} }; func use() { NewTarget := func() Other { return Other{} }; dep := NewTarget(); dep.Run() }'));
    const edges = resolveEdges([result]);
    expect(edges.filter(e => e.tier === 'type')).toEqual([]);
    expect(buildPatchWithResolution(result, 'hash', 'workspace', edges).ops.filter(op => op.type === 'UpsertEdge' && op.attrs?.tier === 'type')).toEqual([]);
  });

  it('Go rejects a shadowing factory parameter but keeps the package factory in a sibling scope', () => {
    const result = parse('go', methods('go', 'func NewTarget() Target { return Target{} }; func shadowed(NewTarget func() Other) { dep := NewTarget(); dep.Run() }; func known() { dep := NewTarget(); dep.Run() }'));
    expect(resolveEdges([result]).filter(e => e.tier === 'type')).toEqual([
      expect.objectContaining({ srcName: 'known', dstQualifiedKey: 'Target.Run' }),
    ]);
  });

  it('TypeScript var in a nested block overwrites a function parameter binding', () => {
    const result = parse('ts', methods('ts', 'function use(dep: Target) { if (true) { var dep = { run() {} }; } dep.run(); }'));
    const edges = resolveEdges([result]);
    expect(edges.filter(e => e.tier === 'type')).toEqual([]);
    expect(buildPatchWithResolution(result, 'hash', 'workspace', edges).ops.filter(op => op.type === 'UpsertEdge' && op.attrs?.tier === 'type')).toEqual([]);
  });

  it('TypeScript infers function-scoped var after a block without confusing let shadows', () => {
    const result = parse('ts', methods('ts', 'function fromVar() { if (true) { var dep = new Target(); } dep.run(); }; function fromLet(dep: Target) { if (true) { let dep = { run() {} }; } dep.run(); }'));
    expect(resolveEdges([result]).filter(e => e.tier === 'type')).toEqual([
      expect.objectContaining({ srcName: 'fromVar', dstQualifiedKey: 'Target.run' }),
      expect.objectContaining({ srcName: 'fromLet', dstQualifiedKey: 'Target.run' }),
    ]);
  });

  it.each([
    'class Holder { static { var dep = new Target(); } }; function use() { dep.run(); }',
    'namespace Holder { var dep = new Target(); }; function use() { dep.run(); }',
  ])('TypeScript var does not escape a static block or namespace', (source) => {
    const result = parse('ts', methods('ts', source));
    expect(resolveEdges([result]).filter(e => e.tier === 'type')).toEqual([]);
  });

  it.each(labelledCases)('matches the labelled $language $name sample', (fixture) => {
    const result = parse(fixture.language, fixture.source);
    const edges = resolveEdges([result]).filter(e => e.tier === 'type');
    expect(edges.map(e => e.dstQualifiedKey)).toEqual(fixture.expected);
  });
  it.each([
    ['scala', 'class T { def run() = () }; class U { def run() = () }; object Use { def use() = { val x: T = new T(); x.run() } }'],
    ['ts', 'class T { run() {} } class U { run() {} } function use() { const x: T = new T(); x.run(); }'],
    ['go', 'package p\ntype T struct{}; type U struct{}; func (t T) Run() {}; func (u U) Run() {}; func use() { x := T{}; x.Run() }'],
  ])('resolves a %s local despite competing method names', (extension, source) => {
    const result = parseFile(`/repo/use.${extension}`, source.replaceAll(';', ';\n').replaceAll('} ', '}\n'))!;
    expect(result).not.toBeNull();
    expect(result.relationships).toContainEqual(expect.objectContaining({
      predicate: 'CALLS', dstName: extension === 'go' ? 'T.Run' : 'T.run', receiverType: 'T',
    }));
    expect(resolveEdges([result])).toContainEqual(expect.objectContaining({
      predicate: 'CALLS', dstQualifiedKey: extension === 'go' ? 'T.Run' : 'T.run', tier: 'type', confidence: 0.95,
    }));
  });

  it.each([
    ['scala', 'constructor parameter', 'class Use(dep: Target) { def use() = dep.run() }'],
    ['scala', 'qualified field', 'class Use(val dep: Target) { def use() = this.dep.run() }'],
    ['scala', 'field', 'class Use { val dep: Target = new Target(); def use() = dep.run() }'],
    ['scala', 'typed val', 'object Use { def use() = { val dep: Target = new Target(); dep.run() } }'],
    ['scala', 'typed var', 'object Use { def use() = { var dep: Target = new Target(); dep.run() } }'],
    ['scala', 'new', 'object Use { def use() = { val dep = new Target(); dep.run() } }'],
    ['scala', 'typed parameter', 'object Use { def use(dep: Target) = dep.run() }'],
    ['ts', 'typed parameter', 'function use(dep: Target) { dep.run(); }'],
    ['ts', 'annotated const', 'function use() { const dep: Target = new Target(); dep.run(); }'],
    ['ts', 'annotated let', 'function use() { let dep: Target = new Target(); dep.run(); }'],
    ['ts', 'new', 'function use() { let dep = new Target(); dep.run(); }'],
    ['ts', 'field', 'class Use { dep: Target; use() { this.dep.run(); } }'],
    ['ts', 'abstract field', 'abstract class Use { dep: Target; use() { this.dep.run(); } }'],
    ['ts', 'initialized field', 'class Use { dep = new Target(); use() { this.dep.run(); } }'],
    ['ts', 'parameter property', 'class Use { constructor(private dep: Target) {} use() { this.dep.run(); } }'],
    ['ts', 'readonly parameter property', 'class Use { constructor(readonly dep: Target) {} use() { this.dep.run(); } }'],
    ['go', 'literal', 'func use() { dep := Target{}; dep.Run() }'],
    ['go', 'pointer literal', 'func use() { dep := &Target{}; dep.Run() }'],
    ['go', 'var', 'func use() { var dep Target; dep.Run() }'],
    ['go', 'pointer var', 'func use() { var dep *Target; dep.Run() }'],
    ['go', 'factory', 'func NewTarget() *Target { return &Target{} }; func use() { dep := NewTarget(); dep.Run() }'],
  ])('%s infers %s', (ext, _rule, body) => {
    const result = parse(ext, methods(ext, body));
    const key = ext === 'go' ? 'Target.Run' : 'Target.run';
    const edges = resolveEdges([result]);
    expect(edges).toContainEqual(expect.objectContaining({ dstQualifiedKey: key, tier: 'type', confidence: 0.95 }));
    const patch = buildPatchWithResolution(result, 'hash', 'workspace', edges);
    expect(patch.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', predicate: 'CALLS', attrs: { tier: 'type', confidence: 0.95 } }));
  });

  it.each(['Target()', 'Target.apply()'])('Scala infers companion %s from its declared return', (factory) => {
    const result = parse('scala', methods('scala', `object Target { def apply(): Target = new Target() }; object Use { def use() = { val dep = ${factory}; dep.run() } }`));
    expect(resolveEdges([result])).toContainEqual(expect.objectContaining({ dstQualifiedKey: 'Target.run', tier: 'type' }));
  });

  it('Scala infers a case-class constructor', () => {
    const result = parse('scala', 'case class Target() { def run() = () }; object Use { def use() = { val dep = Target(); dep.run() } }');
    expect(resolveEdges([result])).toContainEqual(expect.objectContaining({ dstQualifiedKey: 'Target.run', tier: 'type' }));
  });

  it.each(['Target()', 'Target.apply()'])('Scala infers companion %s returning a constructor directly', (factory) => {
    const result = parse('scala', methods('scala', `object Target { def apply() = new Target() }; object Use { def use() = { val dep = ${factory}; dep.run() } }`));
    expect(resolveEdges([result])).toContainEqual(expect.objectContaining({ dstQualifiedKey: 'Target.run', tier: 'type' }));
  });

  it.each([
    ['scala', 'object Use { def use(dep: Target) = { { val dep = unknown(); dep.run() } } }'],
    ['scala', 'class Use(dep: Target) { def use(dep: Any) = dep.run() }'],
    ['ts', 'function use(dep: Target) { { const dep = unknown(); dep.run(); } }'],
    ['ts', 'function use(dep: Target) { function nested(dep) { dep.run(); } }'],
    ['ts', 'function use(dep: Target) { const nested = dep => dep.run(); }'],
    ['ts', 'function use<Target>(dep: Target) { dep.run(); }'],
    ['ts', 'function use() { type Target = any; const dep: Target = unknown(); dep.run(); }'],
    ['ts', 'function use(dep: Missing.Target) { dep.run(); }'],
    ['ts', 'function use(dep: Target) { { dep.run(); const dep = unknown(); } }'],
    ['ts', 'function use(dep: Target) { try {} catch (dep) { dep.run(); } }'],
    ['ts', 'class Use { signature(dep: Target): void; use() { this.dep.run(); } }'],
    ['go', 'func use(dep *Target) { { dep := unknown(); dep.Run() } }'],
    ['go', 'func use(dep *Target) { f := func(dep interface{}) { dep.Run() }; _ = f }'],
    ['go', 'func use(dep *Target) { for _, dep := range unknown() { dep.Run() } }'],
    ['ts', 'function use(dep: Target) { for (const dep of unknown()) { dep.run(); } }'],
    ['ts', 'function use(dep: Target) { for (dep of unknown()) {} dep.run(); }'],
    ['scala', 'object Use { def use(dep: Target) = unknown().foreach { dep => dep.run() } }'],
    ['scala', 'object Use { def use(dep: Target) = unknown() match { case dep: Any => dep.run() } }'],
    ['scala', 'object Use { def use(dep: Target) = for (dep <- unknown()) yield dep.run() }'],
    ['go', 'func use(dep Target) { switch dep := unknown().(type) { default: dep.Run() } }'],
    ['go', 'func use(dep Target) { if dep := unknown(); dep != nil { dep.Run() } }'],
  ])('%s unknown shadows do not borrow the outer receiver', (ext, body) => {
    const result = parse(ext, methods(ext, body));
    expect(result.relationships.filter(r => r.receiverType === 'Target')).toEqual([]);
    expect(resolveEdges([result]).filter(e => e.predicate === 'CALLS')).toEqual([]);
    expect(typedEdgeOps(buildPatch(result, 'hash', 'workspace').ops)).toEqual([]);
  });

  it.each([
    ['scala', 'object Target { def apply(): Other = new Other() }; object Use { def use() = { val dep = Target(); dep.run() } }'],
    ['ts', 'function use() { let dep = new Target(); dep = unknown(); dep.run(); }'],
    ['go', 'func NewTarget() (*Target, error) { return nil, nil }; func use() { dep, err := NewTarget(); dep.Run(); _ = err }'],
  ])('%s does not assume a factory name or stale assignment is its type', (ext, body) => {
    const result = parse(ext, methods(ext, body));
    const edges = resolveEdges([result]).filter(e => e.predicate === 'CALLS');
    if (ext === 'scala') expect(edges).toContainEqual(expect.objectContaining({ dstQualifiedKey: 'Other.run', tier: 'type' }));
    else expect(edges.filter(e => e.tier === 'type')).toEqual([]);
    expect(edges.some(e => e.dstQualifiedKey === (ext === 'go' ? 'Target.Run' : 'Target.run'))).toBe(false);
  });

  it('Scala leaves conflicting inherited members unresolved', () => {
    const result = parse('scala', 'trait A { def run() = () }; trait B { def run() = () }; class Target extends A with B {}; object Use { def use(dep: Target) = dep.run() }');
    expect(resolveEdges([result]).filter(e => e.tier === 'type')).toEqual([]);
  });

  it.each([
    ['ts', 'function first(dep: Target) {} function use() { dep.run(); } class Target { run() {} }'],
    ['scala', 'class First(dep: Target) {}; object Use { def use() = dep.run() }; class Target { def run() = () }'],
    ['go', 'package p\nfunc first(dep Target) {}; func use() { dep.Run() }; type Target struct{}; func (t Target) Run() {}'],
  ])('%s parameters do not leak to sibling scopes at the root offset', (ext, source) => {
    const result = parse(ext, source);
    expect(resolveEdges([result]).filter(e => e.tier === 'type')).toEqual([]);
  });

  it.each([
    ['scala', 'class Target { def run(x: Int) = (); def run(x: String) = () }; object Use { def use(dep: Target) = dep.run(1) }'],
    ['go', 'package p\ntype Target struct{}; func (t Target) Run() {}; func (t Target) Run() {}; func use(dep Target) { dep.Run() }'],
  ])('%s ambiguous member definitions do not guess a type-tier signature', (ext, source) => {
    const result = parse(ext, source);
    expect(resolveEdges([result]).filter(e => e.predicate === 'CALLS')).toEqual([]);
    // The call falls back to its bare member name, as it resolved before inference.
    const ops = buildPatch(result, 'hash', 'workspace').ops;
    expect(typedEdgeOps(ops)).toEqual([]);
    expect(ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toHaveLength(1);
  });

  it('TypeScript overload signatures share their one implementation node', () => {
    const result = parse('ts', 'class Target { run(x: number): void; run(x: string): void; run(x: any) {} } function use(dep: Target) { dep.run(1); }');
    expect(result.entities.filter(e => e.name === 'run')).toHaveLength(1);
    expect(resolveEdges([result])).toEqual([expect.objectContaining({ dstQualifiedKey: 'Target.run', tier: 'type' })]);
  });

  it('TypeScript bare names never resolve through a same-named field or parameter property', () => {
    const result = parse('ts', "import { logger } from './logger'; class AuditLog { info() {} } class Client { send() {} } class Other { send() {} } const client = new Other(); class Svc { private logger: AuditLog = new AuditLog(); constructor(private client: Client) {} run() { logger.info('x'); client.send(); this.logger.info('y'); } }");
    expect(resolveEdges([result]).filter(e => e.tier === 'type').map(e => e.dstQualifiedKey)).toEqual(['Other.send', 'AuditLog.info']);
  });

  it('Go closure parameters stay inside the closure', () => {
    const result = parse('go', methods('go', 'func use() { dep := Target{}; f := func(dep Other) { dep.Run() }; _ = f; dep.Run() }'));
    expect(resolveEdges([result]).filter(e => e.tier === 'type').map(e => e.dstQualifiedKey)).toEqual(['Other.Run', 'Target.Run']);
  });

  it.each(['extends Base', 'extends Empty with Base'])('Scala resolves inherited members: %s', (heritage) => {
    const base = parse('scala', 'trait Base { def run() = () }; trait Empty {}', 'base');
    const child = parse('scala', `class Child ${heritage} {}`, 'child');
    const caller = parse('scala', 'object Use { def use(dep: Child) = dep.run() }');
    const fresh = resolveEdges([base, child, caller]);
    expect(fresh).toContainEqual(expect.objectContaining({ dstFilePath: base.filePath, dstQualifiedKey: 'Base.run', tier: 'type' }));
    const summaries = new Map([base, child, caller].map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([caller], undefined, index)).toEqual(fresh.filter(e => e.srcFilePath === caller.filePath));
  });

  it('TypeScript does not type a global or library receiver as a same-named repo class', () => {
    const geo = parse('ts', 'export class Map { set() {} }', 'geo/map');
    const use = parse('ts', 'function use() { const m = new Map<string, number>(); m.set("a", 1); }');
    expect(resolveEdges([geo, use]).filter(e => e.tier === 'type')).toEqual([]);
    const imported = parse('ts', "import { Map } from './geo/map'; function use() { const m = new Map(); m.set(); }");
    expect(resolveEdges([geo, imported]).filter(e => e.tier === 'type')).toEqual([
      expect.objectContaining({ dstFilePath: geo.filePath, dstQualifiedKey: 'Map.set' }),
    ]);
  });

  it.each([
    ['', []],
    ['import mylib._\n', ['Option.get']],
    ['import mylib.Option\n', ['Option.get']],
  ])('Scala types a receiver only from a type in scope (%j)', (imports, expected) => {
    const lib = parse('scala', 'package mylib\nclass Option { def get() = () }', 'option');
    const use = parse('scala', `package app\n${imports}object Use { def use(o: Option) = o.get() }`);
    expect(resolveEdges([lib, use]).filter(e => e.tier === 'type').map(e => e.dstQualifiedKey)).toEqual(expected);
  });

  it('Scala types a receiver from its own package without an import', () => {
    const target = parse('scala', 'package app\nclass Target { def run() = () }', 'target');
    const other = parse('scala', 'package other\nclass Target { def run() = () }', 'other');
    const use = parse('scala', 'package app\nobject Use { def use(dep: Target) = dep.run() }');
    expect(resolveEdges([target, other, use]).filter(e => e.tier === 'type')).toEqual([
      expect.objectContaining({ dstFilePath: target.filePath, dstQualifiedKey: 'Target.run' }),
    ]);
  });

  it('Scala imports disambiguate same-named types by declared package', () => {
    const caller = parse('scala', 'import model.Target\nobject Use { def use(dep: Target) = dep.run() }');
    const target = parse('scala', 'package model\nclass Target { def run() = () }', 'target');
    const other = parse('scala', 'package other\nclass Target { def run() = () }', 'other');
    const files = [caller, target, other];
    const fresh = resolveEdges(files).filter(e => e.tier === 'type');
    expect(fresh).toEqual([expect.objectContaining({ dstFilePath: target.filePath, dstQualifiedKey: 'Target.run' })]);
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([caller], undefined, index).filter(e => e.tier === 'type')).toEqual(fresh);
  });

  it.each([
    ['ts', "import { Target as Alias } from './target'; function use(dep: Alias) { dep.run(); }", 'export class Target { run() {} }'],
    ['scala', 'import model.Target\nobject Use { def use(dep: Target) = dep.run() }', 'package model\nclass Target { def run() = () }'],
    ['go', 'package p\nfunc use() { dep := NewTarget(); dep.Run() }', 'package p\ntype Target struct{}; func (t Target) Run() {}; func NewTarget() *Target { return &Target{} }'],
  ])('%s resolves across files and stored summaries', (ext, source, targetSource) => {
    const caller = parse(ext, source);
    const target = parse(ext, targetSource, 'target');
    const competing = parse(ext, ext === 'ts' ? 'export class Other { run() {} }' : ext === 'scala' ? 'class Other { def run() = () }' : 'package p\ntype Other struct{}; func (o Other) Run() {}', 'other');
    const files = [caller, target, competing];
    const fresh = resolveEdges(files).filter(e => e.srcFilePath === caller.filePath);
    expect(fresh).toContainEqual(expect.objectContaining({ dstFilePath: target.filePath, dstQualifiedKey: ext === 'go' ? 'Target.Run' : 'Target.run', tier: 'type' }));
    const summaries = new Map(files.map(r => [r.filePath, summarizeParseResult(r)]));
    const index = buildGlobalResolutionIndex([...summaries.keys()], undefined, undefined, summaries);
    expect(resolveEdges([caller], undefined, index)).toEqual(fresh);
  });
});

describe('receiver inference is additive', () => {
  const callsFrom = (edges: ReturnType<typeof resolveEdges>, srcName: string) =>
    edges.filter(e => e.predicate === 'CALLS' && e.srcName === srcName);

  it('Go keeps calls through an unaliased package import and types its factory', () => {
    const svc = parse('go', 'package svc\ntype Store struct{}\nfunc NewStore() *Store { return &Store{} }\nfunc (s *Store) Save() {}\nfunc Helper() {}\n', 'pkg/svc/store');
    const app = parse('go', 'package main\nimport "example.com/m/pkg/svc"\nfunc main() { svc.Helper(); s := svc.NewStore(); s.Save() }\n', 'cmd/app/main');
    const calls = callsFrom(resolveEdges([svc, app]), 'main');
    expect(calls).toContainEqual(expect.objectContaining({ dstFilePath: svc.filePath, dstQualifiedKey: 'Helper', tier: 'import' }));
    expect(calls).toContainEqual(expect.objectContaining({ dstFilePath: svc.filePath, dstQualifiedKey: 'NewStore', tier: 'import' }));
    expect(calls).toContainEqual(expect.objectContaining({ dstFilePath: svc.filePath, dstQualifiedKey: 'Store.Save', tier: 'type' }));
  });

  it('TypeScript namespace-import calls resolve by their bare name, as before', () => {
    const util = parse('ts', 'export function helper() {}', 'util');
    const lib = parse('ts', 'export function boot() {}', 'lib');
    const main = parse('ts', "import * as U from './util'; import * as lib from './lib'; function main() { U.helper(); lib.boot(); }", 'main');
    expect(main.relationships.filter(r => r.predicate === 'CALLS').map(r => r.dstName)).toEqual(['helper', 'boot']);
    const calls = callsFrom(resolveEdges([util, lib, main]), 'main');
    expect(calls).toContainEqual(expect.objectContaining({ dstFilePath: util.filePath, dstQualifiedKey: 'helper', tier: 'import' }));
    expect(calls).toContainEqual(expect.objectContaining({ dstFilePath: lib.filePath, dstQualifiedKey: 'boot', tier: 'import' }));
  });

  it('a receiver whose type is not inferred falls back to its bare member name', () => {
    const client = parse('ts', 'export class IxClient { stats() {} } export function createClient(): IxClient { return new IxClient(); }', 'client');
    const cmd = parse('ts', "import { IxClient, createClient } from './client'; function run() { const client = createClient(); client.stats(); } function check(c: Pick<IxClient, 'stats'>) { c.stats(); }", 'cmd');
    const edges = resolveEdges([client, cmd]);
    for (const caller of ['run', 'check']) {
      expect(callsFrom(edges, caller)).toContainEqual(expect.objectContaining({ dstFilePath: client.filePath, dstQualifiedKey: 'IxClient.stats', tier: 'import' }));
    }
    // The fallback edge is written under the relationship's own name.
    const ops = buildPatchWithResolution(cmd, 'hash', 'workspace', edges).ops;
    // run -> createClient, run -> stats, check -> stats.
    expect(ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS').map(op => op.attrs))
      .toEqual([{ confidence: 0.9, tier: 'binding' }, { confidence: 0.9, tier: 'import' }, { confidence: 0.9, tier: 'import' }]);
  });

  it('Scala falls back to the bare member when a factory return is unknown', () => {
    const repo = parse('scala', 'class Repo { def find() = () }; object Factory { def makeRepo() = new Repo() }', 'repo');
    const use = parse('scala', 'object Use { def use() = { val r = makeRepo(); r.find() } }');
    expect(callsFrom(resolveEdges([repo, use]), 'Use.use')).toContainEqual(expect.objectContaining({ dstFilePath: repo.filePath, dstQualifiedKey: 'Repo.find' }));
  });

  it('Scala chained calls keep bare callee names, never receiver source text', () => {
    const result = parseFile('/repo/use.scala', 'object Use {\n  def use(xs: Seq[Int]) = {\n    xs.map { x =>\n      x + 1\n    }.filter(_ > 2).foreach(println)\n    Option(1).getOrElse(0)\n  }\n}\n')!;
    const names = result.relationships.filter(r => r.predicate === 'CALLS').map(r => r.dstName);
    expect(names).toEqual(expect.arrayContaining(['filter', 'foreach', 'getOrElse']));
    expect(names.filter(n => /[^\w.$]/.test(n))).toEqual([]);
  });

  it('an unresolved typed call is recorded under its bare member name, as before', () => {
    const result = parse('ts', 'function main() { const seen = new Registry(); seen.lookup(1); }', 'main');
    expect(result.relationships).toContainEqual(expect.objectContaining({ dstName: 'Registry.lookup', receiverType: 'Registry' }));
    const main = buildPatch(result, 'hash', 'workspace').ops.find(op => op.type === 'UpsertNode' && op.name === 'main');
    expect((main as { attrs?: Record<string, unknown> } | undefined)?.attrs?.unresolved_calls).toEqual(['Registry', 'lookup']);
  });

  it('builtin member calls on an uninferred receiver stay filtered', () => {
    const result = parse('ts', "function main() { console.log('x'); }", 'main');
    expect(result.relationships.filter(r => r.predicate === 'CALLS')).toEqual([]);
    const file = buildPatch(result, 'hash', 'workspace').ops.find(op => op.type === 'UpsertNode' && op.name === 'main');
    expect((file as { attrs?: Record<string, unknown> } | undefined)?.attrs?.unresolved_calls).toBeUndefined();
  });
});

describe('summaries stored before receiver inference', () => {
  it('Go incremental resolution keeps the edge it had, without receiver facts', () => {
    const files = [
      parse('go', 'package p\ntype Target struct{}\n', 'types'),
      parse('go', 'package p\nfunc (t Target) Run() {}\n', 'methods'),
      parse('go', 'package p\nfunc use(t Target) { t.Run() }\n'),
    ];
    const stale = new Map(files.map(r => {
      const { receiverFactories: _f, receiverHeritage: _h, receiverPackage: _p, ...summary } = summarizeParseResult(r);
      return [r.filePath, summary];
    }));
    const index = buildGlobalResolutionIndex([...stale.keys()], undefined, undefined, stale);
    const edges = resolveEdges([files[2]], undefined, index).filter(e => e.predicate === 'CALLS');
    expect(edges).toContainEqual(expect.objectContaining({ dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run', tier: 'qualifier' }));
    const fresh = resolveEdges(files).filter(e => e.predicate === 'CALLS' && e.srcFilePath === files[2].filePath);
    expect(fresh).toContainEqual(expect.objectContaining({ dstFilePath: files[1].filePath, dstQualifiedKey: 'Target.Run', tier: 'type' }));
    // Both land on the same graph edge; only its tier differs until the file is re-parsed.
    const ids = (e: typeof edges) => buildPatchWithResolution(files[2], 'h', 'ws', e).ops.filter(op => op.type === 'UpsertEdge').map(op => op.id);
    expect(ids(edges)).toEqual(ids(fresh));
  });
});

describe('receiver summary signature', () => {
  const sig = (ext: string, source: string) => summarizeParseResult(parse(ext, source, 'child')).sig;

  it('changes when only a Scala subclass file re-imports its superclass', () => {
    expect(sig('scala', 'import p1.Parent\nclass Child extends Parent {}'))
      .not.toBe(sig('scala', 'import p2.Parent\nclass Child extends Parent {}'));
  });

  it('stays the same for a file without receiver facts when its imports change', () => {
    expect(sig('ts', "import { a } from './a'; export function f() {}"))
      .toBe(sig('ts', "import { a } from './b'; export function f() {}"));
  });
});

describe('receiver inference only adds to a patch', () => {
  const withoutInference = (r: ReturnType<typeof parse>) => ({
    ...r,
    relationships: r.relationships.filter(rel => !rel.receiverOnly)
      .map(({ receiverType: _t, receiverFactory: _f, ...rel }) => rel),
  });
  it.each([
    ['ts', "import { Target as T } from './t'; function use(dep: Target, o: T) { dep.run(); o.run(); this.x(); console.log(dep); }"],
    ['scala', 'object Use { def use(dep: Target) = { dep.run(); List(1).map(x => x).filter(_ > 0) } }'],
    ['go', 'import "example.com/m/yaml"\nfunc use(dep Target, n yaml.Node) { dep.Run(); n.Decode(); yaml.Helper(); d := NewTarget(); d.Run() }; func NewTarget() *Target { return &Target{} }'],
  ])('%s keeps every claim and edge id of the uninferred patch', (ext, body) => {
    const typed = parse(ext, methods(ext, body));
    const plain = withoutInference(typed);
    const typedOps = buildPatchWithResolution(typed, 'h', 'ws', resolveEdges([typed])).ops;
    const plainOps = buildPatchWithResolution(plain, 'h', 'ws', resolveEdges([plain])).ops;
    const claims = (ops: typeof typedOps) => ops.filter(op => op.type === 'AssertClaim');
    expect(claims(typedOps)).toEqual(claims(plainOps));
    const edges = (ops: typeof typedOps) => new Map(ops.filter(op => op.type === 'UpsertEdge').map(op => [op.id, op]));
    const typedEdges = edges(typedOps);
    for (const [id, op] of edges(plainOps)) {
      expect(typedEdges.get(id)).toMatchObject({ src: op.src, dst: op.dst, predicate: op.predicate });
    }
    // Nodes are the same, except that a call resolved by type leaves unresolved_calls.
    const nodes = (ops: typeof typedOps) => ops.filter(op => op.type !== 'UpsertEdge' && op.type !== 'AssertClaim');
    const strip = (op: (typeof typedOps)[number]) => {
      const { unresolved_calls: _c, unresolved_call_count: _n, ...attrs } = (op.attrs ?? {}) as Record<string, unknown>;
      return { ...op, attrs };
    };
    expect(nodes(typedOps).map(strip)).toEqual(nodes(plainOps).map(strip));
    nodes(typedOps).forEach((op, i) => {
      const unresolved = (o: typeof op) => ((o.attrs as { unresolved_calls?: string[] } | undefined)?.unresolved_calls ?? []);
      expect(unresolved(nodes(plainOps)[i])).toEqual(expect.arrayContaining(unresolved(op)));
    });
  });
});
