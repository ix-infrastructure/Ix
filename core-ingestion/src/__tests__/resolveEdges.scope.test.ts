// Copyright 2026 Ix Infrastructure Inc.

// Regression tests for two ingestion defects:
//  1. JS/TS calls resolved by name alone: every vitest file's `describe(...)`
//     (a global / an import from 'vitest') got a CALLS edge to an unrelated
//     `SampleCommand.describe` method in test-fixtures.
//  2. Module paths passed to an import helper as string literals — including
//     paths into another package's build output (`dist/x.js` -> `src/x.ts`) —
//     produced no IMPORTS edge.

import { describe, expect, it } from 'vitest';

import { parseFile, type FileParseResult, type ResolvedEdge } from '../index.js';
import { resolveEdges } from './helpers/untiered.js';
import { buildPatch, buildPatchWithResolution } from '../patch-builder.js';

function parse(filePath: string, source: string): FileParseResult {
  const result = parseFile(filePath, source);
  expect(result).not.toBeNull();
  return result!;
}

const callsTo = (edges: ResolvedEdge[], dstFilePath: string) =>
  edges.filter(e => e.predicate === 'CALLS' && e.dstFilePath === dstFilePath);

const SAMPLE_COMMAND = parse(
  'core-ingestion/test-fixtures/typescript/sample-command.ts',
  [
    'export function statusOf(r: string[]): string { return r.join(","); }',
    'export class CheckRunner {',
    '  describe(results: string[]): string { return statusOf(results); }',
    '  run(): number { return 1; }',
    '}',
    '',
  ].join('\n'),
);

const SAMPLE_COMMAND_SOURCE = [
  'export class CheckRunner {',
  '  describe(results: string[]): string { return results.join(","); }',
  '  run(): number { return 1; }',
  '}',
  '',
].join('\n');

const DOCTOR = parse(
  'ix-cli/src/cli/doctor.ts',
  'export function runDoctor(): number { return 1; }\n',
);

describe('call resolution respects lexical scope (JS/TS)', () => {
  it('does not link a vitest-imported describe() to an unrelated describe method', () => {
    const testFile = parse(
      'ix-cli/src/cli/__tests__/doctor.test.ts',
      [
        'import { describe, it, expect } from "vitest";',
        'import { runDoctor } from "../doctor.js";',
        'describe("doctor", () => {',
        '  it("runs", () => { expect(runDoctor()).toBe(1); });',
        '});',
        '',
      ].join('\n'),
    );

    const edges = resolveEdges([testFile, DOCTOR, SAMPLE_COMMAND]);

    expect(callsTo(edges, SAMPLE_COMMAND.filePath)).toEqual([]);
    // The legitimate imported call still resolves at the import tier.
    expect(callsTo(edges, DOCTOR.filePath)).toEqual([
      expect.objectContaining({ dstName: 'runDoctor', dstQualifiedKey: 'runDoctor', confidence: 0.9 }),
    ]);
  });

  it('does not link a jest-style global describe() (no import) to anything in the repo', () => {
    const jestFile = parse(
      'web/src/__tests__/widget.test.ts',
      'describe("widget", () => { test("renders", () => { expect(1).toBe(1); }); });\n',
    );
    // A module-scope function of the same name, in a file the test never imports.
    const helpers = parse(
      'web/src/test-helpers.ts',
      'export function describe(name: string): string { return name; }\n',
    );

    // Each alone would have been an unambiguous global-tier match.
    expect(resolveEdges([jestFile, helpers]).filter(e => e.predicate === 'CALLS')).toEqual([]);
    expect(resolveEdges([jestFile, SAMPLE_COMMAND]).filter(e => e.predicate === 'CALLS')).toEqual([]);
  });

  it('never resolves a bare call to a class member, even in a file the caller imports', () => {
    const caller = parse(
      'src/app.ts',
      [
        'import { CheckRunner } from "./sample.js";',
        'export function main(r: CheckRunner): string {',
        '  run();',
        '  return describe(["x"]);',
        '}',
        '',
      ].join('\n'),
    );
    const sample = parse('src/sample.ts', SAMPLE_COMMAND_SOURCE);

    const edges = resolveEdges([caller, sample]);
    expect(callsTo(edges, 'src/sample.ts')).toEqual([]);
  });

  it('still resolves member calls on an imported class (import tier)', () => {
    const caller = parse(
      'src/app.ts',
      [
        'import { CheckRunner } from "./sample.js";',
        'export function main(r: CheckRunner): string { return r.describe(["x"]); }',
        '',
      ].join('\n'),
    );
    const sample = parse('src/sample.ts', SAMPLE_COMMAND_SOURCE);

    expect(callsTo(resolveEdges([caller, sample]), 'src/sample.ts')).toEqual([
      expect.objectContaining({ dstName: 'describe', dstQualifiedKey: 'CheckRunner.describe', confidence: 0.9 }),
    ]);
  });

  it('resolves a bare call to the module-scope definition when a same-named member also exists', () => {
    const caller = parse(
      'src/app.ts',
      'import { run } from "./tasks.js";\nexport function main() { return run(); }\n',
    );
    const tasks = parse(
      'src/tasks.ts',
      'export class Job { run() { return 0; } }\nexport function run() { return new Job().run(); }\n',
    );

    // Before: bestQKey saw ['Job.run', 'run'], called it ambiguous, dropped the edge.
    expect(callsTo(resolveEdges([caller, tasks]), 'src/tasks.ts')).toEqual([
      expect.objectContaining({ dstName: 'run', dstQualifiedKey: 'run', confidence: 0.9 }),
    ]);
  });

  it('keeps the global fallback for an unbound bare call to a unique module-scope function', () => {
    const caller = parse('src/foo.ts', 'export function callRun() { return helperFn(); }\n');
    const target = parse('src/bar.ts', 'export function helperFn() { return 1; }\n');

    expect(callsTo(resolveEdges([caller, target]), 'src/bar.ts')).toEqual([
      expect.objectContaining({ dstName: 'helperFn', dstQualifiedKey: 'helperFn', confidence: 0.5 }),
    ]);
  });

  it('does not un-drop an ambiguous global match by discarding same-named members', () => {
    // `gte` here is a parameter. Globally, the name is a method in
    // one file and a module-scope function in another: ambiguous before the
    // scope rules, and it must stay ambiguous -- dropping the method first would
    // make the unrelated module-scope `gte` look like the unique target.
    const caller = parse(
      'src/schema.ts',
      'export function between(gte: (a: number, b: number) => boolean, min: number) {\n  return gte(min, 0);\n}\n',
    );
    const semver = parse('src/semver.ts', 'export function gte(a: string, b: string) { return a >= b; }\n');
    const zod = parse('src/number.ts', 'export class NumberSchema { gte(n: number) { return this; } }\n');

    const edges = resolveEdges([caller, semver, zod]);
    expect(edges.filter(e => e.predicate === 'CALLS' && e.srcFilePath === 'src/schema.ts')).toEqual([]);
    // Without the method elsewhere, the unique module-scope function keeps the
    // global fallback exactly as before.
    expect(callsTo(resolveEdges([caller, semver]), 'src/semver.ts')).toEqual([
      expect.objectContaining({ dstName: 'gte', dstQualifiedKey: 'gte', confidence: 0.5 }),
    ]);
  });

  it('resolves an ambient-named helper destructured from a CommonJS require (import tier)', () => {
    const helpers = parse(
      'lib/helpers.js',
      'function test() { return 1; }\nfunction expect() { return 2; }\nmodule.exports = { test, expect };\n',
    );
    const user = parse(
      'lib/use.js',
      "const { test, expect } = require('./helpers');\nfunction go() { test(); expect(); }\nmodule.exports = { go };\n",
    );

    expect(callsTo(resolveEdges([user, helpers]), 'lib/helpers.js').map(e => e.dstQualifiedKey).sort())
      .toEqual(['expect', 'test']);
  });

  it('does not resolve a name imported from an external package to an unrelated in-repo symbol', () => {
    const caller = parse(
      'src/app.ts',
      'import { formatDate } from "date-lib";\nexport function main() { return formatDate(new Date()); }\n',
    );
    const unrelated = parse('src/legacy/format.ts', 'export function formatDate(d: Date) { return String(d); }\n');

    expect(callsTo(resolveEdges([caller, unrelated]), 'src/legacy/format.ts')).toEqual([]);
  });

  it('still resolves a monorepo workspace package import to the package that defines it', () => {
    const caller = parse(
      'packages/app/src/main.ts',
      'import { formatDate } from "@acme/utils";\nimport { parse } from "@babel/types";\nexport function main() { formatDate(new Date()); return parse(); }\n',
    );
    const utils = parse('packages/utils/src/dates.ts', 'export function formatDate(d: Date) { return String(d); }\n');
    const babel = parse('packages/babel-types/src/parse.ts', 'export function parse() { return 1; }\n');

    const edges = resolveEdges([caller, utils, babel]);
    expect(callsTo(edges, 'packages/utils/src/dates.ts')).toEqual([
      expect.objectContaining({ dstName: 'formatDate', confidence: 0.5 }),
    ]);
    expect(callsTo(edges, 'packages/babel-types/src/parse.ts')).toEqual([
      expect.objectContaining({ dstName: 'parse', confidence: 0.5 }),
    ]);
  });

  it('resolves a library\'s own tests importing it by package name', () => {
    // No directory is called `mylib`, so only the package.json declaration can
    // place it: the root declares it here, packages/tools declares another.
    const test = parse(
      'test/parse.test.ts',
      'import { parse } from "mylib";\nimport { lint } from "mylib-tools/lint";\nexport function t() { parse(); lint(); }\n',
    );
    const lib = parse('src/parse.ts', 'export function parse() { return 1; }\n');
    const tools = parse('packages/tools/src/lint.ts', 'export function lint() { return 1; }\n');
    const dirs = new Map([['mylib', ''], ['mylib-tools', 'packages/tools']]);

    expect(callsTo(resolveEdges([test, lib, tools]), 'src/parse.ts'), 'the directory-name guess alone').toEqual([]);
    const edges = resolveEdges([test, lib, tools], undefined, undefined, { packageDirOf: name => dirs.get(name) });
    expect(callsTo(edges, 'src/parse.ts')).toEqual([expect.objectContaining({ dstName: 'parse' })]);
    expect(callsTo(edges, 'packages/tools/src/lint.ts')).toEqual([expect.objectContaining({ dstName: 'lint' })]);
  });

  it('keeps a declared package\'s names inside its own directory', () => {
    const caller = parse('app/main.ts', 'import { parse } from "mylib-tools";\nexport function main() { return parse(); }\n');
    const elsewhere = parse('src/parse.ts', 'export function parse() { return 1; }\n');
    const dirs = new Map([['mylib-tools', 'packages/tools']]);

    const edges = resolveEdges([caller, elsewhere], undefined, undefined, { packageDirOf: name => dirs.get(name) });
    expect(callsTo(edges, 'src/parse.ts')).toEqual([]);
  });

  it('leaves non-JS languages on name-based resolution', () => {
    const caller = parse('app/main.py', 'def main():\n    return helper_fn()\n');
    const target = parse('lib/helpers.py', 'def helper_fn():\n    return 1\n');

    expect(callsTo(resolveEdges([caller, target]), 'lib/helpers.py')).toEqual([
      expect.objectContaining({ dstName: 'helper_fn', confidence: 0.5 }),
    ]);
  });
});

describe('bare calls never resolve to a class member (Python, Rust, PHP)', () => {
  it('Python: describe() does not link to another file\'s Foo.describe method', () => {
    const method = parse('pkg/fixtures.py', 'class Foo:\n    def describe(self):\n        return 1\n');
    const caller = parse('pkg/test_x.py', 'def test_x():\n    describe("x")\n');
    expect(callsTo(resolveEdges([caller, method]), method.filePath)).toEqual([]);
  });

  it('Python: a member call still reaches the method, and a bare call a module-scope function', () => {
    const lib = parse('pkg/lib.py', 'class Foo:\n    def describe(self):\n        return 1\n\ndef helper_fn():\n    return 2\n');
    const caller = parse('pkg/main.py', 'def run(obj):\n    obj.describe()\n    return helper_fn()\n');
    const edges = callsTo(resolveEdges([caller, lib]), lib.filePath);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ dstName: 'describe', dstQualifiedKey: 'Foo.describe' }),
      expect.objectContaining({ dstName: 'helper_fn', dstQualifiedKey: 'helper_fn' }),
    ]));
    expect(edges).toHaveLength(2);
  });

  it('Rust: describe() does not link to an impl method; a free function still resolves', () => {
    const lib = parse('src/lib.rs', 'struct Foo;\nimpl Foo {\n  fn describe(&self) -> i32 { 1 }\n}\npub fn helper_fn() -> i32 { 2 }\n');
    const caller = parse('src/main.rs', 'fn t() {\n  describe();\n  helper_fn();\n}\n');
    expect(callsTo(resolveEdges([caller, lib]), lib.filePath)).toEqual([
      expect.objectContaining({ dstName: 'helper_fn', dstQualifiedKey: 'helper_fn' }),
    ]);
  });

  it('PHP: describe() does not link to a class method; a function still resolves', () => {
    const lib = parse('src/Lib.php', '<?php\nclass Foo {\n  public function describe() { return 1; }\n}\nfunction helper_fn() { return 2; }\n');
    const caller = parse('src/main.php', '<?php\nfunction t() {\n  describe();\n  helper_fn();\n}\n');
    expect(callsTo(resolveEdges([caller, lib]), lib.filePath)).toEqual([
      expect.objectContaining({ dstName: 'helper_fn', dstQualifiedKey: 'helper_fn' }),
    ]);
  });
});

describe('dynamic and helper-literal imports (JS/TS)', () => {
  const LOADER_PATH = 'ix-cli/src/cli/commands/ingestion-loader.ts';
  const LOADER_SOURCE = [
    'import { dirname, resolve } from "node:path";',
    'const importModule = async (specifier: string) => import(specifier);',
    'function resolveIngestionModule(relativePath: string): string { return resolve(dirname("."), relativePath); }',
    'export async function loadIngestionModules() {',
    '  const local = await import("./watch-utils.js");',
    '  return Promise.all([',
    '    importModule(resolveIngestionModule("../../../../core-ingestion/dist/index.js")),',
    '    importModule(resolveIngestionModule("../../../../core-ingestion/dist/languages.js")),',
    '    importModule(resolveIngestionModule("../../../../core-ingestion/dist/missing.js")),',
    '    local,',
    '  ]);',
    '}',
    '',
  ].join('\n');

  const files = () => [
    parse(LOADER_PATH, LOADER_SOURCE),
    parse('ix-cli/src/cli/commands/watch-utils.ts', 'export function debounce() {}\n'),
    parse('core-ingestion/src/index.ts', 'export function parseFile() {}\n'),
    parse('core-ingestion/src/languages.ts', 'export function languageFromPath() {}\n'),
  ];

  const importsFrom = (edges: ResolvedEdge[], src: string) =>
    edges.filter(e => e.predicate === 'IMPORTS' && e.srcFilePath === src).map(e => e.dstFilePath).sort();

  it('resolves `await import("./x.js")` and helper literals into dist/ to their src/ sources', () => {
    expect(importsFrom(resolveEdges(files()), LOADER_PATH)).toEqual([
      'core-ingestion/src/index.ts',
      'core-ingestion/src/languages.ts',
      'ix-cli/src/cli/commands/watch-utils.ts',
    ]);
  });

  it('maps .mjs -> .mts and .cjs -> .cts build paths', () => {
    const loader = parse(
      'tools/load.ts',
      'export const a = import("../lib/dist/esm.mjs");\nexport const b = loadModule("../lib/dist/cjs.cjs");\n',
    );
    const mts = { ...parse('lib/src/esm.ts', 'export const x = 1;\n'), filePath: 'lib/src/esm.mts' };
    const cts = { ...parse('lib/src/cjs.ts', 'export const y = 1;\n'), filePath: 'lib/src/cjs.cts' };

    expect(importsFrom(resolveEdges([loader, mts, cts]), 'tools/load.ts')).toEqual([
      'lib/src/cjs.cts',
      'lib/src/esm.mts',
    ]);
  });

  it('prefers a tracked dist/ file over the src/ mapping', () => {
    const loader = parse('app/load.ts', 'export const m = import("../pkg/dist/x.js");\n');
    const dist = parse('pkg/dist/x.js', 'export const x = 1;\n');
    const src = parse('pkg/src/x.ts', 'export const x = 1;\n');

    expect(importsFrom(resolveEdges([loader, dist, src]), 'app/load.ts')).toEqual(['pkg/dist/x.js']);
  });

  it('does not map build output importing its own dist/ siblings to src/', () => {
    // Shipped declarations reference their siblings with source extensions; the
    // dependency is the sibling .d.ts, never the package's src/ tree.
    const decl = parse('pkg/dist/cluster/Message.d.ts', 'import * as Rpc from "../rpc/Rpc.ts";\nexport type M = Rpc.R;\n');
    const siblingSrc = parse('pkg/src/rpc/Rpc.ts', 'export type R = number;\n');

    expect(importsFrom(resolveEdges([decl, siblingSrc]), 'pkg/dist/cluster/Message.d.ts')).toEqual([]);
  });

  it('ignores string literals passed to non-import calls', () => {
    const reader = parse(
      'src/reader.ts',
      [
        'import { readFileSync } from "node:fs";',
        'export function read() { return readFileSync("./other.ts", "utf8") + describeModule; }',
        'const describeModule = String("./other.ts");',
        '',
      ].join('\n'),
    );
    const other = parse('src/other.ts', 'export const x = 1;\n');

    expect(reader.relationships.filter(r => r.importVia === 'helper')).toEqual([]);
    expect(importsFrom(resolveEdges([reader, other]), 'src/reader.ts')).toEqual([]);
  });

  it('emits a patch edge only for helper imports that resolved', () => {
    const [loader, ...rest] = files();
    const resolved = resolveEdges([loader, ...rest]);
    const patch = buildPatchWithResolution(loader, 'hash', 'ws', resolved);
    const importEdges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'IMPORTS');

    // node:path + watch-utils.js (real imports) + index.js + languages.js
    // (resolved helper literals); the unresolvable missing.js is dropped.
    expect(importEdges).toHaveLength(4);
    const claims = patch.ops.filter(op => op.type === 'AssertClaim' && String(op.field).startsWith('imports:'));
    expect(claims.map(op => op.value).sort()).toEqual(['index.js', 'languages.js', 'node:path', 'watch-utils.js']);

    // Without resolution a helper literal is only a guess: no edge at all.
    const unresolved = buildPatch(loader, 'hash', 'ws');
    const guessed = unresolved.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'IMPORTS');
    expect(guessed).toHaveLength(2); // node:path + the real `import("./watch-utils.js")`
  });
});
