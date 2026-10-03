// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { formatEdgeResults, printJson, relativePath, sliceEdgeResults, type Diagnostic } from "../format.js";
import { checkGraphHealth, graphHealthProse, isUnhealthy, type GraphHealth } from "../graph-health.js";
import { parsePickOption } from "../options.js";
import { activeReadScope, resolveFileOrReport, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";
import { llmLine } from "../llm.js";
import { edgeTargetFor, rankTextUses, withEdgeSites } from "../edge-sites.js";
import { renderWarning } from "../ui.js";

const execFileAsync = promisify(execFile);

/**
 * The graph's health, as edge-result diagnostics. On a hollowed graph "no
 * callers" is a count of lost edges, not an answer. llm and json carry a
 * `graph_degraded` diagnostic; text shows it as the reason for an empty result
 * (formatEdgeResults) or, over rows, as a banner (`bannerOverRows`).
 */
async function healthDiagnostics(health: Promise<GraphHealth>): Promise<{ diagnostics?: Diagnostic[]; fix?: string }> {
  const h = await health;
  if (!isUnhealthy(h)) return {};
  return { diagnostics: [{ code: "graph_degraded", message: graphHealthProse(h) }], fix: h.fix };
}

function bannerOverRows(health: { diagnostics?: Diagnostic[] }, format: string, rows: number): void {
  if (format === "text" && rows > 0 && health.diagnostics) renderWarning(health.diagnostics[0].message);
}

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix callers verify_token\n  ix callers processPayment --format json\n  ix callers parse --kind method --limit 20")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; format: string }) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;
      if (opts.format === "text") printResolved(target);
      const healthCheck = checkGraphHealth(client, activeReadScope());
      // Use expand by entity ID to avoid aggregating results across all same-named entities
      const result = await client.expand(target.id, {
        direction: "in",
        predicates: ["CALLS", "REFERENCES"],
      });
      const health = await healthDiagnostics(healthCheck);
      bannerOverRows(health, opts.format, result.nodes.length);
      // `ix ingest --force` does not bring a hollowed graph's edges back; the
      // health check names what does.
      const remedy = health.fix ?? "ix ingest --force --recursive .";

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

          // Calls first and the definition out: an unranked fallback led with
          // import lines and the target's own signature.
          const ranked = rankTextUses(
            allTextResults.map((r) => ({ ...r, snippet: r.attrs.snippet as string })),
            target.name,
          ).map(({ snippet: _snippet, ...r }) => r);
          const candidatesFound = ranked.length;
          const textResults = ranked.slice(0, 10);

          if (textResults.length > 0) {
            if (opts.format === "llm") {
              console.log(llmLine("callers", [
                ["target", target.name], ["source", "text"],
                ["shown", textResults.length], ["total", candidatesFound],
              ]));
              console.log(llmLine("diagnostic", [
                ["code", "text_fallback_used"],
                ["message", "No graph-backed CALLS/REFERENCES edges; showing text matches."],
              ]));
              for (const d of health.diagnostics ?? []) {
                console.log(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
              }
              for (const r of textResults) {
                console.log(llmLine("ref", [["path", r.path], ["line", r.line], ["snippet", r.attrs?.snippet ?? ""]]));
              }
              return;
            }
            if (opts.format === "json") {
              printJson({
                results: textResults,
                resultSource: "text",
                resolvedTarget: target,
                summary: {
                  candidatesFound,
                  candidatesReturned: textResults.length,
                },
                diagnostics: [{
                  code: "text_fallback_used",
                  message: `No graph-backed CALLS/REFERENCES edges found. If files were ingested before extraction was added, run: ${remedy}`,
                }, ...(health.diagnostics ?? [])],
              });
            } else {
              bannerOverRows(health, opts.format, textResults.length);
              stderr(chalk.dim("No graph-backed CALLS/REFERENCES edges found. Showing text-based candidate usages."));
              stderr(chalk.dim(`Tip: if files were ingested before CALLS extraction, run: ${remedy}\n`));
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
        formatEdgeResults(sliceEdgeResults([], limit), "callers", target.name, opts.format, target, "graph", health.diagnostics);
      } else {
        const slice = sliceEdgeResults(result.nodes, limit);
        const site = await edgeTargetFor(client, target, "callers");
        formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "callers", site) }, "callers", target.name, opts.format, target, "graph", health.diagnostics);
      }
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix callees processPayment\n  ix callees parse --format json")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; format: string }) => {
      const client = createClient();
      const calleeLimit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;
      if (opts.format === "text") printResolved(target);
      const healthCheck = checkGraphHealth(client, activeReadScope());
      // Use expand by entity ID to avoid aggregating results across all same-named entities
      const result = await client.expand(target.id, {
        direction: "out",
        predicates: ["CALLS", "REFERENCES"],
      });
      const health = await healthDiagnostics(healthCheck);
      bannerOverRows(health, opts.format, result.nodes.length);
      const slice = sliceEdgeResults(result.nodes, calleeLimit);
      const site = await edgeTargetFor(client, target, "callees");
      formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "callees", site) }, "callees", target.name, opts.format, target, "graph", health.diagnostics);
    });
}
