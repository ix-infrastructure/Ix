// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('TypeScript queries', () => {
  it('captures definitions, imports, heritage edges, and method calls', () => {
    const result = parseFile(
      '/repo/example.ts',
      `
        import { Foo } from './bar'

        interface Greeter {
          greet(): void
        }

        class Example extends Base implements Greeter {
          method(): Foo {
            return foo.bar()
          }
        }

        function helper(): void {}

        const arrow = () => helper()
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(entity => entity.name)).toEqual(
      expect.arrayContaining(['Greeter', 'Example', 'method', 'helper', 'arrow']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'example.ts',
      dstName: 'bar',
      predicate: 'IMPORTS',
      importRaw: './bar',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Example',
      dstName: 'Base',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Example',
      dstName: 'Greeter',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Example.method',
      dstName: 'bar',
      predicate: 'CALLS',
    });
  });

  it('indexes a module-level const, and only a module-level one', () => {
    const result = parseFile(
      '/repo/constants.ts',
      `
        export const SUPPORTED_EXTENSIONS = new Set(['.ts'])
        const BUDGETS = [1, 2]
        export const contextBundleSchema = z.object({})
        export const BUNDLE_SCHEMA = 'ix-context-bundle/1'
        let mutable = 3
        const { destructured } = source
        export const handler = () => 1
        const legacy = function () { return 2 }
        function outer() {
          const local = 5
          return local
        }
      `,
    );

    expect(result).not.toBeNull();
    const byKind = (kind: string) =>
      result!.entities.filter(e => e.kind === kind).map(e => e.name).sort();

    // The four ground-truth symbols from the retrieval benchmark that a graph
    // of this repo could not resolve (Ix#679) — note BUDGETS is unexported.
    expect(byKind('constant')).toEqual([
      'BUDGETS', 'BUNDLE_SCHEMA', 'SUPPORTED_EXTENSIONS', 'contextBundleSchema',
    ]);

    // A function value is still a function, and the const rule does not add a
    // second `constant` entity for it.
    //
    // Deduped in the assertion because `export const handler = () => 1` already
    // matched two of the four function rules before this change (the plain
    // lexical_declaration rule is unanchored, so it matches inside the
    // export_statement the fourth rule matches). Both entries carry the same
    // name and line range, so patch-builder folds them onto one node id — it is
    // wasted work, not a wrong graph, and it is not this change's to fix.
    expect([...new Set(byKind('function'))]).toEqual(['handler', 'legacy', 'outer']);

    const names = result!.entities.map(e => e.name);
    expect(names).not.toContain('local');        // function-local
    expect(names).not.toContain('mutable');      // `let`, not `const`
    expect(names).not.toContain('destructured'); // binds no single name
  });

  it('gives a constant the line range of its own declaration', () => {
    const result = parseFile('/repo/c.ts', `const A = 1\nconst B = [\n  2,\n]\n`);
    const b = result!.entities.find(e => e.name === 'B')!;
    expect(b.kind).toBe('constant');
    expect([b.lineStart, b.lineEnd]).toEqual([2, 4]);
  });

  it('substitutes this → enclosing class for this.method() calls', () => {
    const result = parseFile(
      '/repo/model.ts',
      `
        class Document {
          save() {
            this.validate()
            this.emit('save')
          }
          validate() {}
        }
      `,
    );

    expect(result).not.toBeNull();
    // this.validate() inside Document.save should produce Document.validate
    expect(result!.relationships).toContainEqual({
      srcName: 'Document.save',
      dstName: 'Document.validate',
      predicate: 'CALLS',
    });
    // this.emit() likewise
    expect(result!.relationships).toContainEqual({
      srcName: 'Document.save',
      dstName: 'Document.emit',
      predicate: 'CALLS',
    });
  });
});

describe('TypeScript class and interface heritage', () => {
  const extendsOf = (source: string) => parseFile('/repo/src/widgets.ts', source)!.relationships
    .filter(rel => rel.predicate === 'EXTENDS')
    .map(rel => [rel.srcName, rel.dstName]);

  it('extends a bare, generic or namespace-qualified class, as before', () => {
    expect(extendsOf('class A extends B {}\n')).toEqual([['A', 'B']]);
    expect(extendsOf('class A extends B<T> {}\n')).toEqual([['A', 'B']]);
    expect(extendsOf('class A extends ns.B {}\n')).toEqual([['A', 'ns.B']]);
    expect(extendsOf('abstract class A extends ns.B<T> {}\n')).toEqual([['A', 'ns.B']]);
  });

  it('implements bare, generic and namespace-qualified interfaces by name', () => {
    expect(extendsOf('class A implements I {}\n')).toEqual([['A', 'I']]);
    expect(extendsOf('class A implements I<T> {}\n')).toEqual([['A', 'I']]);
    expect(extendsOf('class A implements ns.I {}\n')).toEqual([['A', 'ns.I']]);
    expect(extendsOf('class A implements ns.I<T> {}\n')).toEqual([['A', 'ns.I']]);
    expect(extendsOf('abstract class A implements a.b.I<T>, J {}\n').sort()).toEqual([['A', 'J'], ['A', 'a.b.I']]);
    expect(extendsOf('class A extends B<T> implements I<T>, ns.J, ns.K<X>, L {}\n').sort())
      .toEqual([['A', 'B'], ['A', 'I'], ['A', 'L'], ['A', 'ns.J'], ['A', 'ns.K']]);
  });

  it('extends bare, generic and namespace-qualified interfaces by name', () => {
    expect(extendsOf('interface J extends I {}\n')).toEqual([['J', 'I']]);
    expect(extendsOf('interface J extends I<T> {}\n')).toEqual([['J', 'I']]);
    expect(extendsOf('interface J extends ns.I {}\n')).toEqual([['J', 'ns.I']]);
    expect(extendsOf('interface J extends I<T>, ns.K<X>, M {}\n').sort())
      .toEqual([['J', 'I'], ['J', 'M'], ['J', 'ns.K']]);
  });

  it('takes no edge from a type argument', () => {
    expect(extendsOf('class A implements I<Arg> {}\ninterface J extends K<Arg> {}\n').sort())
      .toEqual([['A', 'I'], ['J', 'K']]);
  });
});

// #1020: which calls cannot denote a module-level function of their name.
describe('TypeScript call scope flags', () => {
  /** `src -> dst` for each CALLS relationship, with the scope flags it carries. */
  function calls(source: string): Record<string, { memberCall?: true; localCallee?: true }> {
    const result = parseFile('/repo/scope.ts', source);
    expect(result).not.toBeNull();
    return Object.fromEntries(result!.relationships
      .filter(rel => rel.predicate === 'CALLS')
      .map(rel => [`${rel.srcName} -> ${rel.dstName}`, {
        ...(rel.memberCall ? { memberCall: true as const } : {}),
        ...(rel.localCallee ? { localCallee: true as const } : {}),
      }]));
  }

  it('marks a member call on a parameter, a local, this or super', () => {
    expect(calls([
      'export function validate(x: number) { return x; }',
      'export function useParam(conn: Conn) { conn.validate(); }',
      'export function useLocal() { const c = open(); c.pool[0].validate(); }',
      'export function useCatch() { try { run(); } catch (err) { err.validate(); } }',
      'export function useLoop(xs: Conn[]) { for (const x of xs) x.validate(); }',
      'export function useArrow() { return (c: Conn) => c.validate(); }',
      'class Base { validate() {} }',
      'export class Svc extends Base {',
      '  field = this.validate();',
      '  run() { this.validate(); super.validate(); }',
      '}',
    ].join('\n'))).toMatchObject({
      'useParam -> validate': { memberCall: true },
      'useLocal -> validate': { memberCall: true },
      'useCatch -> validate': { memberCall: true },
      'useLoop -> validate': { memberCall: true },
      'Svc.run -> validate': { memberCall: true },
    });
  });

  it('leaves a receiver that may be a module-scope name unmarked', () => {
    const flags = calls([
      "import * as ns from './ns';",
      'function validate(x: number) { return x; }',
      'const api = { validate };',
      'export function viaObject() { api.validate(); }',
      'export function viaNamespace() { ns.validate(); }',
      'export function viaGlobal() { window.validate(); }',
      "export function viaRequire() { require('./a').validate(); }",
      'export const literal = { run() { this.validate(); }, validate };',
      'export function plain() { this.validate(); }',
    ].join('\n'));
    // `this` outside a class (an object literal's method, a plain function) is not an instance.
    for (const caller of ['viaObject', 'viaNamespace', 'viaGlobal', 'viaRequire', 'literal', 'plain']) {
      expect(flags[`${caller} -> validate`], caller).toEqual({});
    }
  });

  it('does not mark a member call when one site in the scope may be a module-scope name', () => {
    expect(calls([
      'const api = { validate() {} };',
      'export function mixed(conn: Conn) { conn.validate(); api.validate(); }',
    ].join('\n'))['mixed -> validate']).toEqual({});
  });

  it('marks a plain call to a parameter or local, never to a module-scope name', () => {
    const flags = calls([
      "import { check } from './check';",
      'export function validate(x: number) { return x; }',
      'export function param(validate: (x: number) => number) { return validate(1); }',
      'export function arrowParam() { return [1].map(validate => validate(1)); }',
      'export function local() { const validate = pick(); return validate(1); }',
      'export function hoisted() { if (ok) { validate(1); } var validate = pick(); }',
      'export function nested(validate: Fn) { return () => validate(1); }',
      'export function imported() { return check(1) + validate(1); }',
      'export function shadowedImport(check: Fn) { return check(1); }',
      'export function blockOnly() { { const validate = pick(); } return validate(1); }',
    ].join('\n'));
    expect(flags).toMatchObject({
      'param -> validate': { localCallee: true },
      'local -> validate': { localCallee: true },
      'hoisted -> validate': { localCallee: true },
      'nested -> validate': { localCallee: true },
      'shadowedImport -> check': { localCallee: true },
    });
    expect(flags['imported -> check']).toEqual({});
    expect(flags['imported -> validate']).toEqual({});
    expect(flags['blockOnly -> validate']).toEqual({});
  });

  it('does not mark a call to a local function the parser extracts as an entity', () => {
    const result = parseFile('/repo/scope.ts', 'export function outer() {\n  const helper = () => 1;\n  return helper();\n}\n');
    expect(result!.entities.map(e => e.name)).toContain('helper');
    expect(calls('export function outer() {\n  const helper = () => 1;\n  return helper();\n}\n')['outer -> helper']).toEqual({});
  });

  it('leaves a local that holds a module unmarked', () => {
    const flags = calls([
      "export function lazy() { const api = require('./api'); api.validate(); }",
      "export async function dynamic() { const mod = await import('./api'); mod.validate(); }",
      "export function helper() { const sub = importModule('./api.js').sub; sub.validate(); }",
      "export function plain() { const conn = open(); conn.validate(); }",
    ].join('\n'));
    for (const caller of ['lazy', 'dynamic', 'helper']) expect(flags[`${caller} -> validate`], caller).toEqual({});
    expect(flags['plain -> validate']).toEqual({ memberCall: true });
  });

  it('treats a namespace body as module scope', () => {
    expect(calls('namespace N {\n  const api = make();\n  export function run() { api.validate(); }\n}\n')['run -> validate']).toEqual({});
  });
});
