// Copyright 2026 Ix Infrastructure Inc.

/** Instance-log markers for evaluation errors the official run report scores as unresolved.
 * Any other error (image build, Docker, harness crash) stays fatal.
 */
export const EVALUATION_ERRORS = { patch_apply_failed: '>>>>> Patch Apply Failed', test_timeout: 'Test timed out' };

export function evaluationError(log) {
  for (const [reason, marker] of Object.entries(EVALUATION_ERRORS)) if (log.includes(marker)) return reason;
  throw new Error('Official evaluation errored without a patch-apply or test-timeout marker; inspect the harness logs');
}

/** Check official task reports or the harness's explicit empty-patch/error summary. */
export function checkResolution(report, receipt, instanceId, patch) {
  if (receipt.report_kind === 'empty-patch-summary') {
    if (patch !== '' || receipt.resolved !== false || !Array.isArray(report.empty_patch_ids) || !report.empty_patch_ids.includes(instanceId)) throw new Error('Invalid official empty-patch evidence');
  } else if (receipt.report_kind === 'error-summary') {
    if (patch === '' || receipt.resolved !== false || !Object.hasOwn(EVALUATION_ERRORS, receipt.evaluation_error ?? '') || !Array.isArray(report.error_ids) || !report.error_ids.includes(instanceId)) throw new Error('Invalid official evaluation-error evidence');
  } else if (report[instanceId]?.resolved !== receipt.resolved) {
    throw new Error('Resolution differs from official report');
  }
}
