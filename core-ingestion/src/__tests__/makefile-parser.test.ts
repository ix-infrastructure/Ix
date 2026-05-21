import { parseMakefile, resolvePhony } from './makefile-parser';

const SAMPLE = `
CC := gcc
CFLAGS ?= -Wall

.PHONY: clean all

all: main.o utils.o
\tgcc -o app main.o utils.o

clean:
\trm -f *.o app
`.trim();

test('parses variables', () => {
  const ast = parseMakefile(SAMPLE);
  expect(ast.variables).toHaveLength(2);
});