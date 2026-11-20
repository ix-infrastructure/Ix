// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * What the extractor named `extractor` produces, recorded in
 * core-ingestion/test-fixtures/extractor-output.json. The patch id folds in the
 * extractor name, and `ix map` re-ingests unchanged files only when that name
 * changes, so output that changes under the same name never reaches an
 * existing graph (#964). patchBuilder.golden.test.ts compares this record with
 * what the current build produces and fails until the name is bumped.
 */
export interface ExtractorOutputRecord {
  /** `extractorName()` when the record was written. */
  extractor: string;
  /** Lockfile version of each package the parser loads (`parserDependencyVersions`). */
  parserDependencies: Record<string, string>;
  /** sha256 of each golden case's output (extractor name masked), by case name. */
  outputs: Record<string, string>;
}

export interface ExtractorOutputCheck {
  /** Output differs under an unchanged extractor name: needs a new name. */
  needsBump: string[];
  /** The record is out of date but nothing an ingest writes changed under its name. */
  stale: string[];
}

/** Environment variable that rewrites the record instead of checking it. */
export const UPDATE_ENV = 'IX_UPDATE_EXTRACTOR_OUTPUT';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/**
 * sha256 of a value with object keys sorted, so code that only reorders the
 * keys of an op does not read as different output.
 */
export function outputDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/**
 * Compare the recorded output with the current one.
 *
 * Under the same extractor name, a changed parser dependency version or a
 * changed case digest needs a bump. The dependency check is strict: a grammar
 * upgrade needs a bump even when every case digest is unchanged, because the
 * cases cover only a few languages. A package or case added or removed only
 * makes the record stale: a new grammar's files were never in a graph, and a
 * removed case says nothing about output. Once the name differs from the
 * record's, the bump is done and the record is only stale.
 */
export function compareExtractorOutput(
  recorded: ExtractorOutputRecord | null,
  current: ExtractorOutputRecord,
): ExtractorOutputCheck {
  const needsBump: string[] = [];
  const stale: string[] = [];
  if (recorded === null) {
    stale.push('no record yet');
    return { needsBump, stale };
  }
  if (recorded.extractor !== current.extractor) {
    stale.push(`the record is for ${recorded.extractor}, the extractor is now ${current.extractor}`);
    return { needsBump, stale };
  }
  const diff = (label: string, before: Record<string, string>, after: Record<string, string>, describe: (name: string) => string) => {
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (!(name in after)) stale.push(`${label} ${name} removed`);
      else if (!(name in before)) stale.push(`${label} ${name} added`);
      else if (before[name] !== after[name]) needsBump.push(describe(name));
    }
  };
  diff('parser dependency', recorded.parserDependencies, current.parserDependencies,
    (name) => `parser dependency ${name} changed from ${recorded.parserDependencies[name]} to ${current.parserDependencies[name]}`);
  diff('golden case', recorded.outputs, current.outputs, (name) => `golden case "${name}" produces different output`);
  return { needsBump, stale };
}

export function readExtractorOutputRecord(file: string): ExtractorOutputRecord | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ExtractorOutputRecord;
}

export function writeExtractorOutputRecord(file: string, record: ExtractorOutputRecord): void {
  const sorted = (values: Record<string, string>) =>
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const body = {
    extractor: record.extractor,
    parserDependencies: sorted(record.parserDependencies),
    outputs: sorted(record.outputs),
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

/** The failure message for a check that did not pass, or null when it passed. */
export function extractorOutputFailure(check: ExtractorOutputCheck, updating: boolean): string | null {
  const lines = (items: string[]) => items.map((item) => `  - ${item}`).join('\n');
  if (check.needsBump.length > 0) {
    return [
      'The extractor now produces different output under the same name, so `ix map` would',
      'keep the old output for every unchanged file in an existing graph:',
      lines(check.needsBump),
      'A maintainer bumps `extractorName()` in core-ingestion/src/patch-builder.ts and adds the old',
      `name to PREVIOUS_EXTRACTORS, then runs \`${UPDATE_ENV}=1 npx vitest run src/__tests__/patchBuilder.golden.test.ts\``,
      'in core-ingestion. The record cannot be rewritten under the old name.',
    ].join('\n');
  }
  if (check.stale.length > 0 && !updating) {
    return [
      'core-ingestion/test-fixtures/extractor-output.json is out of date:',
      lines(check.stale),
      `Run \`${UPDATE_ENV}=1 npx vitest run src/__tests__/patchBuilder.golden.test.ts\` in core-ingestion.`,
    ].join('\n');
  }
  return null;
}
