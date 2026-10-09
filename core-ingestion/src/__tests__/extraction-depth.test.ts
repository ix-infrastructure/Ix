// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { buildPatchWithResolution } from '../patch-builder.js';
import { classifyFileRole } from '../role-classifier.js';

/**
 * Extraction depth: what the parser used to leave out of a TypeScript file,
 * parse errors it said nothing about, and file roles it got wrong.
 */

const SAMPLE = `import { Base } from './base';
export type Alias = { a: number };
export enum Color { Red, Green }
export abstract class Shape extends Base<Alias> {
  abstract area(): number;
  draw = () => 1;
}
export namespace NS {
  export function inner() { return 1; }
}
export function over(a: string): string;
export function over(a: number): number;
export function over(a: any): any { return a; }
export class K extends NS.Deep {}
export function uses(c: Color, p: Promise<Alias>, xs: Alias[], m: Alias | null, mm: Map<string, Alias>): void {
  const z = p as unknown as Alias;
}
`;

describe('TypeScript extraction', () => {
  for (const file of ['/repo/sample.ts', '/repo/sample.tsx']) {
    it(`type aliases, enums, abstract classes, namespaces and their members are nodes (${file.slice(-3)})`, () => {
      const r = parseFile(file, SAMPLE)!;
      const byName = new Map(r.entities.map(e => [e.name, e]));
      for (const name of ['Alias', 'Color', 'Shape', 'NS', 'area', 'draw', 'inner', 'over', 'K', 'uses']) {
        expect(byName.has(name), name).toBe(true);
      }
      expect(byName.get('area')!.container).toBe('Shape');
      expect(byName.get('draw')!.container).toBe('Shape');
    });

    it(`extends and type positions produce edges (${file.slice(-3)})`, () => {
      const rels = parseFile(file, SAMPLE)!.relationships;
      expect(rels).toContainEqual({ srcName: 'Shape', dstName: 'Base', predicate: 'EXTENDS' });
      expect(rels).toContainEqual({ srcName: 'K', dstName: 'NS.Deep', predicate: 'EXTENDS' });
      // Promise<Alias>, Alias[], Alias | null, Map<string, Alias>, `as Alias`: one edge.
      expect(rels).toContainEqual({ srcName: 'uses', dstName: 'Alias', predicate: 'REFERENCES' });
      expect(rels).toContainEqual({ srcName: 'uses', dstName: 'Color', predicate: 'REFERENCES' });
      // `extends Base<Alias>`
      expect(rels.some(rel => rel.predicate === 'REFERENCES' && rel.dstName === 'Alias' && rel.srcName.startsWith('Shape'))).toBe(true);
      // Builtins stay out.
      expect(rels.some(rel => rel.dstName === 'Promise' || rel.dstName === 'Map')).toBe(false);
    });
  }
});

describe('TypeScript overloads', () => {
  it('are one function, spanning the implementation', () => {
    const r = parseFile('/repo/over.ts', [
      'export function over(a: string): string;',
      'export function over(a: number): number;',
      'export function over(a: any): any {',
      '  return a;',
      '}',
    ].join('\n'))!;
    const over = r.entities.filter(e => e.name === 'over');
    expect(over.map(e => [e.lineStart, e.lineEnd])).toEqual([[3, 5]]);
    expect(r.chunks.filter(c => c.name === 'over').map(c => [c.lineStart, c.lineEnd])).toEqual([[3, 5]]);
  });

  it('without an implementation (declare, .d.ts) are one function at the first signature', () => {
    const r = parseFile('/repo/over.d.ts', [
      'export declare function over(a: string): string;',
      'export declare function over(a: number): number;',
    ].join('\n'))!;
    expect(r.entities.filter(e => e.name === 'over').map(e => e.lineStart)).toEqual([1]);
  });
});

describe('parse errors', () => {
  it('flags a file tree-sitter had to recover, and puts it on the file node', () => {
    const broken = parseFile('/repo/broken.ts', 'export function ok() { return 1; }\nexport function bad( {\n')!;
    expect(broken.hasParseErrors).toBe(true);
    const fileNode = buildPatchWithResolution(broken, 'h', 'ws', []).ops
      .find(op => op.type === 'UpsertNode' && op.kind === 'file') as { attrs: Record<string, unknown> };
    expect(fileNode.attrs.parse_errors).toBe(true);
  });

  it('says nothing about a clean file', () => {
    const clean = parseFile('/repo/clean.ts', 'export function ok() { return 1; }\n')!;
    expect('hasParseErrors' in clean).toBe(false);
    const fileNode = buildPatchWithResolution(clean, 'h', 'ws', []).ops
      .find(op => op.type === 'UpsertNode' && op.kind === 'file') as { attrs: Record<string, unknown> };
    expect('parse_errors' in fileNode.attrs).toBe(false);
  });
});

describe('Java varargs annotations are blanked, not deleted', () => {
  it('keeps byte offsets after the annotation', () => {
    const source = [
      'package com.example;',
      'public final class P {',
      '  public static void check(@Nullable Object @Nullable ... args) {}',
      '  public static void after() {}',
      '}',
      '',
    ].join('\n');
    const r = parseFile('/repo/P.java', source)!;
    const chunk = r.chunks.find(c => c.name === 'after')!;
    expect(source.slice(chunk.startByte, chunk.endByte)).toContain('void after()');
  });
});

describe('file roles on workspace-relative paths', () => {
  const role = (path: string, source?: string) => classifyFileRole(path, source).role;

  it('root-level directories count', () => {
    expect(role('tests/test_models.py')).toBe('test');
    expect(role('tests/helpers.py')).toBe('test');
    expect(role('src/tests/helpers.py')).toBe('test');
    expect(role('vendor/lib/x.go')).toBe('external');
    expect(role('fixtures/data.json')).toBe('fixture');
    expect(role('scripts/release.sh')).toBe('tooling');
    expect(role('test/fixtures/user.json')).toBe('fixture');
  });

  it('pytest conventions are tests', () => {
    expect(role('pkg/test_models.py')).toBe('test');
    expect(role('conftest.py')).toBe('test');
  });

  it('no longer misfires', () => {
    expect(role('src/config.ts', 'if (env === "testing") {}')).toBe('production');
    expect(role('pkg/api/PodSpec.go')).toBe('production');
    expect(role('api/spec/openapi.yaml')).toBe('production');
    expect(role('src/audio/resample.py')).toBe('production');
    expect(role('src/db/seed.ts')).toBe('production');
    expect(role('src/audio/SampleRate.java')).toBe('production');
    expect(role('src/tools/search.ts')).toBe('tooling');
  });

  it('still catches what it should', () => {
    expect(role('pkg/x/x_test.go', 'package x\n\nimport "testing"\n')).toBe('test');
    expect(role('pkg/x/util.go', 'package x\n\nimport (\n  "fmt"\n  "testing"\n)\n')).toBe('test');
    expect(role('src/test/scala/FooSpec.scala')).toBe('test');
    expect(role('src/FakeClock.java')).toBe('fixture');
    expect(role('src/Stubborn.java')).toBe('production');
    expect(role('spec/models/user_spec.rb')).toBe('test');
  });

  it('reports only the winning bucket\'s signals', () => {
    const r = classifyFileRole('test/fixtures/user.json');
    expect(r.role).toBe('fixture');
    expect(r.role_signals).toEqual(['path:fixtures/']);
  });
});
