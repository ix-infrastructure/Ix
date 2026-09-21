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
