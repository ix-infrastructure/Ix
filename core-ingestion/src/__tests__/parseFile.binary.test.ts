// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

// QA-07. Ingest decodes every file with `bytes.toString('utf-8')` and has no
// binary or NUL check, so a stray NUL byte or invalid UTF-8 in a `.ts` file
// reaches `parseFile` as an ordinary string. The only guard is the catch at
// the end of `parseFile`, which turns a throw into `null` plus `onFailure`.
//
// Inputs are built from escapes: this source holds no raw NUL byte.
//
// Measured when written: tree-sitter does NOT truncate at a NUL. Both
// functions either side are extracted, and the tree is flagged
// `hasParseErrors`. No input tried makes `parseFile` throw, so the catch has
// nothing here to guard: these are pins on current behaviour, and the red
// check is a truncation of the source at the first NUL (see the PR).

function names(result: ReturnType<typeof parseFile>): string[] {
  return (result?.entities ?? []).map((entity) => entity.name);
}

describe('parseFile on binary-looking input (QA-07)', () => {
  it('extracts the functions either side of NUL bytes without throwing', () => {
    const source = 'export function before() {}\n' + '\u0000\u0000' + '\nexport function after() {}\n';
    const failures: unknown[] = [];

    let result: ReturnType<typeof parseFile> = null;
    expect(() => {
      result = parseFile('nul.ts', source, { onFailure: (failure) => failures.push(failure) });
    }).not.toThrow();

    expect(failures).toEqual([]);
    expect(result).not.toBeNull();
    expect(names(result)).toEqual(expect.arrayContaining(['before', 'after']));
  });

  it('extracts the functions either side of invalid UTF-8, decoded as ingest decodes it', () => {
    const bytes = Buffer.concat([
      Buffer.from('export function a() {}\n'),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('\nexport function b() {}\n'),
    ]);
    const source = bytes.toString('utf-8');
    expect(source).toContain('�');
    const failures: unknown[] = [];

    let result: ReturnType<typeof parseFile> = null;
    expect(() => {
      result = parseFile('bad-utf8.ts', source, { onFailure: (failure) => failures.push(failure) });
    }).not.toThrow();

    expect(failures).toEqual([]);
    expect(result).not.toBeNull();
    expect(names(result)).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
