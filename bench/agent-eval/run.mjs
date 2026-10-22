// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateConfig, validateProbe, schedule } from './config.mjs';
import { checkManifestSource, loadManifest, sha256 } from './manifest.mjs';
import { budgetTokens, parseMetrics } from './metrics.mjs';
import { execute } from './process.mjs';
import { markdown, summarize } from './stats.mjs';
import { checkResolution } from './evaluation.mjs';
import { armEnvironment, findBinary } from './isolation.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const contained = (parent, child) => { const rel = relative(parent, child); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function resolveConfigPaths(config, base = process.cwd()) {
  config = structuredClone(config);
  // argv entries representing files are resolved before changing into task checkouts.
  const argv = (args) => args?.map((arg, i) => typeof arg === 'string' && !arg.startsWith('-') && ((i === 0 && arg.includes('/')) || /\.(mjs|cjs|js|py|sh|json)$/.test(arg)) ? resolve(base, arg) : arg);
  if (config.agent) {
    config.agent.command = argv(config.agent.command);
    if (config.agent.binary?.includes('/')) config.agent.binary = resolve(base, config.agent.binary);
  }
  if (config.environment) for (const stage of ['setup', 'probe']) config.environment[stage] = argv(config.environment[stage]);
  if (config.evaluator) {
    config.evaluator.command = argv(config.evaluator.command);
    if (config.evaluator.harness_path) config.evaluator.harness_path = resolve(base, config.evaluator.harness_path);
    if (config.evaluator.python?.includes('/')) config.evaluator.python = resolve(base, config.evaluator.python);
  }
  if (config.environment) {
    for (const field of ['source_path', 'ix_cli']) if (config.environment[field]) config.environment[field] = resolve(base, config.environment[field]);
    if (config.environment.tool_paths) config.environment.tool_paths = config.environment.tool_paths.map((dir) => resolve(base, dir));
  }
  for (const field of ['dataset_export', 'repo_cache']) if (config[field]) config[field] = resolve(base, config[field]);
  return config;
}
export function dryConfig() {
  const stub = [process.execPath, join(root, 'stub.mjs')];
  return { version: 1, repeats: 2, seed: 20261013, bootstrap_samples: 1000,
    agent: { family: 'stub', version: 'synthetic-v1', model: 'stub', effort: 'medium', telemetry: 'normalized', command: [...stub, 'agent'] },
    budget: { max_turns: 20, max_tokens: 100000, seconds: 30 },
    environment: { seconds: 30, plugin_revision: 'synthetic-v1', setup: [...stub, 'setup'], probe: [...stub, 'probe'] },
    evaluator: { seconds: 30, kind: 'synthetic', command: [...stub, 'evaluate'] } };
}

/** No shell interpolation: all adapters receive exactly one final request-file argument. */
export async function runBenchmark({ manifestPath, config, out, dryRun = false }) {
  const manifest = loadManifest(manifestPath);
  if (dryRun !== (manifest.dataset === 'synthetic')) throw new Error('Synthetic manifests require --dry-run; real datasets forbid it');
  validateConfig(config, dryRun);
  config = resolveConfigPaths(config);
  if (!dryRun && config.agent.command[1]?.endsWith('/agent.mjs')) config.agent.binary = findBinary(config.agent.binary ?? config.agent.family);
  out = resolve(out);
  if (existsSync(out)) throw new Error('Output directory already exists; choose a fresh path');
  if (!dryRun) {
    const dataset = readFileSync(config.dataset_export, 'utf8');
    checkManifestSource(manifest, dataset, config.dataset_export);
  }
  mkdirSync(out, { recursive: true });
  const jobs = schedule(manifest.tasks, config.repeats, config.seed);
  json(join(out, 'harness.json'), { version: 1, files: Object.fromEntries(readdirSync(root).filter((name) => name.endsWith('.mjs')).sort().map((name) => [name, sha256(readFileSync(join(root, name)))])) });
  json(join(out, 'manifest.json'), manifest); json(join(out, 'config.json'), config);
  json(join(out, 'schedule.json'), jobs.map(({ task, ...job }) => ({ ...job, instance_id: task.instance_id })));
  const runs = [];
  for (const [index, job] of jobs.entries()) {
    const runPath = join(out, `${String(index).padStart(4, '0')}-${job.task.instance_id}-${job.repeat}-${job.arm}`);
    const repoPath = join(runPath, 'repo'), home = join(runPath, 'home');
    mkdirSync(home, { recursive: true });
    const request = { version: 1, synthetic: dryRun, ...job, task: { instance_id: job.task.instance_id, repo: job.task.repo, base_commit: job.task.base_commit, problem_statement: job.task.problem_statement }, run_path: runPath, repo_path: repoPath, home, agent: config.agent, budget: config.budget, environment: config.environment, evaluator: config.evaluator, dataset_export: config.dataset_export && resolve(config.dataset_export) };
    const env = armEnvironment(request);
    const requestPath = join(runPath, 'request.json'); json(requestPath, request);
    const stage = (name, argv, seconds, cwd = repoPath) => execute([...argv, requestPath], { cwd, env, seconds, log: join(runPath, name), allowTimeout: name === 'agent', captureExit: name === 'agent' });
    const setupStart = performance.now();
    try {
      if (dryRun) mkdirSync(repoPath); else {
        const cached = resolve(config.repo_cache, `${job.task.repo.replace('/', '__')}.git`);
        if (!contained(resolve(config.repo_cache), realpathSync(cached))) throw new Error('Repository cache escapes configured root');
        await execute(['git', 'clone', '--no-hardlinks', '--no-checkout', cached, repoPath], { env, seconds: config.environment.seconds, log: join(runPath, 'clone') });
        await execute(['git', 'checkout', '--detach', job.task.base_commit], { cwd: repoPath, env, seconds: config.environment.seconds, log: join(runPath, 'checkout') });
      }
      await stage('setup', config.environment.setup, config.environment.seconds);
      const probe = JSON.parse((await stage('probe', config.environment.probe, config.environment.seconds)).stdout);
      validateProbe(probe, request);
      for (const evidence of probe.evidence ?? []) {
        const file = realpathSync(resolve(runPath, evidence.path));
        if (!contained(runPath, file) || sha256(readFileSync(file)) !== evidence.sha256) throw new Error('Invalid environment evidence');
      }
      if (!dryRun) {
        const head = await execute(['git', 'rev-parse', 'HEAD'], { cwd: repoPath, env, seconds: 10 });
        if (head.stdout.trim() !== job.task.base_commit) throw new Error('Setup changed pinned checkout');
        // Keep setup-created integration files out of the solution patch.
        const diff = await execute(['git', 'diff', '--binary', 'HEAD'], { cwd: repoPath, env, seconds: 10 });
        if (diff.stdout) throw new Error('Setup modified tracked task files');
      }
      const setupSeconds = (performance.now() - setupStart) / 1000;
      const hookLog = join(runPath, 'hooks.jsonl');
      if (existsSync(hookLog)) writeFileSync(hookLog, ''); // Exclude setup/probe hook calls.
      const agent = await stage('agent', config.agent.command, config.budget.seconds);
      const metrics = parseMetrics(agent.stdout, config.agent.telemetry, { allowIncomplete: agent.timed_out || agent.exit_code !== 0 });
      const overTurns = metrics.turns > config.budget.max_turns;
      const usage = metrics.observed_usage;
      const overTokens = usage && budgetTokens(usage) > config.budget.max_tokens;
      const termination = agent.timed_out ? 'time_budget' : overTokens ? 'token_budget' : (overTurns ? 'turn_budget' : metrics.budget_reason ?? 'completed');
      if (agent.exit_code !== 0 && termination === 'completed') throw new Error('Agent stage failed without a recognized budget outcome');
      if (metrics.ix_permission_denials) throw new Error('Agent was denied Ix tools; the comparison would be biased against Ix. Check the ix arm --allowedTools integration');
      // The probe proved the baseline PATH has no launcher, so a failed `ix` attempt is an observation; a working one is a leak.
      if (job.arm === 'baseline' && metrics.ix_succeeded) throw new Error('Baseline ix call succeeded; inspect isolation before comparing arms');
      let patch = '';
      if (!dryRun) {
        await execute(['git', 'add', '-N', '--', '.'], { cwd: repoPath, env, seconds: 10 });
        patch = (await execute(['git', 'diff', '--binary', job.task.base_commit, '--', '.', ':(exclude).claude', ':(exclude).agents', ':(exclude).codex', ':(exclude).ix', ':(exclude).mcp.json'], { cwd: repoPath, env, seconds: 10 })).stdout;
      }
      writeFileSync(join(runPath, 'prediction.patch'), patch);
      let hookSeconds = 0;
      if (existsSync(hookLog)) {
        const hooks = readFileSync(hookLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
        for (const hook of hooks) {
          if (!Number.isSafeInteger(hook.ix_calls) || hook.ix_calls < 0 || !(Number.isFinite(hook.seconds) && hook.seconds >= 0)) throw new Error('Invalid hook telemetry');
          hookSeconds += hook.seconds;
          metrics.ix_calls += hook.ix_calls;
          if (hook.type === 'ix_error') { metrics.ix_errors++; metrics.ix_errors_by_code[hook.code] = (metrics.ix_errors_by_code[hook.code] ?? 0) + 1; }
        }
      }
      if (!dryRun && job.arm === 'ix' && config.environment.setup.includes(join(root, 'provision.mjs')) && termination === 'completed' && patch && (!existsSync(hookLog) || !readFileSync(hookLog, 'utf8').trim())) throw new Error('Agent changed code without firing the configured Ix hook');
      json(join(runPath, 'prediction.json'), [{ instance_id: job.task.instance_id, model_name_or_path: 'agent-eval', model_patch: patch }]);
      const evaluation = await stage('evaluate', config.evaluator.command, config.evaluator.seconds, runPath);
      const result = JSON.parse(evaluation.stdout);
      if (result.instance_id !== job.task.instance_id || typeof result.resolved !== 'boolean' || result.evaluator !== config.evaluator.kind || (!dryRun && result.revision !== config.evaluator.revision)) throw new Error('Invalid official evaluation receipt');
      if (!dryRun) {
        const reportPath = realpathSync(result.report_path);
        if (!contained(runPath, reportPath) || sha256(readFileSync(reportPath)) !== result.report_sha256) throw new Error('Invalid official report evidence');
        const official = JSON.parse(readFileSync(reportPath, 'utf8'));
        checkResolution(official, result, job.task.instance_id, patch);
      }
      const run = { instance_id: job.task.instance_id, repo: job.task.repo, base_commit: job.task.base_commit, repeat: job.repeat, arm: job.arm, ...metrics, termination, official_resolved: Number(result.resolved), resolved: Number(result.resolved && !overTurns && !overTokens), wall_seconds: agent.seconds, hook_seconds: hookSeconds, setup_seconds: setupSeconds, eval_seconds: evaluation.seconds, total_wall_seconds: (performance.now() - setupStart) / 1000 };
      json(join(runPath, 'result.json'), run); runs.push(run);
      writeFileSync(join(out, 'runs.jsonl'), runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (error) {
      json(join(runPath, 'failure.json'), { stage_error: error.message });
      throw new Error(`Run ${index} (${job.task.instance_id}/${job.arm}) invalid: ${error.message}`);
    }
  }
  const report = summarize(runs, { samples: config.bootstrap_samples, seed: config.seed });
  json(join(out, 'report.json'), report); writeFileSync(join(out, 'summary.md'), markdown(report, dryRun));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run') options.dryRun = true;
      else if (['--manifest', '--config', '--out'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
      else throw new Error('Usage: node run.mjs [--dry-run] [--manifest FILE] [--config FILE] --out NEW_DIRECTORY');
    }
    if (!options.out || (!options.dryRun && (!options.manifest || !options.config))) throw new Error('An output path and, for real runs, manifest/config are required');
    await runBenchmark({ out: options.out, dryRun: options.dryRun ?? false, manifestPath: options.manifest ?? join(root, 'smoke.json'), config: options.config ? JSON.parse(readFileSync(options.config, 'utf8')) : dryConfig() });
    console.log('Completed paired runs; see summary.md and report.json in the output directory.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
