// Copyright 2026 Ix Infrastructure Inc.

/**
 * Exit codes for a graph command whose target did not resolve to one entity.
 *
 * A coding agent treats any non-zero exit as "the tool is broken" and goes
 * back to grep. When a miss, an ambiguous name, an unmapped directory and a
 * real failure all exited 1, the agent could not tell "retry with --pick" from
 * "give up". Each now has its own code, and the machine formats carry the
 * matching error slug (json `error`, llm `error code=`):
 *
 *   0  results
 *   1  a real error (backend down, bad argument, ...)
 *   2  ambiguous target, with --strict (*):        `ambiguous_target`
 *   3  target found nowhere: suggestions when known `unresolved_target`
 *   4  workspace not mapped                         `workspace_not_mapped`
 *
 * An error is still overhead to an agent, so two of these now answer instead
 * (exit 0): an ambiguous target is answered for its top candidate, with an
 * `ambiguous_target` notice naming what was chosen and listing the rest for
 * `--pick`; a name that is no code symbol but appears in source files is
 * answered with those files (`text_matches`, with the miss's near names; a
 * qualified name stays a miss, and so does any name under `ix context --out` /
 * `--save`, `ix diff` and `ix history`, which promise an artifact a file list
 * is not). The guess is always visible,
 * which keeps #847's rule against silent guessing. `--strict` or
 * `IX_STRICT_TARGETS=1` restores both errors (exit 2 and 3).
 *
 * (*) Two ambiguities are no tie to break, and still exit 2 without
 * `--strict`: a name only fuzzy matches carry (no entity has it; its source
 * text answers instead when there is any), and an explicit `--pick <n>` past
 * the end of the list.
 *
 * All of them are still non-zero, so a runner that only asks "did it fail?"
 * sees what it always saw. `IX_LEGACY_EXIT_CODES=1` collapses 2, 3 and 4 back
 * to 1 for an integration that compares the status against 1.
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_AMBIGUOUS = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_NOT_MAPPED = 4;

export const LEGACY_EXIT_CODES_ENV = "IX_LEGACY_EXIT_CODES";

/** `IX_STRICT_TARGETS=1`: what `--strict` does, for every graph command. */
export const STRICT_TARGETS_ENV = "IX_STRICT_TARGETS";

export type MissOutcome = "ambiguous" | "not_found" | "not_mapped";

const CODES: Record<MissOutcome, number> = {
  ambiguous: EXIT_AMBIGUOUS,
  not_found: EXIT_NOT_FOUND,
  not_mapped: EXIT_NOT_MAPPED,
};

/** One line per code, for `--help` and the agent docs. */
export const EXIT_CODES_HELP = `
Exit codes:
  0  results     2  ambiguous, with --strict: candidates listed     4  workspace not mapped
  1  error       3  not found: suggestions listed
  An ambiguous target is answered for its top candidate, with a notice listing
  the others (--pick <n> chooses one); a name found only as text in source files
  is answered with those files. --strict or ${STRICT_TARGETS_ENV}=1 makes both
  errors again (exit 2 and 3). Exit 2 without --strict: a name only fuzzy
  matches carry and no source file mentions, or a --pick past the end. ${LEGACY_EXIT_CODES_ENV}=1 makes every non-zero exit 1.`;

function envSwitch(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return !!value && value !== "0" && value !== "false" && value !== "no";
}

export function legacyExitCodes(): boolean {
  return envSwitch(LEGACY_EXIT_CODES_ENV);
}

/**
 * Whether a target that did not resolve to one entity is an error (exit 2 or
 * 3), as it was before ambiguous targets and text matches were answered.
 */
export function strictTargets(opts?: { strict?: boolean }): boolean {
  return !!opts?.strict || envSwitch(STRICT_TARGETS_ENV);
}

/**
 * The outcome a failure's error slug stands for, when it is one of the three
 * that have their own exit code; undefined for every other failure (exit 1).
 */
export function outcomeForCode(code: string): MissOutcome | undefined {
  switch (code) {
    case "ambiguous_target": return "ambiguous";
    case "unresolved_target": return "not_found";
    case "workspace_not_mapped": return "not_mapped";
    default: return undefined;
  }
}

/** The exit code for an outcome, honouring the legacy switch. */
export function exitCodeFor(outcome: MissOutcome): number {
  return legacyExitCodes() ? EXIT_ERROR : CODES[outcome];
}

/**
 * How bad a code is, for a run that answered several targets: an error beats
 * an unmapped workspace beats a miss beats an ambiguity, so the worst one
 * decides the status. Unknown non-zero codes count as errors.
 */
function severity(code: number): number {
  switch (code) {
    case EXIT_OK: return 0;
    case EXIT_AMBIGUOUS: return 1;
    case EXIT_NOT_FOUND: return 2;
    case EXIT_NOT_MAPPED: return 3;
    default: return 4;
  }
}

/** The more severe of two exit codes. */
export function worseExitCode(a: number, b: number): number {
  return severity(b) > severity(a) ? b : a;
}

function currentExitCode(): number {
  const code = process.exitCode;
  if (code === undefined || code === null || code === "") return EXIT_OK;
  const n = Number(code);
  return Number.isFinite(n) ? n : EXIT_ERROR;
}

/**
 * The worst outcome recorded since `runForOutcome` last reset it. The exit
 * code alone cannot say which outcome a target had under the legacy switch,
 * where every one of them is 1.
 */
let recorded: MissOutcome | undefined;

function worseOutcome(a: MissOutcome | undefined, b: MissOutcome | undefined): MissOutcome | undefined {
  if (!a || !b) return a ?? b;
  return CODES[b] > CODES[a] ? b : a;
}

/**
 * Record an outcome on `process.exitCode`, keeping any worse status already
 * set: one target's ambiguity must not hide another's error.
 */
export function setOutcome(outcome: MissOutcome): void {
  recorded = worseOutcome(recorded, outcome);
  process.exitCode = worseExitCode(currentExitCode(), exitCodeFor(outcome));
}

/**
 * Run one target of a multi-target command and return the exit code it alone
 * would have had, and the worst outcome it recorded, leaving
 * `process.exitCode` at the worst code so far.
 */
export async function runForOutcome(fn: () => Promise<void>): Promise<{ exitCode: number; outcome?: MissOutcome }> {
  const before = currentExitCode();
  const recordedBefore = recorded;
  process.exitCode = undefined;
  recorded = undefined;
  await fn();
  const own = currentExitCode();
  const outcome = recorded;
  process.exitCode = worseExitCode(before, own) || undefined;
  recorded = worseOutcome(recordedBefore, outcome);
  return { exitCode: own, ...(outcome ? { outcome } : {}) };
}

/** `runForOutcome`'s exit code alone. */
export async function runForExitCode(fn: () => Promise<void>): Promise<number> {
  return (await runForOutcome(fn)).exitCode;
}
