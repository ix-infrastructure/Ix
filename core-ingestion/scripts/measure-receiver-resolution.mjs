// Copyright 2026 Ix Infrastructure Inc.

// Offline measurements; run after npm run build. An optional module directory
// permits comparing another extractor build on exactly the same source corpus.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const moduleDir = path.resolve(process.argv[2] ?? path.join(root, 'core-ingestion/dist'));
const { parseFile, resolveEdges } = await import(pathToFileURL(path.join(moduleDir, 'index.js')));
const { buildPatchWithResolution, symbolNodeId } = await import(pathToFileURL(path.join(moduleDir, 'patch-builder.js')));
const labels = JSON.parse(readFileSync(path.join(root, 'core-ingestion/test-fixtures/receiver-inference/cases.json'), 'utf8'));

function measure(files, expected) {
  const edges = resolveEdges(files);
  const stats = {};
  const incoming = new Set();
  const methods = [];
  const labelledPredictions = [];
  for (const file of files) {
    const language = file.language;
    const row = stats[language] ??= { files: 0, calls: 0, resolved: 0, unresolved_call_count: 0, method_targets: 0, fallback_eligible: 0 };
    row.files++;
    row.calls += file.relationships.filter(r => r.predicate === 'CALLS').length;
    const patch = buildPatchWithResolution(file, 'measurement', 'measurement', edges);
    const labelledTargets = new Map(file.entities.filter(e => ['Target', 'Other'].includes(e.container) && ['run', 'Run'].includes(e.name))
      .map(e => [symbolNodeId('measurement', file.filePath, `${e.container}.${e.name}`), `${e.container}.${e.name}`]));
    row.resolved += patch.ops.filter(op => op.type === 'UpsertEdge' && op.predicate === 'CALLS').length;
    for (const op of patch.ops) {
      if (expected && op.type === 'UpsertEdge' && op.predicate === 'CALLS' && labelledTargets.has(op.dst)) {
        labelledPredictions.push({ filePath: file.filePath, key: labelledTargets.get(op.dst) });
      }
      if (op.type === 'UpsertEdge' && ['CALLS', 'REFERENCES'].includes(op.predicate)) incoming.add(op.dst);
      if (op.type === 'UpsertNode') {
        row.unresolved_call_count += op.attrs?.unresolved_call_count ?? 0;
        if (op.kind === 'method' || (op.kind === 'function' && file.entities.some(e => e.container && e.name === op.name && e.lineStart === op.attrs?.line_start))) methods.push({ id: op.id, language });
      }
    }
  }
  for (const method of methods) {
    const row = stats[method.language];
    row.method_targets++;
    if (!incoming.has(method.id)) row.fallback_eligible++;
  }
  for (const row of Object.values(stats)) {
    row.resolved_share = row.calls ? row.resolved / row.calls : null;
    // This is the graph-side trigger for callers' fallback, not live request telemetry.
    row.fallback_eligible_share = row.method_targets ? row.fallback_eligible / row.method_targets : null;
  }
  if (!expected) return { languages: stats };
  const predicted = labelledPredictions;
  const correct = predicted.filter(e => expected.get(e.filePath)?.includes(e.key));
  const count = [...expected.values()].reduce((n, keys) => n + keys.length, 0);
  return { languages: stats, labelled_sample: { expected: count, predicted: predicted.length, correct: correct.length,
    precision: predicted.length ? correct.length / predicted.length : null, recall: count ? correct.length / count : null } };
}

const fixtureFiles = [];
const expected = new Map();
for (const [i, label] of labels.entries()) {
  const file = parseFile(`labelled/case-${i}.${label.language}`, label.source);
  if (!file || file.hasParseErrors) throw new Error(`Fixture failed to parse: ${label.name}`);
  fixtureFiles.push(file);
  expected.set(file.filePath, label.expected);
}
// Fixtures are independent programs, so measure each separately to avoid collisions
// between their repeated class names, then aggregate counts rather than resolutions.
const fixtureResults = fixtureFiles.map(file => measure([file], new Map([[file.filePath, expected.get(file.filePath)]])));
const fixtures = { languages: {}, labelled_sample: { expected: 0, predicted: 0, correct: 0 } };
for (const result of fixtureResults) {
  for (const [language, row] of Object.entries(result.languages)) {
    const total = fixtures.languages[language] ??= {};
    for (const [key, value] of Object.entries(row)) if (!key.endsWith('_share')) total[key] = (total[key] ?? 0) + value;
  }
  for (const key of ['expected', 'predicted', 'correct']) fixtures.labelled_sample[key] += result.labelled_sample[key];
}
for (const row of Object.values(fixtures.languages)) {
  row.resolved_share = row.calls ? row.resolved / row.calls : null;
  row.fallback_eligible_share = row.method_targets ? row.fallback_eligible / row.method_targets : null;
}
fixtures.labelled_sample.precision = fixtures.labelled_sample.predicted ? fixtures.labelled_sample.correct / fixtures.labelled_sample.predicted : null;
fixtures.labelled_sample.recall = fixtures.labelled_sample.correct / fixtures.labelled_sample.expected;

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0');
const repositoryFiles = tracked.filter(p => /\.(?:ts|tsx|scala|go)$/.test(p) && !/\.d\.ts$/.test(p))
  .map(p => parseFile(p, readFileSync(path.join(root, p), 'utf8'))).filter(Boolean);
// Manually labelled production declarations and their first typed member call.
const repositoryLabels = JSON.parse(readFileSync(path.join(root, 'core-ingestion/test-fixtures/receiver-inference/repository-sample.json'), 'utf8'));
const repositoryEdges = resolveEdges(repositoryFiles);
const sample = repositoryLabels.map(label => ({ label, edge: repositoryEdges.find(e => e.tier === 'type' &&
  e.srcFilePath === label.srcFilePath && e.srcName === label.srcName) }));
const predicted = sample.filter(item => item.edge);
const correct = predicted.filter(({ label, edge }) => edge.dstFilePath === label.dstFilePath && edge.dstQualifiedKey === label.dstQualifiedKey);
console.log(JSON.stringify({ fixtures, repository: measure(repositoryFiles),
  repository_labelled_sample: { expected: sample.length, predicted: predicted.length, correct: correct.length,
    precision: predicted.length ? correct.length / predicted.length : null },
  corpus_note: 'Current checkout only; Scala sources are checked-in fixtures and there are no tracked Go source files. Fallback eligibility counts method targets without incoming CALLS/REFERENCES edges; it is not live callers request telemetry.' }, null, 2));
