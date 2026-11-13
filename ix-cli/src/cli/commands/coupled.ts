// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { printJson, relativePath } from "../format.js";
import { coupledFor, readCoupling } from "../git-coupling.js";
import { couplingLines, targetCoupling } from "../coupling-output.js";
import { resolveFileOrReport } from "../resolve.js";
import { parsePickOption, STRICT_TARGET_HELP } from "../options.js";
import { llmLine } from "../llm.js";

export function registerCoupledCommand(program: Command): void {
  program
    .command("coupled <target>")
    .description("Rank files or symbols that change together; show recent fixes")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict symbols to matching paths")
    .option("--pick <n>", "Pick Nth ambiguous candidate", parsePickOption)
    .option("--strict", STRICT_TARGET_HELP)
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--limit <n>", "Max partners (default and maximum 20)", "20")
    .action(
      async (
        target: string,
        opts: {
          kind?: string;
          path?: string;
          pick?: number;
          strict?: boolean;
          format: string;
          limit: string;
        },
      ) => {
        const index = readCoupling(resolveWorkspaceRoot());
        if (!index) {
          const message =
            "Git history is unavailable. Run ix map in a git repository with history mining enabled.";
          if (opts.format === "json")
            printJson({ status: "history_unavailable", partners: [], recentFixes: [], message });
          else
            console.log(
              opts.format === "llm"
                ? llmLine("coupling", [
                    ["status", "history_unavailable"],
                    ["message", message],
                  ])
                : message,
            );
          return;
        }
        const limit = Math.max(1, Math.min(Number.parseInt(opts.limit, 10) || 20, 20));
        const path = (relativePath(target) ?? target).replace(/^\.\//, "");
        let result;
        if (
          !opts.kind &&
          !opts.path &&
          Object.values(index.entities).some((e) => e.path === path && e.key === undefined)
        ) {
          result = coupledFor(index, { path }, limit);
        } else {
          const resolved = await resolveFileOrReport(
            createClient({ query: true }),
            target,
            { ...opts, textAnswer: false },
            opts.format,
          );
          if (!resolved) return;
          result = targetCoupling(resolved, limit);
        }
        if (opts.format === "json") printJson({ target, ...result });
        else for (const line of couplingLines(result, opts.format)) console.log(line);
      },
    );
}
