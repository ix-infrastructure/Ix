// Copyright 2026 Ix Infrastructure Inc.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execute } from './process.mjs';
import { sha256 } from './manifest.mjs';
import { checkResolution, evaluationError } from './evaluation.mjs';

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (request.synthetic || request.evaluator.kind !== 'swe-bench') throw new Error('Official evaluator requires real SWE-bench tasks');
const { evaluator, task, run_path } = request;
if (!evaluator.harness_path) throw new Error('Set evaluator.harness_path to a pinned local SWE-bench checkout');
const revision = (await execute(['git', '-C', evaluator.harness_path, 'rev-parse', 'HEAD'], { seconds: 10 })).stdout.trim();
if (revision !== evaluator.revision) throw new Error('SWE-bench revision mismatch');
const dirty = await execute(['git', '-C', evaluator.harness_path, 'status', '--porcelain', '--untracked-files=no'], { seconds: 10 });
if (dirty.stdout) throw new Error('SWE-bench evaluator has tracked modifications');
const python = evaluator.python ?? 'python';
const runId = 'agent-eval';
// Force imports from the pinned checkout rather than a different pip installation.
await execute([python, '-m', 'swebench.harness.run_evaluation', '--dataset_name', request.dataset_export,
  '--predictions_path', join(run_path, 'prediction.json'), '--instance_ids', task.instance_id,
  '--run_id', runId, '--max_workers', '1', '--timeout', String(evaluator.test_seconds ?? 1800)], {
  cwd: run_path, seconds: evaluator.seconds,
  env: { ...process.env, PYTHONPATH: evaluator.harness_path }, log: join(run_path, 'official-harness'),
});
const instanceLogs = join(run_path, 'logs', 'run_evaluation', runId, 'agent-eval', task.instance_id);
const patch = readFileSync(join(run_path, 'prediction.patch'), 'utf8');
let reportPath = join(instanceLogs, 'report.json');
let reportKind = 'task', failure = {};
if (!existsSync(reportPath)) {
  // No task report: the run summary lists the instance as an empty patch or an evaluation error.
  reportPath = join(run_path, 'agent-eval.agent-eval.json');
  reportKind = patch === '' ? 'empty-patch-summary' : 'error-summary';
  if (reportKind === 'error-summary') {
    const log = readFileSync(join(instanceLogs, 'run_instance.log'), 'utf8');
    failure = { evaluation_error: evaluationError(log), log_sha256: sha256(log) };
  }
}
const text = readFileSync(reportPath, 'utf8'), report = JSON.parse(text);
const resolved = reportKind === 'task' ? report[task.instance_id]?.resolved : false;
if (typeof resolved !== 'boolean') throw new Error('Official report absent or missing resolution');
const receipt = { instance_id: task.instance_id, resolved, evaluator: 'swe-bench', revision, report_kind: reportKind, report_path: reportPath, report_sha256: sha256(text), ...failure };
checkResolution(report, receipt, task.instance_id, patch);
console.log(JSON.stringify(receipt));
