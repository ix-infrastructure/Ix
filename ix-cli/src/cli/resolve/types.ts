// Copyright 2026 Ix Infrastructure Inc.

/**
 * The shapes a target resolution produces. Data only: no module here talks to
 * the backend, reads the environment or prints, so the scoring and picking
 * modules beside it can share these types and stay pure.
 */

import type { GraphHealth } from "../graph-health.js";
import type { TargetCandidate } from "../target-suggestions.js";
import type { TextMatch } from "../text-matches.js";

export type ResolutionMode = "exact" | "preferred-kind" | "scored" | "ambiguous" | "heuristic" | "fuzzy";

export interface ResolvedEntity {
  id: string;
  kind: string;
  name: string;
  path?: string;
  resolutionMode: ResolutionMode;
}

export interface AmbiguousResult {
  resolutionMode: "ambiguous";
  /**
   * `container`: the type that holds the candidate (its CONTAINS parent, never
   * a file), when the graph names one. Added after the list is ranked.
   */
  candidates: Array<{ id: string; name: string; kind: string; path?: string; line?: number; score?: number; rank?: number; container?: string }>;
  diagnostics?: Array<{ code: string; message: string }>;
  /** How many candidates tied (the candidate list shows at most 8 of them). */
  total?: number;
  /** True when the search window came back full, so `total` is a lower bound. */
  truncated?: boolean;
}

/**
 * A resolved target that was a guess worth reporting. The result still resolves
 * (exit 0); the notice says which candidates were passed over, or that the
 * match was fuzzy. It is never an `error`, so plugin runners see no failure.
 */
export interface ResolutionNotice {
  code: "ambiguous_target" | "fuzzy_match";
  target: string;
  message: string;
  chosen: { id: string; name: string; kind: string; path?: string };
  candidates: AmbiguousResult["candidates"];
  total: number;
  truncated?: boolean;
  /** Extra diagnostics, e.g. `pick_out_of_range`. */
  diagnostics?: Array<{ code: string; message: string }>;
}

/**
 * A near-miss worth naming when a target does not resolve.
 *
 * A miss is a dead end for the caller: an agent that gets "no entity found"
 * spends its next turn running `ix search` by hand, and a person retypes the
 * name. The candidates are already in hand (or one search away), so they are
 * cheaper to hand over than to make the caller ask for.
 */
export interface Suggestion {
  id: string;
  name: string;
  kind: string;
  path?: string;
}

export type ResolveResult =
  | { resolved: true; entity: ResolvedEntity; hiddenTestCount?: number; notices?: ResolutionNotice[] }
  | { resolved: false; ambiguous: true; result: AmbiguousResult; hiddenTestCount?: number }
  | {
      resolved: false;
      ambiguous: false;
      hiddenTestCount?: number;
      suggestions?: Suggestion[];
      /** Did-you-mean names from the bounded probe; never the ambiguity `candidates`. */
      didYouMean?: TargetCandidate[];
      retryCommand?: string;
      /**
       * Why it missed, when that is more than "no such name": a file target
       * that is on disk but not in the graph (`file_not_in_graph`), or on
       * neither (`file_not_found`). The message then replaces the generic one.
       */
      reason?: string;
      message?: string;
      /** For a symbol miss with a `symbol_*` reason: the files the name appears in. */
      files?: string[];
      /** Every file the miss probe found the name in, with its first matching line. */
      matches?: TextMatch[];
      /** The probe says `ix map` would fix the miss. */
      remap?: boolean;
      /** Set by the reporter's caller when the graph itself is empty or degraded. */
      graph?: GraphHealth;
    };
