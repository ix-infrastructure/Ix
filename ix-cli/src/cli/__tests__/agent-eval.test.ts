// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Both Windows and POSIX lanes retain manifest, telemetry and statistics coverage. POSIX runs
// the full suite once; it already re-runs the portable subset to prove what Windows skips.
function runSuite(portable: boolean) {
  const suite = fileURLToPath(new URL('../../../../bench/agent-eval/test/eval.test.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, ...(portable ? { AGENT_EVAL_PORTABLE_ONLY: '1' } : {}) },
  });
  expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/# fail 0/);
}

const portable = process.platform === 'win32';
it(portable ? 'portable agent benchmark unit tests' : 'agent benchmark unit, integration and smoke tests', () => runSuite(portable), 130_000);
