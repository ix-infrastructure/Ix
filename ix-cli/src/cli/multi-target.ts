// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import {
  CliUsageError, WorkspaceNotMappedError, backendUnreachableError, formatFetchError, isBackendUnreachable,
  parseBackendError,
} from "./errors.js";
import { captureJson, printJson } from "./format.js";
import { llmError, llmLine } from "./llm.js";
import { EXIT_AMBIGUOUS, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_OK, exitCodeFor, runForExitCode } from "./outcome.js";

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

  const codes: number[] = [];
  if (format === "json") {
    const groups: Record<string, unknown>[] = [];
    for (const target of targets) {
      let payloads: unknown[] = [];
      let failure: TargetFailure | undefined;
      const exitCode = await runForExitCode(async () => {
        try {
          payloads = await captureJson(() => run(target));
        } catch (err) {
          failure = targetFailure(err);
          process.exitCode = failure.exitCode;
        }
      });
      codes.push(exitCode);
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
    codes.push(await runForExitCode(async () => {
      try {
        await run(target);
      } catch (err) {
        const failure = targetFailure(err);
        process.exitCode = failure.exitCode;
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
      ["failed", summary.failed || undefined],
    ]));
  }
}

interface TargetFailure { code: string; message: string; next?: string; exitCode: number }

/**
 * What one target's thrown error says, in the slugs and codes the
 * process-wide boundary (`renderCliError`) would use, without exiting.
 * A usage error is rethrown: it is the same for every target.
 */
function targetFailure(err: unknown): TargetFailure {
  if (err instanceof CliUsageError) throw err;
  if (err instanceof WorkspaceNotMappedError) {
    return { code: err.code, message: err.summary, next: err.hint, exitCode: exitCodeFor("not_mapped") };
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

function summarize(codes: readonly number[]) {
  const ok = codes.filter((c) => c === EXIT_OK).length;
  const ambiguous = codes.filter((c) => c === EXIT_AMBIGUOUS).length;
  const notFound = codes.filter((c) => c === EXIT_NOT_FOUND).length;
  return { total: codes.length, ok, ambiguous, notFound, failed: codes.length - ok - ambiguous - notFound };
}
