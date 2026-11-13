// Copyright 2026 Ix Infrastructure Inc.

/**
 * The names this module used to define, re-exported from where they live now
 * (#950). Nothing is defined here.
 *
 * - `output/json.ts`: `--pretty`, resolution notices, `printJson`, `captureJson`.
 * - `output/slice.ts`: `--limit`/`--offset` slices and their truncation hints.
 * - `output/rows.ts`: paths, row locations and other per-row helpers.
 * - `output/types.ts`: shapes several renderers share.
 * - `output/emit.ts`: `Renderer<T>` and `emit`, which owns the `--format` switch.
 * - `render/<command>.ts`: one command's renderer.
 *
 * New code imports from those modules directly. The list stays because
 * `@ix/cli/cli/format.js` is reachable through the package's `exports`, and
 * because 49 modules import from it today.
 */

export {
  captureJson,
  noteResolutionNotices,
  printJson,
  resetResolutionNotices,
  setPrettyJson,
  takeResolutionNotices,
} from "./output/json.js";
export {
  EXPAND_MAX_EDGES,
  expandCapped,
  sliceEdgeResults,
  sliceRanked,
  truncationHint,
  type Slice,
} from "./output/slice.js";
export {
  compactTreeNode,
  confidenceColor,
  disambiguatingIds,
  lineSpan,
  locationLabel,
  relativePath,
  roundFloat,
  rowLocation,
  siteLabel,
  stripNulls,
} from "./output/rows.js";
export type { Diagnostic, DiagnosticCode, EntityRef, ResultSource } from "./output/types.js";

export { formatBugs } from "./render/bugs.js";
export { formatConflicts, renderConflictsLlm } from "./render/conflicts.js";
export { formatContext } from "./render/context.js";
export { formatDecisions } from "./render/decisions.js";
export { formatDiff, renderDiffLlm } from "./render/diff.js";
export { formatEdgeResults, renderEdgeResultsLlm, type EdgeCandidate } from "./render/edges.js";
export { formatExplain, type ExplainResult } from "./render/explain.js";
export { formatIntents } from "./render/intents.js";
export { formatLocateResults, type LocateResult } from "./render/locate.js";
export { formatNodes, renderNodesLlm } from "./render/nodes.js";
export { formatPatches, renderPatchesLlm } from "./render/patches.js";
export { formatTextResults, renderTextResultsLlm, type TextPaging, type TextResult } from "./render/text.js";
