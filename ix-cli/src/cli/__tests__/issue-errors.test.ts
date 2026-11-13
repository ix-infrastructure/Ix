// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadIngestionModules } from '../commands/ingestion-loader.js';
import { stripMapModeOps } from '../commands/ingest.js';
import type { GraphPatchPayload } from '../../client/types.js';
import { buildIssueErrorIndex } from '../explain/issue-errors.js';
import { extractCandidates, issueConfidence, pickStartingPoints, planIssue, rankIssueFiles, type SymbolHit } from '../explain/issue.js';
import { parseTraceFrame } from '../explain/traceback.js';
import * as issue from '../explain/issue.js';
// @ts-expect-error -- the benchmark harness is a standalone JavaScript module.
import { evaluateErrorSlice } from '../../../scripts/ranking-eval/error-slice.mjs';

const fixture = (name: string) => readFileSync(new URL(`../../../../core-ingestion/test-fixtures/error-sites/${name}`, import.meta.url), 'utf8');

async function corpus(names: string[], extra: Record<string, string> = {}) {
  const [parser, builder] = await loadIngestionModules();
  const texts = new Map([...names.map(name => [`src/${name}`, fixture(name)] as const), ...Object.entries(extra)]);
  const repo = { files: () => [...texts.keys()], read: (path: string) => texts.get(path), grep: (needle: string) => [...texts].filter(([, text]) => text.includes(needle)).map(([path, line]) => ({ path, line })) };
  const symbols: SymbolHit[] = [];
  for (const [path, text] of texts) {
    const parsed = parser.parseFile(path, text);
    const patch = builder.buildPatch(parsed, 'hash', 'workspace');
    for (const entity of parsed.entities) {
      const key = entity.container ? `${entity.container}.${entity.name}` : entity.name;
      symbols.push({ id: builder.symbolNodeId('workspace', path, key), path, ...entity });
    }
    expect(patch.ops.length).toBeGreaterThan(0);
  }
  const search = async (name: string) => symbols.filter(s => s.name === name);
  const errorIndex = await buildIssueErrorIndex(repo, repo.files());
  return { repo, search, errorIndex };
}

describe('runtime error localization', () => {
  afterEach(() => vi.restoreAllMocks());

  it('bounds a 1,000-file message scan and preserves identifier localization', async () => {
    // Freeze time so this proves the file cap even on a fast machine.
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const files = Array.from({ length: 1000 }, (_, n) => `src/fail${n}.ts`);
    const source = fixture('fail.ts').padEnd(13079, ' ');
    const read = vi.fn(() => source);
    const repo = { files: () => files, read, grep: () => files.map(path => ({ path, line: source })) };
    const errorIndex = await buildIssueErrorIndex(repo, files);
    const search = async (name: string): Promise<SymbolHit[]> => name === 'renderTable'
      ? [{ name, kind: 'function', path: files[999], id: 'render-table' }] : [];
    const text = 'The renderTable function produces incorrect output.';
    const baseline = await pickStartingPoints(text, { files, search });
    expect((await pickStartingPoints(text, { files, search, errorIndex })).starts).toEqual(baseline.starts);
    expect(baseline.starts).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(32);
    // Repeated matching and new traceback requests share the exhausted budget.
    expect(errorIndex.messages(text)).toEqual([]);
    expect(errorIndex.enclosing(files[999], 1)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(32);
  });

  it('shares the byte cap across messages and enclosing-symbol lookups', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const files = Array.from({ length: 10 }, (_, n) => `src/fail${n}.ts`);
    const source = fixture('fail.ts').padEnd(180 * 1024, ' ');
    const read = vi.fn(() => source);
    const repo = { files: () => files, read, grep: () => files.map(path => ({ path, line: source })) };
    const errorIndex = await buildIssueErrorIndex(repo, files);
    const matches = errorIndex.messages('Invalid record sample: missing field');
    expect(matches.map(site => site.path)).toEqual(files.slice(0, 2));
    expect(read).toHaveBeenCalledTimes(3);
    expect(errorIndex.messages('Invalid record sample: missing field')).toEqual(matches);
    expect(errorIndex.enclosing(files[0], 2)?.name).toBe('fail');
    expect(errorIndex.enclosing(files[9], 2)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stops scanning when the shared deadline expires during a source read', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const read = vi.fn(() => { now = 151; return fixture('fail.ts'); });
    const files = ['src/first.ts', 'src/second.ts'];
    const repo = { files: () => files, read, grep: () => files.map(path => ({ path, line: 'throw' })) };
    const errorIndex = await buildIssueErrorIndex(repo, files);
    expect(errorIndex.messages('Invalid record sample: missing field')).toEqual([]);
    expect(errorIndex.enclosing(files[1], 2)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('selects an enclosing-symbol start from each recorded goroutine stack', async () => {
    const deps = await corpus(['goroutine-main.go', 'goroutine-worker.go']);
    const text = fixture('goroutines.trace');
    const groups = extractCandidates(text).tracebackFrames!;
    expect(groups.slice(0, 2).map(frames => frames[0].path)).toEqual([
      '/reporter/project/src/goroutine-main.go', '/reporter/project/src/goroutine-worker.go',
    ]);
    const { starts } = await pickStartingPoints(text, { files: deps.repo.files(), search: deps.search, errorIndex: deps.errorIndex });
    expect(starts).toEqual([
      expect.objectContaining({ path: 'src/goroutine-main.go', name: 'fail', via: 'traceback frame' }),
      expect.objectContaining({ path: 'src/goroutine-worker.go', name: 'wait', via: 'traceback frame' }),
    ]);
  });

  it.each([
    ['python', 'fail.py', 1, 2], ['v8', 'fail.js', 1, 3],
    ['jvm', 'Failure.java', 2, 4], ['go', 'fail.go', 5, 7],
  ])('maps a recorded %s traceback to its enclosing graph symbol', async (runtime, name, lineStart, lineEnd) => {
    const { repo, search, errorIndex } = await corpus([name as string]);
    const text = fixture(`${runtime}.trace`);
    expect(extractCandidates(text).tracebackFrames?.flat().some(f => f.line > 0)).toBe(true);
    const { starts } = await pickStartingPoints(text, { files: repo.files(), search, errorIndex });
    expect(starts[0]).toMatchObject({ name: 'fail', path: `src/${name}`, lineStart, lineEnd, via: 'traceback frame', traceback: true });
    expect(starts[0].id).toBe((await search('fail'))[0].id);
    expect(issueConfidence({ starts, fallback: false }).confident).toBe(true);
  });

  it('uses rendered messages without symbol or path hints as confident, reserved starts', async () => {
    const deps = await corpus(['fail.ts']);
    const plan = await planIssue('The operation fails with "Invalid record sample: missing field".', deps);
    expect(plan.starts[0]).toMatchObject({ name: 'fail', path: 'src/fail.ts', via: 'error message', lineStart: 1 });
    expect(plan.fallback).toBe(false);
    expect(issueConfidence(plan).confident).toBe(true);
    const bm25 = Array.from({ length: 10 }, (_, n) => ({ path: `src/noise${n}.ts`, score: 100 - n }));
    expect(rankIssueFiles({ starts: plan.starts, bm25, near: new Map() }, 5).map(r => r.path)).toContain('src/fail.ts');
  });

  it('retains searchable messages and RAISES edges in map mode', async () => {
    const [parser, builder] = await loadIngestionModules();
    const patch = builder.buildPatch(parser.parseFile('src/fail.ts', fixture('fail.ts')), 'hash', 'workspace');
    const mapped = stripMapModeOps(patch as GraphPatchPayload);
    expect(mapped.ops).toContainEqual(expect.objectContaining({ type: 'UpsertNode', name: 'Invalid record {}: missing field', kind: 'constant' }));
    expect(mapped.ops).toContainEqual(expect.objectContaining({ type: 'UpsertEdge', predicate: 'RAISES' }));
    const ids = new Set(mapped.ops.filter(op => op.type === 'UpsertNode').map(op => op.id));
    for (const edge of mapped.ops.filter(op => op.type === 'UpsertEdge')) {
      expect(ids.has(edge.src)).toBe(true);
      expect(ids.has(edge.dst)).toBe(true);
    }
  });

  it('keeps the source location as a file start when the graph lacks the enclosing function', async () => {
    const { repo, errorIndex } = await corpus(['fail.py']);
    const { starts } = await pickStartingPoints(fixture('python.trace'), { files: repo.files(), errorIndex, search: async () => [] });
    expect(starts[0]).toMatchObject({ name: 'fail.py', kind: 'file', path: 'src/fail.py', lineStart: 2, lineEnd: 2, via: 'traceback frame' });
    expect(starts[0].id).toBeUndefined();
  });

  it('parses Windows V8, JVM modules, Scala and Go frame locations', () => {
    expect(parseTraceFrame('    at save (C:\\project\\src\\save.ts:23:7)')).toMatchObject({ path: 'C:/project/src/save.ts', line: 23 });
    expect(parseTraceFrame('\tat java.base/com.example.Store.save(Store.java:42)')).toMatchObject({ path: 'Store.java', line: 42, packagePath: 'com/example/Store.java' });
    expect(parseTraceFrame('\tat example.Store$.save(Store.scala:12)')).toMatchObject({ path: 'Store.scala', line: 12, runtime: 'jvm' });
    expect(parseTraceFrame('\t/other/machine/src/save.go:19 +0x20')).toMatchObject({ path: '/other/machine/src/save.go', line: 19, runtime: 'go' });
    expect(parseTraceFrame('Please inspect src/save.go:19')).toBeUndefined();
    expect(parseTraceFrame('\tat example.Store.save(Native Method)')).toBeUndefined();
  });

  it('evaluates slice membership and before/after file recall on source fixtures', async () => {
    const noise = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`src/noise${n}.ts`,
      'export const message = "Invalid record sample: missing field";']));
    const { repo } = await corpus(['fail.ts'], noise);
    const before = { ...issue, planIssue: (text: string, deps: Parameters<typeof planIssue>[1]) => planIssue(text, { ...deps, errorIndex: false }) };
    const rows = [{ instance_id: 'fixture-message', problem_statement: 'Invalid record sample: missing field',
      patch: 'diff --git a/src/fail.ts b/src/fail.ts\n' },
    { instance_id: 'fixture-unmatched', problem_statement: 'An unrelated operation is slow',
      patch: 'diff --git a/src/fail.ts b/src/fail.ts\n' }];
    const report = await evaluateErrorSlice(rows, before, issue, () => repo, buildIssueErrorIndex);
    expect(report).toMatchObject({ evaluated: 2, matched: 1, share: 0.5, beforeF5: 0, afterF5: 1 });
  });
});
