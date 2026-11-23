// Copyright 2026 Ix Infrastructure Inc.
// Node 26. Run against built Step 2 and candidate checkouts on the same host.
// --map requires IX_E2E=1 and resets the disposable E2E backend before each run.
import assert from 'node:assert/strict';
import { pairedGate } from './behavior-perf-interval.mjs';
import { execFile } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [baseline, mode] = process.argv.slice(2);
if (!baseline || !['--parser', '--map'].includes(mode))
  throw Error('Usage: behavior-perf.mjs BASELINE_ROOT --parser|--map');
// Set IX_BOOLEAN_PILOT=1 to compare 1.31 with 1.32 on identical source.
const flowPilot = process.env.IX_FLOW_PILOT === '1';
const pilot = flowPilot || process.env.IX_BOOLEAN_PILOT === '1';
const control = pilot && process.env.IX_PILOT_CONTROL === '1';
const roots = [resolve(baseline), control ? resolve(baseline) : here];
const results = [];
const median = (a) => (a[(a.length - 1) >> 1] + a[a.length >> 1]) / 2;
function report(name, samples, ceiling) {
  const series = samples.map((values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { n: values.length, median: median(sorted), min: sorted[0], max: sorted.at(-1), values };
  });
  const delta = 100 * (series[1].median / series[0].median - 1);
  const result = { name, series, delta, ceiling, pass: delta <= ceiling };
  if (pilot && ceiling > 0) {
    result.gate = pairedGate(samples, 0.5, ceiling, mode === '--parser' ? 4 : 1);
    result.pass &&= result.gate.decision === 'pass';
  }
  console.log(JSON.stringify(result));
  results.push(result);
}
const dense =
  'class Job {\n  start(){\n' +
  'if (this.status === "queued") { this.status = "running"; }\n'.repeat(100) +
  '  }\n}\n';

async function parserBench() {
  const { ParsePool } = await import('../dist/cli/commands/parse-pool.js');
  const paths = readdirSync(join(here, 'ix-cli/src'), { recursive: true })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.includes('__tests__'))
    .sort();
  const sparse = Array.from({ length: 32 }, (_, i) => {
    const path = paths[Math.floor((i * paths.length) / 32)];
    return [path, readFileSync(join(here, 'ix-cli/src', path), 'utf8')];
  });
  const copies = source => Array.from({ length: 32 }, (_, i) => [`job${i}.ts`, source]);
  const cases = [sparse, copies(dense)];
  if (pilot) {
    let mixed = dense.replace('start(){', 'running=false; work(){if(this.running)return; tick();} start(){this.running=true;');
    if (flowPilot) mixed = mixed.replace('start(){', 'start(){try{while(again)this.running=false;}finally{this.status="idle";}');
    const incidental = 'class Flag { running=false; label(){if(this.running)return "on";return "off";}' +
      Array.from({length:80}, (_, i) => `m${i}(){this.running=true;}`).join('') + '}';
    cases.push(copies(mixed), copies(incidental));
    if (flowPilot) {
      const negative = 'class A{ go(){'+'try{for(let i=0;i<N;i++){other.status="x";}}catch(e){audit(e);}'.repeat(60)+'}}';
      const deep = 'class A{ go(){'+'try{while(ready){'.repeat(18)+'this.status="deep";'+'}}finally{}'.repeat(18)+'}}';
      cases.push(copies(negative), copies(deep));
    }
  }
  const samples = cases.map(() => [[], []]);
  async function timed(pool, build, k, record) {
    const start = performance.now();
    const out = await Promise.all(cases[k].map(([p, s]) => pool.parse(p, s)));
    const ms = performance.now() - start;
    assert(out.every(Boolean));
    assert.equal(out.reduce((n, r) => n + (r.behavior?.writes.length ?? 0), 0),
      [0, 3200, flowPilot ? (build && !control ? 3296 : 3232) : (build && !control ? 3232 : 3200), 0, 0, 0][k]);
    if (flowPilot && k === 5 && build && !control)
      assert(out.every(r => r.behavior?.coverage === 'partial' && r.behavior.cutReason === 'depth'));
    if (record) samples[k][build].push(ms);
  }
  const newPool = build => new ParsePool(join(roots[build], 'core-ingestion/dist/parse-worker.js'), 4);
  if (pilot) {
    // Match each observation within a pair of hot pools. Only one pool is working.
    for (let session = 0; session < 4; session++) {
      const pools = [];
      for (const build of session % 2 ? [1, 0] : [0, 1]) pools[build] = newPool(build);
      try {
        for (const k of cases.keys()) for (let round = 0; round < 11; round++) {
          for (const build of (session + round) % 2 ? [1, 0] : [0, 1])
            await timed(pools[build], build, k, round >= 5);
        }
      } finally { await Promise.all(pools.map(pool => pool.destroy())); }
    }
  } else {
    for (const build of [0, 1, 1, 0]) {
      const pool = newPool(build);
      try {
        for (const k of cases.keys()) for (let round = 0; round < 15; round++)
          await timed(pool, build, k, round >= 5);
      } finally { await pool.destroy(); }
    }
  }
  report('32 production files / four-worker pool (ms)', samples[0], 5);
  report('3200 writes / four-worker pool (ms)', samples[1], 10);

  if (pilot) {
    report(flowPilot ? 'mixed dense writes plus two nested sites per file (ms)' : '3200 string and 32 candidate boolean writes (ms)', samples[2], 10);
    report('32 classes with 80 incidental writes each (ms)', samples[3], 5);
    if (flowPilot) {
      report('32 wide negative files with loops and exception arms (ms)', samples[4], 5);
      report('32 nested exception files at the depth cap (ms)', samples[5], 5);
    }
    return;
  }

  // Time the optional pass independently, with identical instrumentation in both modules.
  let elapsed;
  globalThis.__ixRecordBehaviorTime = (ms) => {
    elapsed = ms;
  };
  const hook = registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (!url.endsWith('/core-ingestion/dist/behavior.js')) return result;
      const src = result.source.toString();
      const index = src.indexOf('export function extractBehavior(');
      const start = src.indexOf('{', index),
        end = src.indexOf('\n}', start);
      assert(index >= 0 && end > start);
      return {
        ...result,
        source:
          src.slice(0, start + 1) +
          'const begin=performance.now();try{' +
          src.slice(start + 1, end) +
          '\n}finally{globalThis.__ixRecordBehaviorTime(performance.now()-begin)}' +
          src.slice(end),
      };
    },
  });
  try {
    const mods = await Promise.all(
      roots.map((root) => import(pathToFileURL(join(root, 'core-ingestion/dist/index.js')))),
    );
    const src =
      '// status = "example"\nclass Job {\n' +
      Array.from({ length: 100 }, (_, i) => `m${i}(){let x=1; ${'work(x);'.repeat(10)}}`).join('\n') +
      '\n}';
    const data = [[], []];
    for (let round = 0; round < 35; round++)
      for (const b of round % 2 ? [1, 0] : [0, 1]) {
        elapsed = undefined;
        const parsed = mods[b].parseFile('job.ts', src, { budgetMs: 0 });
        assert(parsed && !parsed.behavior && elapsed > 0);
        if (round >= 10) data[b].push(elapsed);
      }
    report('100 false-positive candidate bodies / extractor only (ms)', data, -50);
  } finally {
    hook.deregister();
    delete globalThis.__ixRecordBehaviorTime;
  }
}

async function mapBench() {
  const { e2eEnv, resetBackend, checkout, cleanupScratch } = await import('../test/e2e/harness.ts');
  const env = e2eEnv();
  const dir = mkdtempSync(join(tmpdir(), 'ix-behavior-perf-'));
  // Stage both built runtimes on the same filesystem and with the same layout.
  // Measuring a developer checkout against a bare dist copy includes unrelated startup I/O.
  const stage = mkdtempSync(join(tmpdir(), 'ix-behavior-builds-'));
  const runtimes = roots.map((root, i) => {
    const path = join(stage, String(i));
    for (const pkg of ['ix-cli', 'core-ingestion']) {
      const dest = join(path, pkg);
      mkdirSync(dest, { recursive: true });
      for (const file of ['dist', 'package.json'])
        cpSync(join(root, pkg, file), join(dest, file), { recursive: true });
      symlinkSync(realpathSync(join(root, pkg, 'node_modules')), join(dest, 'node_modules'), 'dir');
    }
    return path;
  });
  const rounds = 24;
  const warmups = 4;
  const run = promisify(execFile);
  try {
    for (const evidence of [false, true]) {
      for (let i = 0; i < 24; i++) {
        const source =
          `export class Job${i} {\n` +
          (pilot && evidence ? '  running=false; work(){if(this.running)return; tick();}\n' : '') +
          '  start(){\n' +
          (pilot && evidence ? '    this.running=true;\n' : '') +
          (flowPilot && evidence ? '    try{while(again)this.running=false;}finally{this.status="idle";}\n' : '') +
          (evidence
            ? '    if(this.status === "queued") this.status="running";\n'
            : '    return "running";\n') +
          '  }\n}\n';
        writeFileSync(join(dir, `job${i}.ts`), source);
      }
      const co = checkout(dir, 'fixture');
      const data = [[], []],
        requests = [[], []],
        uploaded = [[], []],
        firstRequest = [[], []],
        bulkTime = [[], []];
      for (let r = 0; r < rounds + warmups; r++)
        for (const b of r % 2 ? [1, 0] : [0, 1]) {
          await resetBackend(env);
          const home = mkdtempSync(join(dir, 'home-'));
          const file = join(home, 'requests.jsonl');
          const options = {
            cwd: co.dir,
            env: {
              ...process.env,
              IX_E2E: '1',
              IX_HOME: home,
              IX_ENDPOINT: env.endpoint,
              IX_FETCH_LOG: file,
              IX_FETCH_BODY: '1',
              IX_NO_UPDATE_CHECK: '1',
              NO_COLOR: '1',
            },
          };
          const args = [
            '--import',
            join(here, 'ix-cli/scripts/fetch-log.mjs'),
            join(runtimes[b], 'ix-cli/dist/cli/main.js'),
            'map',
            '.',
            '--silent',
          ];
          const start = performance.now();
          await run(process.execPath, args, options);
          const ms = performance.now() - start;
          const recorded = () =>
            readFileSync(file, 'utf8')
              .trim()
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
              .filter((event) => event.ev === 'req');
          const fresh = recorded();
          const uploads = fresh.filter((event) => /^\/v1\/patch(?:es\/bulk)?$/.test(event.path));
          assert(uploads.length && uploads.every((event) => typeof event.body === 'string'));
          const patches = uploads.flatMap((event) => {
            const body = JSON.parse(event.body);
            return body.patches ?? [body];
          });
          const writes = patches
            .flatMap((p) => p.ops)
            .reduce((count, op) => count + (op.attrs?.behavior_v1?.writes.length ?? 0), 0);
          const expected = flowPilot ? 48 + (b && !control ? 48 : 0) : pilot ? 24 + (b && !control ? 24 : 0) : b ? 24 : 0;
          assert.equal(writes, evidence ? expected : 0, 'uploaded verified sites');
          const bytes = uploads.reduce((total, event) => total + Buffer.byteLength(event.body), 0);
          writeFileSync(file, '');
          await run(process.execPath, args, options);
          const reads = recorded();
          assert(reads.length > 0, 'no-op request instrumentation');
          assert(!reads.some((r) => /\/v1\/(patch(?:es\/bulk)?$|entity\/)/.test(r.path)));
          if (r >= warmups) {
            data[b].push(ms);
            requests[b].push(reads.length);
            uploaded[b].push(bytes);
            firstRequest[b].push(fresh[0].start);
            bulkTime[b].push(uploads.reduce((total, event) => total + event.ms, 0));
          }
          rmSync(home, { recursive: true, force: true });
        }
      report(
        `24-file fresh map, ${evidence ? (pilot ? 'mixed evidence' : '24 guarded writes') : 'zero writes'} (ms)`,
        data,
        evidence ? 10 : 5,
      );
      assert.deepEqual(requests[1], requests[0], 'paired steady-state request counts');
      report('steady no-op requests', requests, 0);
      console.log(
        JSON.stringify({ name: 'fresh map diagnostics', evidence, uploaded, firstRequest, bulkTime }),
      );
    }
  } finally {
    cleanupScratch();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

if (mode === '--map') await mapBench();
else await parserBench();
if (results.some((r) => !r.pass)) process.exitCode = 1;
