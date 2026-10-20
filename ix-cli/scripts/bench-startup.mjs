#!/usr/bin/env node
// Copyright 2026 Ix Infrastructure Inc.

// Wall time of the agent-facing `ix` commands against the built CLI, with `rg`
// on the same term alongside `ix text` for comparison. A measuring tool for a
// person, not a CI gate: timings on shared runners are too noisy to assert on.
//
//   npm run build && node scripts/bench-startup.mjs [--runs 10] [--term word]
//                                                   [--cwd dir] [--cli path]
//
// Every command runs once untimed (to warm the OS file cache and Node's
// compile cache), then --runs times. Output is a Markdown table of the median
// and p90 in milliseconds and the exit code of the last run: a command that
// cannot reach a backend still pays its full start-up before it says so, which
// is the part this measures.
//
// Each `ix` command is timed twice: with the warm daemon off (IX_DAEMON=off,
// every call its own process) and on, once a daemon for this IX_HOME is
// running. The daemon is stopped again at the end. Not on Windows, where the
// CLI never uses one.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    runs: 10,
    term: "registerOssCommands",
    cwd: resolve(here, "../.."),
    cli: resolve(here, "../dist/cli/main.js"),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--runs") out.runs = Math.max(1, parseInt(value, 10) || out.runs);
    else if (flag === "--term") out.term = value;
    else if (flag === "--cwd") out.cwd = resolve(value);
    else if (flag === "--cli") out.cli = resolve(value);
    else if (flag === "-h" || flag === "--help") {
      process.stdout.write("usage: bench-startup.mjs [--runs N] [--term WORD] [--cwd DIR] [--cli PATH]\n");
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${flag}\n`);
      process.exit(2);
    }
    i++;
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(opts.cli)) {
  process.stderr.write(`${opts.cli} not found: run \`npm run build\` first.\n`);
  process.exit(2);
}

const readTarget = existsSync(join(opts.cwd, "ix-cli/src/cli/main.ts")) ? "ix-cli/src/cli/main.ts" : "README.md";
const hookInput = JSON.stringify({
  session_id: "bench-startup",
  tool_name: "Bash",
  cwd: opts.cwd,
  tool_input: { command: "true" },
});

const ix = (...args) => ({ cmd: process.execPath, args: [opts.cli, ...args], daemon: true });
const cases = [
  { label: "node -e 0", ...{ cmd: process.execPath, args: ["-e", "0"] } },
  { label: "ix --version", ...ix("--version") },
  { label: `ix text ${opts.term}`, ...ix("text", opts.term) },
  // An explicit "." -- with no path and a piped stdin, rg searches stdin.
  { label: `rg -n ${opts.term} .`, cmd: "rg", args: ["-n", opts.term, "."] },
  { label: `ix locate ${opts.term}`, ...ix("locate", opts.term) },
  { label: `ix read ${readTarget}`, ...ix("read", readTarget) },
  { label: `ix explain ${opts.term}`, ...ix("explain", opts.term) },
  { label: `ix callers ${opts.term}`, ...ix("callers", opts.term) },
  { label: `ix search ${opts.term}`, ...ix("search", opts.term) },
  { label: `ix context ${opts.term}`, ...ix("context", opts.term) },
  { label: `ix impact ${opts.term}`, ...ix("impact", opts.term) },
  { label: `ix around ${readTarget}`, ...ix("around", readTarget) },
  { label: "ix hook claude-post-edit", ...ix("hook", "claude-post-edit"), input: hookInput },
];

// No update check, no colour: neither is what an agent sees, and both vary.
const env = { ...process.env, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1" };
delete env.FORCE_COLOR;
const coldEnv = { ...env, IX_DAEMON: "off" };
const warmEnv = { ...env };
delete warmEnv.IX_DAEMON;
const useDaemon = process.platform !== "win32";

function once(c, runEnv = coldEnv) {
  const started = process.hrtime.bigint();
  const child = spawnSync(c.cmd, c.args, {
    cwd: opts.cwd, env: runEnv, input: c.input ?? "", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms, status: child.error ? `error: ${child.error.code ?? child.error.message}` : child.status };
}

function percentile(sorted, p) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function measure(c, runEnv) {
  once(c, runEnv);
  const times = [];
  let status;
  for (let i = 0; i < opts.runs; i++) {
    const r = once(c, runEnv);
    times.push(r.ms);
    status = r.status;
  }
  times.sort((a, b) => a - b);
  return { median: percentile(times, 50), p90: percentile(times, 90), status };
}

function daemonStatus() {
  const r = spawnSync(process.execPath, [opts.cli, "daemon", "status", "--json"], { env: warmEnv, encoding: "utf-8" });
  try { return JSON.parse(r.stdout); } catch { return { running: false }; }
}

/** Start this IX_HOME's daemon the way an agent's first call does, and wait for it. */
function startDaemon() {
  once(ix("text", opts.term), warmEnv);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (daemonStatus().running) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

const rows = cases.map((c) => ({ label: c.label, cold: measure(c, coldEnv) }));
const daemonUp = useDaemon && startDaemon();
let served = 0;
if (daemonUp) {
  cases.forEach((c, i) => { if (c.daemon) rows[i].warm = measure(c, warmEnv); });
  served = daemonStatus().served;
  spawnSync(process.execPath, [opts.cli, "daemon", "stop"], { env: warmEnv, encoding: "utf-8" });
}

const fmt = (ms) => ms.toFixed(0);
process.stdout.write(`Node ${process.version}, ${opts.runs} runs each, cwd ${opts.cwd}\n`);
process.stdout.write(daemonUp
  ? `Daemon on: ${served} calls answered by the daemon.\n\n`
  : `Daemon on: not measured (${useDaemon ? "it did not start" : "not used on Windows"}).\n\n`);
process.stdout.write("| Command | daemon off median ms | off p90 ms | daemon on median ms | on p90 ms | exit |\n|---|---:|---:|---:|---:|---:|\n");
for (const r of rows) {
  const warm = r.warm ? `${fmt(r.warm.median)} | ${fmt(r.warm.p90)}` : "— | —";
  const status = r.warm && r.warm.status !== r.cold.status ? `${r.cold.status} / ${r.warm.status}` : r.cold.status;
  process.stdout.write(`| \`${r.label}\` | ${fmt(r.cold.median)} | ${fmt(r.cold.p90)} | ${warm} | ${status} |\n`);
}
