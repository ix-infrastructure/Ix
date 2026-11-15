// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';

// tree-sitter-kotlin is an optional dependency built from source on install; a
// platform where it did not build has no Kotlin grammar at all.
const kotlinAvailable = isGrammarSupported('a.kt');

const SAMPLE = `package com.example.app

import com.example.util.Helper
import kotlinx.coroutines.launch

interface Greeter {
    fun greet(name: String): String
}

open class Base(val repo: Repository)

class Service(private val helper: Helper?, repo: Repository) : Base(repo), Greeter {
    val cache: Map<String, Widget> = mapOf()

    override fun greet(name: String): String {
        val w = Widget()
        helper?.render(w)
        return format(name)
    }
}

object Registry

fun format(s: String): String = s.trim()
`;

describe.skipIf(!kotlinAvailable)('Kotlin queries', () => {
  // The issue's reproduction, verbatim.
  it('parses a class, its method and a top-level function', () => {
    const failures: string[] = [];
    const result = parseFile('a.kt', 'class A { fun f() { g() } }\nfun g() {}\n', {
      onFailure: failure => failures.push(failure.message),
    });

    expect(failures).toEqual([]);
    expect(result).not.toBeNull();
    // The Kotlin query tags every fun as a function; a member is told apart
    // by its container.
    const names = result!.entities.map(entity => `${entity.kind}:${entity.container ?? ''}:${entity.name}`);
    expect(names).toEqual(expect.arrayContaining(['class::A', 'function:A:f', 'function::g']));
    // (The call to `g` is not checked here: single-letter callees are dropped
    // for every language. Calls are covered by the sample below.)
  });

  const parse = () => {
    const result = parseFile('/repo/src/Service.kt', SAMPLE);
    expect(result).not.toBeNull();
    return result!;
  };

  it('captures classes, interfaces, objects, methods, properties and functions', () => {
    const names = parse().entities.map(entity => `${entity.kind}:${entity.container ?? ''}:${entity.name}`);
    expect(names).toEqual(expect.arrayContaining([
      'interface::Greeter',
      'function:Greeter:greet',
      'class::Base',
      'class::Service',
      'function:Service:greet',
      'function:Service:cache',
      'class::Registry',
      'function::format',
    ]));
  });

  it('does not turn a local val into a member, so its calls stay with the method', () => {
    const result = parse();
    expect(result.entities.map(entity => entity.name)).not.toContain('w');
    expect(result.relationships).toContainEqual(
      expect.objectContaining({ srcName: 'Service.greet', dstName: 'Widget', predicate: 'CALLS' }),
    );
  });

  it('captures imports', () => {
    const imports = parse().relationships
      .filter(rel => rel.predicate === 'IMPORTS')
      .map(rel => rel.dstName);
    expect(imports).toEqual(expect.arrayContaining([
      'com.example.util.Helper',
      'kotlinx.coroutines.launch',
    ]));
  });

  it('captures direct, member and constructor calls', () => {
    const calls = parse().relationships
      .filter(rel => rel.predicate === 'CALLS' && rel.srcName === 'Service.greet')
      .map(rel => rel.dstName);
    expect(calls).toEqual(expect.arrayContaining(['format', 'render', 'Widget']));
  });

  it('captures heritage for a superclass call and an implemented interface', () => {
    const extended = parse().relationships
      .filter(rel => rel.srcName === 'Service' && (rel.predicate === 'EXTENDS' || rel.predicate === 'IMPLEMENTS'))
      .map(rel => rel.dstName);
    expect(extended).toEqual(expect.arrayContaining(['Base', 'Greeter']));
  });

  it('captures type references from parameter, property and generic types', () => {
    const refs = parse().relationships
      .filter(rel => rel.predicate === 'REFERENCES')
      .map(rel => rel.dstName);
    expect(refs).toEqual(expect.arrayContaining(['Repository', 'Helper', 'Widget']));
  });
});
