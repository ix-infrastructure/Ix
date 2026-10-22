// Copyright 2026 Ix Infrastructure Inc.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { checkManifestSource, importVerified, loadManifest, sha256, validateManifest } from '../manifest.mjs';
import { schedule, validateConfig, validateProbe } from '../config.mjs';
import { budgetTokens, commandCounts, isIxMcpTool, parseMetrics, METRICS } from '../metrics.mjs';
import { markdown, summarize } from '../stats.mjs';
import { dryConfig, resolveConfigPaths, runBenchmark } from '../run.mjs';
import { execute } from '../process.mjs';
import { checkResolution, evaluationError } from '../evaluation.mjs';
import { armEnvironment } from '../isolation.mjs';
import { assertMapped, checkTaskIsolation, integrationFiles } from '../provision.mjs';
import { CLAUDE_IX_MCP_RULE, MCP_SERVER, PLUGIN_NAME, nativeArgs } from '../integration.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Worktree-local scratch also keeps the CI smoke independent of machine config.
const scratch = mkdtempSync(join(root, 'results-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const smoke = join(root, 'smoke.json');
const rows = Array.from({ length: 60 }, (_, i) => ({ instance_id: `fixture__repo-${i}`, repo: `fixture/repo-${i % 6}`, base_commit: sha256(`fixture-${i}`).slice(0, 40), problem_statement: `Synthetic export fixture ${i}`, patch: 'HIDDEN GOLD', test_patch: 'HIDDEN TESTS' }));
const integrationTest = (name, fn) => test(name, { skip: process.platform === 'win32' || process.env.AGENT_EVAL_PORTABLE_ONLY === '1' }, fn);
const ndjson = (events) => events.map((e) => JSON.stringify(e)).join('\n');

test('manifest importer pins 50 tasks, covers 5 repos, and is stable across input ordering', () => {
  const text = JSON.stringify(rows), manifest = importVerified(text);
  assert.equal(manifest.tasks.length, 50);
  assert.ok(new Set(manifest.tasks.map((t) => t.repo)).size >= 5);
  assert.equal(manifest.source_sha256, sha256(text));
  assert.deepEqual(manifest.tasks, importVerified(JSON.stringify([...rows].reverse())).tasks);
  assert.deepEqual(manifest.tasks, importVerified(rows.map((r) => JSON.stringify(r)).join('\n')).tasks);
  assert.ok(!JSON.stringify(manifest).includes('HIDDEN'));
  const path = join(scratch, 'manifest.json'); writeFileSync(path, JSON.stringify(manifest));
  assert.deepEqual(loadManifest(path), manifest);
  assert.equal(importVerified(text, { count: 3, minRepos: 3, seed: 7 }).tasks.length, 3);
});

test('manifest rejects missing fields, traversal, duplicates and insufficient coverage', () => {
  for (const field of ['instance_id', 'repo', 'base_commit', 'problem_statement']) {
    const row = { ...rows[0] }; delete row[field];
    assert.throws(() => importVerified(JSON.stringify([row]), { count: 1, minRepos: 1 }));
  }
  assert.throws(() => importVerified(JSON.stringify([rows[0], rows[0]]), { count: 1, minRepos: 1 }), /duplicate/);
  assert.throws(() => importVerified(JSON.stringify(rows), { count: 61 }), /Insufficient/);
  assert.throws(() => importVerified('{}'), /array/);
  assert.throws(() => importVerified(JSON.stringify(rows), { count: 1, minRepos: 2 }), /coverage/);
  assert.throws(() => validateManifest({ ...loadManifest(smoke), tasks: [{ ...rows[0], repo: '../repo' }] }), /Invalid repo/);
  assert.throws(() => validateManifest({ ...loadManifest(smoke), tasks: [{ ...rows[0], instance_id: '..' }] }), /instance_id/);
});

test('shared arm configuration and randomized schedule are reproducible and balanced', () => {
  const config = dryConfig(); validateConfig(config, true);
  assert.throws(() => validateConfig(config), /family/);
  const invalid = structuredClone(config); invalid.budget.seconds = 0;
  assert.throws(() => validateConfig(invalid, true), /positive/);
  const jobs = schedule(rows.slice(0, 3));
  assert.equal(jobs.length, 12);
  assert.deepEqual(jobs, schedule(rows.slice(0, 3)));
  assert.notDeepEqual(jobs, schedule(rows.slice(0, 3), 2, 9));
  for (const task of rows.slice(0, 3)) for (const repeat of [0, 1]) assert.deepEqual(jobs.filter((j) => j.task === task && j.repeat === repeat).map((j) => j.arm).sort(), ['baseline', 'ix']);
  const paths = resolveConfigPaths({ agent: { command: ['node', 'bench/agent-eval/agent.mjs'] }, evaluator: { python: 'local/python', harness_path: 'local/harness' } }, scratch);
  assert.equal(paths.agent.command[1], resolve(scratch, 'bench/agent-eval/agent.mjs'));
  assert.equal(paths.evaluator.python, resolve(scratch, 'local/python'));
});

test('probe rejects unmapped ix, stale maps, plugin drift and baseline contamination', () => {
  const request = { arm: 'ix', repo_path: '/fixture/repo', task: rows[0], agent: { version: 'v1' }, environment: { plugin_revision: 'pin' } };
  const probe = { version: 1, repo_path: request.repo_path, base_commit: rows[0].base_commit, agent_version: 'v1', ix_available: true, mapped: true, plugin_installed: true, skills_installed: true, hooks_enabled: true, mapped_commit: rows[0].base_commit, plugin_revision: 'pin', evidence: [{ path: 'plugin', sha256: 'hash' }] };
  validateProbe(probe, request);
  for (const key of ['ix_available', 'mapped', 'plugin_installed', 'skills_installed', 'hooks_enabled']) assert.throws(() => validateProbe({ ...probe, [key]: false }, request), /environment/);
  assert.throws(() => validateProbe({ ...probe, mapped_commit: 'stale' }, request), /Stale/);
  assert.throws(() => validateProbe({ ...probe, plugin_revision: 'wrong' }, request), /revision/);
  assert.throws(() => validateProbe(probe, { ...request, arm: 'baseline' }), /environment/);
});

test('normalized telemetry deduplicates tool ids and counts direct shell searches and ix errors', () => {
  assert.deepEqual(commandCounts('echo rg; rg needle | grep x && /bin/find .; env A=b ix locate Foo'), { search_calls: 3, rg_calls: 1, grep_calls: 1, find_calls: 1, ix_calls: 1 });
  const metrics = parseMetrics(ndjson([{ type: 'turn', id: 'a' }, { type: 'tool', id: 't', command: 'rg foo; ix locate Foo' }, { type: 'tool', id: 't', command: 'rg foo' }, { type: 'ix_error', code: 'STALE_MAP' }, { type: 'usage', input_tokens: 100, output_tokens: 10, cached_tokens: 20 }, { type: 'done' }]), 'normalized');
  assert.equal(metrics.tool_calls, 1); assert.equal(metrics.search_calls, 1); assert.equal(metrics.ix_calls, 1);
  assert.deepEqual(metrics.ix_errors_by_code, { STALE_MAP: 1 });
  assert.throws(() => parseMetrics('{bad}', 'normalized'));
  assert.throws(() => parseMetrics(ndjson([{ type: 'done' }]), 'normalized'), /Incomplete/);
  assert.throws(() => parseMetrics(ndjson([{ type: 'turn', id: 'a' }, { type: 'usage', input_tokens: 10, output_tokens: 1 }, { type: 'done' }]), 'normalized'), /cached_tokens/);
});

test('Claude parses terminal usage including cache creation, deduplicated message ids and ix tool failures', () => {
  const assistant = { type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ix locate Foo' } }, { type: 'tool_use', id: 'm', name: 'mcp__ix-memory__locate', input: {} }] } };
  const metrics = parseMetrics(ndjson([assistant, assistant, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: '{"error":{"code":"UNMAPPED"}}' }] } }, { type: 'result', usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }]), 'claude');
  assert.equal(metrics.input_tokens, 80); assert.equal(metrics.cached_tokens, 30);
  assert.equal(metrics.turns, 1); assert.equal(metrics.tool_calls, 2); assert.equal(metrics.ix_calls, 2);
  assert.deepEqual(metrics.ix_errors_by_code, { UNMAPPED: 1 });
});

test('Claude Ix MCP calls count under both direct and plugin-scoped tool names', () => {
  for (const name of ['mcp__ix-memory__locate', 'mcp__ix__search', 'mcp__plugin_ix-agent-eval_ix-memory__locate', 'mcp__plugin_ix_ix__explain']) assert.equal(isIxMcpTool(name), true, name);
  for (const name of ['Bash', 'mcp__github__search', 'mcp__plugin_ix-agent-eval_github__search', 'mcp__plugin_tools_ixl__x', 'mcp__ixl__x']) assert.equal(isIxMcpTool(name), false, name);
  const tool = { type: 'tool_use', id: 'p', name: 'mcp__plugin_ix-agent-eval_ix-memory__locate', input: {} };
  const metrics = parseMetrics(ndjson([{ type: 'assistant', message: { id: 'a', content: [tool] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p', is_error: true, content: [{ type: 'text', text: '{"error":{"code":"UNMAPPED"}}' }] }] } }, { type: 'result', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }]), 'claude');
  assert.equal(metrics.ix_calls, 1); assert.deepEqual(metrics.ix_errors_by_code, { UNMAPPED: 1 });
});

test('token ceiling counts uncached input and output, not cache reads', () => {
  // A long Claude session re-reads its cached context every turn; that must not exhaust the ceiling.
  assert.equal(budgetTokens({ input_tokens: 250_000, cached_tokens: 240_000, output_tokens: 5_000 }), 15_000);
  assert.equal(budgetTokens({ input_tokens: 10, cached_tokens: 0, output_tokens: 2 }), 12);
});

test('example config grants edits and shell; only the ix arm is allowed the Ix MCP server', () => {
  const { agent, budget } = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
  // Claude --print denies anything that would prompt, so both arms need explicit tool permissions.
  const argv = (arm) => nativeArgs({ arm, run_path: '/run', agent, budget });
  const allowed = (args) => args.filter((arg, i) => args[i - 1] === '--allowedTools');
  assert.deepEqual(allowed(argv('ix')), [`Bash,${CLAUDE_IX_MCP_RULE}`]);
  assert.deepEqual(allowed(argv('baseline')), ['Bash']);
  assert.ok(argv('ix').includes('acceptEdits'));
  // The rule must match the provisioned plugin/server names and the telemetry matcher.
  assert.equal(CLAUDE_IX_MCP_RULE, `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER}`);
  assert.ok(isIxMcpTool(`${CLAUDE_IX_MCP_RULE}__locate`));
  const files = integrationFiles({ agent, run_path: '/run', home: '/home', environment: { seconds: 1 } });
  assert.deepEqual(Object.keys(JSON.parse(files['/run/plugin/.mcp.json']).mcpServers), [MCP_SERVER]);
  assert.equal(JSON.parse(files['/run/plugin/.claude-plugin/plugin.json']).name, PLUGIN_NAME);
  // Shared args and tool rules cannot grant or override integrations.
  for (const args of [['--allowedTools', 'Bash'], ['--allowed-tools=Bash'], ['--mcp-config', '{}']]) assert.throws(() => nativeArgs({ arm: 'ix', run_path: '/run', agent: { ...agent, args }, budget }), /override/);
  assert.throws(() => nativeArgs({ arm: 'baseline', run_path: '/run', agent: { ...agent, allowed_tools: [CLAUDE_IX_MCP_RULE] }, budget }), /MCP/);
  assert.throws(() => nativeArgs({ arm: 'ix', run_path: '/run', agent: { ...agent, family: 'codex', allowed_tools: ['Bash'] }, budget }), /Claude Code only/);
  assert.equal(nativeArgs({ arm: 'ix', run_path: '/run', agent: { ...agent, family: 'codex', allowed_tools: [] }, budget }).includes('--allowedTools'), false);
});

test('Claude Ix permission denials are reported separately from Ix errors', () => {
  const tool = { type: 'tool_use', id: 'p', name: `${CLAUDE_IX_MCP_RULE}__locate`, input: {} };
  const denied = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'p', is_error: true, content: `Claude requested permissions to use ${CLAUDE_IX_MCP_RULE}__locate, but you haven't granted it yet.` }] } };
  const result = (extra) => ({ type: 'result', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...extra });
  const assistant = { type: 'assistant', message: { id: 'a', content: [tool] } };
  let metrics = parseMetrics(ndjson([assistant, denied, result({ permission_denials: [{ tool_name: tool.name, tool_use_id: 'p', tool_input: {} }] })]), 'claude');
  assert.equal(metrics.ix_permission_denials, 1); assert.equal(metrics.ix_errors, 0);
  metrics = parseMetrics(ndjson([assistant, result({ permission_denials: [{ tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'ix locate Foo' } }, { tool_name: 'WebFetch', tool_use_id: 'w', tool_input: {} }] })]), 'claude');
  assert.equal(metrics.ix_permission_denials, 1);
  metrics = parseMetrics(ndjson([assistant, result({ permission_denials: [] })]), 'claude');
  assert.equal(metrics.ix_permission_denials, 0);
});

test('Codex sums completed turn usage and captures command/MCP errors by code', () => {
  const usage = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 50 } };
  const metrics = parseMetrics(ndjson([{ type: 'turn.started' }, { type: 'item.completed', item: { id: 't', type: 'command_execution', command: 'rg foo; ix locate Foo', exit_code: 1, aggregated_output: '{"error":{"code":"NOT_FOUND"}}' } }, usage, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'ix-memory', error: { code: 'DOWN' } } }, usage]), 'codex');
  assert.equal(metrics.input_tokens, 200); assert.equal(metrics.cached_tokens, 100); assert.equal(metrics.turns, 2);
  assert.equal(metrics.search_calls, 1); assert.equal(metrics.ix_calls, 2);
  assert.deepEqual(metrics.ix_errors_by_code, { NOT_FOUND: 1, DOWN: 1 });
  assert.throws(() => parseMetrics(ndjson([{ type: 'turn.started' }, { type: 'turn.failed' }]), 'codex'), /failed/);
  assert.throws(() => parseMetrics(ndjson([{ type: 'turn.started' }, usage, { type: 'turn.started' }]), 'codex'), /Incomplete/);
});

function fixtureRuns() {
  return [0, 1].flatMap((task) => [0, 1].flatMap((repeat) => ['baseline', 'ix'].map((arm) => ({ instance_id: `fixture-${task}`, arm, repeat, ...Object.fromEntries(METRICS.map((m) => [m, m === 'resolved' ? 1 : arm === 'ix' ? task * 2 : 0])) }))));
}
test('paired task bootstrap has fixture bounds and rejects duplicate/incomplete repeats', () => {
  const runs = fixtureRuns(), report = summarize(runs, { samples: 1000, seed: 17 });
  assert.equal(report.metrics.input_tokens.mean_difference.estimate, 1);
  assert.deepEqual(report.metrics.input_tokens.mean_difference.ci90, [0, 2]);
  assert.deepEqual(report.metrics.resolved.mean_difference.ci90, [0, 0]);
  assert.deepEqual(report, summarize(runs, { samples: 1000, seed: 17 }));
  assert.equal(report.bootstrap.unit, 'task');
  assert.match(markdown(report), /90% CI/);
  assert.throws(() => summarize([...runs, runs[0]]), /Duplicate/);
  assert.throws(() => summarize(runs.slice(1)), /Unpaired/);
  assert.throws(() => summarize([{ ...runs[0], input_tokens: NaN }]), /Invalid metric/);
});

integrationTest('three-task stub dry run executes all stages for both arms and persists reports', async () => {
  const out = join(scratch, 'smoke');
  const report = await runBenchmark({ manifestPath: smoke, config: dryConfig(), out, dryRun: true });
  assert.equal(report.tasks, 3); assert.equal(report.repeats, 2);
  const runs = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 12);
  assert.ok(runs.every((r) => r.resolved === 1));
  assert.ok(runs.filter((r) => r.arm === 'baseline').every((r) => r.ix_calls === 0 && r.search_calls === 1));
  assert.ok(runs.filter((r) => r.arm === 'ix').every((r) => r.ix_calls === 1));
  assert.deepEqual(report.metrics.input_tokens.mean_difference.ci90, [-10, -10]);
  assert.match(readFileSync(join(out, 'summary.md'), 'utf8'), /Synthetic dry run/);
  assert.ok(existsSync(join(out, 'schedule.json')));
  await assert.rejects(runBenchmark({ manifestPath: smoke, config: dryConfig(), out, dryRun: true }), /already exists/);
});

integrationTest('CLI dry-run works from the repository root without Docker or a paid agent', () => {
  const out = join(scratch, 'cli');
  const stdout = execFileSync(process.execPath, [join(root, 'run.mjs'), '--dry-run', '--out', out], { encoding: 'utf8' });
  assert.match(stdout, /Completed/); assert.ok(existsSync(join(out, 'summary.md')));
});

integrationTest('budget exhaustion retains outcomes and completes the comparison report', async () => {
  const config = dryConfig(); config.budget.max_tokens = 1;
  const out = join(scratch, 'budget');
  const report = await runBenchmark({ manifestPath: smoke, config, out, dryRun: true });
  const runs = readFileSync(join(out, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 12);
  assert.ok(runs.every((run) => run.termination === 'token_budget' && run.resolved === 0 && run.official_resolved === 1));
  assert.ok(runs.every((run) => Number.isFinite(run.hook_seconds)));
  assert.equal(report.metrics.resolved.baseline.mean, 0);
  assert.ok(existsSync(join(out, 'summary.md')));
});

integrationTest('invalid environments still stop loudly without a comparison report', async () => {
  const badProbe = join(scratch, 'bad-probe.mjs');
  writeFileSync(badProbe, "console.log(JSON.stringify({version: 1, mapped: false}))\n");
  const badConfig = dryConfig(); badConfig.environment.probe = [process.execPath, badProbe];
  await assert.rejects(runBenchmark({ manifestPath: smoke, config: badConfig, out: join(scratch, 'probe'), dryRun: true }), /identity/);
  await assert.rejects(runBenchmark({ manifestPath: smoke, config: dryConfig(), out: join(scratch, 'wrong-mode') }), /require --dry-run/);
});

test('subprocess errors and deadlines fail rather than producing partial metrics', async () => {
  await assert.rejects(execute([process.execPath, '-e', 'process.exit(7)'], { seconds: 2 }), /exited 7/);
  await assert.rejects(execute([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { seconds: .1 }), /deadline/);
});

test('empty solutions need explicit official summary evidence, never a guessed failure', () => {
  const receipt = { report_kind: 'empty-patch-summary', resolved: false };
  checkResolution({ empty_patch_ids: ['fixture'] }, receipt, 'fixture', '');
  assert.throws(() => checkResolution({ empty_patch_ids: [] }, receipt, 'fixture', ''), /evidence/);
  assert.throws(() => checkResolution({ empty_patch_ids: ['fixture'] }, receipt, 'fixture', 'nonempty'), /evidence/);
  assert.throws(() => checkResolution({}, { resolved: false }, 'fixture', ''), /differs/);
});

test('patch-apply and test-timeout evaluation errors score unresolved; other errors stay fatal', () => {
  const receipt = { report_kind: 'error-summary', resolved: false, evaluation_error: 'patch_apply_failed' };
  checkResolution({ error_ids: ['fixture'] }, receipt, 'fixture', 'diff');
  assert.throws(() => checkResolution({ error_ids: [] }, receipt, 'fixture', 'diff'), /evidence/);
  assert.throws(() => checkResolution({ error_ids: ['fixture'] }, receipt, 'fixture', ''), /evidence/);
  assert.throws(() => checkResolution({ error_ids: ['fixture'] }, { ...receipt, resolved: true }, 'fixture', 'diff'), /evidence/);
  assert.throws(() => checkResolution({ error_ids: ['fixture'] }, { ...receipt, evaluation_error: 'docker' }, 'fixture', 'diff'), /evidence/);
  assert.equal(evaluationError('x\n>>>>> Patch Apply Failed:\nerror: corrupt patch'), 'patch_apply_failed');
  assert.equal(evaluationError('EvaluationError: Evaluation error in fixture: Test timed out after 900 seconds.'), 'test_timeout');
  assert.throws(() => evaluationError('BuildImageError: docker daemon unavailable'), /inspect the harness logs/);
});

integrationTest('SWE-bench adapter turns a logged patch-apply error into an unresolved receipt', () => {
  const harness = join(scratch, 'swe-harness'), python = join(scratch, 'fake-python.cjs');
  mkdirSync(harness, { recursive: true });
  execFileSync('git', ['init', '-q', harness]); writeFileSync(join(harness, 'README'), 'fixture');
  execFileSync('git', ['-C', harness, 'add', '.']); execFileSync('git', ['-C', harness, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);
  const revision = execFileSync('git', ['-C', harness, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Mimics the official harness: no task report, the instance listed in error_ids, the cause in run_instance.log.
  writeFileSync(python, `#!${process.execPath}
    const { mkdirSync, writeFileSync } = require('node:fs');
    const id = process.argv[process.argv.indexOf('--instance_ids') + 1], dir = 'logs/run_evaluation/agent-eval/agent-eval/' + id;
    mkdirSync(dir, { recursive: true }); writeFileSync(dir + '/run_instance.log', process.env.FAKE_INSTANCE_LOG);
    writeFileSync('agent-eval.agent-eval.json', JSON.stringify({ error_ids: [id], empty_patch_ids: [], resolved_ids: [] }));
  `.replace(/^\s+/gm, ''), { mode: 0o755 });
  const evaluate = (name, log) => {
    const run_path = join(scratch, `swe-${name}`); mkdirSync(run_path, { recursive: true });
    writeFileSync(join(run_path, 'prediction.patch'), 'diff --git a/x b/x\n');
    const request = { synthetic: false, dataset_export: 'fixture.json', run_path, task: { instance_id: 'fixture__repo-1' }, evaluator: { kind: 'swe-bench', revision, harness_path: harness, python, seconds: 30 } };
    writeFileSync(join(run_path, 'request.json'), JSON.stringify(request));
    return spawnSync(process.execPath, [join(root, 'swebench.mjs'), join(run_path, 'request.json')], { encoding: 'utf8', env: { ...process.env, FAKE_INSTANCE_LOG: log } });
  };
  const applied = evaluate('apply', '>>>>> Patch Apply Failed:\npatch: **** malformed patch');
  assert.equal(applied.status, 0, applied.stderr);
  const receipt = JSON.parse(applied.stdout);
  assert.equal(receipt.resolved, false); assert.equal(receipt.report_kind, 'error-summary'); assert.equal(receipt.evaluation_error, 'patch_apply_failed');
  const docker = evaluate('docker', 'BuildImageError: docker daemon unavailable');
  assert.notEqual(docker.status, 0); assert.match(docker.stderr, /inspect the harness logs/);
});

integrationTest('real-run plumbing checks dataset pins and official evidence and includes new solution files', async () => {
  // All data/evaluation here are synthetic fixtures; this does not exercise Docker.
  const source = join(scratch, 'source'), cache = join(scratch, 'cache');
  mkdirSync(source); mkdirSync(cache);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'no-global-config') } });
  git('init', '-q'); writeFileSync(join(source, 'source.txt'), 'before\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const base = git('rev-parse', 'HEAD').trim();
  git('clone', '--bare', source, join(cache, 'fixture__repo.git'));
  const exportPath = join(scratch, 'real-fixture-export.json');
  const text = JSON.stringify([{ ...rows[0], repo: 'fixture/repo', base_commit: base }]);
  writeFileSync(exportPath, text);
  const manifestPath = join(scratch, 'real-fixture-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(importVerified(text, { count: 1, minRepos: 1 })));
  const adapter = join(scratch, 'fixture-adapter.mjs');
  writeFileSync(adapter, `
    import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {createHash} from 'node:crypto';
    const [stage,file] = process.argv.slice(2), r = JSON.parse(readFileSync(file, 'utf8'));
    const hash = text => createHash('sha256').update(text).digest('hex');
    const ix = r.arm === 'ix', evidence = join(r.home, 'fixture-evidence.json');
    if(stage === 'setup') {
      writeFileSync(evidence, '{}'); mkdirSync(join(r.repo_path, '.claude'));
      writeFileSync(join(r.repo_path, '.claude', 'settings.json'), '{}');
    } else if(stage === 'probe') console.log(JSON.stringify({version:1, repo_path:r.repo_path, base_commit:r.task.base_commit, agent_version:r.agent.version, ix_available:ix, mapped:ix, plugin_installed:ix, skills_installed:ix, hooks_enabled:ix, mapped_commit:r.task.base_commit, plugin_revision:r.environment.plugin_revision, evidence:ix ? [{path:evidence, sha256:hash('{}')}] : []}));
    else if(stage === 'agent') {
      writeFileSync(join(r.repo_path, 'source.txt'), 'after\\n'); writeFileSync(join(r.repo_path, 'added.txt'), 'new solution\\n');
      const {execFileSync} = await import('node:child_process');
      execFileSync('git', ['add', 'source.txt', 'added.txt']);
      execFileSync('git', ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','agent fix']);
      for(const e of [{type:'turn',id:'a'}, {type:'tool',id:'t',command:'rg fixture'}, {type:'usage',input_tokens:10,output_tokens:10,cached_tokens:0}, {type:'done'}]) console.log(JSON.stringify(e));
    } else if(stage === 'evaluate') {
      const report_path = join(r.run_path,'fixture-official-report.json');
      const report = JSON.stringify({[r.task.instance_id]:{resolved:true}}); writeFileSync(report_path,report);
      console.log(JSON.stringify({instance_id:r.task.instance_id,resolved:!r.evaluator.mismatch,evaluator:'swe-bench',revision:r.evaluator.revision,report_path,report_sha256:hash(report)}));
    }
  `);
  const config = dryConfig();
  config.agent = { ...config.agent, family: 'claude', command: [process.execPath, adapter, 'agent'] };
  config.environment = { ...config.environment, plugin_revision: base, setup: [process.execPath, adapter, 'setup'], probe: [process.execPath, adapter, 'probe'] };
  config.evaluator = { ...config.evaluator, kind: 'swe-bench', revision: base, command: [process.execPath, adapter, 'evaluate'] };
  config.dataset_export = exportPath; config.repo_cache = cache;
  const out = join(scratch, 'real-fixture');
  const report = await runBenchmark({ manifestPath, config, out });
  assert.equal(report.metrics.resolved.baseline.mean, 1);
  const jobs = JSON.parse(readFileSync(join(out, 'schedule.json'), 'utf8'));
  const first = jobs[0], runPath = join(out, `0000-${first.instance_id}-${first.repeat}-${first.arm}`);
  const patch = readFileSync(join(runPath, 'prediction.patch'), 'utf8');
  assert.match(patch, /source.txt/); assert.match(patch, /added.txt/); assert.doesNotMatch(patch, /settings.json/);
  config.evaluator.mismatch = true;
  await assert.rejects(runBenchmark({ manifestPath, config, out: join(scratch, 'bad-official') }), /differs from official/);
  writeFileSync(exportPath, text + '\n');
  await assert.rejects(runBenchmark({ manifestPath, config, out: join(scratch, 'bad-hash') }), /hash mismatch/);
});

 test('quoted command examples are not counted as executed Ix calls', () => {
   for (const cmd of ["echo 'example; ix locate Foo '", 'echo "example && ix locate Foo"', "printf '%s\\n' 'rg a | grep b'", 'echo escaped\\; ixample']) {
     assert.equal(commandCounts(cmd).ix_calls, 0);
     assert.equal(commandCounts(cmd).search_calls, 0);
   }
   assert.equal(commandCounts('"ix" locate Foo; echo "ix locate Bar"').ix_calls, 1);
 });
 test('example real configuration ships its setup and probe adapters', () => {
   const config = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
   for (const stage of ['setup', 'probe']) assert.ok(existsSync(resolve(root, '../..', config.environment[stage][1])), `missing ${stage}`);
 });


test('quote-aware command counting handles shell wrappers, escapes and comments', () => {
  assert.equal(commandCounts("/bin/bash -lc 'rg needle; ix locate Foo'").ix_calls, 1);
  assert.equal(commandCounts("/bin/bash -lc 'echo \"example; ix locate Foo\"'").ix_calls, 0);
  assert.equal(commandCounts('echo escaped\\;ix locate Foo').ix_calls, 0);
  assert.equal(commandCounts('# ix locate Foo\nrg needle').rg_calls, 1);
  assert.equal(commandCounts('echo "a|grep x"; "grep" needle').grep_calls, 1);
});

test('mapping probe rejects successful-but-empty, stale and partial maps', () => {
  const status = { graphCompleted: true, mapCompleted: true, staleFiles: 0, graphHealth: { status: 'ok' } };
  const stats = { nodes: { total: 3 } };
  assertMapped(status, stats);
  for (const patch of [{ graphCompleted: false }, { mapCompleted: null }, { staleFiles: 1 }, { graphHealth: { status: 'empty' } }, { replayedFiles: ['file.py'] }, { parseTimeouts: ['file.py'] }]) {
    assert.throws(() => assertMapped({ ...status, ...patch }, stats), /unmapped/);
  }
  assert.throws(() => assertMapped(status, { nodes: { total: 0 } }), /unmapped/);
});

integrationTest('shipped provisioner installs pinned local integrations and isolates PATH in both native arms', async () => {
  const source = join(scratch, 'ix-source'); mkdirSync(source);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'absent-config') } });
  git('init', '-q'); mkdirSync(join(source, 'skills', 'ix'), { recursive: true });
  writeFileSync(join(source, 'skills', 'ix', 'SKILL.md'), '---\nname: ix\ndescription: Fixture\n---\nPinned skill\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD').trim();
  const tools = join(scratch, 'ambient-bin'); mkdirSync(tools);
  writeFileSync(join(tools, 'ix'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const fakeIx = join(scratch, 'fake-ix.mjs');
  writeFileSync(fakeIx, `
    import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const [cmd] = process.argv.slice(2), marker = join(process.env.IX_HOME,'mapped');
    if(cmd==='--version') console.log('ix 1.0-fixture');
    else if(cmd==='map') { mkdirSync(process.env.IX_HOME,{recursive:true}); writeFileSync(marker,process.cwd()); }
    else if(cmd==='status') console.log(JSON.stringify({graphCompleted:existsSync(marker),mapCompleted:existsSync(marker),staleFiles:0,graphHealth:{status:'ok'}}));
    else if(cmd==='stats') console.log(JSON.stringify({nodes:{total:existsSync(marker)?10:0}}));
    else if(cmd==='hook') console.log('{}');
    else process.exitCode=1;
  `);
  const fakeAgent = join(scratch, 'fake-native');
  writeFileSync(fakeAgent, `#!${process.execPath}
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {execFileSync} from 'node:child_process';
    if(process.argv[2]==='--version') console.log('agent 1.0-fixture');
    else {
      const r=JSON.parse(readFileSync(process.env.AGENT_EVAL_REQUEST,'utf8'));
      const args=process.argv.slice(2); writeFileSync(join(r.run_path,'native-args.json'),JSON.stringify(args));
      if(r.arm==='ix') {
        if(r.agent.family==='claude') {
          const plugin=args[args.indexOf('--plugin-dir')+1];
          const hooks=JSON.parse(readFileSync(join(plugin,'hooks','hooks.json'),'utf8'));
          execFileSync('sh',['-c',hooks.hooks.PostToolUse[0].hooks[0].command],{input:'{}'});
        } else {
          const config=readFileSync(join(process.env.CODEX_HOME,'config.toml'),'utf8');
          const notify=JSON.parse(config.split('\\n')[0].slice('notify = '.length));
          execFileSync(notify[0],[...notify.slice(1),JSON.stringify({type:'agent-turn-complete'})]);
        }
      }
      for(const e of [{type:'turn',id:'a'},{type:'usage',input_tokens:10,output_tokens:2,cached_tokens:0},{type:'done'}]) console.log(JSON.stringify(e));
    }
  `, { mode: 0o755 });
  for (const family of ['claude', 'codex']) for (const arm of ['baseline', 'ix']) {
    const run_path = join(scratch, `provision-${family}-${arm}`), repo_path = join(run_path, 'repo'), home = join(run_path, 'home');
    mkdirSync(home, { recursive: true });
    execFileSync('git', ['clone', '-q', source, repo_path]);
    // This repository's skill is inert until installed in the agent-specific location.
    const request = { synthetic: true, arm, run_path, repo_path, home, task: { base_commit: revision, problem_statement: 'fixture' }, agent: { family, binary: fakeAgent, version: '1.0-fixture', model: 'fixture-model', effort: 'medium' }, budget: { max_turns: 2 },
      environment: { plugin_revision: revision, source_path: source, ix_cli: fakeIx, ix_version: '1.0-fixture', endpoint: 'http://127.0.0.1:8090', seconds: 10, tool_paths: [tools, '/usr/bin', '/bin'] } };
    assert.throws(() => checkTaskIsolation({ ...request, synthetic: false }), (error) => /ancestor/.test(error.message) && error.message.includes(resolve(root, '..', '..')));
    const env = armEnvironment(request, { ...process.env, IX_ENDPOINT: 'http://wrong.invalid', IX_WORKSPACE_ID: 'wrong', JARVIS_IX_SOCKET: 'wrong' });
    assert.equal(env.IX_WORKSPACE_ID, undefined); assert.equal(env.JARVIS_IX_SOCKET, undefined);
    assert.equal(env.IX_ENDPOINT, arm === 'ix' ? request.environment.endpoint : undefined);
    const requestPath = join(run_path, 'request.json'); writeFileSync(requestPath, JSON.stringify(request));
    const provision = join(root, 'provision.mjs');
    await execute([process.execPath, provision, 'setup', requestPath], { cwd: repo_path, env });
    const result = JSON.parse((await execute([process.execPath, provision, 'probe', requestPath], { cwd: repo_path, env })).stdout);
    validateProbe(result, request);
    const transcript = await execute([process.execPath, join(root, 'agent.mjs'), requestPath], { cwd: repo_path, env });
    assert.equal(parseMetrics(transcript.stdout, 'normalized').turns, 1);
    const args = JSON.parse(readFileSync(join(run_path, 'native-args.json'), 'utf8'));
    assert.ok(args.includes('fixture-model'));
    if (family === 'claude') assert.equal(args.includes('--plugin-dir'), arm === 'ix');
    if (arm === 'baseline') {
      await assert.rejects(execute(['ix', '--version'], { env }), /ENOENT/);
      writeFileSync(join(repo_path, 'AGENTS.md'), 'ambient instructions');
      await assert.rejects(execute([process.execPath, provision, 'probe', requestPath], { env }), /exited/);
    } else {
      for (const evidence of result.evidence) assert.equal(sha256(readFileSync(evidence.path)), evidence.sha256);
      const files = integrationFiles(request), first = Object.keys(files)[0];
      if (family === 'claude') {
        const hooks = JSON.parse(files[join(run_path, 'plugin', 'hooks', 'hooks.json')]).hooks.PostToolUse[0].hooks[0];
        assert.equal(hooks.timeout, 2 * request.environment.seconds + 30); // Outlasts both ix stage deadlines.
      }
      writeFileSync(first, 'tampered');
      await assert.rejects(execute([process.execPath, provision, 'probe', requestPath], { env }), /exited/);
      writeFileSync(first, files[first]);
      rmSync(join(home, '.ix', 'mapped'));
      // Direct assertMapped also covers map failures that return exit 0.
      assert.ok(readFileSync(join(run_path, 'hooks.jsonl'), 'utf8').includes('probe'));
    }
  }
  writeFileSync(join(source, 'skills', 'ix', 'SKILL.md'), 'drifted');
  const r = join(scratch, 'provision-claude-ix', 'request.json');
  await assert.rejects(execute([process.execPath, join(root, 'provision.mjs'), 'probe', r], { env: { ...process.env, PATH: join(scratch, 'provision-claude-ix', 'bin') } }), /exited/);
});

test('manifest pins agree with the hash-verified source export', () => {
  const text = JSON.stringify(rows), manifest = importVerified(text);
  checkManifestSource(manifest, text);
  for (const field of ['repo', 'base_commit', 'problem_statement']) {
    const changed = structuredClone(manifest); changed.tasks[0][field] = 'drifted';
    assert.throws(() => checkManifestSource(changed, text), /differs from source/);
  }
});

test('native Ix failures retain JSON and LLM error codes', () => {
  const metrics = parseMetrics(ndjson([{ type: 'turn.started' }, { type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'ix stats', exit_code: 1, aggregated_output: 'error code=backend_error message="unavailable"' } }, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }]), 'codex');
  assert.deepEqual(metrics.ix_errors_by_code, { backend_error: 1 });
});


test('portable subset retains unit coverage and excludes POSIX integration tests', { skip: process.env.AGENT_EVAL_PORTABLE_ONLY === '1' }, () => {
  const env = { ...process.env, AGENT_EVAL_PORTABLE_ONLY: '1' }; delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ['--test', '--test-reporter=tap', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 60_000, env });
  assert.match(output, /# fail 0/);
  const skipped = Number(output.match(/# skipped (\d+)/)?.[1]);
  assert.ok(skipped >= 6, `POSIX integrations ran in portable subset: ${skipped} skipped`);
  assert.ok(Number(output.match(/# pass (\d+)/)?.[1]) >= 10);
});


test('partial budget telemetry preserves observations without invented token totals', () => {
  const text = ndjson([{ type: 'turn.started' }, { type: 'item.completed', item: { id: 'tool', type: 'command_execution', command: 'rg needle', exit_code: 0 } }]) + '\n{"type":';
  assert.throws(() => parseMetrics(text, 'codex'));
  const metrics = parseMetrics(text, 'codex', { allowIncomplete: true });
  assert.equal(metrics.turns, 1); assert.equal(metrics.search_calls, 1);
  assert.equal(metrics.input_tokens, null); assert.equal(metrics.usage_complete, false);
  const turnLimit = parseMetrics(ndjson([{ type: 'assistant', message: { id: 'a', content: [] } }, { type: 'result', subtype: 'error_max_turns', is_error: true }]), 'claude', { allowIncomplete: true });
  assert.equal(turnLimit.budget_reason, 'turn_budget'); assert.equal(turnLimit.input_tokens, null);
});

test('missing usage keeps resolution denominators and reports complete-pair coverage', () => {
  const runs = fixtureRuns();
  for (const run of runs.filter((r) => r.instance_id === 'fixture-0' && r.arm === 'baseline')) {
    Object.assign(run, { input_tokens: null, output_tokens: null, cached_tokens: null, usage_complete: false, termination: 'time_budget' });
  }
  const report = summarize(runs, { samples: 1000 });
  assert.equal(report.metrics.resolved.coverage.paired_tasks, 2);
  assert.equal(report.metrics.input_tokens.coverage.paired_tasks, 1);
  assert.equal(report.metrics.input_tokens.coverage.baseline_observed_runs, 2);
  assert.deepEqual(report.metrics.input_tokens.mean_difference.ci90, [2, 2]);
  assert.equal(report.per_task[0].metrics.input_tokens.difference, null);
  for (const run of runs) Object.assign(run, { input_tokens: null, output_tokens: null, cached_tokens: null, usage_complete: false });
  const absent = summarize(runs, { samples: 100 });
  assert.equal(absent.metrics.input_tokens.mean_difference.ci90, null);
  assert.match(markdown(absent), /unavailable/);
});

test('agent deadlines can preserve output while other subprocess deadlines remain strict', async () => {
  const result = await execute([process.execPath, '-e', 'console.log("observed"); setInterval(() => {}, 1000)'], { seconds: 1, allowTimeout: true });
  assert.equal(result.timed_out, true); assert.match(result.stdout, /observed/);
  await assert.rejects(execute([process.execPath, '-e', 'process.exit(7)'], { allowTimeout: true }), /exited 7/);
});

integrationTest('time-budget outcome evaluates its retained solution and continues subsequent jobs', async () => {
  const adapter = join(scratch, 'deadline-agent.mjs');
  writeFileSync(adapter, `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
    if(r.arm==='baseline' && r.task.instance_id==='synthetic-one') {
      writeFileSync(join(r.repo_path,'solution.txt'),'synthetic solution\\n');
      console.log(JSON.stringify({type:'turn',id:'partial'}));
      process.stdout.write('{"type":'); setInterval(()=>{},1000);
    } else { process.argv.splice(2,0,'agent'); await import(${JSON.stringify(join(root, 'stub.mjs'))}); }
  `);
  const config = dryConfig(); config.repeats = 1; config.budget.seconds = 1;
  config.agent.command = [process.execPath, adapter];
  const out = join(scratch, 'time-budget'), report = await runBenchmark({ manifestPath: smoke, config, out, dryRun: true });
  const runs = readFileSync(join(out,'runs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 6);
  const limited = runs.find((r) => r.termination === 'time_budget');
  assert.equal(limited.resolved, 1); assert.equal(limited.input_tokens, null);
  assert.equal(report.metrics.resolved.coverage.paired_tasks, 3);
  assert.equal(report.metrics.input_tokens.coverage.paired_tasks, 2);
  assert.ok(existsSync(join(out, 'summary.md')));
});

integrationTest('turn-budget overshoots are retained conservatively as unresolved', async () => {
  const adapter = join(scratch, 'turn-agent.mjs');
  writeFileSync(adapter, `
    console.log(JSON.stringify({type:'turn',id:'extra'}));
    process.argv.splice(2,0,'agent'); await import(${JSON.stringify(join(root, 'stub.mjs'))});
  `);
  const config = dryConfig(); config.repeats = 1; config.budget.max_turns = 1;
  config.agent.command = [process.execPath, adapter];
  const out = join(scratch, 'turn-budget');
  await runBenchmark({ manifestPath: smoke, config, out, dryRun: true });
  const runs = readFileSync(join(out,'runs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 6);
  assert.ok(runs.every((r) => r.termination === 'turn_budget' && r.resolved === 0 && r.official_resolved === 1));
  assert.ok(existsSync(join(out, 'summary.md')));
});


integrationTest('native turn-limit exit receipts remain evaluable and ordinary crashes remain fatal', async () => {
  const adapter = join(scratch, 'native-turn-limit.mjs');
  writeFileSync(adapter, `
    import {readFileSync,writeFileSync} from 'node:fs'; import {join} from 'node:path';
    const r=JSON.parse(readFileSync(process.argv[2],'utf8'));
    writeFileSync(join(r.repo_path,'solution.txt'),'synthetic solution\\n');
    console.log(JSON.stringify({type:'assistant',message:{id:'a',content:[]}}));
    console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true}));
    process.exitCode=1;
  `);
  const config = dryConfig(); config.repeats = 1; config.agent.telemetry = 'claude';
  config.agent.command = [process.execPath, adapter];
  const out = join(scratch, 'native-turn-limit'), report = await runBenchmark({ manifestPath: smoke, config, out, dryRun: true });
  const runs = readFileSync(join(out,'runs.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(runs.length, 6); assert.ok(runs.every((r) => r.termination === 'turn_budget' && r.input_tokens === null));
  assert.equal(report.metrics.resolved.baseline.mean, 1);
  assert.equal(report.metrics.input_tokens.mean_difference.ci90, null);
  const crash = join(scratch, 'agent-crash.mjs'); writeFileSync(crash, 'process.exitCode=7;\n');
  config.agent.command = [process.execPath, crash];
  const invalid = join(scratch, 'agent-crash');
  await assert.rejects(runBenchmark({ manifestPath: smoke, config, out: invalid, dryRun: true }), /without a recognized budget/);
  assert.ok(!existsSync(join(invalid,'summary.md')));
});
