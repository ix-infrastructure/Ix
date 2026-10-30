// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';
import { buildPatchWithResolution, symbolNodeId } from '../patch-builder.js';

/** Where each EXTENDS edge of `srcPath` resolves: `src -> dstFile:dstKey`. */
function heritage(files: Record<string, string>, srcPath: string, opts?: Parameters<typeof resolveEdges>[3]): string[] {
  const parsed = Object.entries(files).map(([filePath, source]) => parseFile(filePath, source)!);
  return resolveEdges(parsed, undefined, undefined, opts)
    .filter(edge => edge.predicate === 'EXTENDS' && edge.srcFilePath === srcPath)
    .map(edge => `${edge.srcName} ${edge.dstName} -> ${edge.dstFilePath}:${edge.dstQualifiedKey}`)
    .sort();
}

describe('EXTENDS resolution for Python bases', () => {
  const base = {
    '/repo/pkg/__init__.py': '',
    '/repo/pkg/base.py': 'class Base:\n    pass\n',
    '/repo/app/__init__.py': '',
    '/repo/app/models.py': 'class Model:\n    pass\n\nclass Outer:\n    class Inner:\n        pass\n',
  };

  it('resolves a bare imported base, as before', () => {
    expect(heritage({
      ...base,
      '/repo/app/user.py': 'from .models import Model\n\nclass User(Model):\n    pass\n',
    }, '/repo/app/user.py')).toEqual(['User Model -> /repo/app/models.py:Model']);
  });

  it('resolves a base qualified by a relatively imported module', () => {
    expect(heritage({
      ...base,
      '/repo/app/user.py': 'from . import models\n\nclass User(models.Model):\n    pass\n',
    }, '/repo/app/user.py')).toEqual(['User models.Model -> /repo/app/models.py:Model']);
  });

  it('resolves a base qualified by an absolutely imported module', () => {
    expect(heritage({
      ...base,
      '/repo/app/user.py': [
        'from pkg import base',
        'import pkg.base',
        '',
        'class A(base.Base):',
        '    pass',
        '',
        'class B(pkg.base.Base):',
        '    pass',
        '',
      ].join('\n'),
    }, '/repo/app/user.py')).toEqual([
      'A base.Base -> /repo/pkg/base.py:Base',
      'B pkg.base.Base -> /repo/pkg/base.py:Base',
    ]);
  });

  it('resolves generic bases by their subscripted name', () => {
    expect(heritage({
      ...base,
      '/repo/app/user.py': [
        'from typing import Generic, TypeVar',
        'from . import models',
        'from .models import Model',
        '',
        'class Box(Generic[T]):',
        '    pass',
        '',
        'class IntBox(Box[int]):',
        '    pass',
        '',
        'class A(Model[T]):',
        '    pass',
        '',
        'class B(models.Model[T]):',
        '    pass',
        '',
      ].join('\n'),
    }, '/repo/app/user.py')).toEqual([
      'A Model -> /repo/app/models.py:Model',
      'B models.Model -> /repo/app/models.py:Model',
    ]);
  });

  it('resolves each base of a mixed list and ignores keyword arguments', () => {
    const files = {
      ...base,
      '/repo/app/meta.py': 'class Meta(type):\n    pass\n',
      '/repo/app/user.py': [
        'from pkg import base',
        'from . import models',
        'from .models import Outer',
        'from .meta import Meta',
        '',
        'class User(models.Model, base.Base[T], Outer.Inner, metaclass=Meta, total=False):',
        '    pass',
        '',
      ].join('\n'),
    };
    expect(heritage(files, '/repo/app/user.py')).toEqual([
      'User Outer.Inner -> /repo/app/models.py:Outer.Inner',
      'User base.Base -> /repo/pkg/base.py:Base',
      'User models.Model -> /repo/app/models.py:Model',
    ]);
    const parsed = parseFile('/repo/app/user.py', files['/repo/app/user.py'])!;
    expect(parsed.relationships.some(rel => rel.predicate === 'EXTENDS' && rel.dstName === 'Meta')).toBe(false);
  });

  it('leaves an external nn.Module unresolved beside an in-repo Module and nn.py', () => {
    expect(heritage({
      '/repo/app/__init__.py': '',
      '/repo/app/module.py': 'class Module:\n    pass\n',
      '/repo/app/nn.py': 'class Module:\n    pass\n',
      '/repo/app/attention.py': [
        'import torch',
        'from torch import nn',
        '',
        'class Attention(nn.Module):',
        '    pass',
        '',
        'class Block(torch.nn.Module):',
        '    pass',
        '',
      ].join('\n'),
    }, '/repo/app/attention.py')).toEqual([]);
  });

  it('does not resolve a module-qualified base the file never imports', () => {
    expect(heritage({
      ...base,
      '/repo/app/user.py': 'class User(models.Model):\n    pass\n',
    }, '/repo/app/user.py')).toEqual([]);
  });
});

describe('EXTENDS resolution for JavaScript bases', () => {
  it('resolves a bare imported base from a class declaration or a bound class expression', () => {
    expect(heritage({
      '/repo/src/base.js': 'export class Base {}\n',
      '/repo/src/widget.js': [
        "import { Base } from './base';",
        'class A extends Base {}',
        'const B = class extends Base {};',
        'let C = class Named extends Base {};',
        '',
      ].join('\n'),
    }, '/repo/src/widget.js')).toEqual([
      'A Base -> /repo/src/base.js:Base',
      'B Base -> /repo/src/base.js:Base',
      'C Base -> /repo/src/base.js:Base',
    ]);
  });

  it('leaves an external React.Component unresolved beside an in-repo Component', () => {
    expect(heritage({
      '/repo/src/Component.js': 'export class Component {}\n',
      '/repo/src/panel.js': [
        "import React from 'react';",
        'export class Panel extends React.Component {}',
        'export const Card = class extends React.Component {};',
        '',
      ].join('\n'),
    }, '/repo/src/panel.js')).toEqual([]);
  });
});

describe('EXTENDS resolution for TypeScript bases', () => {
  const base = {
    '/repo/src/base.ts': [
      'export class Base<T = unknown> {}',
      'export interface I<T = unknown> {}',
      'export interface K {}',
      '',
    ].join('\n'),
    '/repo/src/barrel.ts': "export * as ns from './base';\n",
  };

  it('resolves a namespace-qualified class base through import * as ns', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': [
        "import * as ns from './base';",
        'export class A extends ns.Base {}',
        'export abstract class B extends ns.Base<string> {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([
      'A ns.Base -> /repo/src/base.ts:Base',
      'B ns.Base -> /repo/src/base.ts:Base',
    ]);
  });

  it('resolves a namespace-qualified base through a named import of a module', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': "import { ns } from './barrel';\nexport class A extends ns.Base implements ns.I<number> {}\n",
    }, '/repo/src/widget.ts')).toEqual([
      'A ns.Base -> /repo/src/base.ts:Base',
      'A ns.I -> /repo/src/base.ts:I',
    ]);
  });

  it('resolves bare and generic bases, as before', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': [
        "import { Base } from './base';",
        'export class A extends Base {}',
        'export class B extends Base<number> {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([
      'A Base -> /repo/src/base.ts:Base',
      'B Base -> /repo/src/base.ts:Base',
    ]);
  });

  it('resolves generic, namespace-qualified and listed implemented interfaces', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': [
        "import * as ns from './base.js';",
        "import { I, K } from './base';",
        'export class A implements I<string> {}',
        'export class B implements ns.I {}',
        'export class C implements ns.I<number> {}',
        'export class D extends ns.Base<T> implements I<T>, ns.K {}',
        'export abstract class E implements ns.I<T>, K {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([
      'A I -> /repo/src/base.ts:I',
      'B ns.I -> /repo/src/base.ts:I',
      'C ns.I -> /repo/src/base.ts:I',
      'D I -> /repo/src/base.ts:I',
      'D ns.Base -> /repo/src/base.ts:Base',
      'D ns.K -> /repo/src/base.ts:K',
      'E K -> /repo/src/base.ts:K',
      'E ns.I -> /repo/src/base.ts:I',
    ]);
  });

  it('resolves generic, namespace-qualified and listed interface bases', () => {
    expect(heritage({
      ...base,
      '/repo/src/shapes.ts': [
        "import * as ns from './base';",
        "import type { I, K } from './base';",
        'export interface J1 extends I<string> {}',
        'export interface J2 extends ns.I {}',
        'export interface J3 extends ns.I<number>, K, ns.K {}',
        '',
      ].join('\n'),
    }, '/repo/src/shapes.ts')).toEqual([
      'J1 I -> /repo/src/base.ts:I',
      'J2 ns.I -> /repo/src/base.ts:I',
      'J3 K -> /repo/src/base.ts:K',
      'J3 ns.I -> /repo/src/base.ts:I',
      'J3 ns.K -> /repo/src/base.ts:K',
    ]);
  });

  it('never lands a qualified base on a same-named type the namespace does not hold', () => {
    expect(heritage({
      ...base,
      '/repo/src/other.ts': 'export class Widget {}\nexport interface Shape {}\n',
      '/repo/src/widget.ts': [
        "import * as ns from './base';",
        "import * as other from './other';",
        'export class A extends ns.Widget implements ns.Shape {}',
        'export class B extends missing.Widget implements missing.Shape {}',
        'export interface J extends ns.Shape, missing.Shape {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([]);
  });

  it('leaves an external base unresolved beside in-repo same-named types', () => {
    expect(heritage({
      '/repo/src/Component.ts': 'export class Component {}\nexport interface OnInit {}\nexport interface Props {}\n',
      '/repo/src/panel.ts': [
        "import * as React from 'react';",
        "import * as core from '@angular/core';",
        "import { OnInit } from '@angular/core';",
        'export class Panel extends React.Component<Props> implements core.OnInit, OnInit {}',
        'export interface PanelProps extends React.Props<Panel> {}',
        '',
      ].join('\n'),
    }, '/repo/src/panel.ts')).toEqual([]);
  });
  it('never binds an external namespace to an in-repo file by its stem', () => {
    const files = {
      '/repo/src/react.ts': 'export class Component {}\n',
      '/repo/src/core/index.ts': 'export interface OnInit {}\n',
      '/repo/src/panel.ts': [
        "import * as React from 'react';",
        "import * as core from '@angular/core';",
        'export class Panel extends React.Component implements core.OnInit {}',
        '',
      ].join('\n'),
    };
    expect(heritage(files, '/repo/src/panel.ts')).toEqual([]);
    expect(heritage(files, '/repo/src/panel.ts', { resolveModuleSpecifier: () => undefined })).toEqual([]);
  });

  it('resolves a namespace the workspace resolver maps to an in-repo module', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': "import * as models from '@acme/models';\nexport class A extends models.Base {}\n",
    }, '/repo/src/widget.ts', {
      resolveModuleSpecifier: (_source, specifier) => specifier === '@acme/models' ? ['/repo/src/base.ts'] : undefined,
    })).toEqual(['A models.Base -> /repo/src/base.ts:Base']);
  });

  it('does not treat export * as ns as a binding in its own file', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.ts': "export * as ns from './base';\nexport class A extends ns.Base {}\n",
    }, '/repo/src/widget.ts')).toEqual([]);
  });

  it('resolves a namespace base a barrel re-exports', () => {
    const models = {
      '/repo/src/models/base.ts': 'export class Base {}\nexport interface I<T> {}\n',
      '/repo/src/models/shape.ts': 'export interface Shape {}\n',
      '/repo/src/models/index.ts': "export * from './base';\nexport { Shape } from './shape';\n",
    };
    expect(heritage({
      ...models,
      '/repo/src/widget.ts': [
        "import * as models from './models';",
        'export class A extends models.Base implements models.I<string>, models.Shape {}',
        'export class B extends models.Missing {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([
      'A models.Base -> /repo/src/models/base.ts:Base',
      'A models.I -> /repo/src/models/base.ts:I',
      'A models.Shape -> /repo/src/models/shape.ts:Shape',
    ]);
  });

  it('never lands an unimported generic or bare base on a same-named module type', () => {
    expect(heritage({
      '/repo/src/lib/iter.ts': 'export interface Iterable<T> {}\nexport class Repository<T> {}\nexport interface Plain {}\n',
      '/repo/src/widget.ts': [
        'export class A implements Iterable<number> {}',
        'export class B extends Repository<User> {}',
        'export interface C extends Iterable<number>, Plain {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.ts')).toEqual([]);
  });

  it('still resolves an unimported base to an in-repo ambient declaration', () => {
    expect(heritage({
      '/repo/src/lib/iter.ts': 'export interface Iterable<T> {}\n',
      '/repo/types/globals.d.ts': 'interface Plugin<T> {}\ndeclare class Widget {}\n',
      '/repo/src/widget.ts': 'export class A extends Widget implements Plugin<number>, Iterable<number> {}\n',
    }, '/repo/src/widget.ts')).toEqual([
      'A Plugin -> /repo/types/globals.d.ts:Plugin',
      'A Widget -> /repo/types/globals.d.ts:Widget',
    ]);
  });
});

describe('EXTENDS resolution for JavaScript namespace bases', () => {
  const base = { '/repo/src/base.js': 'export class Base {}\n', '/repo/src/other.js': 'export class Other {}\n' };

  it('resolves ns.Base through import * as ns', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.js': [
        "import * as ns from './base.js';",
        'class A extends ns.Base {}',
        'const B = class extends ns.Base {};',
        '',
      ].join('\n'),
    }, '/repo/src/widget.js')).toEqual([
      'A ns.Base -> /repo/src/base.js:Base',
      'B ns.Base -> /repo/src/base.js:Base',
    ]);
  });

  it('resolves ns.Base through const ns = require()', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.js': "const ns = require('./base');\nclass A extends ns.Base {}\n",
    }, '/repo/src/widget.js')).toEqual(['A ns.Base -> /repo/src/base.js:Base']);
  });

  it('resolves ns.Base through a barrel that re-exports it', () => {
    expect(heritage({
      ...base,
      '/repo/src/index.js': "export * from './base.js';\n",
      '/repo/src/widget.js': "import * as ns from './index.js';\nclass A extends ns.Base {}\n",
    }, '/repo/src/widget.js')).toEqual(['A ns.Base -> /repo/src/base.js:Base']);
  });

  it('never resolves ns.Other to a module the namespace is not', () => {
    expect(heritage({
      ...base,
      '/repo/src/widget.js': [
        "const ns = require('./base');",
        "const lib = require('lib');",
        "import { Other } from './other.js';",
        'class A extends ns.Other {}',
        'class B extends lib.Base {}',
        'class C extends missing.Base {}',
        '',
      ].join('\n'),
    }, '/repo/src/widget.js')).toEqual([]);
  });
});

describe('EXTENDS edges in the patch', () => {
  /** The EXTENDS edges `srcPath`'s patch writes, as `srcId -> dstId`. */
  function patchedExtends(files: Record<string, string>, srcPath: string): string[] {
    const parsed = Object.entries(files).map(([filePath, source]) => parseFile(filePath, source)!);
    const src = parsed.find(result => result.filePath === srcPath)!;
    const edges = resolveEdges(parsed).filter(edge => edge.srcFilePath === srcPath);
    return buildPatchWithResolution(src, 'h', 'ws', edges).ops
      .filter((op: any) => op.type === 'UpsertEdge' && op.predicate === 'EXTENDS')
      .map((op: any) => `${op.src} -> ${op.dst}`)
      .sort();
  }
  const id = (filePath: string, key: string) => symbolNodeId('ws', filePath, key);

  it('links a Python class to its module-qualified, generic and same-file bases', () => {
    const user = '/repo/app/user.py';
    expect(patchedExtends({
      '/repo/app/__init__.py': '',
      '/repo/app/models.py': 'class Model:\n    pass\n',
      [user]: [
        'from . import models',
        'from torch import nn',
        '',
        'class Box:',
        '    pass',
        '',
        'class User(models.Model, Box[int], nn.Module):',
        '    pass',
        '',
      ].join('\n'),
    }, user)).toEqual([
      `${id(user, 'User')} -> ${id('/repo/app/models.py', 'Model')}`,
      `${id(user, 'User')} -> ${id(user, 'Box')}`,
    ].sort());
  });

  it('links a TypeScript class to its namespace-qualified and generic bases', () => {
    const widget = '/repo/src/widget.ts';
    const base = '/repo/src/base.ts';
    expect(patchedExtends({
      [base]: 'export class Base {}\nexport interface I<T> {}\n',
      [widget]: "import * as ns from './base';\nexport class Widget extends ns.Base implements ns.I<number> {}\n",
    }, widget)).toEqual([
      `${id(widget, 'Widget')} -> ${id(base, 'Base')}`,
      `${id(widget, 'Widget')} -> ${id(base, 'I')}`,
    ].sort());
  });

  it('links a JavaScript class expression to its imported base', () => {
    const widget = '/repo/src/widget.js';
    expect(patchedExtends({
      '/repo/src/base.js': 'export class Base {}\n',
      [widget]: "import { Base } from './base';\nexport const Widget = class extends Base {};\n",
    }, widget)).toEqual([`${id(widget, 'Widget')} -> ${id('/repo/src/base.js', 'Base')}`]);
  });
});
