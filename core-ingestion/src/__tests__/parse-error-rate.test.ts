// Copyright 2026 Ix Infrastructure Inc.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { grammarStatus, parseFile } from '../index.js';
import { languageFromPath } from '../languages.js';
import receiverCases from '../../test-fixtures/receiver-inference/cases.json';

const root = resolve(import.meta.dirname, '../../..');
// Tracked inputs only: never count node_modules, generated dist, or local files.
// NUL separation also works for spaces in paths on Windows.
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const fixturePath = /^(?:core-ingestion\/test-fixtures\/|ix-cli\/test\/(?:e2e\/)?fixtures\/)/;
const unavailable = new Map(grammarStatus().filter(s => !s.loaded).map(s => [s.language, s]));
// npm's latest upstream tree-sitter-typescript is still 0.23.2; the published
// @sengac fork 0.25.15 reproduces the same 58 failing files. The base repo
// measured 58/614 TS files (9.446%); owner-approved fallback = baseline + 1 point.
// TODO: restore 2% when a published native grammar handles generic calls such
// as orig<typeof import("./module.js")>() and unique.length in for conditions.
// Keep fixtures at 2%, including their recorded source snippets.
const repoTypeScriptLimit = 100 * 58 / 614 + 1;

interface Rate {
  total: number;
  errors: string[];
  skipped: string[];
}

describe('parse-error rate (real tracked files)', () => {
  for (const corpus of ['fixtures', 'repo'] as const) {
    it(`${corpus}: stays within each language's parse-error limit`, () => {
      const rates = new Map<string, Rate>();
      const failures: string[] = [];
      const inputs = files.filter(file => fixturePath.test(file) === (corpus === 'fixtures'))
        .map(file => ({ file, source: () => readFileSync(resolve(root, file), 'utf8') }));
      if (corpus === 'fixtures') {
        for (const c of receiverCases) {
          inputs.push({
            file: `core-ingestion/test-fixtures/receiver-inference/cases.json#${c.name}/use.${c.language}`,
            source: () => c.source,
          });
        }
      }
      for (const { file, source } of inputs) {
        const language = languageFromPath(file);
        if (!language) continue;
        let rate = rates.get(language);
        if (!rate) rates.set(language, rate = { total: 0, errors: [], skipped: [] });
        if (unavailable.has(language)) {
          rate.skipped.push(file);
          continue;
        }
        rate.total++;
        // Disable the extraction budget so CI load cannot turn a syntax metric
        // into a timeout metric. An unexpected null result still fails the gate.
        const parsed = parseFile(file, source(), { budgetMs: 0 });
        if (!parsed || parsed.hasParseErrors) rate.errors.push(file);
      }

      expect(rates.size, `${corpus} corpus is empty`).toBeGreaterThan(0);
      for (const [language, rate] of [...rates].sort(([a], [b]) => a.localeCompare(b))) {
        if (rate.skipped.length) {
          console.warn(`${corpus}/${language}: SKIPPED ${rate.skipped.length} files; ` +
            `grammar unavailable: ${unavailable.get(language)?.reason}\n${rate.skipped.join('\n')}`);
        }
        if (!rate.total) continue;
        const limit = corpus === 'repo' && language === 'typescript' ? repoTypeScriptLimit : 2;
        const percent = 100 * rate.errors.length / rate.total;
        const report = `${corpus}/${language}: ${rate.errors.length}/${rate.total} ` +
          `(${percent.toFixed(2)}%), limit ${limit.toFixed(2)}%` +
          (rate.errors.length ? `\n${rate.errors.join('\n')}` : '');
        console.log(report);
        if (percent > limit) failures.push(report);
      }
      expect(failures, failures.join('\n\n')).toEqual([]);
    }, 120_000);
  }
});
