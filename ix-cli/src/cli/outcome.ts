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
 *   2  ambiguous target: candidates returned       `ambiguous_target`
 *   3  target not found: suggestions when known     `unresolved_target`
 *   4  workspace not mapped                         `workspace_not_mapped`
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

export type MissOutcome = "ambiguous" | "not_found" | "not_mapped";

const CODES: Record<MissOutcome, number> = {
  ambiguous: EXIT_AMBIGUOUS,
  not_found: EXIT_NOT_FOUND,
  not_mapped: EXIT_NOT_MAPPED,
};

/** One line per code, for `--help` and the agent docs. */
export const EXIT_CODES_HELP = `
Exit codes:
  0  results     2  ambiguous: candidates listed      4  workspace not mapped
  1  error       3  not found: suggestions listed
  ${LEGACY_EXIT_CODES_ENV}=1 makes every non-zero exit 1.`;

export function legacyExitCodes(): boolean {
  const value = process.env[LEGACY_EXIT_CODES_ENV]?.trim().toLowerCase();
  return !!value && value !== "0" && value !== "false" && value !== "no";
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
 * Record an outcome on `process.exitCode`, keeping any worse status already
 * set: one target's ambiguity must not hide another's error.
 */
export function setOutcome(outcome: MissOutcome): void {
  process.exitCode = worseExitCode(currentExitCode(), exitCodeFor(outcome));
}

/**
 * Run one target of a multi-target command and return the exit code it alone
 * would have had, leaving `process.exitCode` at the worst code so far.
 */
export async function runForExitCode(fn: () => Promise<void>): Promise<number> {
  const before = currentExitCode();
  process.exitCode = undefined;
  await fn();
  const own = currentExitCode();
  process.exitCode = worseExitCode(before, own) || undefined;
  return own;
}
