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
      predicate: 'IMPLEMENTS',
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
  const heritageOf = (source: string, predicate = 'EXTENDS') => parseFile('/repo/src/widgets.ts', source)!.relationships
    .filter(rel => rel.predicate === predicate)
    .map(rel => [rel.srcName, rel.dstName]);

  it('extends a bare, generic or namespace-qualified class, as before', () => {
    expect(heritageOf('class A extends B {}\n')).toEqual([['A', 'B']]);
    expect(heritageOf('class A extends B<T> {}\n')).toEqual([['A', 'B']]);
    expect(heritageOf('class A extends ns.B {}\n')).toEqual([['A', 'ns.B']]);
    expect(heritageOf('abstract class A extends ns.B<T> {}\n')).toEqual([['A', 'ns.B']]);
  });

  it('implements bare, generic and namespace-qualified interfaces by name', () => {
    expect(heritageOf('class A implements I {}\n', 'IMPLEMENTS')).toEqual([['A', 'I']]);
    expect(heritageOf('class A implements I<T> {}\n', 'IMPLEMENTS')).toEqual([['A', 'I']]);
    expect(heritageOf('class A implements ns.I {}\n', 'IMPLEMENTS')).toEqual([['A', 'ns.I']]);
    expect(heritageOf('class A implements ns.I<T> {}\n', 'IMPLEMENTS')).toEqual([['A', 'ns.I']]);
    expect(heritageOf('abstract class A implements a.b.I<T>, J {}\n', 'IMPLEMENTS').sort()).toEqual([['A', 'J'], ['A', 'a.b.I']]);
    expect(heritageOf('class A extends B<T> implements I<T>, ns.J, ns.K<X>, L {}\n', 'IMPLEMENTS').sort())
      .toEqual([['A', 'I'], ['A', 'L'], ['A', 'ns.J'], ['A', 'ns.K']]);
  });

  it('extends bare, generic and namespace-qualified interfaces by name', () => {
    expect(heritageOf('interface J extends I {}\n')).toEqual([['J', 'I']]);
    expect(heritageOf('interface J extends I<T> {}\n')).toEqual([['J', 'I']]);
    expect(heritageOf('interface J extends ns.I {}\n')).toEqual([['J', 'ns.I']]);
    expect(heritageOf('interface J extends I<T>, ns.K<X>, M {}\n').sort())
      .toEqual([['J', 'I'], ['J', 'M'], ['J', 'ns.K']]);
  });

  it('takes no edge from a type argument', () => {
    const source = 'class A implements I<Arg> {}\ninterface J extends K<Arg> {}\n';
    expect(heritageOf(source)).toEqual([['J', 'K']]);
    expect(heritageOf(source, 'IMPLEMENTS')).toEqual([['A', 'I']]);
  });
});
