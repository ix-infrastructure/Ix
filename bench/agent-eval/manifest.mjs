// Copyright 2026 Ix Infrastructure Inc.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
export function validateManifest(manifest) {
  if (manifest.version !== 1 || !['swe-bench-verified', 'synthetic'].includes(manifest.dataset)) {
    throw new Error('Unsupported manifest version or dataset');
  }
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new Error('Empty task set');
  const ids = new Set();
  for (const task of manifest.tasks) {
    if (!task || typeof task.instance_id !== 'string' || !/^[\w.-]+$/.test(task.instance_id) || ['.', '..'].includes(task.instance_id) || ids.has(task.instance_id)) throw new Error('Invalid or duplicate instance_id');
    if (typeof task.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(task.repo) || task.repo.split('/').some((p) => ['.', '..'].includes(p)) || typeof task.base_commit !== 'string' || !/^[a-f0-9]{40}$/.test(task.base_commit)) {
      throw new Error(`Invalid repo or base_commit: ${task.instance_id}`);
    }
    if (typeof task.problem_statement !== 'string' || !task.problem_statement.trim()) throw new Error('Missing problem_statement');
    ids.add(task.instance_id);
  }
  if (manifest.dataset !== 'synthetic' && !/^[a-f0-9]{64}$/.test(manifest.source_sha256 ?? '')) throw new Error('Missing source_sha256');
  return manifest;
}
export const loadManifest = (file) => validateManifest(JSON.parse(readFileSync(file, 'utf8')));

export function checkManifestSource(manifest, text) {
  if (sha256(text) !== manifest.source_sha256) throw new Error('Dataset export hash mismatch');
  let rows;
  try { rows = JSON.parse(text); } catch { rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line)); }
  if (!Array.isArray(rows)) throw new Error('Export must be a JSON array or JSONL');
  const byId = new Map(rows.map((row) => [row.instance_id, row]));
  if (byId.size !== rows.length) throw new Error('Duplicate source task ids');
  for (const task of manifest.tasks) {
    const row = byId.get(task.instance_id);
    if (!row || ['repo', 'base_commit', 'problem_statement'].some((field) => row[field] !== task[field])) throw new Error(`Manifest task differs from source export: ${task.instance_id}`);
  }
}

/** Stable hash ordering avoids dependence on export row order or JS sort/random versions. */
export function importVerified(text, { count = 50, minRepos = 5, seed = 20261013 } = {}) {
  positiveInteger(count, 'count'); positiveInteger(minRepos, 'minRepos');
  if (!Number.isSafeInteger(seed) || minRepos > count) throw new Error('Invalid seed or repository coverage');
  let rows;
  try { rows = JSON.parse(text); } catch { rows = text.trim().split(/\r?\n/).map((line) => JSON.parse(line)); }
  if (!Array.isArray(rows)) throw new Error('Export must be a JSON array or JSONL');
  const tasks = rows.map(({ instance_id, repo, base_commit, problem_statement }) => ({ instance_id, repo, base_commit, problem_statement }));
  validateManifest({ version: 1, dataset: 'swe-bench-verified', source_sha256: sha256(text), tasks });
  const ranked = tasks.sort((a, b) => sha256(`${seed}:${a.instance_id}`).localeCompare(sha256(`${seed}:${b.instance_id}`)));
  if (ranked.length < count || new Set(ranked.map((task) => task.repo)).size < minRepos) throw new Error('Insufficient tasks or repositories');
  const selected = [], repos = new Set();
  for (const task of ranked) {
    if (repos.size < minRepos && !repos.has(task.repo)) { selected.push(task); repos.add(task.repo); }
  }
  for (const task of ranked) if (selected.length < count && !selected.includes(task)) selected.push(task);
  return validateManifest({ version: 1, dataset: 'swe-bench-verified', source_sha256: sha256(text), selection: { count, minRepos, seed }, tasks: selected });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [input, output, count = '50', minRepos = '5', seed = '20261013'] = process.argv.slice(2);
    if (!input || !output) throw new Error('Usage: node manifest.mjs EXPORT.json MANIFEST.json [count=50] [minRepos=5] [seed=20261013]');
    writeFileSync(output, JSON.stringify(importVerified(readFileSync(input, 'utf8'), { count: Number(count), minRepos: Number(minRepos), seed: Number(seed) }), null, 2) + '\n', { flag: 'wx' });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
