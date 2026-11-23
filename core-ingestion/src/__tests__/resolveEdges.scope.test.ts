// Copyright 2026 Ix Infrastructure Inc.

// Regression tests for two ingestion defects:
//  1. JS/TS calls resolved by name alone: every vitest file's `describe(...)`
//     (a global / an import from 'vitest') got a CALLS edge to an unrelated
//     `SampleCommand.describe` method in test-fixtures.
//  2. Module paths passed to an import helper as string literals — including
//     paths into another package's build output (`dist/x.js` -> `src/x.ts`) —
//     produced no IMPORTS edge.

import { describe, expect, it } from 'vitest';

import { buildGlobalResolutionIndex, parseFile, resolveEdges as resolveEdgesWithTier, summarizeParseResult, type FileParseResult, type ResolvedEdge } from '../index.js';
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

    const edges = resolveEdges([caller, sample]);
    // The call's own edge as before, plus the typed receiver's exact member.
    expect(callsTo(edges, 'src/sample.ts')).toEqual([
      expect.objectContaining({ dstName: 'describe', dstQualifiedKey: 'CheckRunner.describe', confidence: 0.9 }),
      expect.objectContaining({ dstName: 'CheckRunner.describe', dstQualifiedKey: 'CheckRunner.describe', confidence: 0.95 }),
    ]);
    // One graph edge: the call's own id, upgraded to the type tier.
    const tiered = resolveEdgesWithTier([caller, sample]);
    const calls = buildPatchWithResolution(caller, 'h', 'ws', tiered).ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    const untyped = buildPatchWithResolution(caller, 'h', 'ws', tiered.filter(e => e.dstName === 'describe')).ops
      .filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS');
    expect(calls).toEqual(untyped.map(op => ({ ...op, attrs: { confidence: 0.95, tier: 'type' } })));
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
    // Nor does the unique module-scope function become its target without the
    // method: a call to a parameter names the parameter (#1020).
    expect(callsTo(resolveEdges([caller, semver]), 'src/semver.ts')).toEqual([]);
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

// #1020: across files, a member call or a call to a parameter was resolved by
// its bare name, whatever the receiver or the local scope said.
describe('member calls and calls to locals across files (#1020)', () => {
  const callsFrom = (edges: ResolvedEdge[], srcFilePath: string) =>
    edges.filter(e => e.predicate === 'CALLS' && e.srcFilePath === srcFilePath)
      .map(e => `${e.srcName} -> ${e.dstFilePath}:${e.dstQualifiedKey}`);

  it('TypeScript: a member call on a parameter does not resolve through an import of the file', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\nexport function other() {}\n');
    const caller = parse('src/b.ts', "import { other } from './a';\nexport function use(conn: Conn) { other(); conn.validate(); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['use -> src/a.ts:other']);
  });

  it('TypeScript: a member call is not bound by an import of the same name', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import { validate } from './a';\nexport function use(conn: Conn) { return conn.validate(); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual([]);
  });

  it('TypeScript: a call on a namespace import still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import * as a from './a';\nexport function use() { return a.validate(1); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['use -> src/a.ts:validate']);
  });

  it('JavaScript: a call on a lazily required module still reaches its function', () => {
    const lib = parse('src/api.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', "function use() { const api = require('./api'); return api.validate(1); }\nmodule.exports = { use };\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js')).toEqual(['use -> src/api.js:validate']);
  });

  // A local declared first and given the module later is still a module.
  it('JavaScript: a local assigned a module after its declaration still reaches the module function', () => {
    const lib = parse('src/api.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', [
      'function guarded(x) {',
      '  let api;',
      "  try { api = require('./api'); } catch (e) {}",
      '  return api.validate(x);',
      '}',
      'function hoisted(x) {',
      '  var api;',
      "  if (x) api = require('./api');",
      '  return api.validate(x);',
      '}',
      'async function dynamic(x) {',
      '  let api = null;',
      "  api = await import('./api');",
      '  return api.validate(x);',
      '}',
      'module.exports = { guarded, hoisted, dynamic };',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js').sort()).toEqual([
      'dynamic -> src/api.js:validate', 'guarded -> src/api.js:validate', 'hoisted -> src/api.js:validate',
    ]);
  });

  it('JavaScript: the callback of a dynamic import takes the module', () => {
    const lib = parse('src/api.js', 'export function validate(x) { return x; }\n');
    const caller = parse('src/b.js', [
      "export function arrow() { return import('./api').then(api => api.validate(1)); }",
      "export function named() { return import('./api').then(function (api) { return api.validate(1); }); }",
      "export function picked() { return import('./api').then(({ validate }) => validate(1)); }",
      // A promise of anything else hands over an ordinary value.
      'export function other(p) { return p.then(conn => conn.validate(1)); }',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js').sort()).toEqual([
      'arrow -> src/api.js:validate', 'named -> src/api.js:validate', 'picked -> src/api.js:validate',
    ]);
  });

  it('TypeScript: a local assigned a namespace import after its declaration still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import * as a from './a';",
      'export function late() { let m; m = a; return m.validate(1); }',
      'export function either(o: any) { let m = null; m = o ? o : a; return m.validate(1); }',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts').sort()).toEqual([
      'either -> src/a.ts:validate', 'late -> src/a.ts:validate',
    ]);
  });

  it('JavaScript: a local reassigned from another local or parameter is still a non-module receiver', () => {
    const lib = parse('src/a.js', 'export function validate(x) { return x; }\n');
    const caller = parse('src/b.js', [
      "import { validate } from './a';",
      'export function swap(conn, other) { let c; c = conn; c = other; return c.validate(1); }',
      'export function made() { let c = make(); c = make(); return c.validate(1); }',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js').filter(e => e.endsWith(':validate'))).toEqual([]);
  });

  it('JavaScript: a module stored on a this field still reaches the module function', () => {
    const lib = parse('src/api.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', [
      "const api = require('./api');",
      'class Lazy {',
      "  constructor() { this.api = require('./api'); }",
      '  run() { return this.api.validate(1); }',
      '}',
      'class Either {',
      '  constructor(f) { this.u = f ?? api; }',
      '  run() { return this.u.validate(1); }',
      '}',
      'module.exports = { Lazy, Either };',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js').sort()).toEqual([
      'Either.run -> src/api.js:validate', 'Lazy.run -> src/api.js:validate',
    ]);
  });

  it('TypeScript: a parameter property defaulting to a module still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import * as a from './a';",
      'export class Holder {',
      '  constructor(private u = a) {}',
      '  run() { return this.u.validate(1); }',
      '}',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['Holder.run -> src/a.ts:validate']);
  });

  it('Python: a module stored on self, or imported inside a function with a fallback, still reaches the module function', () => {
    const lib = parse('pkg/api.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', [
      'import importlib',
      'from pkg import api',
      '',
      'class Either:',
      '    def __init__(self, impl):',
      '        self.api = impl or api',
      '    def run(self):',
      '        return self.api.validate(1)',
      '',
      'class Dyn:',
      '    def __init__(self):',
      "        self.api = importlib.import_module('pkg.api')",
      '    def run(self):',
      '        return self.api.validate(1)',
      '',
      'def optional(x):',
      '    try:',
      '        from pkg import api',
      '    except ImportError:',
      '        api = None',
      '    return api.validate(x)',
      '',
      'def renamed(x):',
      '    try:',
      '        import pkg.api as mod',
      '    except ImportError:',
      '        mod = None',
      '    return mod.validate(x)',
      '',
    ].join('\n'));
    expect([...new Set(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py'))].sort()).toEqual([
      'Dyn.run -> pkg/api.py:validate', 'Either.run -> pkg/api.py:validate',
      'optional -> pkg/api.py:validate', 'renamed -> pkg/api.py:validate',
    ]);
  });

  // AMD binds each callback parameter, by position, to the module its
  // dependency array names: as much a module as a `require(...)` local.
  it('JavaScript: a member call on an AMD define() dependency still reaches the module function', () => {
    const lib = parse('src/utils.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/app.js', "define(['./utils'], function (utils) {\n  function go() { return utils.validate(1); }\n  return { go };\n});\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/app.js')).toEqual(['go -> src/utils.js:validate']);
  });

  it('JavaScript: a member call on an AMD require() dependency (arrow callback) still reaches the module function', () => {
    const lib = parse('src/utils.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/app.js', "function go() {\n  require(['./utils'], (utils) => utils.validate(1));\n}\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/app.js')).toEqual(['go -> src/utils.js:validate']);
  });

  it('JavaScript: only the AMD callback parameters the dependency array names are modules', () => {
    const lib = parse('src/utils.js', 'function validate(x) { return x; }\nfunction close() {}\nmodule.exports = { validate, close };\n');
    // `conn` has no dependency entry; a non-literal array binds nothing.
    const caller = parse('src/app.js', [
      "define(['./utils'], function (utils, conn) {",
      '  function go() { return conn.validate(1); }',
      '  return { go };',
      '});',
      'function other(deps) { define(deps, function (m) { return m.close(); }); }',
      "function third(dep) { define([dep], function (m) { return m.close(); }); }",
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/app.js')).toEqual([]);
  });

  // A UMD wrapper calls its factory with the dependencies (or hands it to
  // define()), so the factory's parameters hold modules.
  it('JavaScript: a member call on a UMD factory dependency still reaches the module function', () => {
    const lib = parse('src/dep.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', [
      '(function (root, factory) {',
      "  if (typeof define === 'function' && define.amd) define(['./dep'], factory);",
      "  else if (typeof module === 'object') module.exports = factory(require('./dep'));",
      '  else root.B = factory(root.Dep);',
      '})(this, function (dep) {',
      '  function run() { return dep.validate(1); }',
      '  return { run };',
      '});',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js')).toEqual(['run -> src/dep.js:validate']);
    const tiers = resolveEdgesWithTier([lib, caller]).filter(e => e.predicate === 'CALLS' && e.srcFilePath === 'src/b.js').map(e => e.tier);
    expect(tiers).toEqual(['import']);
  });

  it('JavaScript: a function passed to an IIFE that never calls it binds no modules', () => {
    const lib = parse('src/dep.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', [
      '(function (root, cb) { root.cb = cb; })(this, function (conn) {',
      '  function run() { return conn.validate(1); }',
      '  return { run };',
      '});',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js')).toEqual([]);
  });

  // An IIFE parameter is what the call passes in, looked up where the call is.
  it('JavaScript: a member call on an IIFE parameter holding a module still reaches the module function', () => {
    const lib = parse('src/a.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const viaLocal = parse('src/b.js', [
      "const a = require('./a');",
      '(function (lib) { function run() { return lib.validate(1); } run(); })(a);',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, viaLocal]), 'src/b.js')).toEqual(['run -> src/a.js:validate']);
    const direct = parse('src/c.js', "(function (lib) { function run() { return lib.validate(1); } run(); })(require('./a'));\n");
    expect(callsFrom(resolveEdges([lib, direct]), 'src/c.js')).toEqual(['run -> src/a.js:validate']);
    const arrowCall = parse('src/d.js', "((lib) => { function run() { return lib.validate(1); } run(); }).call(this, require('./a'));\n");
    expect(callsFrom(resolveEdges([lib, arrowCall]), 'src/d.js')).toEqual(['run -> src/a.js:validate']);
    const applied = parse('src/e.js', "(function (lib) { function run() { return lib.validate(1); } run(); }).apply(this, [require('./a')]);\n");
    expect(callsFrom(resolveEdges([lib, applied]), 'src/e.js')).toEqual(['run -> src/a.js:validate']);
  });

  it('JavaScript: an IIFE parameter given a non-module value stays a non-module local', () => {
    const lib = parse('src/a.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    // `{}` has no roots; `a` is the IIFE's own parameter name, but the
    // argument is the enclosing function's local `conn`, not the module.
    const caller = parse('src/b.js', [
      "const a = require('./a');",
      '(function (lib) { function run() { return lib.validate(1); } run(); })({});',
      'function outer(conn) {',
      '  (function (a) { function go() { return a.validate(1); } go(); })(conn);',
      '}',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js')).toEqual([]);
  });

  // #1020 accepted trade-off: an untyped parameter with no default is a
  // receiver known not to be a module, whatever it is named, so even
  // `module.validate()` gets no edge to a module-level `validate`. Only a
  // module-typed parameter (`typeof A`, `ModuleType`), a module default or an
  // AMD dependency keeps it.
  it('Python: an untyped parameter receiver gets no module-function edge, by design', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', 'import pkg.a\n\ndef setup(module):\n    module.validate(1)\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual([]);
  });

  it('TypeScript/JavaScript: an untyped parameter receiver gets no module-function edge, by design', () => {
    const tsLib = parse('src/a.ts', 'export function validate(x: number) { return x; }\nexport function other() {}\n');
    const tsCaller = parse('src/b.ts', "import { other } from './a';\nexport function setup(module) { other(); module.validate(1); }\n");
    expect(callsFrom(resolveEdges([tsLib, tsCaller]), 'src/b.ts')).toEqual(['setup -> src/a.ts:other']);
    const jsLib = parse('src/c.js', 'function validate(x) { return x; }\nmodule.exports = { validate };\n');
    const jsCaller = parse('src/d.js', 'function setup(module) { return module.validate(1); }\nmodule.exports = { setup };\n');
    expect(callsFrom(resolveEdges([jsLib, jsCaller]), 'src/d.js')).toEqual([]);
  });

  it('TypeScript: a member call on an unknown receiver still reaches a method in another file', () => {
    const lib = parse('src/check.ts', 'export class Checker { describe() { return 1; } }\n');
    const caller = parse('src/b.ts', "import './check';\nexport function use(x: Thing) { return x.describe(); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['use -> src/check.ts:Checker.describe']);
  });

  it('Python: a member call on a parameter does not take the global fallback to a module function', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', 'def use(conn):\n    conn.validate()\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual([]);
  });

  it('Python: an unknown receiver reaches another file\'s method even when this file has a module function of the name', () => {
    const lib = parse('pkg/lib.py', 'class Foo:\n    def describe(self):\n        return 1\n');
    const caller = parse('pkg/main.py', 'def describe():\n    return 0\n\ndef run(obj):\n    return obj.describe()\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/main.py')).toEqual(['run -> pkg/lib.py:Foo.describe']);
  });

  it('Python: a call to a parameter is not bound by the import it shadows', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', 'from pkg.a import validate\n\ndef use(validate):\n    return validate(1)\n\ndef plain():\n    return validate(1)\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual(['plain -> pkg/a.py:validate']);
  });

  // A local is only as local as what it aliases: a local that names a module,
  // or is destructured from a namespace import, still reaches its functions.
  it('TypeScript: a name destructured from a namespace import inside a function still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import * as utils from './a';\nexport function f() { const { validate } = utils; return validate(1); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['f -> src/a.ts:validate']);
  });

  it('TypeScript: a member call on a local alias of a namespace import still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import * as utils from './a';\nexport function f() { const m = utils; return m.validate(1); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['f -> src/a.ts:validate']);
  });

  it('TypeScript: an alias of a parameter is still a local', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import './a';\nexport function f(conn: Conn) { const c = conn; c.validate(1); }\nexport function g(conn: Conn) { const { validate } = conn; validate(1); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual([]);
  });

  it('Python: a member call on a local alias of a module still reaches the module function', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', 'from pkg import a\n\ndef f():\n    m = a\n    m.validate(1)\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual(['f -> pkg/a.py:validate']);
  });

  it('Python: an alias of a parameter is still a local', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', 'def f(conn):\n    c = conn\n    c.validate(1)\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual([]);
  });

  // A property assigned a function reference (`self.validate = validate`)
  // makes `self.validate()` a call of that function, not of a method.
  it('Python: a self attribute holding an imported function still reaches it', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', [
      'from pkg.a import validate',
      '',
      'class S:',
      '    def __init__(self):',
      '        self.validate = validate',
      '    def run(self):',
      '        self.validate(1)',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toContain('S.run -> pkg/a.py:validate');
  });

  it('TypeScript: a this property holding an imported function still reaches it', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import { validate } from './a';",
      'export class S {',
      '  v: any;',
      '  constructor() { this.handlers = { validate }; }',
      '  run() { this.handlers.validate(1); }',
      '}',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toContain('S.run -> src/a.ts:validate');
  });

  it('Rust: a method call does not resolve to another file\'s free function', () => {
    const lib = parse('src/lib.rs', 'pub fn validate(x: i32) -> i32 { x }\n');
    const caller = parse('src/main.rs', 'fn t(conn: Conn) {\n  conn.validate();\n}\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'src/main.rs')).toEqual([]);
  });

  // A receiver that may hold a module through a compound value, a parameter's
  // default or type, a loop or importlib is not a non-module local.
  it('TypeScript: a receiver holding a module through ??, a default, typeof or a loop still reaches the module function', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import * as A from './a';",
      'export function g(o: Opts) { const m = o.impl ?? A; m.validate(1); }',
      'export function h(mod: typeof A) { mod.validate(1); }',
      'export function d(mod = A) { mod.validate(1); }',
      'export function l() { for (const m of [A]) m.validate(1); }',
      'export function c(o: Opts) { const m = o.flag ? o.impl : o.other; m.validate(1); }',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts').sort()).toEqual([
      'd -> src/a.ts:validate', 'g -> src/a.ts:validate', 'h -> src/a.ts:validate', 'l -> src/a.ts:validate',
    ]);
  });

  it('JavaScript: a parameter defaulting to a module still reaches the module function', () => {
    const lib = parse('src/a.js', 'export function validate(x) { return x; }\n');
    const caller = parse('src/b.js', "import * as A from './a';\nexport function d(mod = A) { mod.validate(1); }\nexport function p(conn) { conn.validate(1); }\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js')).toEqual(['d -> src/a.js:validate']);
  });

  it('Python: a receiver holding a module through a default, importlib, or/if or a loop still reaches the module function', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', [
      'import importlib',
      'from pkg import a',
      '',
      'def run(mod=a):',
      '    mod.validate(1)',
      '',
      'def dyn():',
      "    m = importlib.import_module('pkg.a')",
      '    m.validate(1)',
      '',
      'def either(o):',
      '    m = o.impl or a',
      '    m.validate(1)',
      '',
      'def loop():',
      '    for m in (a,):',
      '        m.validate(1)',
      '',
      'def local(conn):',
      '    for c in conn.items:',
      '        c.validate(1)',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py').sort()).toEqual([
      'dyn -> pkg/a.py:validate', 'either -> pkg/a.py:validate', 'loop -> pkg/a.py:validate', 'run -> pkg/a.py:validate',
    ]);
  });

  // A class-body binding of a function is an attribute holding it.
  it('Python: a class attribute holding a function still reaches it through self', () => {
    const lib = parse('pkg/a.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', [
      'from pkg.a import validate',
      '',
      'class S:',
      '    validate = staticmethod(validate)',
      '    def run(self):',
      '        self.validate(1)',
      '',
      'class T:',
      '    validate = validate',
      '    def run(self):',
      '        self.validate(1)',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py').sort()).toEqual(['S.run -> pkg/a.py:validate', 'T.run -> pkg/a.py:validate']);
  });

  it('TypeScript: a class field holding an imported function still reaches it through this', () => {
    const lib = parse('src/a.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', "import { validate } from './a';\nexport class S {\n  validate = validate;\n  run() { this.validate(1); }\n}\n");
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['S.run -> src/a.ts:validate']);
  });

  // A property holding a whole module (`this.utils = utils`) makes
  // `this.utils.validate()` a call on that module, not a member-only call.
  it('TypeScript: a this property or class field holding a namespace import still reaches the module function', () => {
    const lib = parse('src/utils.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import * as utils from './utils';",
      'export class C {',
      '  utils = utils;',
      '  run() { this.utils.validate(1); }',
      '}',
      'export class D {',
      '  u: any;',
      '  constructor() { this.u = utils; }',
      '  run() { this.u.validate(1); }',
      '}',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts').sort()).toEqual([
      'C.run -> src/utils.ts:validate', 'D.run -> src/utils.ts:validate',
    ]);
  });

  it('TypeScript: a this property holding a parameter is still a non-module receiver', () => {
    const lib = parse('src/utils.ts', 'export function validate(x: number) { return x; }\n');
    const caller = parse('src/b.ts', [
      "import * as utils from './utils';",
      'export class C {',
      '  conn: any;',
      '  constructor(conn: Conn) { this.conn = conn; utils.validate(0); }',
      '  run() { this.conn.validate(1); }',
      '}',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.ts')).toEqual(['C.constructor -> src/utils.ts:validate']);
  });

  it('Python: a self attribute holding an imported module still reaches the module function', () => {
    const lib = parse('pkg/utils.py', 'def validate(x):\n    return x\n');
    const caller = parse('pkg/b.py', [
      'from pkg import utils',
      '',
      'class C:',
      '    def __init__(self):',
      '        self.u = utils',
      '    def run(self):',
      '        self.u.validate(1)',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([lib, caller]), 'pkg/b.py')).toEqual(['C.run -> pkg/utils.py:validate']);
  });

  // A base class in another file may store a module function on the
  // instance; the subclass's `this.validate()` / `self.validate()` reads it.
  it('JavaScript/Python: a property a base class in another file sets to a module function still reaches it', () => {
    const helpers = parse('src/helpers.js', 'function validate() {}\nmodule.exports = { validate };\n');
    const base = parse('src/base.js', "const { validate } = require('./helpers');\nclass Base { constructor() { this.validate = validate; } }\nmodule.exports = { Base };\n");
    const sub = parse('src/b.js', "const { Base } = require('./base');\nclass A extends Base { run() { this.validate(); } }\n");
    expect(callsFrom(resolveEdges([helpers, base, sub]), 'src/b.js')).toEqual(['A.run -> src/helpers.js:validate']);
    // Also when the base is known only through the index (a batch without it).
    const index = buildGlobalResolutionIndex([helpers.filePath, base.filePath],
      new Map([helpers, base].map(r => [r.filePath, summarizeParseResult(r)])));
    expect(callsFrom(resolveEdges([sub], undefined, index), 'src/b.js')).toEqual(['A.run -> src/helpers.js:validate']);

    const pyLib = parse('pkg/h.py', 'def validate():\n    pass\n');
    const pyBase = parse('pkg/a.py', 'from pkg.h import validate\n\nclass Base:\n    def __init__(self):\n        self.validate = validate\n');
    const pySub = parse('pkg/b.py', 'from pkg.a import Base\n\nclass A(Base):\n    def run(self):\n        self.validate()\n');
    expect(callsFrom(resolveEdges([pyLib, pyBase, pySub]), 'pkg/b.py')).toEqual(['A.run -> pkg/h.py:validate']);
  });

  it('JavaScript/Python: a module a base class in another file stores on the instance still reaches the module function', () => {
    const helpers = parse('src/helpers.js', 'function validate() {}\nmodule.exports = { validate };\n');
    const base = parse('src/base.js', "const helpers = require('./helpers');\nclass Base { constructor() { this.helpers = helpers; } }\nmodule.exports = { Base };\n");
    const sub = parse('src/b.js', "const { Base } = require('./base');\nclass A extends Base { run() { this.helpers.validate(); } }\n");
    expect(callsFrom(resolveEdges([helpers, base, sub]), 'src/b.js')).toEqual(['A.run -> src/helpers.js:validate']);

    const pyLib = parse('pkg/h.py', 'def validate():\n    pass\n');
    const pyBase = parse('pkg/a.py', 'from pkg import h\n\nclass Base:\n    def __init__(self):\n        self.helpers = h\n');
    const pySub = parse('pkg/b.py', 'from pkg.a import Base\n\nclass A(Base):\n    def run(self):\n        self.helpers.validate()\n');
    expect(callsFrom(resolveEdges([pyLib, pyBase, pySub]), 'pkg/b.py')).toEqual(['A.run -> pkg/h.py:validate']);
  });

  it('JavaScript: functions mixed into a prototype still reach the module function', () => {
    const helpers = parse('src/helpers.js', 'function validate() {}\nmodule.exports = { validate };\n');
    // A mixin this file cannot list the names of.
    const opaque = parse('src/b.js', "class A { run() { this.validate(); } }\nObject.assign(A.prototype, require('./helpers'));\n");
    expect(callsFrom(resolveEdges([helpers, opaque]), 'src/b.js')).toEqual(['A.run -> src/helpers.js:validate']);
    // An object literal mixed in from another file.
    const target = parse('src/c.js', 'class C { run() { this.validate(); } }\nmodule.exports = { C };\n');
    const mixin = parse('src/m.js', "const { validate } = require('./helpers');\nconst { C } = require('./c');\nObject.assign(C.prototype, { validate });\n");
    expect(callsFrom(resolveEdges([helpers, target, mixin]), 'src/c.js')).toEqual(['C.run -> src/helpers.js:validate']);
  });

  it('JavaScript: an instance property set from a parameter, or a parameter mixed in, stays a non-module receiver', () => {
    const helpers = parse('src/helpers.js', 'function validate() {}\nmodule.exports = { validate };\n');
    const caller = parse('src/b.js', [
      'class A {',
      '  constructor(conn, options) { this.conn = conn; Object.assign(this, options); }',
      '  run() { this.conn.validate(); this.validate(); }',
      '}',
      '',
    ].join('\n'));
    expect(callsFrom(resolveEdges([helpers, caller]), 'src/b.js')).toEqual([]);
    // An object literal that is not put on an instance or prototype (the
    // module's exports) does not make other files' member calls plain calls.
    const other = parse('src/c.js', 'class C { run() { this.validate(); } }\n');
    expect(callsFrom(resolveEdges([helpers, other]), 'src/c.js')).toEqual([]);
  });

  it('Rust: a method call reaches a trait-impl method in another file', () => {
    const lib = parse('src/shape.rs', 'pub trait Shape {\n    fn area(&self) -> f64;\n}\npub struct Sq;\nimpl Shape for Sq {\n    fn area(&self) -> f64 { 1.0 }\n}\n');
    const caller = parse('src/main.rs', 'fn make(s: &dyn Shape) {\n    s.area();\n}\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'src/main.rs')).toEqual(['make -> src/shape.rs:area']);
  });

  it('JavaScript: a member call on a parameter reaches an object-literal or prototype method in another file', () => {
    const lib = parse('src/api.js', 'export const api = {\n  validate() { return 1; },\n};\nfunction Foo() {}\nFoo.prototype.save = function () {};\n');
    const caller = parse('src/b.js', 'export function f(x) {\n  x.validate();\n  x.save();\n}\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'src/b.js').sort()).toEqual(['f -> src/api.js:save', 'f -> src/api.js:validate']);
  });

  it('a summary written before bareMembers existed counts its bare keys as members', () => {
    const lib = parse('src/shape.rs', 'pub fn area() -> f64 { 1.0 }\n');
    const caller = parse('src/main.rs', 'fn make(s: &dyn Shape) {\n    s.area();\n}\n');
    const { bareMembers: _b, ...old } = summarizeParseResult(lib);
    const index = buildGlobalResolutionIndex([lib.filePath], new Map([[lib.filePath, old]]));
    expect(callsFrom(resolveEdges([caller], undefined, index), 'src/main.rs')).toEqual(['make -> src/shape.rs:area']);
    // With a current summary the free function is not a member call's target.
    expect(callsFrom(resolveEdges([lib, caller]), 'src/main.rs')).toEqual([]);
  });

  it('PHP: a -> call does not resolve to another file\'s function', () => {
    const lib = parse('src/lib.php', '<?php\nfunction validate($x) { return $x; }\n');
    const caller = parse('src/main.php', '<?php\nfunction t($conn) {\n  $conn->validate();\n}\n');
    expect(callsFrom(resolveEdges([lib, caller]), 'src/main.php')).toEqual([]);
  });
});
