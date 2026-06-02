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
    // Package-qualified calls keep the :: separator (dplyr::filter) so the patch
    // builder can externalise genuine package calls without confusing them for
    // base-R dotted names like is.null.
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'dplyr::filter', predicate: 'CALLS' }),
    );
  });

  it('keeps backticks on backtick-named function defs (only string LHS is unquoted)', () => {
    const result = parseFile('/repo/backtick.r', '`my fn` <- function(x) x\n');
    expect(result).not.toBeNull();
    // Backtick identifiers are part of the token text; stripping them on the def
    // path (but not the call path) would desync resolution. The strip is reserved
    // for string-keyed S3 names only.
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: '`my fn`', kind: 'function' }),
    );
    expect(result!.entities.map(e => e.name)).not.toContain('my fn');
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

  it('captures function definition via = assignment', () => {
    const result = parseFile('/repo/utils.R', `
foo = function(x) x * 2
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'foo', kind: 'function' }),
    );
  });

  it('captures string-keyed function definition (S3 method name)', () => {
    const result = parseFile('/repo/methods.R', `
"print.myClass" <- function(x, ...) invisible(x)
`);
    expect(result).not.toBeNull();
    expect(result!.entities).toContainEqual(
      expect.objectContaining({ name: 'print.myClass', kind: 'function' }),
    );
  });

  it('emits CALLS relationship for method calls via $', () => {
    const result = parseFile('/repo/main.R', `
run <- function(obj) {
  obj$render(obj$data)
}
`);
    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual(
      expect.objectContaining({ dstName: 'render', predicate: 'CALLS' }),
    );
  });

  it('returns null for non-R extensions', () => {
    const result = parseFile('/repo/script.unknown', 'x <- 1');
    expect(result).toBeNull();
  });
});
