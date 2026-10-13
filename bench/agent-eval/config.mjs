// Copyright 2026 Ix Infrastructure Inc.

import { positiveInteger } from './manifest.mjs';
import { random, shuffled } from './stats.mjs';

export function command(value, name) {
  if (!Array.isArray(value) || !value.length || value.some((v) => typeof v !== 'string' || !v.length)) throw new Error(`${name} must be a nonempty argv array`);
  return value;
}
export function validateConfig(config, synthetic = false) {
  if (config.version !== 1) throw new Error('Unsupported config version');
  positiveInteger(config.repeats, 'repeats');
  positiveInteger(config.bootstrap_samples, 'bootstrap_samples');
  if (config.bootstrap_samples < 100 || !Number.isSafeInteger(config.seed)) throw new Error('Invalid bootstrap settings');
  const agent = config.agent;
  if (!agent || !['claude', 'codex', ...(synthetic ? ['stub'] : [])].includes(agent.family)) throw new Error('Invalid agent family');
  for (const field of ['model', 'effort', 'version']) if (typeof agent[field] !== 'string' || !agent[field].trim()) throw new Error(`Missing agent.${field}`);
  command(agent.command, 'agent.command');
  if (!['normalized', 'claude', 'codex'].includes(agent.telemetry)) throw new Error('Invalid telemetry format');
  for (const key of ['max_turns', 'max_tokens', 'seconds']) positiveInteger(config.budget?.[key], `budget.${key}`);
  for (const stage of ['setup', 'probe']) command(config.environment?.[stage], `environment.${stage}`);
  positiveInteger(config.environment?.seconds, 'environment.seconds');
  if (!synthetic && !/^[a-f0-9]{40}$/.test(config.environment?.plugin_revision ?? '')) throw new Error('Pin environment.plugin_revision to a commit SHA');
  if (config.environment.setup.some((arg) => arg.endsWith('/provision.mjs'))) {
    for (const key of ['source_path', 'ix_cli', 'ix_version']) if (typeof config.environment[key] !== 'string' || !config.environment[key]) throw new Error(`Missing environment.${key}`);
    const endpoint = new URL(config.environment.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Local provisioning requires a loopback Ix endpoint without credentials');
  }
  if (config.environment.tool_paths && (!Array.isArray(config.environment.tool_paths) || config.environment.tool_paths.some((path) => typeof path !== 'string' || !path))) throw new Error('tool_paths must be an array of directories');
  positiveInteger(config.evaluator?.seconds, 'evaluator.seconds');
  command(config.evaluator?.command, 'evaluator.command');
  if (!synthetic && (config.evaluator.kind !== 'swe-bench' || !/^[a-f0-9]{40}$/.test(config.evaluator.revision ?? ''))) throw new Error('Real runs require a revision-pinned SWE-bench evaluator');
  if (!synthetic && (typeof config.dataset_export !== 'string' || typeof config.repo_cache !== 'string')) throw new Error('Real runs require dataset_export and repo_cache');
  return config;
}

export function schedule(tasks, repeats = 2, seed = 20261013) {
  positiveInteger(repeats, 'repeats');
  const rng = random(seed), jobs = [];
  for (const task of shuffled(tasks, rng)) for (let repeat = 0; repeat < repeats; repeat++) {
    for (const arm of shuffled(['baseline', 'ix'], rng)) jobs.push({ task, repeat, arm });
  }
  return jobs;
}

export function validateProbe(probe, request) {
  if (probe.version !== 1 || probe.repo_path !== request.repo_path || probe.base_commit !== request.task.base_commit || probe.agent_version !== request.agent.version) throw new Error('Environment identity/version mismatch');
  for (const key of ['ix_available', 'mapped', 'plugin_installed', 'skills_installed', 'hooks_enabled']) {
    if (probe[key] !== (request.arm === 'ix')) throw new Error(`Invalid ${request.arm} environment: ${key}`);
  }
  if (request.arm === 'ix') {
    if (probe.mapped_commit !== request.task.base_commit || probe.plugin_revision !== request.environment.plugin_revision) throw new Error('Stale map or plugin revision mismatch');
    if (!Array.isArray(probe.evidence) || !probe.evidence.length) throw new Error('Plugin/skill/hook evidence required');
  }
  return probe;
}
