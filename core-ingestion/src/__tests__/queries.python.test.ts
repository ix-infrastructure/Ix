// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Python queries', () => {
  it('captures classes, functions, imports, inheritance, and attribute calls', () => {
    const result = parseFile(
      '/repo/example.py',
      `
from .models import User
from package.helpers import helper

class Service(BaseService):
    def run(self, value: User):
        helper()
        value.save()

def top_level():
    return Service()
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(entity => entity.name)).toEqual(
      expect.arrayContaining(['Service', 'run', 'top_level']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'example.py',
      dstName: 'models',
      predicate: 'IMPORTS',
      importRaw: '.models',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'example.py',
      dstName: 'User',
      predicate: 'IMPORTS',
    });
    expect(result!.importBindings).toContainEqual({
      pkg: '.models',
      local: 'User',
      imported: 'User',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'example.py',
      dstName: 'package.helpers',
      predicate: 'IMPORTS',
      importRaw: 'package.helpers',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Service',
      dstName: 'BaseService',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'helper',
      predicate: 'CALLS',
      bareCall: true,
    });
    // `value` is a parameter, so `value.save()` is a method call: never a
    // module-level `save` (#1020).
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'save',
      predicate: 'CALLS',
      memberCall: true,
    });
    // The qualifier pattern also emits the fully-qualified form so Tier-1b
    // resolution can resolve e.g. Session.execute → session.py when the
    // qualifier is a class name present in the caller's imports. Inside a
    // method too, a typed parameter's qualifier is its declared type.
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'User.save',
      predicate: 'CALLS',
    });
  });

  it('preserves the module path for from-dot imports', () => {
    const result = parseFile(
      '/repo/pkg/caller.py',
      'from . import utils\n\ndef caller():\n    return utils.target()\n',
    );

    expect(result!.relationships).toContainEqual({
      srcName: 'caller.py',
      dstName: 'utils',
      predicate: 'IMPORTS',
      importRaw: '.utils',
    });
    expect(result!.importBindings).toContainEqual({
      pkg: '.utils',
      local: 'utils',
      imported: 'utils',
    });
  });

  it('preserves Python from-import aliases as local bindings', () => {
    const result = parseFile(
      '/repo/pkg/caller.py',
      'from .utils import target as local\n\ndef caller():\n    return local()\n',
    );

    expect(result!.importBindings).toContainEqual({
      pkg: '.utils',
      local: 'local',
      imported: 'target',
    });
  });

  it('resolves qualifier from constructor call assignment (Pattern 1)', () => {
    const result = parseFile(
      '/repo/views.py',
      `
def my_view(request):
    conn = MyClass()
    conn.execute()
      `,
    );

    expect(result).not.toBeNull();
    // Constructor call itself: MyClass()
    expect(result!.relationships).toContainEqual({
      srcName: 'my_view',
      dstName: 'MyClass',
      predicate: 'CALLS',
      bareCall: true,
    });
    // conn resolved to MyClass via assignTypeMap → MyClass.execute
    expect(result!.relationships).toContainEqual({
      srcName: 'my_view',
      dstName: 'MyClass.execute',
      predicate: 'CALLS',
    });
    // bare callee edge is also emitted, on a local receiver (#1020)
    expect(result!.relationships).toContainEqual({
      srcName: 'my_view',
      dstName: 'execute',
      predicate: 'CALLS',
      memberCall: true,
    });
  });

  it('substitutes typed and constructor-assigned receivers inside a method', () => {
    const result = parseFile(
      '/repo/service.py',
      `
class Service:
    def run(self, q: Query, limit: int = 10):
        x = Builder()
        q.filter()
        x.build()
      `,
    );

    expect(result).not.toBeNull();
    const calls = result!.relationships.filter(r => r.predicate === 'CALLS' && r.srcName === 'Service.run');
    expect(calls).toContainEqual({ srcName: 'Service.run', dstName: 'Query.filter', predicate: 'CALLS' });
    expect(calls).toContainEqual({ srcName: 'Service.run', dstName: 'Builder.build', predicate: 'CALLS' });
    expect(calls.map(c => c.dstName)).not.toContain('q.filter');
    expect(calls.map(c => c.dstName)).not.toContain('x.build');
  });

  it('records import a.b as m as an IMPORTS edge and a module alias', () => {
    const result = parseFile(
      '/repo/app/main.py',
      'import pkg.sub.mod as m\nimport os.path\n\ndef main():\n    return m.load()\n',
    );

    expect(result!.relationships).toContainEqual({
      srcName: 'main.py',
      dstName: 'pkg.sub.mod',
      predicate: 'IMPORTS',
      importRaw: 'pkg.sub.mod',
      importAliased: true,
    });
    // The unaliased import carries no flag: it keeps the stem fallback.
    expect(result!.relationships).toContainEqual({ srcName: 'main.py', dstName: 'os.path', predicate: 'IMPORTS', importRaw: 'os.path' });
    expect(result!.importAliases).toEqual({ m: 'pkg.sub.mod' });
    expect(result!.relationships).toContainEqual({ srcName: 'main', dstName: 'm.load', predicate: 'CALLS' });
  });

  it('emits REFERENCES edge for class passed as keyword argument value', () => {
    const result = parseFile(
      '/repo/admin/sites.py',
      `
class AdminSite:
    def login(self, request):
        return LoginView.as_view(authentication_form=AdminAuthenticationForm, extra_context=context)
      `,
    );

    expect(result).not.toBeNull();
    // AdminAuthenticationForm passed as kwarg value → CALLS edge from login
    expect(result!.relationships).toContainEqual({
      srcName: 'AdminSite.login',
      dstName: 'AdminAuthenticationForm',
      predicate: 'CALLS',
      bareCall: true,
    });
  });

  it('resolves qualifier from Model.objects.method() assignment (Pattern 2)', () => {
    const result = parseFile(
      '/repo/views.py',
      `
def list_items():
    queryset = MyModel.objects.all()
    queryset.filter()
      `,
    );

    expect(result).not.toBeNull();
    // ORM call emits MyModel.all via the two-level qualifier query
    expect(result!.relationships).toContainEqual({
      srcName: 'list_items',
      dstName: 'MyModel.all',
      predicate: 'CALLS',
    });
    // queryset resolved to MyModel via assignTypeMap → MyModel.filter
    expect(result!.relationships).toContainEqual({
      srcName: 'list_items',
      dstName: 'MyModel.filter',
      predicate: 'CALLS',
    });
  });

  it('extracts signatures from a .pyi stub', () => {
    // Stubs are the only place a compiled extension's API exists in Python, so
    // without them a call into a native op dead-ends at the import.
    const result = parseFile(
      '/repo/torch_ext/_C.pyi',
      `from typing import overload

import torch

def fused_attn(q: torch.Tensor, k: torch.Tensor, scale: float = 1.0) -> torch.Tensor: ...

class KernelHandle:
    device: int
    def launch(self, n: int) -> None: ...
`,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(['fused_attn', 'KernelHandle', 'launch']),
    );
  });

  describe('class heritage', () => {
    const extendsOf = (source: string) => parseFile('/repo/pkg/models.py', source)!.relationships
      .filter(rel => rel.predicate === 'EXTENDS')
      .map(rel => [rel.srcName, rel.dstName]);

    it('extends a bare base, as before', () => {
      expect(extendsOf('class X(Base):\n    pass\n')).toEqual([['X', 'Base']]);
    });

    it('extends a dotted base by its dotted name', () => {
      expect(extendsOf('class Attention(nn.Module):\n    pass\n')).toEqual([['Attention', 'nn.Module']]);
      expect(extendsOf('class X(a.b.Base):\n    pass\n')).toEqual([['X', 'a.b.Base']]);
    });

    it('extends the subscripted name of a generic base', () => {
      expect(extendsOf('class Repo(Generic[T]):\n    pass\n')).toEqual([['Repo', 'Generic']]);
      expect(extendsOf('class IntBox(Box[int]):\n    pass\n')).toEqual([['IntBox', 'Box']]);
      expect(extendsOf('class Y(mod.Base[K, V]):\n    pass\n')).toEqual([['Y', 'mod.Base']]);
    });

    it('extends every base of a mixed list, and never a keyword argument', () => {
      expect(extendsOf(
        'class X(Base, pkg.Mixin, Box[int], mod.Base[T], metaclass=Meta, total=False):\n    pass\n',
      )).toEqual([['X', 'Base'], ['X', 'pkg.Mixin'], ['X', 'Box'], ['X', 'mod.Base']]);
    });

    it('extends nothing for keyword-only, splat and call bases', () => {
      expect(extendsOf('class Movie(TypedDict, total=False):\n    pass\n')).toEqual([['Movie', 'TypedDict']]);
      expect(extendsOf('class X(metaclass=Meta):\n    pass\n')).toEqual([]);
      expect(extendsOf('class X(*bases, **kw):\n    pass\n')).toEqual([]);
      expect(extendsOf('class X(make_base()):\n    pass\n')).toEqual([]);
    });
  });
});

// #1020: which calls cannot denote a module-level function of their name.
describe('Python call scope flags', () => {
  function calls(source: string): Record<string, { memberCall?: true; localCallee?: true }> {
    const result = parseFile('/repo/scope.py', source);
    expect(result).not.toBeNull();
    return Object.fromEntries(result!.relationships
      .filter(rel => rel.predicate === 'CALLS')
      .map(rel => [`${rel.srcName} -> ${rel.dstName}`, {
        ...(rel.memberCall ? { memberCall: true as const } : {}),
        ...(rel.localCallee ? { localCallee: true as const } : {}),
      }]));
  }

  it('marks a member call on self, a parameter or a local, not its qualified form', () => {
    const flags = calls([
      'def close():',
      '    pass',
      '',
      'class C:',
      '    def close(self):',
      '        pass',
      '    def run(self, conn):',
      '        conn.validate()',
      '        self.close()',
      '        self.pool[0].release()',
      '        with open_conn() as c:',
      '            c.commit()',
      '        super().flush()',
    ].join('\n'));
    expect(flags).toMatchObject({
      'C.run -> validate': { memberCall: true },
      'C.run -> close': { memberCall: true },
      'C.run -> release': { memberCall: true },
      'C.run -> commit': { memberCall: true },
      'C.run -> flush': { memberCall: true },
    });
    // The qualified relationships keep resolving by their qualifier.
    expect(flags['C.run -> C.close']).toEqual({});
    expect(flags['C.run -> conn.validate']).toEqual({});
  });

  it('leaves a module-scope receiver unmarked', () => {
    const flags = calls([
      'import os',
      'api = make_api()',
      'def via_module():',
      '    os.validate()',
      'def via_global():',
      '    api.validate()',
      'def via_local_import():',
      '    import helpers',
      '    helpers.validate()',
      'def via_global_decl():',
      '    global api',
      '    api = make_api()',
      '    api.validate()',
    ].join('\n'));
    for (const caller of ['via_module', 'via_global', 'via_local_import', 'via_global_decl']) {
      expect(flags[`${caller} -> validate`], caller).toEqual({});
    }
  });

  it('marks a plain call to a parameter or local, never to a module-scope name', () => {
    const flags = calls([
      'from checks import check',
      'def validate(x):',
      '    return x',
      'def param(validate):',
      '    return validate(1)',
      'def assigned_later():',
      '    validate(1)',
      '    validate = pick()',
      'def loop(fns):',
      '    for validate in fns:',
      '        validate(1)',
      'def closure(validate):',
      '    def inner():',
      '        return validate(1)',
      '    return inner',
      'def shadowed_import(check):',
      '    return check(1)',
      'def plain():',
      '    return validate(1) + check(1)',
      'def nested_def():',
      '    def helper():',
      '        return 1',
      '    return helper()',
      'def default_value(x=validate(0)):',
      '    return x',
    ].join('\n'));
    expect(flags).toMatchObject({
      'param -> validate': { localCallee: true },
      'assigned_later -> validate': { localCallee: true },
      'loop -> validate': { localCallee: true },
      'inner -> validate': { localCallee: true },
      'shadowed_import -> check': { localCallee: true },
    });
    expect(flags['plain -> validate']).toEqual({});
    expect(flags['plain -> check']).toEqual({});
    expect(flags['nested_def -> helper']).toEqual({});
    expect(flags['default_value -> validate']).toEqual({});
  });

  it('marks a member call when the other sites in the scope call a parameter or local', () => {
    const flags = calls([
      'def validate(x):',
      '    return x',
      'def both(validate, conn):',
      '    validate(1)',
      '    conn.validate(1)',
      'def with_module(conn):',
      '    validate(1)',
      '    conn.validate(1)',
    ].join('\n'));
    expect(flags['both -> validate']).toEqual({ memberCall: true });
    expect(flags['with_module -> validate']).toEqual({});
  });
});
