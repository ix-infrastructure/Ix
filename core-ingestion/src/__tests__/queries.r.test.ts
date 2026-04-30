import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

describe('R queries', () => {
  it('detects language as R', () => {
    const result = parseFile('/repo/analysis.R', `
x <- 1
`);
    expect(result).not.toBeNull();
    expect(result!.language).toBe(SupportedLanguages.R);
  });

  it('captures function definition via <- assignment', () => {
    const result = parseFile('/repo/utils.R', `
cleanData <- function(df, threshold = 0.5) {
  df[df$score > threshold, ]
}
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'cleanData', kind: 'function' }),
    );
  });

  it('captures multiple function definitions', () => {
    const result = parseFile('/repo/helpers.R', `
normalize <- function(x) {
  (x - min(x)) / (max(x) - min(x))
}

summarize <- function(df) {
  list(n = nrow(df), mean = mean(df$value))
}
`);
    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['normalize', 'summarize']),
    );
  });

  it('emits CALLS relationship for direct function calls', () => {
    const result = parseFile('/repo/main.R', `
run <- function(data) {
  cleaned <- cleanData(data)
  cleaned
}
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'cleanData', predicate: 'CALLS' }),
    );
  });

  it('emits CALLS relationship for package-qualified calls with qualifier prefix', () => {
    const result = parseFile('/repo/model.R', `
fitModel <- function(df) {
  dplyr::filter(df, value > 0)
}
`);
    expect(result).not.toBeNull();
    // qualifier + method: same convention as Go pkg.Func and Python module.method
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'dplyr.filter', predicate: 'CALLS' }),
    );
  });

  it('emits IMPORTS for library() with quoted string', () => {
    const result = parseFile('/repo/setup.R', `
library("dplyr")
library("ggplot2")
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'dplyr' }),
    );
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'ggplot2' }),
    );
  });

  it('emits IMPORTS for library() with unquoted symbol', () => {
    const result = parseFile('/repo/setup.R', `
library(tidyr)
require(stringr)
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'tidyr' }),
    );
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'stringr' }),
    );
  });

  it('emits IMPORTS for source() calls', () => {
    const result = parseFile('/repo/main.R', `
source("./helpers.R")
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ predicate: 'IMPORTS', dstName: 'helpers.R' }),
    );
  });

  it('captures nested function definitions', () => {
    const result = parseFile('/repo/factory.R', `
makeCounter <- function(start = 0) {
  increment <- function() {
    start <<- start + 1
    start
  }
  increment
}
`);
    expect(result).not.toBeNull();
    // Both outer and inner functions are captured; R has no class-based containment
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['makeCounter', 'increment']),
    );
  });

  it('returns null for non-R extensions', () => {
    const result = parseFile('/repo/script.unknown', 'x <- 1');
    expect(result).toBeNull();
  });
});
