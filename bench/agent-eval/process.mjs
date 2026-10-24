// Copyright 2026 Ix Infrastructure Inc.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const groupAlive = (pid) => {
  try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

/** Members of process group `pgid`: pid, parent pid and command line. Undefined when `ps` is unavailable. */
function groupMembers(pgid) {
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ps.status !== 0) return undefined;
  return ps.stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(line)).filter((m) => m && Number(m[3]) === pgid)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[4] }));
}

/** When the adapter exits, stop its whole group at once and kill every member except `keep` processes and their
 * descendants, then resume those. Nothing else the adapter left behind runs on, whatever the arm.
 * Repeats until no other member is left (a fork racing the stop). Without `ps`, the whole group is killed.
 */
export function reapExcept(pgid, keep) {
  const signal = (target, name) => { try { process.kill(target, name); return true; } catch { return false; } };
  if (!signal(-pgid, 'SIGSTOP')) return; // Group already gone.
  try {
    for (let pass = 0; pass < 5; pass++) {
      const members = groupMembers(pgid);
      if (!members) { signal(-pgid, 'SIGKILL'); return; }
      const kept = new Set(members.filter((m) => keep(m.args)).map((m) => m.pid));
      for (let grew = true; grew;) {
        grew = false;
        for (const m of members) if (!kept.has(m.pid) && kept.has(m.ppid)) { kept.add(m.pid); grew = true; }
      }
      const others = members.filter((m) => !kept.has(m.pid));
      if (!others.length) return;
      for (const m of others) signal(m.pid, 'SIGKILL');
    }
    signal(-pgid, 'SIGKILL'); // Still forking after repeated passes: keep nothing.
  } finally { signal(-pgid, 'SIGCONT'); }
}

/** One deadline, no retries. Only the agent caller opts into retaining timeout/exit receipts.
 * drainSeconds lets `keep` descendants that outlive the adapter (an Ix hook, matched on its command line) finish
 * before the group is reaped; every other descendant is killed the moment the adapter exits.
 * The deadline and stage time end when the adapter exits, even if a descendant still holds its stdout open.
 */
export function execute(argv, { cwd, env = process.env, seconds = 60, log, input, allowTimeout = false, captureExit = false, drainSeconds = 0, keep = () => false } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const detached = process.platform !== 'win32' && process.env.AGENT_EVAL_CHILD !== '1';
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, AGENT_EVAL_CHILD: '1' }, detached, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', failure, timedOut = false, exitedAt, drainTimer, cut = false;
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
    // Only drained processes outlive the adapter; anything else could still change the checkout before it is recorded.
    const cutAtExit = () => { if (!cut && detached && !timedOut && drainSeconds > 0) { cut = true; reapExcept(child.pid, keep); } };
    child.on('exit', () => {
      exitedAt = performance.now(); clearTimeout(timer); cutAtExit();
      // A descendant that inherited stdout keeps 'close' from firing; reap it once the drain ends. Buffered output is still read.
      if (!timedOut) drainTimer = setTimeout(kill, drainSeconds * 1000);
    });
    child.on('close', async (code) => {
      clearTimeout(timer); clearTimeout(drainTimer);
      exitedAt ??= performance.now(); cutAtExit();
      const elapsed = (exitedAt - started) / 1000; // Excludes the drain.
      if (detached && !timedOut && drainSeconds > 0) {
        const deadline = exitedAt + drainSeconds * 1000;
        while (groupAlive(child.pid) && performance.now() < deadline) await new Promise((done) => setTimeout(done, 100));
      }
      if (detached) kill(); // Also reap descendants that outlived their adapter (and the drain).
      if (log) { writeFileSync(`${log}.stdout`, stdout); writeFileSync(`${log}.stderr`, stderr); }
      if (failure && !(allowTimeout && timedOut && failure.message.startsWith('Stage deadline'))) return reject(failure);
      if (code !== 0 && !captureExit && !(allowTimeout && timedOut)) return reject(new Error(`Stage exited ${code}; inspect stage logs`));
      resolve({ stdout, stderr, seconds: elapsed, timed_out: timedOut, exit_code: code });
    });
  });
}
