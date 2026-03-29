import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { formatEdgeResults, relativePath } from "../format.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";

const execFileAsync = promisify(execFile);

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix callers verify_token\n  ix callers processPayment --format json\n  ix callers parse --kind method --limit 20")
    .action(async (symbol: string, opts: { kind?: string; pick?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;
      if (opts.format !== "json") printResolved(target);
      // Use expand by entity ID to avoid aggregating results across all same-named entities
      const result = await client.expand(target.id, {
        direction: "in",
        predicates: ["CALLS", "REFERENCES"],
      });

      if (result.nodes.length === 0) {
        // Fallback to text search
        try {
          const root = resolveWorkspaceRoot();
          const { stdout } = await execFileAsync("rg", [
            "--json", "--max-count", "10", target.name, root,
          ], { maxBuffer: 5 * 1024 * 1024 });

          const allTextResults: any[] = [];
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "match") {
                const data = parsed.data;
                allTextResults.push({
                  id: "",
                  kind: "text-match",
                  name: `${data.path?.text ?? ""}:${data.line_number ?? 0}`,
                  resolved: false,
                  path: relativePath(data.path?.text) ?? "",
                  line: data.line_number ?? 0,
                  attrs: { snippet: data.lines?.text?.trim() ?? "" },
                });
              }
            } catch { /* skip malformed lines */ }
          }

          const candidatesFound = allTextResults.length;
          const textResults = allTextResults.slice(0, 10);

          if (textResults.length > 0) {
            if (opts.format === "json") {
              console.log(JSON.stringify({
                results: textResults,
                resultSource: "text",
                resolvedTarget: target,
                summary: {
                  candidatesFound,
                  candidatesReturned: textResults.length,
                },
                diagnostics: [{
                  code: "text_fallback_used",
                  message: "No graph-backed CALLS/REFERENCES edges found. If files were ingested before extraction was added, run: ix ingest --force --recursive .",
                }],
              }, null, 2));
            } else {
              stderr(chalk.dim("No graph-backed CALLS/REFERENCES edges found. Showing text-based candidate usages."));
              stderr(chalk.dim("Tip: if files were ingested before CALLS extraction, run: ix ingest --force --recursive .\n"));
              for (const r of textResults) {
                const snippet = r.attrs?.snippet ?? "";
                console.log(`  ${chalk.dim(r.name)}  ${snippet}`);
              }
              if (candidatesFound > 10) {
                stderr(chalk.dim(`\n  (${candidatesFound} total candidates; showing 10)`));
              }
            }
            return;
          }
        } catch { /* ripgrep not available or no matches */ }

        // Both graph and text empty
        formatEdgeResults([], "callers", target.name, opts.format, target, "graph");
      } else {
        formatEdgeResults(result.nodes.slice(0, limit), "callers", target.name, opts.format, target, "graph");
      }
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix callees processPayment\n  ix callees parse --format json")
    .action(async (symbol: string, opts: { kind?: string; pick?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const calleeLimit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;
      if (opts.format !== "json") printResolved(target);
      // Use expand by entity ID to avoid aggregating results across all same-named entities
      const result = await client.expand(target.id, {
        direction: "out",
        predicates: ["CALLS", "REFERENCES"],
      });
      formatEdgeResults(result.nodes.slice(0, calleeLimit), "callees", target.name, opts.format, target, "graph");
    });
}
