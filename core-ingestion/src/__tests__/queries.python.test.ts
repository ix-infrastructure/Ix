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
  });
});
