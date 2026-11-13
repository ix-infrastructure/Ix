// Copyright 2026 Ix Infrastructure Inc.

// Score the error-evidence slice of the existing localization dataset. Both
// variants see the same base snapshot, search, gold files and query. --before
// must be an issue.js module built from the parent revision, not the study's
// older frozen baseline. No repositories or datasets are downloaded.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCorpus, goldFiles } from './corpus.mjs';
import { defSearch } from './defs.mjs';

export async function evaluateErrorSlice(rows, before, after, load, makeIndex) {
  const results = [];
  for (const row of rows) {
    const repo = load(row);
    const files = repo.files();
    const gold = goldFiles(row.patch).filter(p => files.includes(p) && before.isSourcePath(p));
    if (!gold.length) continue;
    const search = defSearch(repo, files.filter(before.isSourcePath));
    const text = row.problem_statement;
    const errorIndex = await makeIndex(repo, files.filter(after.isSourcePath));
    const oldPlan = await before.planIssue(text, { repo, search });
    const newPlan = await after.planIssue(text, { repo, search, errorIndex });
    // Membership is independent of MAX_STARTS: explicit paths may fill all
    // three slots even though the issue also contains matchable evidence.
    const source = path => newPlan.sourcePaths?.has(path) ?? after.isSourcePath(path);
    const message = errorIndex.messages(text).some(site => source(site.path));
    let traceback = false;
    for (const line of text.split('\n')) {
      if (!after.extractCandidates(line).tracebackFrames?.length) continue;
      const evidence = await after.pickStartingPoints(line, { files, search: async () => [], sourcePaths: newPlan.sourcePaths });
      if (evidence.starts.some(s => s.via === 'traceback frame')) { traceback = true; break; }
    }
    const score = (lib, plan) => {
      const top = lib.rankIssueFiles({ ...plan, near: new Map() }, 5).map(r => r.path);
      return gold.filter(p => top.includes(p)).length / gold.length;
    };
    results.push({ id: row.instance_id, message, traceback, matchable: message || traceback,
      before: score(before, oldPlan), after: score(after, newPlan) });
  }
  const slice = results.filter(r => r.matchable);
  const mean = (key) => slice.length ? slice.reduce((sum, r) => sum + r[key], 0) / slice.length : null;
  return { evaluated: results.length, matched: slice.length,
    share: results.length ? slice.length / results.length : null,
    // F@5 follows the existing harness: macro mean gold-file recall at five.
    beforeF5: mean('before'), afterF5: mean('after'), results };
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
  const dataset = option('dataset'), repos = option('repos'), beforePath = option('before');
  if (!dataset || !repos || !beforePath) throw new Error('Required: --dataset <jsonl> --repos <bare-repo-dir> --before <parent-issue-module> [--set dev|test --final yes-once]');
  const set = option('set') ?? 'dev';
  if (!['dev', 'test'].includes(set)) throw new Error('Expected --set dev or test');
  if (set === 'test' && option('final') !== 'yes-once') throw new Error('The held-out split requires --final yes-once');
  const split = JSON.parse(readFileSync(new URL('./split.json', import.meta.url), 'utf8'));
  const ids = new Set(split[set]);
  const rows = readFileSync(dataset, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => ids.has(row.instance_id));
  if (!rows.length) throw new Error('Dataset contains no instances from the selected split');
  const before = await import(pathToFileURL(resolve(beforePath)).href);
  const after = await import('../../dist/cli/explain/issue.js');
  const { buildIssueErrorIndex } = await import('../../dist/cli/explain/issue-errors.js');
  const report = await evaluateErrorSlice(rows, before, after, row => loadCorpus(row.repo, row.base_commit, resolve(repos)), buildIssueErrorIndex);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}
