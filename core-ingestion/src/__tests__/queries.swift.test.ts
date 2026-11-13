// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { isGrammarSupported, parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';
import { optionalGrammarExpected } from './helpers/grammars.js';

// tree-sitter-swift is optional. Skip only where it is not installed for this
// platform; where it is installed but fails to load, run and fail.
const swiftRuns = isGrammarSupported('a.swift') || optionalGrammarExpected('tree-sitter-swift');

const SAMPLE = `import Foundation
import UIKit

protocol Greeter {
    func greet(name: String) -> String
}

class Base {}

class Service: Base, Greeter {
    let repo: Repository
    var count = 0

    init(repo: Repository) {
        self.repo = repo
    }

    func greet(name: String) -> String {
        repo.save(name)
        return format(name)
    }
}

struct Point {}

enum Color { case red, green }

extension Point: Equatable {}

typealias Handler = (String) -> Void

func format(_ s: String) -> String { s }
`;

function parse() {
  const failures: string[] = [];
  const result = parseFile('/repo/Sources/Service.swift', SAMPLE, {
    onFailure: failure => failures.push(failure.message),
  });
  expect(failures).toEqual([]);
  expect(result).not.toBeNull();
  return result!;
}

const relationships = (predicate: string) => parse().relationships
  .filter(rel => rel.predicate === predicate)
  .map(rel => `${rel.srcName} -> ${rel.dstName}`);

describe.skipIf(!swiftRuns)('Swift queries', () => {
  it('detects Swift by extension', () => {
    expect(parse().language).toBe(SupportedLanguages.Swift);
  });

  it('captures protocols, classes, structs, enums, type aliases, members and functions', () => {
    const names = parse().entities.map(entity => `${entity.kind}:${entity.container ?? ''}:${entity.name}`);
    expect(names).toEqual(expect.arrayContaining([
      'interface::Greeter',
      'method:Greeter:greet',
      'class::Base',
      'class::Service',
      'method:Service:init',
      'function:Service:greet',
      'function:Service:repo',
      'function:Service:count',
      'class::Point',
      'class::Color',
      'class::Handler',
      'function::format',
    ]));
  });

  it('captures imports', () => {
    expect(relationships('IMPORTS')).toEqual(expect.arrayContaining([
      'Service.swift -> Foundation',
      'Service.swift -> UIKit',
    ]));
  });

  it('captures superclass, protocol conformance and extension conformance', () => {
    expect(relationships('EXTENDS')).toEqual(expect.arrayContaining([
      'Service -> Base',
      'Service -> Greeter',
      'Point -> Equatable',
    ]));
  });

  it('captures direct and member calls', () => {
    expect(relationships('CALLS')).toEqual(expect.arrayContaining([
      'Service.greet -> save',
      'Service.greet -> format',
    ]));
  });

  it('captures a property type annotation as a reference', () => {
    expect(relationships('REFERENCES')).toContain('Service.repo -> Repository');
  });
});
