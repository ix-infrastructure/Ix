// Copyright 2026 Ix Infrastructure Inc.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from './process.mjs';
import { PENDING } from './integration.mjs';

// Claude: PostToolUse. Codex: native notify on agent-turn-complete.
const request = JSON.parse(readFileSync(process.env.AGENT_EVAL_REQUEST, 'utf8'));
if (request.arm !== 'ix') throw new Error('Ix hook activated in baseline');
let calls = 0; const started = performance.now();
const pending = join(request.run_path, PENDING, String(process.pid));
try {
  const mode = process.argv[2];
  if (mode === 'codex' && JSON.parse(process.argv[3] ?? '{}').type !== 'agent-turn-complete') process.exit(0);
  // A marker that outlives the hook means it was killed mid-run; run.mjs then refuses the run's hook telemetry.
  mkdirSync(join(request.run_path, PENDING), { recursive: true });
  writeFileSync(pending, `${mode}\n`);
  calls++;
  await execute(['ix', 'map', '--silent'], { cwd: request.repo_path, seconds: request.environment.seconds });
  if (mode === 'claude') {
    let input = ''; for await (const chunk of process.stdin) input += chunk;
    calls++;
    const result = await execute(['ix', 'hook', 'claude-post-edit'], { cwd: request.repo_path, seconds: request.environment.seconds, input });
    process.stdout.write(result.stdout);
  }
  appendFileSync(join(request.run_path, 'hooks.jsonl'), JSON.stringify({ type: 'hook', mode, ix_calls: calls, seconds: (performance.now() - started) / 1000 }) + '\n');
} catch {
  appendFileSync(join(request.run_path, 'hooks.jsonl'), JSON.stringify({ type: 'ix_error', code: 'HOOK_FAILED', ix_calls: calls, seconds: (performance.now() - started) / 1000 }) + '\n');
  process.exitCode = 1;
} finally {
  rmSync(pending, { force: true });
}
