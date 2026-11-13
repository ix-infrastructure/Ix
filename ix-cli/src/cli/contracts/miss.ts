// Copyright 2026 Ix Infrastructure Inc.

/**
 * The `--format json` records for a target that did not resolve to one entity.
 *
 * These shapes are a public interface: the editor plugins, `ix mcp` and user
 * scripts parse them. Fields are only ever added. A rename or a removal keeps
 * the old field for one deprecation period first (skills/ix/references/
 * output-formats.md, "JSON compatibility"). Build a record through the
 * functions here, not as an inline literal, so the type checker sees a dropped
 * or renamed key.
 *
 * Every miss and every unanswered ambiguity shares one envelope: a string
 * `error` slug and a `message`. The exit code says the same thing (outcome.ts).
 * The two exceptions, `ix locate --strict`'s ambiguity and `ix read`'s
 * ambiguity, have their own types in `locate.ts` and `read.ts` here.
 */

import type { AmbiguousResult, Suggestion } from "../resolve.js";
import type { TargetCandidate } from "../target-suggestions.js";
import type { TextMatch } from "../text-matches.js";

/** The `error` slugs a target miss carries (json `error`, llm `error code=`). */
export type MissCode = "unresolved_target" | "ambiguous_target";

/** What every miss and ambiguity record carries. */
export interface MissEnvelope<C extends MissCode = MissCode> {
  error: C;
  message: string;
}

/** One `{code, message}` diagnostic, as the ambiguity records carry them. */
export interface JsonDiagnostic {
  code: string;
  message: string;
}

/** A candidate of an ambiguous name, for `--pick <n>` (1-based). */
export type AmbiguousCandidate = AmbiguousResult["candidates"][number];

/** A name found nowhere: exit 3. */
export interface UnresolvedTargetJson extends MissEnvelope<"unresolved_target"> {
  /** Every name asked for, when the target was a list of alternatives. */
  targets?: string[];
  /** Why it missed, when that is more than "no such name" (`file_not_in_graph`, ...). */
  reason?: string;
  /** The source files the reason is about. */
  files?: string[];
  /** The resolver's near names in the graph. */
  suggestions?: Suggestion[];
  /** The bounded probe's did-you-mean names. Never the ambiguity `candidates`. */
  didYouMean?: TargetCandidate[];
  /** The graph's health, on an empty or degraded graph. */
  graph?: Record<string, unknown>;
}

/** A name several entities share, not answered: exit 2. */
export interface AmbiguousTargetJson extends MissEnvelope<"ambiguous_target"> {
  candidates: AmbiguousCandidate[];
  /** How many tied; the list shows at most 8. */
  total?: number;
  /** `total` is a lower bound. */
  truncated?: true;
  diagnostics: JsonDiagnostic[];
}

/**
 * A name that is no code symbol but appears in source files: answered (exit
 * 0) with those files. No `error`, so no reader drops the rows; `note` says
 * what it is. A type alias, not an interface, so it still reads as the
 * `Record<string, unknown>` `textMatchesJson` used to return.
 */
export type TextMatchesJson = {
  note: "text_matches";
  target: string;
  reason?: string;
  message: string;
  /** The probe's own message, when it says to run `ix map`. */
  detail?: string;
  textMatches: TextMatch[];
  shown: number;
  total: number;
  suggestions?: Suggestion[];
  didYouMean?: TargetCandidate[];
};

/** The parts of a miss a command knows beyond its message. */
export interface UnresolvedDetail {
  targets?: string[];
  reason?: string;
  files?: string[];
  suggestions?: Suggestion[];
  didYouMean?: TargetCandidate[];
  graph?: Record<string, unknown>;
}

/** The `unresolved_target` record. Empty lists are left out, as they always were. */
export function unresolvedTargetJson(message: string, detail: UnresolvedDetail = {}): UnresolvedTargetJson {
  return {
    error: "unresolved_target",
    message,
    ...(detail.targets ? { targets: detail.targets } : {}),
    ...(detail.reason ? { reason: detail.reason } : {}),
    ...(detail.files?.length ? { files: detail.files } : {}),
    ...(detail.suggestions?.length ? { suggestions: detail.suggestions } : {}),
    ...(detail.didYouMean ? { didYouMean: detail.didYouMean } : {}),
    ...(detail.graph ? { graph: detail.graph } : {}),
  };
}

/** The `ambiguous_target` record, with the candidates to pick from. */
export function ambiguousTargetJson(target: string, result: AmbiguousResult): AmbiguousTargetJson {
  return {
    error: "ambiguous_target",
    message: ambiguousTargetMessage(target),
    candidates: result.candidates,
    ...(result.total != null ? { total: result.total } : {}),
    ...(result.truncated ? { truncated: true as const } : {}),
    diagnostics: result.diagnostics ?? [],
  };
}

export function ambiguousTargetMessage(target: string): string {
  return `Ambiguous symbol "${target}".`;
}
