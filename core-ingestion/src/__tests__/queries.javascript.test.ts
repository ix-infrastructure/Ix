// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

const parse = (source: string) => parseFile('/repo/src/widgets.js', source)!;
const extendsOf = (source: string) => parse(source).relationships
  .filter(rel => rel.predicate === 'EXTENDS')
  .map(rel => [rel.srcName, rel.dstName]);

describe('JavaScript class heritage', () => {
  it('extends a bare base, as before', () => {
    expect(extendsOf('class A extends B {}\n')).toEqual([['A', 'B']]);
  });

  it('extends a member-expression base by its dotted name', () => {
    expect(extendsOf('class A extends ns.B {}\n')).toEqual([['A', 'ns.B']]);
    expect(extendsOf('class Panel extends React.Component {}\n')).toEqual([['Panel', 'React.Component']]);
    expect(extendsOf('export class Deep extends a.b.C {}\n')).toEqual([['Deep', 'a.b.C']]);
  });

  it('extends nothing for a call-expression base', () => {
    expect(extendsOf('class A extends mixin(Base) {}\n')).toEqual([]);
  });

  it('extends from a class expression under the name it is bound to', () => {
    expect(extendsOf('const A = class extends B {};\n')).toEqual([['A', 'B']]);
    expect(extendsOf('const A = class Named extends B {};\n')).toEqual([['A', 'B']]);
    expect(extendsOf('let A = class extends ns.B {};\n')).toEqual([['A', 'ns.B']]);
    expect(extendsOf('var A = class extends B {};\n')).toEqual([['A', 'B']]);
    expect(extendsOf('export const A = class extends B {};\n')).toEqual([['A', 'B']]);
    expect(extendsOf('function make() {\n  const Local = class extends B {};\n  return Local;\n}\n'))
      .toEqual([['Local', 'B']]);
    expect(extendsOf('const A = class {};\n')).toEqual([]);
  });

  it('makes a bound class expression one class that contains its methods', () => {
    const result = parse([
      'const A = class Named extends B {',
      '  run() { return 1; }',
      '};',
      'export const E = class {};',
      'const LIMIT = 3;',
      '',
    ].join('\n'));
    const byName = (name: string) => result.entities.filter(entity => entity.name === name);
    expect(byName('A').map(entity => entity.kind)).toEqual(['class']);
    expect(byName('E').map(entity => entity.kind)).toEqual(['class']);
    expect(byName('Named')).toEqual([]);
    expect(byName('run').map(entity => entity.container)).toEqual(['A']);
    // Other module-level constants are unchanged.
    expect(byName('LIMIT').map(entity => entity.kind)).toEqual(['constant']);
  });
});
