// Copyright 2026 Ix Infrastructure Inc.

/**
 * `ix locate --format json`: every shape one target's answer can take.
 *
 * Fields are only added; see miss.ts for the compatibility rule. Several
 * targets (`ix locate a b c`) wrap one of these per target in
 * `{targets: [{target, exitCode, ...answer}], summary}` (multi-target.ts).
 */

import type { ResolutionNotice } from "../resolve.js";
import type { AmbiguousCandidate, JsonDiagnostic, TextMatchesJson, UnresolvedTargetJson } from "./miss.js";

/**
 * The entity a name resolved to (exit 0). A name that matched several entities
 * (without `--strict`) or only fuzzily is answered for its top candidate, and
 * the answer carries `resolutionNotices` saying so.
 */
export interface LocateJson {
  resolvedTarget: { id: string; kind: string; name: string; path?: string };
  /** How it was chosen (`"fuzzy"` for a fuzzy match); absent for an exact match. */
  resolutionMode?: string;
  lineRange?: { start: number; end: number };
  /** The type or module holding it, for a member. */
  container?: { kind: string; name: string; id?: string };
  systemPath: Array<{ name: string; kind: string }>;
  hasMapData?: boolean;
  stale?: true;
  /** The map is deferred (CL-13): the system path is the last map's. */
  map_stale?: true;
  regions_as_of?: { map_rev: number; file_count: number };
  diagnostics: string[];
  /**
   * Present when the target was a guess: an `ambiguous_target` notice lists the
   * candidates passed over, a `fuzzy_match` notice says no name matched exactly.
   * Never an `error`; the answer still exits 0.
   */
  resolutionNotices?: ResolutionNotice[];
}

/**
 * A miss (exit 3): locate's own body, which shipped plugins read
 * `diagnostics` from, plus the shared `unresolved_target` envelope.
 */
export interface LocateMissJson extends UnresolvedTargetJson {
  resolvedTarget: null;
  resolutionMode: "none";
  systemPath: null;
  diagnostics: string[];
  didYouMean: NonNullable<UnresolvedTargetJson["didYouMean"]>;
}

/**
 * An ambiguity under `--strict` (exit 2).
 *
 * EXCEPTION to the shared envelope: the slug is in `code`, not `error`. This
 * record was never an `error` record, and readers that treat any string
 * `error` as a failure would drop its candidates (#853). Moving it to `error`
 * changes what those readers do, so it waits for an owner decision; when it
 * moves, `code` stays beside `error` for one deprecation period.
 */
export interface LocateStrictAmbiguityJson {
  code: "ambiguous_target";
  message: string;
  resolvedTarget: null;
  resolutionMode: "ambiguous";
  candidates: AmbiguousCandidate[];
  total?: number;
  truncated?: true;
  systemPath: null;
  diagnostics: JsonDiagnostic[];
}

/** A name answered with the source files that mention it (exit 0). */
export interface LocateTextMatchesJson extends TextMatchesJson {
  resolvedTarget: null;
  resolutionMode: "text";
  systemPath: null;
  diagnostics: string[];
}
