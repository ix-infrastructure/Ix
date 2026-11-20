// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFile, resolveEdges } from '../../core-ingestion/dist/index.js';
import { buildPatchWithResolution, symbolNodeId } from '../../core-ingestion/dist/patch-builder.js';
import { compareTestReach, gatherTestsFor } from '../../ix-cli/src/cli/tests-for.ts';

/** In-memory adapter for actual parser patches, with backend-style provenance. */
export function patchGraph(files) {
  const parsed = files.map(({ path: file, source }) => parseFile(file, source)).filter(Boolean);
  const resolved = resolveEdges(parsed);
  const nodes = [], edges = [];
  for (const result of parsed) {
    const patch = buildPatchWithResolution(result, 'benchmark', 'bench', resolved);
    for (const op of patch.ops) {
      if (op.type === 'UpsertNode') nodes.push({ ...op, provenance: { source_uri: result.filePath } });
      if (op.type === 'UpsertEdge') edges.push(op);
    }
  }
  const expand = async (id, options) => {
    let frontier = new Set([id]);
    const selected = new Set();
    for (let i = 0; i < (options.hops ?? 1); i++) {
      const next = new Set();
      for (const edge of edges) {
        if (!options.predicates.includes(edge.predicate)) continue;
        if (options.direction === 'in' && frontier.has(edge.dst)) { selected.add(edge); next.add(edge.src); }
        if (options.direction === 'out' && frontier.has(edge.src)) { selected.add(edge); next.add(edge.dst); }
      }
      frontier = next;
    }
    const result = [...selected].slice(0, options.limit);
    const ids = new Set(result.flatMap(e => [e.src, e.dst]));
    return { nodes: nodes.filter(n => ids.has(n.id)), edges: result };
  };
  return { parsed, nodes, edges, expand };
}

/** Changed base lines only, so untouched definitions in diff context aren't gold. */
export function goldSpans(patch) {
  const spans = new Map();
  let file, line = 0;
  for (const text of patch.split('\n')) {
    if (text.startsWith('--- ')) { file = text.slice(4).replace(/^a\//, '').split('\t')[0]; continue; }
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!file || file === '/dev/null' || text.startsWith('+++')) continue;
    if (text.startsWith('-') || text.startsWith('+')) {
      const lines = spans.get(file) ?? new Set();
      lines.add(Math.max(1, line));
      spans.set(file, lines);
    }
    if (text.startsWith('-') || text.startsWith(' ')) line++;
  }
  return spans;
}

function goldTargets(graph, patch) {
  const targets = [];
  for (const [file, lines] of goldSpans(patch)) {
    const result = graph.parsed.find(r => r.filePath === file);
    if (!result) continue;
    let entities = result.entities.filter(e => ['function', 'method'].includes(e.kind)
      && [...lines].some(line => e.lineStart <= line && e.lineEnd >= line));
    if (!entities.length) entities = result.entities.filter(e => e.kind === 'file');
    for (const entity of entities) {
      const key = entity.container ? `${entity.container}.${entity.name}` : entity.name;
      const node = graph.nodes.find(n => n.id === symbolNodeId('bench', file, key));
      if (node) targets.push(node);
    }
  }
  return targets;
}

const stem = file => path.posix.basename(file).replace(/\.[^.]+$/, '').replace(/\.(?:test|spec)$/, '')
  .replace(/^test_/, '').replace(/_test$/, '').replace(/Tests?$/, '').toLowerCase();

/** Filename baseline ranks ALL test files: matching stem, then directory proximity, then path. */
export function filenameTests(graph, targets) {
  const production = targets.map(n => n.provenance.source_uri);
  const proximity = file => Math.max(0, ...production.map(p => {
    const a = p.split('/'), b = file.split('/');
    let i = 0;
    while (i < a.length - 1 && i < b.length - 1 && a[i] === b[i]) i++;
    return i;
  }));
  return graph.nodes.filter(n => n.kind === 'file' && n.attrs.is_test).map(n => ({
    id: n.id, name: n.name, kind: 'file', path: n.provenance.source_uri,
    score: production.some(p => stem(p) === stem(n.name)) ? 1000 : 0,
  })).sort((a, b) => b.score - a.score || proximity(b.path) - proximity(a.path) || a.path.localeCompare(b.path));
}

function labels(value) {
  if (typeof value === 'string') value = JSON.parse(value);
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Test labels must be string arrays');
  return value;
}

export function selects(row, label) {
  const pytest = label.split('::');
  if (/\.(?:[cm]?[jt]sx?|py|go|java|scala)$/.test(pytest[0])) {
    if (row.path !== pytest[0]) return false;
    return row.kind === 'file' || !pytest[1]
      || (row.selector ?? row.name).split('.').join('::') === pytest.slice(1).join('::').replace(/\[.*$/, '');
  }
  // SWE-bench's unittest ids: test_method (package.module.TestClass).
  const unittest = label.match(/^(\w+) \(([\w.]+)\)$/);
  if (unittest) {
    const parts = unittest[2].split('.');
    const cls = parts.pop();
    const file = parts.join('/') + '.py';
    return (row.path === file || row.path?.endsWith('/' + file))
      && (row.kind === 'file' || (row.selector ?? row.name) === `${cls}.${unittest[1]}` || row.name === unittest[1]);
  }
  return label === row.name || label === row.selector || label === row.path;
}

export async function evaluateTask(graph, targets, groups, ks = [1, 5, 10]) {
  const ranked = new Map();
  const baseline = new Map();
  const nodes = new Map(graph.nodes.map(n => [n.id, n]));
  // Replay callers/importers in classified test files on the same resolved graph.
  const closure = { expand: async (id, options) => {
    const result = await graph.expand(id, options);
    if (!options.predicates.includes('TESTS')) return result;
    return { nodes: result.nodes, edges: result.edges.filter(e => e.predicate !== 'TESTS').map(e =>
      nodes.get(e.src)?.attrs?.role === 'test' && ['CALLS', 'IMPORTS'].includes(e.predicate)
        ? { ...e, predicate: 'TESTS', attrs: { ...e.attrs, via: e.predicate } } : e) };
  } };
  let truncated = false;
  for (const target of targets) {
    const result = await gatherTestsFor(graph, target);
    const prior = await gatherTestsFor(closure, target);
    for (const test of prior.tests) if (!baseline.has(test.id) || baseline.get(test.id).score < test.score) baseline.set(test.id, test);
    truncated ||= result.truncated;
    for (const test of result.tests) if (!ranked.has(test.id) || ranked.get(test.id).score < test.score) ranked.set(test.id, test);
  }
  const after = [...ranked.values()].sort(compareTestReach);
  const before = [...baseline.values()].sort(compareTestReach);
  const filename = filenameTests(graph, targets);
  const results = {};
  for (const [group, expected] of Object.entries(groups)) {
    results[group] = { total: expected.length, top_k: Object.fromEntries(ks.map(k => [k, {
      before: expected.filter(label => before.slice(0, k).some(row => selects(row, label))).length,
      after: expected.filter(label => after.slice(0, k).some(row => selects(row, label))).length,
      filename: expected.filter(label => filename.slice(0, k).some(row => selects(row, label))).length,
    }])) };
  }
  return { targets: targets.length, truncated, results };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) throw new Error('Usage: node --import tsx ../bench/test-reach/evaluate.mjs <manifest.json|--fixtures>');
  const tasks = [];
  if (arg === '--fixtures') {
    const dir = new URL('../../core-ingestion/test-fixtures/test-reach/', import.meta.url);
    const cases = [['calc.ts', 'behavior.test.ts', 'double'], ['calc.js', 'behavior.spec.js', 'doubleJs'],
      ['calc.py', 'test_behavior.py', 'double'], ['calc.go', 'behavior_test.go', 'Double'],
      ['Calc.java', 'src/test/BehaviorTest.java', 'twice']];
    for (const [production, test, name] of cases) {
      const graph = patchGraph([production, test].map(file => ({ path: file,
        source: readFileSync(new URL(/\.(?:test|spec)\.[jt]s$/.test(file) ? file + '.fixture' : file, dir), 'utf8') })));
      tasks.push({ instance_id: production, ...await evaluateTask(graph, [graph.nodes.find(n => n.name === name)], { fixture: [test] }) });
    }
  } else {
    const manifest = JSON.parse(readFileSync(arg, 'utf8'));
    for (const task of manifest.tasks ?? manifest) {
      const groups = { F2P: labels(task.FAIL_TO_PASS), P2P: labels(task.PASS_TO_PASS) };
      if (!groups.F2P.length && !groups.P2P.length) {
        tasks.push({ instance_id: task.instance_id, skipped: 'No F2P/P2P labels' }); continue;
      }
      if (!task.repo_path || !task.patch) {
        tasks.push({ instance_id: task.instance_id, skipped: 'Missing local repo_path or gold patch' }); continue;
      }
      const root = path.resolve(path.dirname(path.resolve(arg)), task.repo_path);
      const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
        .split('\0').filter(file => /\.(?:[cm]?[jt]sx?|py|go|java|scala)$/.test(file))
        .filter(file => !file.split('/').some(part => /^(?:node_modules|vendor|dist|\.git)$/.test(part)))
        .map(file => ({ path: file, source: readFileSync(path.join(root, file), 'utf8') }));
      const graph = patchGraph(files);
      const targets = goldTargets(graph, task.patch);
      if (!targets.length) { tasks.push({ instance_id: task.instance_id, skipped: 'No gold-patch targets resolved' }); continue; }
      tasks.push({ instance_id: task.instance_id, ...await evaluateTask(graph, targets, groups) });
    }
  }
  const totals = {};
  for (const task of tasks) for (const [group, result] of Object.entries(task.results ?? {})) {
    const total = totals[group] ??= { total: 0, top_k: {} };
    total.total += result.total;
    for (const [k, counts] of Object.entries(result.top_k)) {
      const dest = total.top_k[k] ??= { before: 0, after: 0, filename: 0 };
      for (const method of Object.keys(counts)) dest[method] += counts[method];
    }
  }
  console.log(JSON.stringify({ mode: arg === '--fixtures' ? 'fixture-static' : 'benchmark-labels',
    measured_tasks: tasks.filter(t => !t.skipped).length, skipped_tasks: tasks.filter(t => t.skipped).length, totals, tasks }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
