// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { captureJson, printJson } from "./format.js";
import { llmLine } from "./llm.js";
import { EXIT_AMBIGUOUS, EXIT_NOT_FOUND, EXIT_OK, runForExitCode } from "./outcome.js";

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
      const exitCode = await runForExitCode(async () => { payloads = await captureJson(() => run(target)); });
      codes.push(exitCode);
      groups.push({ target, exitCode, ...groupBody(payloads) });
    }
    printJson({ targets: groups, summary: summarize(codes) });
    return;
  }

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    if (format === "llm") console.log(llmLine("target", [["n", index + 1], ["name", target]]));
    else console.log(`${index > 0 ? "\n" : ""}${chalk.bold(`── ${target} ──`)}`);
    codes.push(await runForExitCode(() => run(target)));
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
