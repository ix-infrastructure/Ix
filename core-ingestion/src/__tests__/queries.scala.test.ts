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
    // Attributed to the val that holds the reference, not its enclosing class --
    // matching the `Foo.baz` CALLS expectation directly below, which this one
    // used to contradict by expecting the coarser `Foo` (#557).
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo.baz',
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

  it('extracts modules and plugin imports from an .sbt build definition', () => {
    const result = parseFile(
      '/repo/build.sbt',
      `import sbtassembly.MergeStrategy

ThisBuild / scalaVersion := "2.13.16"

lazy val commonSettings = Seq(scalacOptions ++= Seq("-Wunused:all"))

lazy val core = (project in file("core"))
  .settings(commonSettings, name := "ix-memory-core")

lazy val root = (project in file(".")).aggregate(core)
`,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['commonSettings', 'core', 'root']),
    );
    expect(
      result!.relationships
        .filter((relationship) => relationship.predicate === 'IMPORTS')
        .map((relationship) => relationship.dstName),
    ).toEqual(expect.arrayContaining(['sbtassembly.MergeStrategy']));
  });

  it('still ignores method-local val bindings', () => {
    // The top-level val query must not reopen the noise the template_body
    // restriction was written to prevent.
    const result = parseFile(
      '/repo/Local.scala',
      `object Service {
  def run(): Int = {
    val localBinding = 41
    localBinding + 1
  }
}
`,
    );

    expect(result!.entities.map((entity) => entity.name)).not.toContain('localBinding');
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['Service', 'run']),
    );
  });

});
