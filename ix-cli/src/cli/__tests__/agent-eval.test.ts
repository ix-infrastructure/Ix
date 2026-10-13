// Copyright 2026 Ix Infrastructure Inc.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// Both Windows and POSIX lanes retain manifest, telemetry and statistics coverage.
function runSuite(portable: boolean) {
  const suite = fileURLToPath(new URL('../../../../bench/agent-eval/test/eval.test.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...(portable ? { AGENT_EVAL_PORTABLE_ONLY: '1' } : {}) },
  });
  expect(result.status, `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toMatch(/# fail 0/);
}

it('portable agent benchmark unit tests', () => runSuite(true), 70_000);
it.skipIf(process.platform === 'win32')('POSIX agent benchmark integration and smoke', () => runSuite(false), 70_000);
