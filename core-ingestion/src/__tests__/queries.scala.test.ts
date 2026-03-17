import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Scala queries', () => {
  it('captures class-level val and var definitions but not method-local vals', () => {
    const result = parseFile(
      '/repo/Foo.scala',
      `
        class Foo {
          val bar: String = "hello"
          var baz: NodeKind = NodeKind.File

          def method(): Unit = {
            val local = 42
          }
        }
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(entity => entity.name)).toContain('bar');
    expect(result!.entities.map(entity => entity.name)).toContain('baz');
    expect(result!.entities.map(entity => entity.name)).not.toContain('local');
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo',
      dstName: 'NodeKind',
      predicate: 'REFERENCES',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo.baz',
      dstName: 'NodeKind.File',
      predicate: 'CALLS',
    });
  });

  it('captures selective imports and singleton/member references', () => {
    const result = parseFile(
      '/repo/Imports.scala',
      `
        import ix.memory.model.{NodeId, NodeKind}

        object Imports {
          def choose(): NodeKind = NodeKind.File
          def use(value: NodeId): NodeId = value
        }
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Imports.scala',
      dstName: 'ix.memory.model.NodeId',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Imports.scala',
      dstName: 'ix.memory.model.NodeKind',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Imports.choose',
      dstName: 'NodeKind.File',
      predicate: 'CALLS',
    });
  });
});
