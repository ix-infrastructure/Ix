// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execute } from './process.mjs';
import { nativeArgs } from './integration.mjs';

// Native CLI adapter. CLI/plugin versions must be pinned and independently probed.
const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { agent, task } = request;
if (!['claude', 'codex'].includes(agent.family)) throw new Error('Unsupported native agent');
const binary = agent.binary ?? agent.family;
const version = await execute([binary, '--version'], { seconds: 10 });
if (!version.stdout.trim().split(/\s+/).includes(agent.version)) throw new Error('Installed agent version differs from pinned version');
const args = nativeArgs(request);
// The problem statement is the only dataset text exposed to the solver.
const child = spawn(binary, args, { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.on('error', () => {});
child.stdin.end(task.problem_statement + '\n');
child.on('error', () => { console.error('Unable to start native agent'); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
