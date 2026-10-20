// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import {
  CliUsageError, WorkspaceNotMappedError, backendUnreachableError, formatFetchError, isBackendUnreachable,
  parseBackendError,
} from "./errors.js";
import { captureJson, printJson } from "./format.js";
import { llmError, llmLine } from "./llm.js";
import {
  EXIT_AMBIGUOUS, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_NOT_MAPPED, EXIT_OK, exitCodeFor, runForOutcome, setOutcome,
  type MissOutcome,
} from "./outcome.js";

/**
 * Run a one-target command body for each of several targets and group the
 * answers per target: `ix callers a b c` is one round trip instead of three.
 *
 * One target is the command exactly as before. With several:
 *
 *   json  one object, `{ targets: [{ target, exitCode, ...answer }], summary }`,
 *         where `answer` is what the command prints for that target alone
 *   llm   a `target n=<i> name=<t>` record before each target's own records,
 *         then a `targets` summary record
 *   text  a header line per target
 *
 * The process exits with the worst target's code (outcome.ts): every target
 * answered is 0, and one miss among answers is still that miss's code, so a
 * caller that only reads the status is never told a partial answer is whole.
 *
 * A target whose body throws (a backend error mid-answer) is reported in its
 * own group with its own code, and the remaining targets still run; only a
 * usage error, which is about the flags rather than any one target, ends the
 * run at the process-wide boundary as before.
 */
export async function runPerTarget(
  targets: readonly string[],
  format: string,
  run: (target: string) => Promise<void>,
): Promise<void> {
  if (targets.length === 1) {
    await run(targets[0]);
    return;
  }

  const codes: TargetCode[] = [];
  if (format === "json") {
    const groups: Record<string, unknown>[] = [];
    for (const target of targets) {
      let payloads: unknown[] = [];
      let failure: TargetFailure | undefined;
      const own = await runForOutcome(async () => {
        try {
          payloads = await captureJson(() => run(target));
        } catch (err) {
          failure = targetFailure(err);
          recordFailure(failure);
        }
      });
      codes.push(own);
      const exitCode = own.exitCode;
      groups.push(failure
        ? { target, exitCode, error: failure.code, message: failure.message, ...(failure.next ? { next: failure.next } : {}) }
        : { target, exitCode, ...groupBody(payloads) });
    }
    printJson({ targets: groups, summary: summarize(codes) });
    return;
  }

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (format === "llm") console.log(llmLine("target", [["n", index + 1], ["name", target]]));
    else console.log(`${index > 0 ? "\n" : ""}${chalk.bold(`── ${target} ──`)}`);
    codes.push(await runForOutcome(async () => {
      try {
        await run(target);
      } catch (err) {
        const failure = targetFailure(err);
        recordFailure(failure);
        if (format === "llm") {
          console.log(llmError(failure.code, failure.message, failure.next ? [["hint", failure.next]] : []));
        } else {
          process.stderr.write(chalk.red(`Error: ${failure.message}\n`));
          if (failure.next) process.stderr.write(chalk.dim(`${failure.next}\n`));
        }
      }
    }));
  }
  if (format === "llm") {
    const summary = summarize(codes);
    console.log(llmLine("targets", [
      ["total", summary.total], ["ok", summary.ok],
      ["ambiguous", summary.ambiguous || undefined], ["not_found", summary.notFound || undefined],
      ["not_mapped", summary.notMapped || undefined], ["failed", summary.failed || undefined],
    ]));
  }
}

interface TargetFailure { code: string; message: string; next?: string; exitCode: number; outcome?: MissOutcome }

type TargetCode = { exitCode: number; outcome?: MissOutcome };

/** A thrown target's status, recorded as its outcome when it has one. */
function recordFailure(failure: TargetFailure): void {
  if (failure.outcome) setOutcome(failure.outcome);
  else process.exitCode = failure.exitCode;
}

/**
 * What one target's thrown error says, in the slugs and codes the
 * process-wide boundary (`renderCliError`) would use, without exiting.
 * A usage error is rethrown: it is the same for every target.
 */
function targetFailure(err: unknown): TargetFailure {
  if (err instanceof CliUsageError) throw err;
  if (err instanceof WorkspaceNotMappedError) {
    return { code: err.code, message: err.summary, next: err.hint, exitCode: exitCodeFor("not_mapped"), outcome: "not_mapped" };
  }
  if (isBackendUnreachable(err)) {
    const unreachable = backendUnreachableError();
    return { code: unreachable.error, message: unreachable.message, next: unreachable.next, exitCode: EXIT_ERROR };
  }
  const raw = (err as { message?: unknown } | null | undefined)?.message;
  const structured = typeof raw === "string" ? parseBackendError(raw) : null;
  if (structured) {
    return { code: structured.error, message: structured.message, next: structured.next, exitCode: EXIT_ERROR };
  }
  const message = err === null || err === undefined ? String(err) : formatFetchError(err);
  return { code: "cli_error", message, exitCode: EXIT_ERROR };
}

/** One JSON object per target as-is; anything else under `result(s)`. */
function groupBody(payloads: unknown[]): Record<string, unknown> {
  if (payloads.length === 1) {
    const only = payloads[0];
    if (only !== null && typeof only === "object" && !Array.isArray(only)) return only as Record<string, unknown>;
    return { result: only };
  }
  return payloads.length === 0 ? {} : { results: payloads };
}

/**
 * Which summary bucket a target falls in. By its code, or, when the legacy
 * switch made a miss exit 1, by the outcome it recorded, so the summary says
 * the same with or without `IX_LEGACY_EXIT_CODES`.
 */
function bucketOf({ exitCode, outcome }: TargetCode): "ok" | MissOutcome | "failed" {
  switch (exitCode) {
    case EXIT_OK: return "ok";
    case EXIT_AMBIGUOUS: return "ambiguous";
    case EXIT_NOT_FOUND: return "not_found";
    case EXIT_NOT_MAPPED: return "not_mapped";
  }
  return outcome && exitCode === EXIT_ERROR && exitCodeFor(outcome) === EXIT_ERROR ? outcome : "failed";
}

function summarize(codes: readonly TargetCode[]) {
  const buckets = codes.map(bucketOf);
  const count = (b: ReturnType<typeof bucketOf>) => buckets.filter((x) => x === b).length;
  return {
    total: codes.length, ok: count("ok"), ambiguous: count("ambiguous"), notFound: count("not_found"),
    notMapped: count("not_mapped"), failed: count("failed"),
  };
}
