import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { resolveEdges, type FileParseResult, type ParsedEntity } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const languages = [SupportedLanguages.TypeScript, SupportedLanguages.Scala] as const;
const symbolNames = ['run', 'helperFn', 'NodeKind', 'execute', 'transform'] as const;

function filePathFor(language: SupportedLanguages, index: number): string {
  return `/repo/file-${index}${language === SupportedLanguages.TypeScript ? '.ts' : '.scala'}`;
}

function makeEntity(name: string, language: SupportedLanguages): ParsedEntity {
  return { name, kind: 'function', lineStart: 1, lineEnd: 1, language };
}

describe('resolveEdges property invariants', () => {
  it('never crosses language boundaries and only emits supported confidences without self-loops', () => {
    const arb = fc.array(
      fc.record({
        language: fc.constantFrom(...languages),
        symbol: fc.constantFrom(...symbolNames),
        includeCall: fc.boolean(),
      }),
      { minLength: 2, maxLength: 8 },
    );

    fc.assert(
      fc.property(arb, defs => {
        const results: FileParseResult[] = defs.map((def, index) => ({
          filePath: filePathFor(def.language, index),
          language: def.language,
          entities: [
            { name: `file-${index}`, kind: 'file', lineStart: 1, lineEnd: 1, language: def.language },
            makeEntity(def.symbol, def.language),
            ...(def.includeCall ? [makeEntity(`caller${index}`, def.language)] : []),
          ],
          relationships: def.includeCall
            ? [{ srcName: `caller${index}`, dstName: def.symbol, predicate: 'CALLS' }]
            : [],
        }));

        const resolved = resolveEdges(results);
        for (const edge of resolved) {
          const src = results.find(result => result.filePath === edge.srcFilePath);
          const dst = results.find(result => result.filePath === edge.dstFilePath);

          expect(src).toBeDefined();
          expect(dst).toBeDefined();
          expect(src!.language).toBe(dst!.language);
          expect(edge.srcFilePath).not.toBe(edge.dstFilePath);
          expect([0.9, 0.8, 0.7, 0.5]).toContain(edge.confidence);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('does not emit tier-3 edges when there are zero or multiple same-language global matches', () => {
    const noMatch = resolveEdges([
      {
        filePath: '/repo/caller.ts',
        language: SupportedLanguages.TypeScript,
        entities: [
          { name: 'caller.ts', kind: 'file', lineStart: 1, lineEnd: 1, language: SupportedLanguages.TypeScript },
          makeEntity('caller', SupportedLanguages.TypeScript),
        ],
        relationships: [{ srcName: 'caller', dstName: 'missing', predicate: 'CALLS' }],
      },
      {
        filePath: '/repo/other.scala',
        language: SupportedLanguages.Scala,
        entities: [
          { name: 'other.scala', kind: 'file', lineStart: 1, lineEnd: 1, language: SupportedLanguages.Scala },
          makeEntity('missing', SupportedLanguages.Scala),
        ],
        relationships: [],
      },
    ]);

    expect(noMatch).toEqual([]);

    const ambiguous = resolveEdges([
      {
        filePath: '/repo/caller.ts',
        language: SupportedLanguages.TypeScript,
        entities: [
          { name: 'caller.ts', kind: 'file', lineStart: 1, lineEnd: 1, language: SupportedLanguages.TypeScript },
          makeEntity('caller', SupportedLanguages.TypeScript),
        ],
        relationships: [{ srcName: 'caller', dstName: 'run', predicate: 'CALLS' }],
      },
      {
        filePath: '/repo/a.ts',
        language: SupportedLanguages.TypeScript,
        entities: [
          { name: 'a.ts', kind: 'file', lineStart: 1, lineEnd: 1, language: SupportedLanguages.TypeScript },
          makeEntity('run', SupportedLanguages.TypeScript),
        ],
        relationships: [],
      },
      {
        filePath: '/repo/b.ts',
        language: SupportedLanguages.TypeScript,
        entities: [
          { name: 'b.ts', kind: 'file', lineStart: 1, lineEnd: 1, language: SupportedLanguages.TypeScript },
          makeEntity('run', SupportedLanguages.TypeScript),
        ],
        relationships: [],
      },
    ]);

    expect(ambiguous).toEqual([]);
  });
});
