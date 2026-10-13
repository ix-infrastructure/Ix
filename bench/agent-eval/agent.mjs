// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execute } from './process.mjs';

// Native CLI adapter. CLI/plugin versions must be pinned and independently probed.
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { agent, budget, task } = request;
if (!['claude', 'codex'].includes(agent.family)) throw new Error('Unsupported native agent');
const binary = agent.binary ?? agent.family;
const version = await execute([binary, '--version'], { seconds: 10 });
if (!version.stdout.trim().split(/\s+/).includes(agent.version)) throw new Error('Installed agent version differs from pinned version');
const extra = agent.args ?? [];
if (!Array.isArray(extra) || extra.some((v) => typeof v !== 'string')) throw new Error('agent.args must be an argv array');
if (extra.some((arg) => /plugin|mcp|settings|notify|CODEX_HOME|CLAUDE_CONFIG_DIR/.test(arg))) throw new Error('agent.args must not override arm integrations');
const integration = agent.family === 'claude'
  ? ['--setting-sources', '', ...(request.arm === 'ix' ? ['--plugin-dir', request.run_path + '/plugin'] : ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'])]
  : [];
const args = agent.family === 'claude'
  ? ['--print', '--verbose', '--output-format', 'stream-json', '--model', agent.model, '--effort', agent.effort, '--max-turns', String(budget.max_turns), ...integration, ...extra]
  : ['exec', '--json', '--model', agent.model, '-c', `model_reasoning_effort=${JSON.stringify(agent.effort)}`, ...extra, '-'];
// The problem statement is the only dataset text exposed to the solver.
const child = spawn(binary, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(task.problem_statement + '\n');
child.on('error', () => { console.error('Unable to start native agent'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
