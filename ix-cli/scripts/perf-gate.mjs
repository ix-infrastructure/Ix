// Copyright 2026 Ix Infrastructure Inc.

// Performance gate: backend requests, response bytes and wall time per command
// on a fixed fixture, against budgets in test/perf/budgets.json.
//
//   IX_E2E=1 node scripts/perf-gate.mjs <fixture-repo> [--runs 3] [--update] [--out results.json]
//
// Runs against the real-backend harness stack (test/e2e, `npm run e2e:up`),
// with the same IX_E2E_* variables and the same refusal to touch a shared
// stack: every map run starts from POST /v1/reset. Each command runs --runs
// times through scripts/fetch-log.mjs; the medians are compared with the
// budgets. Requests and bytes are deterministic for a fixed fixture and backend
// image, so they fail above budget + 10%. Wall time depends on the machine and
// is reported, never failed, until there is CI history to set it from.
// --update rewrites the budgets from this run's medians.
//
// Needs a built CLI (npm run build).

/* global process, console, fetch, URL, performance */

import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../dist/cli/main.js");
const FETCH_LOG = resolve(HERE, "fetch-log.mjs");
const BUDGETS = resolve(HERE, "../test/perf/budgets.json");
const PROTECTED_PORTS = new Set([8090, 8091, 8099, 8100, 8190, 8529, 8530, 8539, 8540, 8629]);
const TOLERANCE = 1.1;

function parseArgs(argv) {
  const opts = { runs: 3, update: false, out: null, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") opts.runs = Number(argv[++i]);
    else if (a === "--update") opts.update = true;
    else if (a === "--out") opts.out = argv[++i];
    else opts.fixture = a;
  }
  if (!opts.fixture || !Number.isInteger(opts.runs) || opts.runs < 1) {
    console.error("usage: IX_E2E=1 node scripts/perf-gate.mjs <fixture-repo> [--runs 3] [--update] [--out results.json]");
    process.exit(2);
  }
  return opts;
}

function endpoint() {
  if (process.env.IX_E2E !== "1") {
    throw new Error("Set IX_E2E=1: the gate resets the backend's database before every map.");
  }
  const url = new URL(process.env.IX_E2E_ENDPOINT ?? `http://127.0.0.1:${process.env.IX_E2E_BACKEND_PORT ?? "8290"}`);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || PROTECTED_PORTS.has(Number(url.port))) {
    throw new Error(`${url.href}: not a harness stack (loopback, and none of the shared ports ${[...PROTECTED_PORTS].join(", ")})`);
  }
  return url.href.replace(/\/$/, "");
}

async function reset(base) {
  const headers = { "content-type": "application/json" };
  if (process.env.IX_TOKEN) headers.authorization = `Bearer ${process.env.IX_TOKEN}`;
  const res = await fetch(`${base}/v1/reset`, { method: "POST", headers, body: "{}" });
  if (!res.ok) throw new Error(`POST /v1/reset: ${res.status}`);
}

/**
 * Where every copy of the fixture is made: the same absolute path on every run
 * and every machine whose temp directory is /tmp, CI included.
 *
 * Node ids are hashed from the workspace's absolute path (workspaceIdForPath),
 * and context's fan-out follows the backend's order of a node's neighbours,
 * which follows those ids. A fresh random directory per run therefore drew a
 * different set of walk seeds each time, and `context` response bytes moved
 * by tens of percent between identical runs of the same commit.
 */
const CHECKOUT_ROOT = join(tmpdir(), "ix-perf-gate-checkout");

/** A fresh copy of the fixture (same directory name) and an empty IX_HOME. */
function checkout(fixture) {
  const root = CHECKOUT_ROOT;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const dir = join(root, basename(fixture));
  cpSync(fixture, dir, { recursive: true });
  const ixHome = join(root, "ix-home");
  mkdirSync(ixHome);
  return { dir, ixHome };
}

/** One CLI run: { requests, bytes, wallMs, status }. */
function measure(base, co, args, log) {
  rmSync(log, { force: true });
  const t0 = performance.now();
  const res = spawnSync(process.execPath, ["--import", FETCH_LOG, CLI, ...args], {
    cwd: co.dir,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, IX_HOME: co.ixHome, IX_ENDPOINT: base, IX_NO_UPDATE_CHECK: "1", NO_COLOR: "1", IX_FETCH_LOG: log },
  });
  const wallMs = Math.round(performance.now() - t0);
  const lines = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const reqs = lines.filter((l) => l.ev === "req");
  return {
    requests: reqs.length,
    bytes: reqs.reduce((n, r) => n + (r.bytes ?? 0), 0),
    wallMs,
    status: res.status,
    stderr: (res.stderr ?? "").slice(-400),
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * The scenarios. `prepare` runs unmeasured before each measured run; `args` is
 * what is measured. Map scenarios reset the backend first; read scenarios run
 * against one map of the fixture made before them.
 */
function scenarios(issueFile) {
  const editTs = (co, i) => appendFileSync(join(co.dir, "ix-cli/src/cli/format.ts"), `\n// perf-gate edit ${i}\n`);
  const addFile = (co, i) =>
    writeFileSync(join(co.dir, `ix-cli/src/cli/perf-gate-${i}.ts`), `export const perfGate${i} = ${i};\n`);
  return [
    { name: "map (fresh)", fresh: true, args: (co) => ["map", co.dir, "--silent"] },
    { name: "map (no-op)", args: (co) => ["map", co.dir, "--silent"] },
    { name: "map (one-line TS edit)", prepare: editTs, args: (co) => ["map", co.dir, "--silent"] },
    { name: "map (add one file)", prepare: addFile, args: (co) => ["map", co.dir, "--silent"] },
    { name: "context IxClient", args: () => ["context", "IxClient", "--format", "json"] },
    { name: "context --from-issue", args: () => ["context", "--from-issue", issueFile, "--format", "json"] },
    { name: "impact resolveWorkspaceRoot", args: () => ["impact", "resolveWorkspaceRoot", "--format", "json"] },
    { name: "rank dependents/function", args: () => ["rank", "--by", "dependents", "--kind", "function", "--format", "json"] },
    { name: "callers getEndpoint", args: () => ["callers", "getEndpoint", "--format", "json"] },
  ];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = endpoint();
  if (!existsSync(CLI)) throw new Error(`${CLI} not found: run npm run build first`);
  const fixture = resolve(opts.fixture);
  const scratch = mkdtempSync(join(tmpdir(), "ix-perf-gate-"));
  const log = join(scratch, "fetch.jsonl");
  const issueFile = join(scratch, "issue.md");
  writeFileSync(issueFile, "ix map reports success but ix search finds nothing after a branch switch; the workspace root looks wrong.\n");
  const results = {};

  try {
    const all = scenarios(issueFile);
    const measureRuns = async (sc, co0) => {
      const runs = [];
      for (let i = 0; i < opts.runs; i++) {
        let co = co0;
        if (sc.fresh) {
          await reset(base);
          co = checkout(fixture);
        }
        sc.prepare?.(co, i);
        const r = measure(base, co, sc.args(co), log);
        // Every command, not only the maps: a read that errors out (a renamed
        // symbol, a crash) makes fewer requests and fewer bytes, which the
        // budgets alone would score as an improvement.
        if (r.status !== 0) throw new Error(`${sc.name} failed (exit ${r.status}): ${r.stderr}`);
        runs.push(r);
      }
      results[sc.name] = {
        requests: median(runs.map((r) => r.requests)),
        bytes: median(runs.map((r) => r.bytes)),
        wallMs: median(runs.map((r) => r.wallMs)),
      };
    };

    // Fresh maps first: each resets the backend and maps a new copy.
    for (const sc of all.filter((s) => s.fresh)) await measureRuns(sc, null);

    // Then one mapped copy shared by every other scenario, in order.
    await reset(base);
    const shared = checkout(fixture);
    const first = measure(base, shared, ["map", shared.dir, "--silent"], log);
    if (first.status !== 0) throw new Error(`initial map failed (exit ${first.status}): ${first.stderr}`);
    for (const sc of all.filter((s) => !s.fresh)) await measureRuns(sc, shared);
  } finally {
    await reset(base).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
    rmSync(CHECKOUT_ROOT, { recursive: true, force: true });
  }

  if (opts.out) writeFileSync(opts.out, JSON.stringify(results, null, 2) + "\n");
  if (opts.update) {
    // A command's own tolerance survives an update; context's fan-out is not
    // deterministic yet, so it starts looser than the default.
    let previous = {};
    try {
      previous = JSON.parse(readFileSync(BUDGETS, "utf8")).budgets ?? {};
    } catch {
      // No budgets yet: start from this run.
    }
    const budgets = Object.fromEntries(Object.entries(results).map(([name, m]) => {
      const tolerance = previous[name]?.tolerance ?? (name.startsWith("context") ? 1.25 : undefined);
      return [name, tolerance ? { ...m, tolerance } : m];
    }));
    writeFileSync(BUDGETS, JSON.stringify({ fixture: basename(fixture), budgets }, null, 2) + "\n");
    console.log(`budgets written to ${BUDGETS}`);
  }
  return report(results, opts.update ? null : JSON.parse(readFileSync(BUDGETS, "utf8")).budgets);
}

function report(results, budgets) {
  const rows = [];
  let failed = 0;
  for (const [name, m] of Object.entries(results)) {
    const b = budgets?.[name];
    const verdict = (value, budget, tolerance) => {
      if (!budget) return "";
      if (value > budget * tolerance) return "OVER";
      return "";
    };
    const tolerance = b?.tolerance ?? TOLERANCE;
    const reqV = verdict(m.requests, b?.requests, tolerance);
    const byteV = verdict(m.bytes, b?.bytes, tolerance);
    const wallV = b?.wallMs && m.wallMs > b.wallMs * 3 ? "slow (advisory)" : "";
    if (reqV || byteV) failed++;
    rows.push(
      `${name.padEnd(30)} req ${String(m.requests).padStart(5)}${b ? ` / ${b.requests}` : ""} ${reqV}`.padEnd(56) +
        `bytes ${String(m.bytes).padStart(9)}${b ? ` / ${b.bytes}` : ""} ${byteV}`.padEnd(36) +
        `wall ${m.wallMs} ms${b ? ` / ${b.wallMs}` : ""} ${wallV}`,
    );
  }
  console.log(rows.join("\n"));
  if (budgets && failed) {
    console.error(
      `\n${failed} command(s) over budget (requests or bytes above budget + its tolerance: ${Math.round((TOLERANCE - 1) * 100)}% unless budgets.json sets one). ` +
        "If the increase is intended, run with --update and commit test/perf/budgets.json.",
    );
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);

