// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges } from '../index.js';
import { buildPatchWithResolution, symbolNodeId } from '../patch-builder.js';

/** Where each EXTENDS edge of `srcPath` resolves: `src -> dstFile:dstKey`. */
function heritage(files: Record<string, string>, srcPath: string): string[] {
  const parsed = Object.entries(files).map(([filePath, source]) => parseFile(filePath, source)!);
  return resolveEdges(parsed)
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

  it('links a JavaScript class expression to its imported base', () => {
    const widget = '/repo/src/widget.js';
    expect(patchedExtends({
      '/repo/src/base.js': 'export class Base {}\n',
      [widget]: "import { Base } from './base';\nexport const Widget = class extends Base {};\n",
    }, widget)).toEqual([`${id(widget, 'Widget')} -> ${id('/repo/src/base.js', 'Base')}`]);
  });
});
