// Copyright 2026 Ix Infrastructure Inc.

import { METRICS } from './metrics.mjs';
import { positiveInteger } from './manifest.mjs';

export function random(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error('seed must be an integer');
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let x = state; x = Math.imul(x ^ x >>> 15, x | 1); x ^= x + Math.imul(x ^ x >>> 7, x | 61); return ((x ^ x >>> 14) >>> 0) / 4294967296; };
}
export function shuffled(items, rng) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
export const median = (values) => { const v = [...values].sort((a, b) => a - b); return (v[Math.floor(v.length / 2)] + v[Math.floor((v.length - 1) / 2)]) / 2; };
const quantile = (values, p) => {
  const v = [...values].sort((a, b) => a - b), pos = (v.length - 1) * p, lo = Math.floor(pos);
  return v[lo] + (v[Math.ceil(pos)] - v[lo]) * (pos - lo);
};

/** Paired task-cluster bootstrap: repeats stay within their task when resampled. */
export function summarize(runs, { samples = 10000, seed = 20261013 } = {}) {
  positiveInteger(samples, 'samples');
  if (samples < 100) throw new Error('At least 100 bootstrap samples required');
  const tasks = new Map();
  for (const run of runs) {
    if (!['baseline', 'ix'].includes(run.arm) || !Number.isSafeInteger(run.repeat) || run.repeat < 0) throw new Error('Invalid run identity');
    for (const metric of METRICS) {
      if (run[metric] === null && run.usage_complete === false && ['input_tokens', 'output_tokens', 'cached_tokens'].includes(metric)) continue;
      if (!Number.isFinite(run[metric]) || run[metric] < 0) throw new Error(`Invalid metric ${metric}`);
    }
    if (![0, 1].includes(run.resolved)) throw new Error('Invalid resolution');
    const arms = tasks.get(run.instance_id) ?? { baseline: new Map(), ix: new Map() };
    if (arms[run.arm].has(run.repeat)) throw new Error('Duplicate run');
    arms[run.arm].set(run.repeat, run); tasks.set(run.instance_id, arms);
  }
  if (!tasks.size) throw new Error('No runs');
  const perTask = [], groups = [];
  let expectedRepeats;
  for (const [instance_id, arms] of tasks) {
    const repeats = [...arms.baseline.keys()].sort((a, b) => a - b);
    if (!repeats.length || repeats.length !== arms.ix.size || repeats.some((r, i) => r !== i || !arms.ix.has(r))) throw new Error('Unpaired or incomplete arms');
    expectedRepeats ??= repeats.length;
    if (repeats.length !== expectedRepeats) throw new Error('Unequal task weighting');
    const group = { baseline: [...arms.baseline.values()], ix: [...arms.ix.values()] };
    groups.push(group);
    perTask.push({ instance_id, metrics: Object.fromEntries(METRICS.map((m) => {
      const b = group.baseline.map((r) => r[m]), x = group.ix.map((r) => r[m]);
      const baseline = b.includes(null) ? null : mean(b), ix = x.includes(null) ? null : mean(x);
      return [m, { baseline, ix, difference: baseline === null || ix === null ? null : ix - baseline }];
    })) });
  }
  const rng = random(seed), metrics = {};
  for (const metric of METRICS) {
    const paired = groups.filter((g) => [...g.baseline, ...g.ix].every((r) => r[metric] !== null));
    const values = (arm, selected = paired) => selected.flatMap((g) => g[arm].map((r) => r[metric]));
    const bootMean = [], bootMedian = [];
    for (let i = 0; i < samples && paired.length; i++) {
      const selected = paired.map(() => paired[Math.floor(rng() * paired.length)]);
      const b = values('baseline', selected), x = values('ix', selected);
      bootMean.push(mean(x) - mean(b)); bootMedian.push(median(x) - median(b));
    }
    const b = values('baseline'), x = values('ix');
    metrics[metric] = {
      coverage: { paired_tasks: paired.length, total_tasks: groups.length, baseline_observed_runs: groups.flatMap((g) => g.baseline).filter((r) => r[metric] !== null).length, ix_observed_runs: groups.flatMap((g) => g.ix).filter((r) => r[metric] !== null).length },
      baseline: { mean: b.length ? mean(b) : null, median: b.length ? median(b) : null }, ix: { mean: x.length ? mean(x) : null, median: x.length ? median(x) : null },
      mean_difference: { estimate: b.length ? mean(x) - mean(b) : null, ci90: bootMean.length ? [quantile(bootMean, .05), quantile(bootMean, .95)] : null },
      median_difference: { estimate: b.length ? median(x) - median(b) : null, ci90: bootMedian.length ? [quantile(bootMedian, .05), quantile(bootMedian, .95)] : null },
    };
  }
  const errorsByArm = { baseline: Object.create(null), ix: Object.create(null) };
  for (const run of runs) for (const [code, count] of Object.entries(run.ix_errors_by_code ?? {})) errorsByArm[run.arm][code] = (errorsByArm[run.arm][code] ?? 0) + count;
  return { tasks: tasks.size, repeats: expectedRepeats, bootstrap: { samples, seed, confidence: .90, unit: 'task', difference: 'ix minus baseline' }, metrics, per_task: perTask, ix_errors_by_code: errorsByArm, terminations: Object.fromEntries(['baseline', 'ix'].map((arm) => [arm, runs.filter((r) => r.arm === arm).reduce((counts, r) => { const reason = r.termination ?? 'completed'; counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {})])) };
}

export function markdown(report, synthetic = false) {
  const fmt = (v) => v === null ? 'unavailable' : Number(v.toFixed(3));
  const diff = (d) => d.ci90 === null ? 'unavailable' : `${fmt(d.estimate)} [${d.ci90.map(fmt).join(', ')}]`;
  const lines = ['# Agent evaluation', '', synthetic ? '**Synthetic dry run — not product evidence.**' : 'Paired agent evaluation; no causal or product claim is inferred automatically.', '', `${report.tasks} tasks × ${report.repeats} repeats per arm. Differences are ix minus baseline. Percentile 90% CIs resample whole tasks; repeats are clustered.`, '', '| Metric | Baseline mean / median | Ix mean / median | Mean difference [90% CI] | Median difference [90% CI] | Paired tasks used |', '|---|---:|---:|---:|---:|---:|'];
  for (const [name, m] of Object.entries(report.metrics)) lines.push(`| ${name} | ${fmt(m.baseline.mean)} / ${fmt(m.baseline.median)} | ${fmt(m.ix.mean)} / ${fmt(m.ix.median)} | ${diff(m.mean_difference)} | ${diff(m.median_difference)} | ${m.coverage.paired_tasks}/${m.coverage.total_tasks} |`);
  lines.push('', 'Resolution is a fraction (1 = resolved). Small sets can have degenerate intervals; these intervals do not cover model drift or environment bias.', '', '## Per-task means and differences', '', '| Task | Metric | Baseline | Ix | Difference |', '|---|---|---:|---:|---:|');
  for (const task of report.per_task) for (const [metric, m] of Object.entries(task.metrics)) lines.push(`| ${task.instance_id} | ${metric} | ${fmt(m.baseline)} | ${fmt(m.ix)} | ${fmt(m.difference)} |`);
  lines.push('', 'Missing usage is unavailable, never zero. Per-metric summaries/CIs use complete paired tasks only; missingness can bias usage comparisons. Resolution includes every scheduled task. Interrupted tool/turn counts are observed lower bounds.', '', '## Termination outcomes', '', '```json', JSON.stringify(report.terminations, null, 2), '```');
  lines.push('', 'Per-task differences are descriptive; uncertainty is reported in the aggregate table.', '', '## Ix errors by code', '', '```json', JSON.stringify(report.ix_errors_by_code, null, 2), '```', '');
  return lines.join('\n');
}
