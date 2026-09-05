import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Rust queries', () => {
  it('captures structs, enums, traits, functions, and imports', () => {
    const result = parseFile(
      '/repo/lib.rs',
      `
use std::collections::HashMap;

pub struct Config {
    name: String,
}

pub enum Status {
    Ok,
    Err,
}

pub trait Runner {
    fn run(&self);
}

pub fn create() -> Config {
    Config { name: String::new() }
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['Config', 'Status', 'Runner', 'create']),
    );
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: expect.stringContaining('HashMap'), predicate: 'IMPORTS' }),
    );
  });

  it('captures REFERENCES for bare type fields (regression guard)', () => {
    const result = parseFile(
      '/repo/bare.rs',
      `
struct Foo {
    count: Count,
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo',
      dstName: 'Count',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES for &Type and &mut Type fields (Bug 1 — reference_type)', () => {
    const result = parseFile(
      '/repo/refs.rs',
      `
struct Searcher<'a> {
    matcher: &'a Config,
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Searcher',
      dstName: 'Config',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES for Box<Type> and other generic wrapper fields (Bug 1 — generic_type)', () => {
    const result = parseFile(
      '/repo/generic.rs',
      `
struct Foo {
    matcher: Box<Matcher>,
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo',
      dstName: 'Matcher',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES for impl Trait parameters (Bug 1 — abstract_type)', () => {
    const result = parseFile(
      '/repo/impl_trait.rs',
      `
fn run(s: impl Sink) {
}
      `,
    );

    expect(result).not.toBeNull();
    // Attributed to the enclosing function, not the file. The parser falls back
    // to the file name only at file scope -- queries.go.test.ts asserts the same
    // rule for Go type references inside `use()`. This expectation used to read
    // `impl_trait.rs`, describing an older file-level fallback, and went stale
    // unnoticed because nothing ran this suite (#557).
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'Sink',
      predicate: 'REFERENCES',
    });
  });

  it('captures REFERENCES for dyn Trait fields (Bug 1 — dynamic_type)', () => {
    const result = parseFile(
      '/repo/dyn_trait.rs',
      `
struct Foo {
    matcher: Box<dyn Matcher>,
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'Foo',
      dstName: 'Matcher',
      predicate: 'REFERENCES',
    });
  });

  it('captures qualified CALLS for scoped constructor calls (Bug 2 — @_qualifier)', () => {
    const result = parseFile(
      '/repo/builder.rs',
      `
fn make() {
    let s = SearcherBuilder::new();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'make',
      dstName: 'SearcherBuilder.new',
      predicate: 'CALLS',
    });
  });

  it('captures simple (unqualified) calls unaffected by Bug 2 fix', () => {
    const result = parseFile(
      '/repo/simple.rs',
      `
fn make() {
    foo();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'make',
      dstName: 'foo',
      predicate: 'CALLS',
    });
  });

  it('captures method calls unaffected by Bug 2 fix', () => {
    const result = parseFile(
      '/repo/method.rs',
      `
fn make(b: Builder) {
    b.build();
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'make',
      dstName: 'build',
      predicate: 'CALLS',
    });
  });
});
