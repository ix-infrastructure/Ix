// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// tree-sitter-c-sharp is a regular dependency, so these tests never skip.

const SAMPLE = `using System.Collections.Generic;
using Acme.Data;

namespace Acme.Services
{
    public interface IGreeter
    {
        string Greet(string name);
    }

    public class Base { }

    public class Service : Base, IGreeter
    {
        private Repository repo;

        public Service(Repository repo)
        {
            this.repo = repo;
        }

        public int Count { get; set; }

        public string Greet(string name)
        {
            var w = new Widget();
            repo?.Save(w);
            return Format(name);
        }

        private static string Format(string s) => s.Trim();
    }

    public struct Point { }

    public enum Color { Red, Green }

    public record User(string Name, int Age);
}
`;

function parse() {
  const failures: string[] = [];
  const result = parseFile('/repo/src/Service.cs', SAMPLE, {
    onFailure: failure => failures.push(failure.message),
  });
  expect(failures).toEqual([]);
  expect(result).not.toBeNull();
  return result!;
}

const relationships = (predicate: string) => parse().relationships
  .filter(rel => rel.predicate === predicate)
  .map(rel => `${rel.srcName} -> ${rel.dstName}`);

describe('C# queries', () => {
  it('detects C# by extension', () => {
    expect(parse().language).toBe(SupportedLanguages.CSharp);
  });

  it('captures the namespace, types, methods and properties', () => {
    const names = parse().entities.map(entity => `${entity.kind}:${entity.container ?? ''}:${entity.name}`);
    expect(names).toEqual(expect.arrayContaining([
      'module::Acme.Services',
      'interface::IGreeter',
      'method:IGreeter:Greet',
      'class::Base',
      'class::Service',
      'method:Service:Greet',
      'method:Service:Format',
      'function:Service:Count',
      'class::Point',
      'class::Color',
      'class::User',
    ]));
  });

  it('captures using directives as imports', () => {
    expect(relationships('IMPORTS')).toEqual(expect.arrayContaining([
      'Service.cs -> System.Collections.Generic',
      'Service.cs -> Acme.Data',
    ]));
  });

  it('captures the base class and the implemented interface', () => {
    expect(relationships('EXTENDS')).toEqual(expect.arrayContaining([
      'Service -> Base',
      'Service -> IGreeter',
    ]));
  });

  it('captures direct, null-conditional and constructor calls', () => {
    expect(relationships('CALLS')).toEqual(expect.arrayContaining([
      'Service.Greet -> Format',
      'Service.Greet -> Save',
      'Service.Greet -> Widget',
    ]));
  });

  it('captures a parameter type as a reference', () => {
    expect(relationships('REFERENCES')).toContain('Service -> Repository');
  });
});
