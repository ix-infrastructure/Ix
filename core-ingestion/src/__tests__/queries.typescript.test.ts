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
