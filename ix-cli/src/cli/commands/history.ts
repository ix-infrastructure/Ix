// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveFileOrReport, printResolved } from "../resolve.js";
import { relativePath, printJson } from "../format.js";
import { llmLine } from "../llm.js";
import { formatOption, kindOption, pathOption, pickOption, STRICT_AMBIGUOUS_HELP, strictOption } from "../options.js";

/** Render an entity's provenance chain as llm records: a header then one `patch` row per revision. */
export function renderHistoryLlm(
  resolved: { name: string; kind: string }, patches: any[],
): string[] {
  const lines = [llmLine("history", [["target", resolved.name], ["kind", resolved.kind], ["count", patches.length]])];
  for (const p of patches) {
    lines.push(llmLine("patch", [
      ["rev", p.rev ?? p.data?.rev],
      ["ts", p.data?.timestamp ?? p.timestamp],
      ["intent", (p.data?.intent ?? p.intent) || undefined],
      ["source", relativePath(p.data?.source?.uri) || undefined],
    ]));
  }
  return lines;
}

export function registerHistoryCommand(program: Command): void {
  program
    .command("history <target>")
    .description("Show provenance chain for a file or entity")
    .addOption(kindOption())
    .addOption(pathOption())
    .addOption(pickOption())
    .addOption(strictOption(STRICT_AMBIGUOUS_HELP))
    .addOption(formatOption())
    .addHelpText("after", `\nExamples:
  ix history ix-cli/src/cli/commands/decide.ts
  ix history decide.ts
  ix history IngestionService --kind class
  ix history <entity-uuid>`)
    .action(async (target: string, opts: { kind?: string; path?: string; pick?: number; strict?: boolean; format: string }) => {
      const client = createClient();
      // An entity's history was asked for: a list of the files that mention
      // a text-only name today is not one, so it stays the miss (exit 3).
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick, strict: opts.strict, textAnswer: false };
      const resolved = await resolveFileOrReport(client, target, resolveOpts, opts.format);
      if (!resolved) return;

      if (opts.format === "text") printResolved(resolved);

      const result = await client.provenance(resolved.id);
      const allPatches = Array.isArray(result) ? result : (result as any)?.patches ?? [];

      if (opts.format === "llm") {
        for (const line of renderHistoryLlm(resolved, allPatches)) console.log(line);
        return;
      }

      if (opts.format === "json") {
        const patches = allPatches;
        printJson({
          resolvedTarget: { kind: resolved.kind, name: resolved.name, path: relativePath(resolved.path) },
          patches: patches.map((p: any) => ({
            rev: p.rev ?? p.data?.rev,
            timestamp: p.data?.timestamp ?? p.timestamp,
            intent: (p.data?.intent ?? p.intent) || undefined,
            source: relativePath(p.data?.source?.uri) ?? undefined,
          })),
        });
      } else {
        const patches = Array.isArray(result) ? result : (result as any)?.patches ?? [];
        if (patches.length === 0) {
          console.log(chalk.dim("  No provenance records found."));
          return;
        }
        for (const p of patches) {
          const rev = p.rev ?? p.data?.rev ?? "?";
          const timestamp = p.data?.timestamp ?? p.timestamp ?? "";
          const intent = p.data?.intent ?? p.intent ?? "";
          const source = p.data?.source?.uri ?? "";
          console.log(`  ${chalk.cyan(`rev ${rev}`)} ${chalk.dim(timestamp)}`);
          if (intent) console.log(`    ${intent}`);
          if (source) console.log(`    ${chalk.dim(source)}`);
        }
      }
    });
}
