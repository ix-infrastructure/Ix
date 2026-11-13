// Copyright 2026 Ix Infrastructure Inc.

/** Shapes shared by several renderers and the commands that feed them. */

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
