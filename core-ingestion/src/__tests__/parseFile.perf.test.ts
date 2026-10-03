// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

/**
 * Parse time must grow with the file, not with its square.
 *
 * Every use of an imported JS/TS name is checked for shadowing, and each check
 * used to rescan every enclosing scope in full: a test file with thousands of
 * calls to one imported helper took minutes, and held a parse worker the whole
 * time. These bounds are loose on purpose; the quadratic version misses them
 * by two orders of magnitude.
 */

/** `n` calls to an imported function, all in one function body. */
function importedCalls(n: number): string {
  const lines = [`import { foo } from './x';`, `export function big() {`];
  for (let i = 0; i < n; i++) lines.push(`  foo(${i});`);
  lines.push('}');
  return lines.join('\n');
}

/** A vitest-shaped file: `n` top-level-ish `it` blocks inside one `describe`. */
function vitestShaped(n: number): string {
  const lines = [`import { describe, it, expect } from 'vitest';`, `import { g } from './g';`, `describe('suite', () => {`];
  for (let i = 0; i < n; i++) {
    lines.push(`  it('case ${i}', () => {`, `    const r = g(${i});`, `    expect(r).toBe(${i});`, `  });`);
  }
  lines.push('});');
  return lines.join('\n');
}

function timed(source: string): { ms: number; parsed: ReturnType<typeof parseFile> } {
  const start = performance.now();
  const parsed = parseFile('a/b.test.ts', source, { budgetMs: 0 });
  return { ms: performance.now() - start, parsed };
}

describe('parseFile scales linearly with uses of an imported name', () => {
  it('parses a 4,000-call file in under 2 s', () => {
    const { ms, parsed } = timed(importedCalls(4000));
    expect(parsed).not.toBeNull();
    expect(ms).toBeLessThan(2000);
  });

  it('parses a 1,000-test vitest file in under 2 s', () => {
    const { ms, parsed } = timed(vitestShaped(1000));
    expect(parsed).not.toBeNull();
    expect(ms).toBeLessThan(2000);
  });

  it('roughly doubles in time when the file doubles', () => {
    timed(importedCalls(500)); // warm the parser and query cache
    // Best of three each, so one scheduling hiccup cannot fail the ratio.
    const best = (n: number) => Math.min(...[0, 1, 2].map(() => timed(importedCalls(n)).ms));
    const small = best(2000);
    const large = best(4000);
    expect(large / small).toBeLessThan(3);
  });
});

describe('parseFile budget', () => {
  it('gives up on a file that runs past its budget and says why', () => {
    const failures: Array<{ reason: string }> = [];
    const parsed = parseFile('a/b.test.ts', vitestShaped(2000), {
      budgetMs: 1,
      onFailure: (failure) => failures.push(failure),
    });
    expect(parsed).toBeNull();
    expect(failures.map((f) => f.reason)).toEqual(['timeout']);
  });

  it('a budget of 0 is no budget', () => {
    expect(parseFile('a/b.test.ts', vitestShaped(200), { budgetMs: 0 })).not.toBeNull();
  });

  it('a file no grammar handles is not a failure', () => {
    const failures: unknown[] = [];
    expect(parseFile('notes.unknownext', 'hello', { onFailure: (f) => failures.push(f) })).toBeNull();
    expect(failures).toEqual([]);
  });
});
