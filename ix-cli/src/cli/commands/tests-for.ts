// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { printJson } from "../format.js";
import { llmLine } from "../llm.js";
import { parsePickOption, STRICT_TARGET_HELP } from "../options.js";
import { resolveFileOrReport } from "../resolve.js";
import { gatherTestsFor } from "../tests-for.js";
import { inferTestCommand } from "../test-command.js";

export function registerTestsForCommand(program: Command): void {
  program
    .command("tests-for <symbol>")
    .description("Rank tests that statically reach a symbol or file through TESTS edges")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict target to a file path substring")
    .option("--pick <n>", "Pick Nth candidate (1-based)", parsePickOption)
    .option("--strict", STRICT_TARGET_HELP)
    .option("--limit <n>", "Max tests to show", "10")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText(
      "after",
      "\nStatic evidence, not runtime coverage. Searches up to 3 edges and 40 nodes.\nRemap with ix map to populate TESTS edges. Commands are suggestions from local runner configs.",
    )
    .action(
      async (
        symbol: string,
        opts: {
          kind?: string;
          path?: string;
          pick?: number;
          strict?: boolean;
          limit: string;
          format: string;
        },
      ) => {
        const client = createClient({ query: true });
        const target = await resolveFileOrReport(client, symbol, opts, opts.format);
        if (!target) return;
        const result = await gatherTestsFor(client, target);
        const limit = Number(opts.limit);
        const tests = result.tests
          .slice(0, limit === 0 ? undefined : limit)
          .map((test) => ({ ...test, command: inferTestCommand(resolveWorkspaceRoot(), test) }));
        const truncated = result.truncated || tests.length < result.tests.length;
        if (opts.format === "json") {
          printJson({ target: { id: target.id, name: target.name }, tests, truncated });
        } else {
          for (const test of tests)
            console.log(
              llmLine("test", {
                id: test.id,
                at: test.path ? `${test.path}:${test.line ?? 1}` : undefined,
                reaches: test.reaches,
                confidence: Number(test.confidence.toFixed(3)),
                command: test.command,
              }),
            );
          if (!tests.length)
            console.log(
              "tests-for: no static test evidence; run ix map if the graph predates TESTS edges.",
            );
          if (truncated)
            console.log("tests-for: results limited; narrow the target or raise --limit.");
        }
      },
    );
}
