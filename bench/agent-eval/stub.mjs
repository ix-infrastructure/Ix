// Copyright 2026 Ix Infrastructure Inc.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './manifest.mjs';

const [stage, file] = process.argv.slice(2), request = JSON.parse(readFileSync(file, 'utf8'));
if (!request.synthetic) throw new Error('Stub only accepts explicitly synthetic tasks');
const ix = request.arm === 'ix';
if (stage === 'setup') writeFileSync(join(request.repo_path, 'synthetic-environment.txt'), `${request.arm}\n`);
else if (stage === 'probe') {
  const evidence = join(request.repo_path, 'synthetic-environment.txt');
  console.log(JSON.stringify({ version: 1, repo_path: request.repo_path, base_commit: request.task.base_commit, agent_version: request.agent.version, ix_available: ix, mapped: ix, plugin_installed: ix, skills_installed: ix, hooks_enabled: ix, mapped_commit: request.task.base_commit, plugin_revision: request.environment.plugin_revision, evidence: ix ? [{ path: evidence, sha256: sha256(readFileSync(evidence)) }] : [] }));
} else if (stage === 'agent') {
  writeFileSync(join(request.repo_path, 'solution.txt'), 'synthetic solution\n');
  for (const event of [{ type: 'turn', id: 'turn-1' }, { type: 'tool', id: 'tool-1', command: ix ? 'ix locate example' : 'rg example' }, { type: 'usage', input_tokens: ix ? 90 : 100, output_tokens: 20, cached_tokens: 10 }, { type: 'done' }]) console.log(JSON.stringify(event));
} else if (stage === 'evaluate') {
  const resolved = readFileSync(join(request.repo_path, 'solution.txt'), 'utf8') === 'synthetic solution\n';
  console.log(JSON.stringify({ instance_id: request.task.instance_id, resolved, evaluator: 'synthetic' }));
} else throw new Error('Unknown stub stage');
