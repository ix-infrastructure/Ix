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
  ])('%s unknown shadows do not borrow the outer receiver', (ext, body) => {
    const result = parse(ext, methods(ext, body));
    expect(resolveEdges([result]).filter(e => e.predicate === 'CALLS')).toEqual([]);
    const patch = buildPatchWithResolution(result, 'hash', 'workspace', []);
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
    expect(buildPatch(result, 'hash', 'workspace').ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
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
    ['ts', 'class Target { run(x: number): void; run(x: string): void; run(x: any) {} } function use(dep: Target) { dep.run(1); }'],
    ['go', 'package p\ntype Target struct{}; func (t Target) Run() {}; func (t Target) Run() {}; func use(dep Target) { dep.Run() }'],
  ])('%s ambiguous member definitions are left unresolved', (ext, source) => {
    const result = parse(ext, source);
    expect(resolveEdges([result]).filter(e => e.predicate === 'CALLS')).toEqual([]);
    const patch = buildPatchWithResolution(result, 'hash', 'workspace', []);
    expect(patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
    expect(buildPatch(result, 'hash', 'workspace').ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS')).toEqual([]);
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
