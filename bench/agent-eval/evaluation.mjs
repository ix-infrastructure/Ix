// Copyright 2026 Ix Infrastructure Inc.

/** Check official task reports or the harness's explicit empty-patch summary. */
export function checkResolution(report, receipt, instanceId, patch) {
  if (receipt.report_kind === 'empty-patch-summary') {
    if (patch !== '' || receipt.resolved !== false || !Array.isArray(report.empty_patch_ids) || !report.empty_patch_ids.includes(instanceId)) throw new Error('Invalid official empty-patch evidence');
  } else if (report[instanceId]?.resolved !== receipt.resolved) {
    throw new Error('Resolution differs from official report');
  }
}
