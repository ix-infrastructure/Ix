import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

describe('Makefile queries', () => {
  it('captures rule targets, variable assignments, and includes', () => {
    const result = parseFile(
      '/repo/Makefile',
      `
CC := gcc
CFLAGS = -Wall

all: main.o utils.o
\t$(CC) $(CFLAGS) -o app main.o utils.o

main.o: main.c
\t$(CC) -c main.c

include config.mk
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['CC', 'CFLAGS', 'all', 'main.o']),
    );
    expect(result!.relationships).toContainEqual({
      srcName: 'Makefile',
      dstName: 'all',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Makefile',
      dstName: 'CC',
      predicate: 'CONTAINS',
    });
    expect(result!.relationships).toContainEqual({
      srcName: 'Makefile',
      dstName: 'config.mk',
      predicate: 'IMPORTS',
    });
  });

  it('does not emit .PHONY as a target entity', () => {
    const result = parseFile(
      '/repo/Makefile',
      `
.PHONY: all clean

all:
\t@echo "building"

clean:
\trm -rf build/
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).not.toContain('.PHONY');
    expect(result!.entities.map(e => e.name)).toContain('all');
    expect(result!.entities.map(e => e.name)).toContain('clean');
  });

  it('does not emit GNU special targets (.SUFFIXES/.DEFAULT/etc.) as entities', () => {
    const result = parseFile(
      '/repo/Makefile',
      `
.SUFFIXES:
.DEFAULT:
.PRECIOUS: app
.EXPORT_ALL_VARIABLES:

app:
\t$(CC) -o app main.c
      `,
    );

    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).not.toContain('.SUFFIXES');
    expect(names).not.toContain('.DEFAULT');
    expect(names).not.toContain('.PRECIOUS');
    expect(names).not.toContain('.EXPORT_ALL_VARIABLES');
    expect(names).toContain('app'); // real targets still captured
  });

  it('captures .mk files by extension', () => {
    const result = parseFile(
      '/repo/config.mk',
      `
PREFIX := /usr/local
BINDIR = $(PREFIX)/bin
      `,
    );

    expect(result).not.toBeNull();
    expect(result!.entities.map(e => e.name)).toEqual(
      expect.arrayContaining(['PREFIX', 'BINDIR']),
    );
  });
});