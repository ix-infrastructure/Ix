// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  buildGlobalResolutionIndex,
  parseFile,
  resolveEdges,
  summarizeParseResult,
  type FileParseResult,
  type ResolvedEdge,
} from '../index.js';

/**
 * Resolution must not depend on how the files are batched. The CLI resolves a
 * repository in streaming batches (and an edit as a batch of one) against a
 * whole-repository index; whatever the partition and order, the union of the
 * batches' edges must equal one call over every file. It did not: a target
 * file's language, imports, and (outside JS/TS, PHP, R, SAS and Go) its symbols
 * were read from the batch, so edges were lost, invented, or changed with the
 * file order.
 */

const key = (e: ResolvedEdge) =>
  [e.srcFilePath, e.srcName, e.predicate, e.dstName, e.dstFilePath, e.dstQualifiedKey, e.confidence].join('\0');

function indexOf(results: FileParseResult[]) {
  return buildGlobalResolutionIndex(
    results.map((r) => r.filePath),
    undefined,
    undefined,
    new Map(results.map((r) => [r.filePath, summarizeParseResult(r)])),
  );
}

function batched(results: FileParseResult[], batchOf: number[], index: ReturnType<typeof indexOf>): Set<string> {
  const batches = new Map<number, FileParseResult[]>();
  results.forEach((r, i) => {
    const b = batchOf[i] ?? 0;
    const list = batches.get(b) ?? [];
    list.push(r);
    batches.set(b, list);
  });
  const out = new Set<string>();
  for (const batch of batches.values()) for (const e of resolveEdges(batch, undefined, index)) out.add(key(e));
  return out;
}

/** A small repository whose edges need every kind of cross-file lookup. */
const MIXED: Array<[string, string]> = [
  ['pkg/__init__.py', 'from pkg.util import helper\n'],
  ['pkg/util.py', 'def helper():\n    return 1\n\ndef scale(x):\n    return x * helper()\n'],
  ['pkg/service.py', 'from pkg.util import helper, scale\n\nclass Service:\n    def run(self):\n        return scale(helper())\n'],
  ['pkg/app.py', 'from pkg import helper\nfrom pkg.service import Service\n\ndef main():\n    return Service().run() + helper()\n'],
  ['pkg/lonely.py', 'def only_here():\n    return 2\n'],
  ['pkg/caller.py', 'def go():\n    return only_here()\n'],
  ['src/com/ex/Util.java', 'package com.ex;\n\npublic class Util {\n  public static int helper() { return 1; }\n}\n'],
  ['src/com/ex/Service.java', 'package com.ex;\n\nimport com.ex.Util;\n\npublic class Service {\n  public int run() { return Util.helper(); }\n}\n'],
  ['src/com/ex/App.java', 'package com.ex;\n\npublic class App {\n  public int main() { return new Service().run() + Util.helper(); }\n}\n'],
  ['web/math.ts', 'export function add(a: number, b: number) { return a + b; }\n'],
  ['web/index.ts', "export { add } from './math';\n"],
  ['web/calc.ts', "import { add } from './index';\nexport function total() { return add(1, 2); }\n"],
  ['web/report.ts', "import { total } from './calc';\nexport class Report { sum() { return total(); } }\n"],
];

const mixed = MIXED.map(([file, src]) => parseFile(file, src)).filter((r): r is FileParseResult => r !== null);

function ownSources(): FileParseResult[] {
  const dir = path.resolve(import.meta.dirname, '..');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && statSync(path.join(dir, f)).isFile())
    .sort()
    .map((f) => parseFile(`core-ingestion/src/${f}`, readFileSync(path.join(dir, f), 'utf8'), { budgetMs: 0 }))
    .filter((r): r is FileParseResult => r !== null);
}

describe('resolveEdges is independent of batching', () => {
  it('the mixed repository resolves cross-file edges in every language', () => {
    const edges = resolveEdges(mixed, undefined, indexOf(mixed));
    const langs = new Set(edges.filter((e) => e.predicate !== 'IMPORTS').map((e) => path.extname(e.srcFilePath)));
    expect([...langs].sort()).toEqual(['.java', '.py', '.ts']);
  });

  for (const [name, corpus] of [['mixed fixture', mixed], ['this package', ownSources()]] as const) {
    it(`any partition and order of ${name} gives the edges of one call`, () => {
      const index = indexOf(corpus);
      const whole = new Set(resolveEdges(corpus, undefined, index).map(key));
      expect(whole.size).toBeGreaterThan(0);
      fc.assert(
        fc.property(
          fc.array(fc.nat(3), { minLength: corpus.length, maxLength: corpus.length }),
          fc.boolean(),
          (batchOf, reverse) => {
            const files = reverse ? [...corpus].reverse() : corpus;
            const order = reverse ? [...batchOf].reverse() : batchOf;
            expect(batched(files, order, index)).toEqual(whole);
          },
        ),
        { numRuns: 25, seed: 20261003 },
      );
    });
  }

  it('a batch of one sees the whole repository', () => {
    const index = indexOf(mixed);
    const whole = new Set(resolveEdges(mixed, undefined, index).map(key));
    expect(batched(mixed, mixed.map((_, i) => i), index)).toEqual(whole);
  });
});

describe('resolveEdges scales with the repository', () => {
  /** `n` Python modules, each calling a helper in another and a dotted member. */
  function synthetic(n: number): FileParseResult[] {
    const out: FileParseResult[] = [];
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const src = `from pkg.m${next} import f${next}\n\nclass C${i}:\n    def m(self):\n        return 1\n\ndef f${i}():\n    return f${next}() + C${next}.m(None)\n`;
      const r = parseFile(`pkg/m${i}.py`, src);
      if (r) out.push(r);
    }
    return out;
  }

  it('doubling the files keeps the time well under quadratic', () => {
    // Best of seven on sizes large enough that one scheduler hiccup can't swing
    // the ratio. Doubling measures ~2.2x locally but sits right at 3x on CI
    // runners; quadratic would be ~4x, so 3.5x still catches it.
    const time = (results: FileParseResult[]) => {
      const index = indexOf(results);
      return Math.min(...Array.from({ length: 7 }, () => {
        const t = performance.now();
        resolveEdges(results, undefined, index);
        return performance.now() - t;
      }));
    };
    const small = synthetic(2000);
    const large = synthetic(4000);
    time(small); // warm up
    time(large);
    expect(time(large) / time(small)).toBeLessThan(3.5);
  }, 60_000);
});

describe('resolveEdges against a summarized index', () => {
  it('an index built from summaries alone resolves like one built with the paths too', () => {
    const summariesOnly = buildGlobalResolutionIndex(
      [],
      undefined,
      undefined,
      new Map(mixed.map((r) => [r.filePath, summarizeParseResult(r)])),
    );
    const whole = new Set(resolveEdges(mixed, undefined, indexOf(mixed)).map(key));
    expect(batched(mixed, mixed.map((_, i) => i), summariesOnly)).toEqual(whole);
  });

  it('resolving a batch leaves the index as it was', () => {
    const indexed = mixed.filter((r) => r.filePath !== 'web/calc.ts');
    const index = indexOf(indexed);
    const snapshot = (i: ReturnType<typeof indexOf>) => JSON.stringify(
      [i.stemToFiles, i.dirToIndexFiles, i.packageToFiles, i.goPkgDirToFiles, i.goPkgPathToFiles].map((m) => [...m]),
    );
    const before = snapshot(index);
    // Not in the index, and its stem and directory collide with files that are.
    const extra = [parseFile('web/index/index.ts', "export const x = 1;\n")!, parseFile('src/com/ex/Extra.java', 'package com.ex;\npublic class Extra {}\n')!];
    resolveEdges([...extra, mixed.find((r) => r.filePath === 'web/calc.ts')!], undefined, index);
    expect(snapshot(index)).toBe(before);
  });

  it('a one-file batch costs time linear in the repository, not in a common stem squared', () => {
    // Every file is an `index.ts`: one stem list as long as the repository.
    function repo(n: number) {
      const results: FileParseResult[] = [];
      for (let i = 0; i < n; i++) {
        const r = parseFile(`p${i}/index.ts`, `export function f${i}() { return 1; }\n`);
        if (r) results.push(r);
      }
      return { results, index: indexOf(results) };
    }
    const time = ({ results, index }: ReturnType<typeof repo>) => Math.min(...[0, 1, 2].map(() => {
      const t = performance.now();
      resolveEdges([results[0]], undefined, index);
      return performance.now() - t;
    }));
    const small = repo(3000);
    const large = repo(12000);
    time(small); // warm up
    // 4x the files: linear is ~4x, the old per-call de-dup was ~16x.
    expect(time(large) / time(small)).toBeLessThan(8);
  });
});
