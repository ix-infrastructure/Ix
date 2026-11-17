// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

// tree-sitter-ruby is a regular dependency, so these tests never skip.

const SAMPLE = `require 'json'
require_relative 'helpers/formatter'

module Billing
  class Invoice < Base
    def initialize(customer)
      @customer = customer
    end

    def total
      line_items.sum
      format_total(compute)
    end

    def self.build(attrs)
      Invoice.new(attrs)
    end
  end

  class Refund < Billing::Invoice
  end
end
`;

function parse() {
  const failures: string[] = [];
  const result = parseFile('/repo/lib/billing.rb', SAMPLE, {
    onFailure: failure => failures.push(failure.message),
  });
  expect(failures).toEqual([]);
  expect(result).not.toBeNull();
  return result!;
}

const relationships = (predicate: string) => parse().relationships
  .filter(rel => rel.predicate === predicate)
  .map(rel => `${rel.srcName} -> ${rel.dstName}`);

describe('Ruby queries', () => {
  it('detects Ruby by extension', () => {
    expect(parse().language).toBe(SupportedLanguages.Ruby);
  });

  it('captures modules, classes, instance methods and singleton methods', () => {
    const names = parse().entities.map(entity => `${entity.kind}:${entity.container ?? ''}:${entity.name}`);
    expect(names).toEqual(expect.arrayContaining([
      'module::Billing',
      'class::Invoice',
      'method:Invoice:initialize',
      'method:Invoice:total',
      'method:Invoice:build',
      'class::Refund',
    ]));
  });

  it('captures require and require_relative as imports', () => {
    expect(relationships('IMPORTS')).toEqual(expect.arrayContaining([
      'billing.rb -> json',
      'billing.rb -> formatter',
    ]));
  });

  it('captures a bare and a scoped superclass', () => {
    expect(relationships('EXTENDS')).toEqual(expect.arrayContaining([
      'Invoice -> Base',
      'Refund -> Billing::Invoice',
    ]));
  });

  it('captures calls inside a method', () => {
    expect(relationships('CALLS')).toEqual(expect.arrayContaining([
      'Invoice.total -> sum',
      'Invoice.total -> format_total',
    ]));
  });
});
