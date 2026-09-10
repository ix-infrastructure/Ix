// Copyright 2026 Ix Infrastructure INC

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Java queries', () => {
  it('captures classes, interfaces, methods, imports, and plain heritage', () => {
    const result = parseFile(
      '/repo/Service.java',
      `
package com.example;

import java.util.List;
import com.example.base.BaseService;

public class Service extends BaseService implements Runnable {
  public void run() {
    helper();
  }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['Service', 'run']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'Service',
      dstName: 'BaseService',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Service',
      dstName: 'Runnable',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Service.run',
      dstName: 'helper',
      predicate: 'CALLS',
    });
  });

  it('captures extends and implements with generic types', () => {
    const result = parseFile(
      '/repo/ImmutableList.java',
      `
package com.example;

public abstract class ImmutableList<E> extends ImmutableCollection<E>
    implements List<E>, RandomAccess {
  public int size() {
    return delegate.size();
  }
}
      `,
    );

    expect(result).not.toBeNull();
    // extends generic type
    expect(result!.relationships).toContainEqual({
      srcName: 'ImmutableList',
      dstName: 'ImmutableCollection',
      predicate: 'EXTENDS',
    });
    // implements generic interface
    expect(result!.relationships).toContainEqual({
      srcName: 'ImmutableList',
      dstName: 'List',
      predicate: 'EXTENDS',
    });
    // implements plain interface alongside generic one
    expect(result!.relationships).toContainEqual({
      srcName: 'ImmutableList',
      dstName: 'RandomAccess',
      predicate: 'EXTENDS',
    });
  });

  it('captures interface extends (plain and generic)', () => {
    const result = parseFile(
      '/repo/SortedList.java',
      `
package com.example;

public interface SortedList<E> extends List<E>, Comparable {
  E first();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'SortedList',
      dstName: 'List',
      predicate: 'EXTENDS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'SortedList',
      dstName: 'Comparable',
      predicate: 'EXTENDS',
    });
  });

  it('captures class that only implements generic interfaces', () => {
    const result = parseFile(
      '/repo/AbstractMultimap.java',
      `
package com.example;

abstract class AbstractMultimap<K, V> implements Multimap<K, V> {
  public boolean put(K key, V value) {
    return getOrCreate(key).add(value);
  }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'AbstractMultimap',
      dstName: 'Multimap',
      predicate: 'EXTENDS',
    });
  });

  it('captures static method calls (via static import pattern)', () => {
    const result = parseFile(
      '/repo/Consumer.java',
      `
package com.example;

import static com.google.common.base.Preconditions.checkArgument;
import static com.google.common.base.Preconditions.checkNotNull;

public class Consumer {
  public void process(Object value) {
    checkNotNull(value);
    checkArgument(value != null, "bad");
  }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Consumer.process',
      dstName: 'checkNotNull',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Consumer.process',
      dstName: 'checkArgument',
      predicate: 'CALLS',
    });
  });

  it('methods after annotated varargs param are contained in their class', () => {
    // tree-sitter-java error-recovers on `@Annotation Type @Annotation ... param`,
    // truncating the class_declaration. Verify our preprocessing keeps all methods
    // attributed to the correct container.
    const result = parseFile(
      '/repo/Preconditions.java',
      `
package com.example;

public final class Preconditions {
  public static void checkArgument(
      boolean expression,
      String template,
      @Nullable Object @Nullable ... args) {
    if (!expression) throw new IllegalArgumentException(template);
  }

  public static void checkNotNull(Object obj) {
    if (obj == null) throw new NullPointerException();
  }
}
      `,
    );

    expect(result).not.toBeNull();
    const containers = Object.fromEntries(
      result!.entities
        .filter(e => e.kind === 'method' || e.kind === 'function')
        .map(e => [e.name, e.container]),
    );
    // Both methods must be contained in Preconditions, not orphaned
    expect(containers['checkArgument']).toBe('Preconditions');
    expect(containers['checkNotNull']).toBe('Preconditions');
  });

  it('captures constructor calls', () => {
    const result = parseFile(
      '/repo/Factory.java',
      `
package com.example;

public class Factory {
  public Widget create() {
    return new Widget();
  }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Factory.create',
      dstName: 'Widget',
      predicate: 'CALLS',
    });
  });
});
