// Copyright 2026 Ix Infrastructure Inc.

// Offline localization slice. Input JSONL rows: {id, issue, files: {path: source}, gold: [path]}.
// Embed repository snapshots so an evaluation never needs a backend or another checkout.
// Build core-ingestion first, then: node --import tsx scripts/ranking-eval/config-slice.mjs <snapshot.jsonl>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFile } from '../../../core-ingestion/dist/index.js';
import { buildPatch } from '../../../core-ingestion/dist/patch-builder.js';
import { bindingCandidates, lookupConfig } from '../../src/cli/config-lookup.ts';
import { planIssue, rankIssueFiles } from '../../src/cli/explain/issue.ts';

export async function evaluateConfigSlice(rows) {
  let slice = 0, detectedSliceIssues = 0, candidates = 0, before = 0, after = 0;
  const details = [];
  for (const row of rows) {
    if (!row.issue || !row.files || !Array.isArray(row.gold) || !row.gold.length) throw new Error('Expected issue, files and nonempty gold in every row');
    const parsed = Object.entries(row.files).map(([path, source]) => parseFile(path, source)).filter(Boolean);
    const nodes = parsed.flatMap(p => {
      const patch = buildPatch(p, 'eval', 'eval');
      return patch.ops.filter(op => op.type === 'UpsertNode').map(op => ({ ...op, provenance: { sourceUri: p.filePath } }));
    });
    const client = {
      search: async query => nodes.filter(n => n.name.includes(query)).slice(0, 200),
      nodes: async ids => ({ nodes: nodes.filter(n => ids.includes(n.id)) }),
    };
    const mentions = bindingCandidates(row.issue);
    if (mentions.length) candidates++;
    // Membership must be fixed before running either detector/ranker. Curated
    // benchmark rows can supply independently labeled bindingMentions (including
    // [] for negatives); otherwise report the syntactic candidate slice.
    if (row.bindingMentions !== undefined && (!Array.isArray(row.bindingMentions) || row.bindingMentions.some(m => typeof m !== 'string' || !m.trim()))) {
      throw new Error('bindingMentions must be an array of nonempty strings');
    }
    const sliceMentions = row.bindingMentions ?? mentions.map(m => m.query);
    if (!sliceMentions.length) continue;
    slice++;
    const detected = (await Promise.all(mentions.map(m => lookupConfig(client, m.query)))).some(r => r.matches.length);
    if (detected) detectedSliceIssues++;
    const repo = { files: () => Object.keys(row.files), read: path => row.files[path], grep: () => [] };
    const search = async name => parsed.flatMap(p => p.entities.filter(e => e.name === name).map(e => ({
      id: `${p.filePath}:${e.name}`, name: e.name, kind: e.kind, path: p.filePath, lineStart: e.lineStart, lineEnd: e.lineEnd,
    })));
    const rank = async config => {
      const plan = await planIssue(row.issue, { repo, search, config });
      return rankIssueFiles({ starts: plan.starts, bm25: plan.bm25, near: new Map(), sourcePaths: plan.sourcePaths }).slice(0, 5).map(r => r.path);
    };
    const oldFiles = await rank(undefined);
    const newFiles = await rank(query => lookupConfig(client, query));
    // F@5 follows the existing localization evaluator: fraction of gold files in the first five.
    const recall = files => row.gold.filter(path => files.includes(path)).length / row.gold.length;
    before += recall(oldFiles);
    after += recall(newFiles);
    details.push({ id: row.id, mentions: sliceMentions, detected, before: oldFiles, after: newFiles });
  }
  return { sliceDefinition: rows.every(row => Array.isArray(row.bindingMentions)) ? 'independently labeled binding mentions' : 'syntactic candidates (unless independently labeled)', issues: rows.length, candidateIssues: candidates, sliceIssues: slice, detectedSliceIssues, share: rows.length ? slice / rows.length : 0,
    before_F_at_5: slice ? before / slice : null, after_F_at_5: slice ? after / slice : null, details };
}

export async function fixtureSmoke() {
  const fixture = name => readFileSync(new URL(`../../../core-ingestion/test-fixtures/config-bindings/${name}`, import.meta.url), 'utf8');
  const source = fixture('app.ts');
  const rows = ['APP_HOST', 'server.port', '--verbose', 'GET /health/:id'].map((query, i) => {
    const issue = `The \`${query}\` has no effect`;
    const files = { 'src/service.ts': source };
    for (let j = 0; j < 8; j++) files[`src/distractor${j}.ts`] = `// ${issue}\nexport const unrelated${j} = true;\n`;
    return { id: `fixture-${i}`, issue, files, gold: ['src/service.ts'] };
  });
  rows.push({ id: 'fixture-control', issue: 'The boot function fails', files: { 'src/service.ts': source }, gold: ['src/service.ts'] });
  let testedEdges = 0, negativeControlEdges = 0;
  for (const name of ['app.ts', 'app.js', 'app.py', 'app.go', 'App.java']) {
    const patch = buildPatch(parseFile(name, fixture(name)), 'precision', 'precision');
    const invalid = new Set(patch.ops.filter(op => op.type === 'UpsertNode' && op.attrs?.binding_kind && /FAKE|fake|not-a-route/.test(op.name)).map(op => op.id));
    const edges = patch.ops.filter(op => op.type === 'UpsertEdge' && op.attrs?.binding_predicate);
    testedEdges += edges.length;
    negativeControlEdges += edges.filter(op => invalid.has(op.dst)).length;
  }
  return { corpus: 'fixture smoke; not the localization benchmark', ...await evaluateConfigSlice(rows), precision: { testedEdges, negativeControlEdges } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Usage: config-slice.mjs <snapshot.jsonl> | --fixtures');
  const result = process.argv[2] === '--fixtures' ? await fixtureSmoke()
    : await evaluateConfigSlice(readFileSync(process.argv[2], 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)));
  console.log(JSON.stringify(result, null, 2));
}
