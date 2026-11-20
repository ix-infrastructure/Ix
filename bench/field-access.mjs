// Copyright 2026 Ix Infrastructure Inc.
// Run after `cd core-ingestion && npm run build`: node bench/field-access.mjs
// Local extraction/resolve/patch CPU only; excludes network/backend commits.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = resolve(process.argv[2] ?? 'core-ingestion/dist');
const { parseFile, resolveEdges } = await import(pathToFileURL(resolve(dist, 'index.js')).href);
const { buildPatchWithResolution } = await import(pathToFileURL(resolve(dist, 'patch-builder.js')).href);
const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'core-ingestion/src', 'ix-cli/src'], { encoding: 'utf8' }).trim().split('\n')
  .filter(p => /\.(ts|js|py|go|java)$/.test(p) && !p.includes('__tests__') && !p.endsWith('.d.ts'));
// Freeze the corpus at HEAD so before/after use identical bytes.
const sources = paths.map(p => [p, execFileSync('git', ['show', `HEAD:${p}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })]);
const samples = [];
for (let run = 0; run < 4; run++) {
  const start = performance.now();
  const parsed = sources.map(([p, s]) => parseFile(p, s, { budgetMs: 0 })).filter(Boolean);
  const edges = resolveEdges(parsed);
  const byFile = new Map();
  for (const edge of edges) {
    const list = byFile.get(edge.srcFilePath) ?? [];
    list.push(edge);
    byFile.set(edge.srcFilePath, list);
  }
  let ops = 0;
  for (const p of parsed) ops += buildPatchWithResolution(p, 'benchmark', 'benchmark', byFile.get(p.filePath) ?? []).ops.length;
  const ms = performance.now() - start;
  if (run) samples.push(Math.round(ms));
  console.log(JSON.stringify({ run, files: sources.length, bytes: sources.reduce((n, [, s]) => n + Buffer.byteLength(s), 0), ms: Math.round(ms), ops }));
}
console.log(JSON.stringify({ medianMs: samples.sort((a, b) => a - b)[1], samples }));
