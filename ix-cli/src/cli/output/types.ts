// Copyright 2026 Ix Infrastructure Inc.

/** Shapes shared by several renderers and the commands that feed them. */

import type {
  Claim,
  CompactScoredClaim,
  ConflictReport,
  ContextMetadata,
  DecisionReport,
  GraphNode,
  IntentReport,
  ScoredClaim,
} from "../../client/types.js";
import type { EdgeSite } from "../edge-sites.js";

export type ResultSource = "graph" | "text" | "graph+text" | "heuristic";

/** A resolved or unresolved reference to a related entity. */
export interface EntityRef {
  name: string;
  kind?: string;
  id?: string;
  resolved: boolean;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  suggestedCommand?: string;
}

export type DiagnosticCode =
  | "unresolved_call_target"
  | "parser_gap_suspected"
  | "dangling_reference_filtered"
  | "ambiguous_resolution"
  | "no_edges"
  | "text_fallback_used"
  | "stale_source"
  | "unfiltered_search"
  | "graph_degraded"
  | "candidates_truncated";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
}

// ── Rows built from what the client returns ─────────────────────────────────
//
// Each is the part of a client type (client/types.ts) a renderer reads, so a
// node or context from the client goes in as it is, a newer backend's extra
// fields ride along, and a field the client stops typing is a compile error
// here rather than an `undefined` on the screen (#941). Fields a renderer
// already falls back on are optional, so a hand-built row need not carry them.

/** Where a node's file and lines are read from (`rowLocation`). */
export interface NodeLocation {
  kind?: string;
  attrs?: Record<string, unknown>;
  provenance?: Partial<Pick<GraphNode["provenance"], "sourceUri" | "source_uri">>;
}

/** A node row (`ix search`): it prints the node's kind and id. */
export type NodeRow = NodeLocation & Pick<GraphNode, "id" | "kind"> & { name?: string };

/**
 * A row of an edge query (`/v1/expand` nodes): every field may be missing, as
 * a dangling reference has only an id. Commands add `site`, `candidate` and
 * `dispatchVia` on the way to the renderer.
 */
export interface EdgeRow extends NodeLocation {
  id?: string;
  name?: string;
  /** Where the call or import is, when the command looked it up. */
  site?: EdgeSite;
  /** Which `--all` candidate the row belongs to. */
  candidate?: number;
  /** The supertype member a dispatch row's call targets. */
  dispatchVia?: string;
}

/**
 * What `formatContext` reads from a `/v1/context` answer (`StructuredContext`):
 * the header needs the metadata, and every list may be absent. `--format json`
 * prints the whole answer, whatever else it carries.
 */
export interface ContextView {
  /** `seedEntities` is only counted. */
  metadata: Pick<ContextMetadata, "query" | "hopsExpanded" | "asOfRev"> & { seedEntities: readonly unknown[] };
  claims?: Array<Pick<ScoredClaim, "finalScore"> & { claim?: Pick<Claim, "statement"> }>;
  compactClaims?: Array<Pick<CompactScoredClaim, "score" | "field" | "path" | "lineRange">>;
  conflicts?: Array<Pick<ConflictReport, "reason" | "recommendation">>;
  decisions?: Array<Pick<DecisionReport, "title" | "rationale">>;
  intents?: Array<Pick<IntentReport, "statement" | "status">>;
}
