// Copyright 2026 Ix Infrastructure Inc.

import * as nodePath from 'node:path';

export type EntityRole = 'production' | 'test' | 'fixture' | 'generated' | 'external' | 'tooling';

export interface RoleClassification {
  role: EntityRole;
  role_confidence: number;   // 0–1
  role_signals: string[];    // human-readable signal names that fired
}

// ---------------------------------------------------------------------------
// Signal tables
// ---------------------------------------------------------------------------

const TEST_PATH_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /[/\\]__tests__[/\\]/i,           signal: 'path:__tests__' },
  { pattern: /[/\\]tests?[/\\]/i,              signal: 'path:tests/' },
  { pattern: /[/\\]spec[/\\]/i,                signal: 'path:spec/' },
  { pattern: /[/\\]src[/\\]test[/\\]/i,        signal: 'path:src/test/' },
  { pattern: /[/\\]test[/\\]unit[/\\]/i,       signal: 'path:test/unit/' },
  { pattern: /[/\\]test[/\\]integration[/\\]/i,signal: 'path:test/integration/' },
  // C#/.NET: directories named Foo.Tests or Foo.Test (e.g. Newtonsoft.Json.Tests/)
  { pattern: /[/\\][^/\\]*\.tests?[/\\]/i,     signal: 'path:.Tests/' },
];

const TEST_FILE_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /\.test\.[^.]+$/i,  signal: 'filename:.test.' },
  { pattern: /\.spec\.[^.]+$/i,  signal: 'filename:.spec.' },
  { pattern: /Tests?\.[^.]+$/,   signal: 'filename:Test(s).' },  // matches Test.cs and Tests.cs
  // FooSpec is a test only where the test frameworks name them so (ScalaTest,
  // Spock, Kotest). Elsewhere `PodSpec.go` and `OpenApiSpec.ts` are code.
  { pattern: /Spec\.(?:scala|groovy|kt|kts)$/, signal: 'filename:Spec.' },
  { pattern: /_test\.[^.]+$/i,   signal: 'filename:_test.' },
  { pattern: /_spec\.[^.]+$/i,   signal: 'filename:_spec.' },
  // pytest's conventions
  { pattern: /^test_[^/\\]*\.py$/, signal: 'filename:test_*.py' },
  { pattern: /^conftest\.py$/,   signal: 'filename:conftest.py' },
];

/** Data and docs: a `spec/` directory holding these is an API spec, not tests. */
const DATA_FILE = /\.(?:ya?ml|json|toml|md|txt|xml|proto|graphql)$/i;

const TEST_IMPORT_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /from ['"](?:jest|vitest|mocha|chai|sinon|jasmine|@testing-library)/,  signal: 'import:js_test_framework' },
  { pattern: /require\(['"](?:jest|vitest|mocha|chai|sinon|jasmine)['"]\)/,          signal: 'import:js_test_framework_require' },
  { pattern: /import\s+(?:unittest|pytest)/,                                         signal: 'import:python_test_framework' },
  { pattern: /from\s+(?:unittest|pytest)/,                                           signal: 'import:python_test_framework_from' },
  { pattern: /import\s+org\.junit/,                                                  signal: 'import:junit' },
  { pattern: /import\s+org\.testng/,                                                 signal: 'import:testng' },
  { pattern: /import\s+io\.mockk/,                                                   signal: 'import:mockk' },
  { pattern: /import\s+org\.mockito/,                                                signal: 'import:mockito' },
  { pattern: /import\s+org\.scalatest/,                                              signal: 'import:scalatest' },
  { pattern: /import\s+munit/,                                                       signal: 'import:munit' },
  { pattern: /import\s+zio\.test/,                                                   signal: 'import:zio_test' },
  // Go's "testing" is checked separately, and only for .go files: the string
  // alone matched `=== "testing"` in any language.
  { pattern: /require\s+['"]rspec['"]/,                                              signal: 'import:rspec' },
  { pattern: /require\s+['"]minitest['"]/,                                           signal: 'import:minitest' },
  // C#/.NET test frameworks
  { pattern: /using\s+NUnit\.Framework/,                                             signal: 'import:nunit' },
  { pattern: /using\s+Xunit/,                                                        signal: 'import:xunit' },
  { pattern: /using\s+Microsoft\.VisualStudio\.TestTools\.UnitTesting/,              signal: 'import:mstest' },
];

const FIXTURE_PATH_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /[/\\]fixtures?[/\\]/i,         signal: 'path:fixtures/' },
  { pattern: /[/\\]__fixtures__[/\\]/i,      signal: 'path:__fixtures__/' },
  { pattern: /[/\\]test[/\\]resources[/\\]/i,signal: 'path:test/resources/' },
  { pattern: /[/\\]testdata[/\\]/i,          signal: 'path:testdata/' },
];

// Whole words only -- separated by `.`, `_`, `-` or the ends of the name, or
// a CamelCase prefix for test doubles (`FakeClock.java`). As substrings they
// caught `resample.py`, `SampleRate.java` and `seed.ts`, and a fixture's
// symbols are hidden by default. `seed` is gone: a seed script is code.
const FIXTURE_FILE_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /(?:^|[._-])fixtures?(?:[._-]|$)/i, signal: 'filename:fixture' },
  { pattern: /\.mock\.[^.]+$/i, signal: 'filename:.mock.' },
  // No `i` flag: it would let `^Stub[A-Z]` match "Stubborn".
  { pattern: /(?:^|[._-])(?:stubs?|Stubs?|STUBS?)(?:[._-]|$)|^Stub[A-Z]/, signal: 'filename:stub' },
  { pattern: /(?:^|[._-])(?:fakes?|Fakes?|FAKES?)(?:[._-]|$)|^Fake[A-Z]/, signal: 'filename:fake' },
  { pattern: /(?:^|[._-])samples?(?:[._-]|$)/i, signal: 'filename:sample' },
];

const GENERATED_PATH_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /[/\\]generated[/\\]/i, signal: 'path:generated/' },
  { pattern: /[/\\]gen[/\\]/i,       signal: 'path:gen/' },
  { pattern: /[/\\]\.gen[/\\]/i,     signal: 'path:.gen/' },
  { pattern: /\.pb\.[^.]+$/,         signal: 'filename:.pb. (protobuf)' },
  { pattern: /\.gen\.[^.]+$/,        signal: 'filename:.gen.' },
  { pattern: /_generated\.[^.]+$/,   signal: 'filename:_generated.' },
];

const GENERATED_SOURCE_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /^\/\/ Code generated/m,   signal: 'source_marker:code_generated' },
  { pattern: /^\/\/ DO NOT EDIT/m,      signal: 'source_marker:do_not_edit' },
  { pattern: /^# Code generated/m,      signal: 'source_marker:code_generated_hash' },
  { pattern: /^# DO NOT EDIT/m,         signal: 'source_marker:do_not_edit_hash' },
  { pattern: /^\/\* Generated by/m,     signal: 'source_marker:generated_by' },
  { pattern: /^\/\* AUTO-GENERATED/im,  signal: 'source_marker:auto_generated' },
  { pattern: /^\/\/ AUTO-GENERATED/im,  signal: 'source_marker:auto_generated_line' },
];

const EXTERNAL_PATH_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /[/\\]vendor[/\\]/i,          signal: 'path:vendor/' },
  { pattern: /[/\\]third[-_]?party[/\\]/i, signal: 'path:third_party/' },
  { pattern: /[/\\]extern[/\\]/i,          signal: 'path:extern/' },
];

const TOOLING_PATH_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /[/\\]scripts?[/\\]/i, signal: 'path:scripts/' },
  { pattern: /[/\\]tools?[/\\]/i,   signal: 'path:tools/' },
  { pattern: /[/\\]ci[/\\]/i,       signal: 'path:ci/' },
  { pattern: /[/\\]\.github[/\\]/i, signal: 'path:.github/' },
  { pattern: /[/\\]dev[/\\]/i,      signal: 'path:dev/' },
];

const TOOLING_FILE_PATTERNS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /^Makefile$/,                    signal: 'filename:Makefile' },
  { pattern: /^Dockerfile[^/\\]*$/,           signal: 'filename:Dockerfile' },
  { pattern: /^docker-compose[^/\\]*\.yml$/i, signal: 'filename:docker-compose' },
  { pattern: /\.config\.[^.]+$/i,             signal: 'filename:.config.' },
  { pattern: /^vite\.config\./i,              signal: 'filename:vite.config' },
  { pattern: /^webpack\.config\./i,           signal: 'filename:webpack.config' },
  { pattern: /^jest\.config\./i,              signal: 'filename:jest.config' },
  { pattern: /^babel\.config\./i,             signal: 'filename:babel.config' },
  { pattern: /^tsconfig[^/\\]*\.json$/i,      signal: 'filename:tsconfig.json' },
  { pattern: /^\.eslintrc/i,                  signal: 'filename:.eslintrc' },
  { pattern: /^rollup\.config\./i,            signal: 'filename:rollup.config' },
  { pattern: /^build\.[^.]+$/i,               signal: 'filename:build.' },
  { pattern: /migrate\.[^.]+$/i,              signal: 'filename:migrate.' },
];

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/** A Go file that imports the standard `testing` package. */
const GO_TESTING_IMPORT = /^import\s*(?:\([^)]*"testing"|"testing")/m;

export function classifyFileRole(filePath: string, source?: string): RoleClassification {
  // Always with a leading `/`: the directory patterns need a separator before
  // the name, and the CLI passes workspace-relative paths, so a root-level
  // `tests/`, `vendor/` or `scripts/` never matched.
  const normalizedPath = `/${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const fileName = nodePath.basename(filePath);
  const isDataFile = DATA_FILE.test(fileName);

  /** First matching pattern of `table` against `subject`, adding `weight` to `bucket`. */
  const buckets = new Map<EntityRole, { score: number; signals: string[] }>();
  const add = (
    bucket: EntityRole,
    table: Array<{ pattern: RegExp; signal: string }>,
    subject: string,
    weight: number,
    skip?: (signal: string) => boolean,
  ): void => {
    for (const { pattern, signal } of table) {
      if (skip?.(signal) || !pattern.test(subject)) continue;
      const b = buckets.get(bucket) ?? { score: 0, signals: [] };
      b.score += weight;
      b.signals.push(signal);
      buckets.set(bucket, b);
      return;
    }
  };

  // --- Test ---
  add('test', TEST_PATH_PATTERNS, normalizedPath, 0.8, signal => signal === 'path:spec/' && isDataFile);
  add('test', TEST_FILE_PATTERNS, fileName, 0.9);
  if (source) {
    const imports = fileName.endsWith('.go')
      ? [...TEST_IMPORT_PATTERNS, { pattern: GO_TESTING_IMPORT, signal: 'import:go_testing' }]
      : TEST_IMPORT_PATTERNS;
    add('test', imports, source, 0.5);
  }

  // --- Fixture ---
  add('fixture', FIXTURE_PATH_PATTERNS, normalizedPath, 0.8);
  add('fixture', FIXTURE_FILE_PATTERNS, fileName, 0.6);

  // --- Generated ---
  add('generated', GENERATED_PATH_PATTERNS, normalizedPath, 0.7);
  if (source) add('generated', GENERATED_SOURCE_PATTERNS, source, 0.9);

  // --- External ---
  add('external', EXTERNAL_PATH_PATTERNS, normalizedPath, 0.9);

  // --- Tooling ---
  add('tooling', TOOLING_PATH_PATTERNS, normalizedPath, 0.6);
  add('tooling', TOOLING_FILE_PATTERNS, fileName, 0.7);

  // --- Pick winner ---
  // On a tie the more specific bucket wins: `test/fixtures/x.json` is a
  // fixture, though both directories now match from the root.
  const order: EntityRole[] = ['fixture', 'test', 'generated', 'external', 'tooling'];
  let top: { role: EntityRole; score: number; signals: string[] } | undefined;
  for (const role of order) {
    const b = buckets.get(role);
    if (b && (!top || b.score > top.score)) top = { role, ...b };
  }

  if (top && top.score >= 0.5) {
    return {
      role: top.role,
      role_confidence: parseFloat(Math.min(top.score, 1.0).toFixed(2)),
      // The winner's reasons only; another bucket's signals explain nothing.
      role_signals: top.signals,
    };
  }

  return { role: 'production', role_confidence: 0.5, role_signals: [] };
}
