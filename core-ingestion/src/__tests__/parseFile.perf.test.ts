// Copyright 2026 Ix Infrastructure Inc.

import { describe, expect, it } from 'vitest';

import { parseFile } from '../index.js';

/**
 * Parse time must grow with the file, not with its square.
 *
 * Every use of an imported JS/TS name is checked for shadowing, and each check
 * used to rescan every enclosing scope in full: a test file with thousands of
 * calls to one imported helper took minutes, and held a parse worker the whole
 * time. These bounds are loose on purpose: the linear version takes well
 * under a second here, the quadratic one minutes, so a bound of 10 s holds on
 * a slow or busy CI runner and still fails the quadratic version. Each test
 * gets its own timeout, because vitest's default 5 s is less than the bound.
 */

/** The wall-clock bound for one parse, and the per-test timeout around it. */
const BOUND_MS = 10_000;
const TEST_TIMEOUT_MS = 60_000;

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

function timed(source: string, budgetMs = 0): { ms: number; parsed: ReturnType<typeof parseFile> } {
  const start = performance.now();
  const parsed = parseFile('a/b.test.ts', source, { budgetMs });
  return { ms: performance.now() - start, parsed };
}

/**
 * Fit how time grows with `n`: one warmup run per size, then the best of
 * `samples` timed runs per size, and the least-squares slope of ln(ms) against
 * ln(n). Linear growth fits about 1, quadratic about 2. The clock is
 * injectable so the fit can be tested without wall time.
 */
function growthExponent(
  sizes: number[],
  run: (n: number) => void,
  opts: { samples?: number; now?: () => number } = {},
): { exponent: number; ms: number[] } {
  const samples = opts.samples ?? 5;
  const now = opts.now ?? (() => performance.now());
  const ms = sizes.map((n) => {
    run(n); // warmup, not counted
    let best = Infinity;
    for (let i = 0; i < samples; i++) {
      const start = now();
      run(n);
      best = Math.min(best, now() - start);
    }
    return best;
  });
  const xs = sizes.map((n) => Math.log(n));
  const ys = ms.map((t) => Math.log(t));
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return { exponent: num / den, ms };
}

/** The bound on the fitted exponent: linear fits about 1, quadratic about 2. */
const MAX_EXPONENT = 1.5;

describe('parseFile scales linearly with uses of an imported name', () => {
  it('parses a 4,000-call file in seconds, not minutes', () => {
    const { ms, parsed } = timed(importedCalls(4000));
    expect(parsed).not.toBeNull();
    expect(ms).toBeLessThan(BOUND_MS);
  }, TEST_TIMEOUT_MS);

  it('parses a 1,000-test vitest file in seconds, not minutes', () => {
    const { ms, parsed } = timed(vitestShaped(1000));
    expect(parsed).not.toBeNull();
    expect(ms).toBeLessThan(BOUND_MS);
  }, TEST_TIMEOUT_MS);

  // The growth exponent fitted over 2k, 4k and 8k calls: linear growth fits
  // about 1, the old unmemoised shadow scan about 2. Per-call cost steps up
  // about 1.3x between 1k and 3k calls (tree-sitter node marshalling), so the
  // old 4k/1k ratio was about 5 to 6 locally and up to 8.6 on CI; these sizes
  // start above that step. Best of five after a warmup, fitted over three
  // sizes, so a single slow sample cannot fail the bound. Each parse also gets
  // a budget of BOUND_MS: the test timeout cannot interrupt a synchronous
  // parse, so without it the quadratic version would run for most of an hour
  // across these 19 parses. With it, the first parse past the budget fails
  // the test.
  it('grows linearly, not quadratically, with uses of an imported name', () => {
    timed(importedCalls(500)); // warm the parser and query cache
    const sources = new Map([2000, 4000, 8000].map((n) => [n, importedCalls(n)]));
    const { exponent, ms } = growthExponent([...sources.keys()], (n) => {
      expect(timed(sources.get(n)!, BOUND_MS).parsed, `${n} calls ran past ${BOUND_MS} ms`).not.toBeNull();
    });
    expect(exponent, `times ${ms.map((t) => t.toFixed(1)).join('/')} ms`).toBeLessThan(MAX_EXPONENT);
  }, TEST_TIMEOUT_MS);
});

describe('growthExponent', () => {
  /** A fake clock that each run advances by `cost(n, call)`, where `call` counts runs per size from 0. */
  function fit(cost: (n: number, call: number) => number) {
    let clock = 0;
    const calls = new Map<number, number>();
    return growthExponent(
      [2000, 4000, 8000],
      (n) => {
        const call = calls.get(n) ?? 0;
        calls.set(n, call + 1);
        clock += cost(n, call);
      },
      { now: () => clock },
    );
  }

  it('fits about 1 for linear growth', () => {
    expect(fit((n) => n).exponent).toBeCloseTo(1, 5);
  });

  it('fits about 2 for quadratic growth, which fails the bound', () => {
    const { exponent } = fit((n) => (n * n) / 1000);
    expect(exponent).toBeCloseTo(2, 5);
    expect(exponent).not.toBeLessThan(MAX_EXPONENT);
  });

  it('ignores one inflated sample per size (best of five)', () => {
    // Call 0 is the warmup; call 2 is a timed sample, slowed 10x.
    expect(fit((n, call) => (call === 2 ? 10 * n : n)).exponent).toBeCloseTo(1, 5);
  });

  it('does not count the warmup run', () => {
    expect(fit((n, call) => (call === 0 ? 100 * n * n : n)).exponent).toBeCloseTo(1, 5);
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
