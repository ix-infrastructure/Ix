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

/**
 * One overload of an overloaded method: a graph node of its own (#1139).
 * `signature` is its erased parameter list as ingest wrote it (`String,int`,
 * `` for none); absent when the node does not say.
 */
export interface OverloadRef {
  id: string;
  line?: number;
  signature?: string;
}

export interface ResolvedEntity {
  id: string;
  kind: string;
  name: string;
  /**
   * The target as the user qualified it (`Class.method`), for headers only.
   * `name` stays the entity's own name: members are matched by it.
   */
  displayName?: string;
  path?: string;
  resolutionMode: ResolutionMode;
  /**
   * Set when the name is an overloaded method: every overload among the
   * candidates, this entity (the first) first, the rest in source order. A
   * command that shows the definition answers for this entity alone; one that
   * answers from graph edges answers for all of them (overload-group.ts), as
   * it did while they were one node. Absent for a target given as an id: an
   * id names one node.
   */
  overloads?: OverloadRef[];
}

export interface AmbiguousResult {
  resolutionMode: "ambiguous";
  /**
   * `container`: the type that holds the candidate (its CONTAINS parent, never
   * a file), when the graph names one. Added after the list is ranked.
   * `overloads`: the candidate is an overloaded method, listed once; these are
   * all of its overloads (see ResolvedEntity.overloads).
   */
  candidates: Array<{ id: string; name: string; kind: string; path?: string; line?: number; score?: number; rank?: number; container?: string; overloads?: OverloadRef[] }>;
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
 *
 * `overloaded_target` is not a guess among candidates: the name is one method
 * with several overloads. `answered` says how many of them the answer is for:
 * 1, the first, from a command that shows the definition; all of them (up to
 * a cap) from a command that answers from graph edges. Its `candidates` is
 * the one row (what `--pick` counts) and `overloads` lists every overload
 * with its id, which is how one is addressed alone.
 */
export interface ResolutionNotice {
  code: "ambiguous_target" | "fuzzy_match" | "overloaded_target";
  target: string;
  message: string;
  chosen: { id: string; name: string; kind: string; path?: string };
  candidates: AmbiguousResult["candidates"];
  total: number;
  truncated?: boolean;
  /** `overloaded_target` only: every overload of the chosen method, the chosen one first. */
  overloads?: OverloadRef[];
  /** `overloaded_target` only: how many of `overloads`, from the first, the answer is for. */
  answered?: number;
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
