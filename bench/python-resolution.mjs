// Copyright 2026 Ix Infrastructure Inc.

// Build core-ingestion first. An optional module path allows comparison with
// another locally built version using exactly the same synthetic workload.
// Usage: node bench/python-resolution.mjs [path/to/core-ingestion/dist/index.js]
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const modulePath = resolve(process.argv[2] ?? 'core-ingestion/dist/index.js');
const { parseFile, resolveEdges } = await import(pathToFileURL(modulePath).href);
const { buildPatchWithResolution } = await import(new URL('patch-builder.js', pathToFileURL(modulePath)).href);
const sources = [];
for (let i = 0; i < 300; i++) {
  let model = `class Target${i}:\n    def run(self):\n        return self.transform0(1)\n`;
  let service = `from pkg.model${i} import Target${i}\n\nclass Service${i}:\n    def __init__(self):\n        self.dep = Target${i}()\n`;
  for (let method = 0; method < 20; method++) {
    model += `\n    def transform${method}(self, value):\n        result = value * ${method + 1}\n        return result\n`;
    service += `\n    def execute${method}(self):\n        self.dep.run()\n        local = Target${i}()\n        local.run()\n`;
  }
  sources.push([`src/pkg/model${i}.py`, model], [`src/pkg/service${i}.py`, service]);
}
const samples = [];
const parseResolveSamples = [];
let edgeCount = 0;
let operationCount = 0;
for (let trial = 0; trial < 9; trial++) {
  const start = performance.now();
  const files = sources.map(([path, source]) => parseFile(path, source));
  const edges = resolveEdges(files);
  edgeCount = edges.length;
  const parsedAt = performance.now();
  operationCount = 0;
  for (const file of files) operationCount += buildPatchWithResolution(file, 'synthetic', 'benchmark', edges).ops.length;
  const elapsed = performance.now() - start;
  if (trial >= 2) {
    samples.push(Math.round(elapsed));
    parseResolveSamples.push(Math.round(parsedAt - start));
  }
}
console.log(JSON.stringify({
  files: sources.length,
  lines: sources.reduce((n, [, source]) => n + source.split('\n').length - 1, 0),
  bytes: sources.reduce((n, [, source]) => n + Buffer.byteLength(source), 0),
  edges: edgeCount,
  patchOperations: operationCount,
  parseResolveMedianMs: [...parseResolveSamples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
  samplesMs: samples,
  medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
}));
