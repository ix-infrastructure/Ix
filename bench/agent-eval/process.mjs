// Copyright 2026 Ix Infrastructure Inc.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/** One deadline, no retries. Only the agent caller opts into retaining timeout/exit receipts. */
export function execute(argv, { cwd, env = process.env, seconds = 60, log, input, allowTimeout = false, captureExit = false } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const detached = process.platform !== 'win32' && process.env.AGENT_EVAL_CHILD !== '1';
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, AGENT_EVAL_CHILD: '1' }, detached, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', failure, timedOut = false;
    const kill = () => {
      try { if (detached) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already exited */ }
    };
    const timer = setTimeout(() => { timedOut = true; failure = new Error(`Stage deadline exceeded (${seconds}s)`); kill(); }, seconds * 1000);
    const capture = (stream, chunk) => {
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024 * 1024) { failure = new Error('Stage output exceeds 64 MiB'); kill(); }
    };
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (detached) kill(); // Also reap descendants that outlived their adapter.
      if (log) { writeFileSync(`${log}.stdout`, stdout); writeFileSync(`${log}.stderr`, stderr); }
      if (failure && !(allowTimeout && timedOut && failure.message.startsWith('Stage deadline'))) return reject(failure);
      if (code !== 0 && !captureExit && !(allowTimeout && timedOut)) return reject(new Error(`Stage exited ${code}; inspect stage logs`));
      resolve({ stdout, seconds: (performance.now() - started) / 1000, timed_out: timedOut, exit_code: code });
    });
  });
}
