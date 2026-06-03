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
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'save',
      predicate: 'CALLS',
    });
    // The qualifier pattern also emits the fully-qualified form so Tier-1b
    // resolution can resolve e.g. Session.execute → session.py when the
    // qualifier is a class name present in the caller's imports.
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'value.save',
      predicate: 'CALLS',
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
    });
    // conn resolved to MyClass via assignTypeMap → MyClass.execute
    expect(result!.relationships).toContainEqual({
      srcName: 'my_view',
      dstName: 'MyClass.execute',
      predicate: 'CALLS',
    });
    // bare callee edge is also emitted
    expect(result!.relationships).toContainEqual({
      srcName: 'my_view',
      dstName: 'execute',
      predicate: 'CALLS',
    });
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
});
