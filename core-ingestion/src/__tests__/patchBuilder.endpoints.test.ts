// Copyright 2026 Ix Infrastructure Inc.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFile, resolveEdges, type FileParseResult, type ResolvedEdge } from '../index.js';
import { buildPatchWithResolution, UNRESOLVED_CALLS_CAP } from '../patch-builder.js';

/**
 * No edge without both endpoints: every `UpsertEdge` in a repository's patch
 * set must point from and to a node some patch in that set upserts. Before,
 * calls to builtins, library functions and names that resolved nowhere were
 * written as edges to ids no patch ever created -- over half the edges in a
 * typical graph.
 */

const repoRoot = path.resolve(import.meta.dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules' && name !== 'dist') sourceFiles(full, out);
    } else if (/\.(ts|py|java|scala)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parseCorpus(): FileParseResult[] {
  const files = [
    ...sourceFiles(path.join(repoRoot, 'core-ingestion/src')),
    ...sourceFiles(path.join(repoRoot, 'core-ingestion/test-fixtures')),
  ];
  return files
    .map((abs) => parseFile(path.relative(repoRoot, abs), readFileSync(abs, 'utf8'), { budgetMs: 0 }))
    .filter((r): r is FileParseResult => r !== null);
}

describe('every edge has a node at both ends', () => {
  const results = parseCorpus();
  const resolved = resolveEdges(results);
  const byFile = new Map<string, ResolvedEdge[]>();
  for (const edge of resolved) {
    const list = byFile.get(edge.srcFilePath) ?? [];
    list.push(edge);
    byFile.set(edge.srcFilePath, list);
  }
  const patches = results.map((r) => buildPatchWithResolution(r, 'hash', 'ws', byFile.get(r.filePath) ?? []));
  const nodes = new Set(patches.flatMap((p) => p.ops.filter((op) => op.type === 'UpsertNode').map((op) => op.id as string)));
  const edges = patches.flatMap((p) => p.ops.filter((op) => op.type === 'UpsertEdge')) as Array<{
    id: string; src: string; dst: string; predicate: string; attrs: Record<string, unknown>;
  }>;

  it('holds over this package and its fixtures', () => {
    expect(results.length).toBeGreaterThan(10);
    expect(edges.length).toBeGreaterThan(100);
    const dangling = edges.filter((e) => !nodes.has(e.src) || !nodes.has(e.dst));
    expect(dangling.map((e) => `${e.predicate} ${e.id}`)).toEqual([]);
  });

  it('writes confidence and tier on every cross-file edge', () => {
    const crossFile = edges.filter((e) => e.attrs.confidence !== undefined);
    expect(crossFile.length).toBeGreaterThan(10);
    for (const e of crossFile) {
      expect(['binding', 'import', 'transitive', 'qualifier', 'global']).toContain(e.attrs.tier);
    }
  });

  it('records the calls it could not place on the node that makes them', () => {
    const upserts = patches.flatMap((p) => p.ops.filter((op) => op.type === 'UpsertNode')) as Array<{
      kind: string; attrs: Record<string, unknown>;
    }>;
    const recording = upserts.filter((n) => n.attrs.unresolved_call_count !== undefined);
    // This package calls plenty of builtins (`.map`, `push`, `Math.max`...),
    // and mostly from inside functions.
    expect(recording.filter((n) => n.kind === 'function' || n.kind === 'method').length).toBeGreaterThan(10);
    for (const n of recording) {
      const names = n.attrs.unresolved_calls as string[];
      expect(names.length).toBe(Math.min(n.attrs.unresolved_call_count as number, UNRESOLVED_CALLS_CAP));
      expect(new Set(names).size).toBe(names.length);
    }
    // No node is ever handed both a count and nothing to show for it.
    expect(upserts.filter((n) => n.attrs.unresolved_calls !== undefined && n.attrs.unresolved_call_count === undefined)).toEqual([]);
  });
});

describe('resolveEdges reports the tier that resolved each edge', () => {
  const parse = (file: string, source: string) => parseFile(file, source)!;
  const edgesFor = (files: Array<[string, string]>) => resolveEdges(files.map(([f, s]) => parse(f, s)));
  const find = (edges: ResolvedEdge[], predicate: string, dstName: string) =>
    edges.find((e) => e.predicate === predicate && e.dstName === dstName);

  it('import: an IMPORTS edge to the imported file', () => {
    const edges = edgesFor([
      ['/repo/a.ts', 'export function helper() { return 1; }\n'],
      ['/repo/b.ts', "import { helper } from './a';\nexport function run() { return helper(); }\n"],
    ]);
    expect(edges.find((e) => e.predicate === 'IMPORTS' && e.dstFilePath === '/repo/a.ts')?.tier).toBe('import');
  });

  it('binding: a call through a named import binding', () => {
    const edges = edgesFor([
      ['/repo/a.ts', 'export function helper() { return 1; }\n'],
      ['/repo/b.ts', "import { helper } from './a';\nexport function run() { return helper(); }\n"],
    ]);
    expect(find(edges, 'CALLS', 'helper')).toMatchObject({ tier: 'binding', confidence: 0.9 });
  });

  it('global: the only definition of a name, in a file not imported', () => {
    const edges = edgesFor([
      ['/repo/lonely.py', 'def lonely_fn():\n    return 1\n'],
      ['/repo/caller.py', 'def go():\n    return lonely_fn()\n'],
    ]);
    expect(find(edges, 'CALLS', 'lonely_fn')).toMatchObject({ tier: 'global', confidence: 0.5 });
  });
});
