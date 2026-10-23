// Copyright 2026 Ix Infrastructure Inc.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from './process.mjs';
import { sha256 } from './manifest.mjs';
import { MAP_STATE, PENDING } from './integration.mjs';

/** Fingerprint of the checkout's changes: tracked content via the diff, untracked files by size and mtime. */
async function treeState(cwd, seconds) {
  const git = async (...args) => (await execute(['git', '--no-optional-locks', ...args], { cwd, seconds })).stdout;
  const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all');
  const untracked = status.split('\0').filter((entry) => entry.startsWith('?? ')).map((entry) => {
    const stat = statSync(join(cwd, entry.slice(3)), { throwIfNoEntry: false });
    return `${entry}\0${stat?.size}\0${stat?.mtimeMs}`;
  });
  return sha256([status, await git('diff', '--binary', 'HEAD'), ...untracked].join('\0'));
}

// Claude: PostToolUse. Codex: native notify on agent-turn-complete.
const request = JSON.parse(readFileSync(process.env.AGENT_EVAL_REQUEST, 'utf8'));
if (request.arm !== 'ix') throw new Error('Ix hook activated in baseline');
let calls = 0, mapped = false; const started = performance.now();
const pending = join(request.run_path, PENDING, String(process.pid));
try {
  const mode = process.argv[2];
  if (mode === 'codex' && JSON.parse(process.argv[3] ?? '{}').type !== 'agent-turn-complete') process.exit(0);
  // A marker that outlives the hook means it was killed mid-run; run.mjs then refuses the run's hook telemetry.
  mkdirSync(join(request.run_path, PENDING), { recursive: true });
  writeFileSync(pending, `${mode}\n`);
  // Like the product's change-triggered refresh, re-map only when the checkout changed since the last map
  // (a read-only Bash call costs two git calls, not a map). The probe always maps: it exercises the hook.
  const state = join(request.run_path, MAP_STATE), { repo_path: cwd, environment: { seconds } } = request;
  const before = await treeState(cwd, seconds);
  mapped = mode === 'probe' || !existsSync(state) || readFileSync(state, 'utf8') !== before;
  if (mapped) {
    calls++;
    await execute(['ix', 'map', '--silent'], { cwd, seconds });
    // Taken after the map, so files the map itself writes do not trigger the next one.
    writeFileSync(state, await treeState(cwd, seconds));
  }
  if (mode === 'claude') {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    calls++;
    const result = await execute(['ix', 'hook', 'claude-post-edit'], { cwd: request.repo_path, seconds: request.environment.seconds, input });
    process.stdout.write(result.stdout);
  }
  appendFileSync(join(request.run_path, 'hooks.jsonl'), JSON.stringify({ type: 'hook', mode, mapped, ix_calls: calls, seconds: (performance.now() - started) / 1000 }) + '\n');
} catch {
  appendFileSync(join(request.run_path, 'hooks.jsonl'), JSON.stringify({ type: 'ix_error', code: 'HOOK_FAILED', mapped, ix_calls: calls, seconds: (performance.now() - started) / 1000 }) + '\n');
  process.exitCode = 1;
} finally {
  rmSync(pending, { force: true });
}
