import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('R queries', () => {
  it('captures function definitions via <- and = assignment', () => {
    const result = parseFile(
      '/repo/script.R',
      `
my_func <- function(x, y) {
  x + y
}

helper = function() {
  invisible(NULL)
}

global_fn <<- function(z) z * 2
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['my_func', 'helper', 'global_fn']),
    );
  });

  it('captures library, require, and source imports', () => {
    const result = parseFile(
      '/repo/analysis.R',
      `
library(dplyr)
require(ggplot2)
source("utils.R")
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'analysis.R',
      dstName: 'dplyr',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'analysis.R',
      dstName: 'ggplot2',
      predicate: 'IMPORTS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'analysis.R',
      dstName: 'utils.R',
      predicate: 'IMPORTS',
    });
  });

  it('captures direct function calls', () => {
    const result = parseFile(
      '/repo/script.R',
      `
process <- function(df) {
  filtered <- filter(df, x > 0)
  print(filtered)
  nrow(filtered)
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'process',
      dstName: 'print',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'process',
      dstName: 'nrow',
      predicate: 'CALLS',
    });
  });

  it('captures dollar-sign method calls', () => {
    const result = parseFile(
      '/repo/script.R',
      `
run <- function(obj) {
  obj$initialize()
  obj$compute(x = 1)
}
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'initialize',
      predicate: 'CALLS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'run',
      dstName: 'compute',
      predicate: 'CALLS',
    });
  });
});
