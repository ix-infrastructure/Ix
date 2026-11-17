// Copyright 2026 Ix Infrastructure Inc.

/**
 * The `--format json` shapes every command can print around or instead of its
 * own answer: the failure record and the multi-target grouping.
 *
 * Like the other types here, these are a public interface the editor plugins
 * read (contracts/fields.ts publishes their paths). Fields are only added.
 */

/**
 * A failure answered on stdout (`emitErrorRecord` in errors.ts, and a thrown
 * target in a multi-target run): the `error` slug and `message`, `dir` for a
 * workspace that is not mapped, and `next` when there is a next step.
 */
export interface ErrorRecordJson {
  error: string;
  message: string;
  dir?: string;
  next?: string;
}

/** The per-bucket target counts of a multi-target run (multi-target.ts). */
export interface TargetSummaryJson {
  total: number;
  ok: number;
  ambiguous: number;
  notFound: number;
  notMapped: number;
  failed: number;
}

/** One target's group: its name and code, then its answer A or its failure. */
export type TargetGroupJson<A> = { target: string; exitCode: number } & (A | ErrorRecordJson);

/** `ix <command> a b --format json`: one group per target, then the summary. */
export interface MultiTargetJson<A> {
  targets: TargetGroupJson<A>[];
  summary: TargetSummaryJson;
}
