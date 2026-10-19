// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { expandCapped, formatEdgeResults, printJson, relativePath, sliceEdgeResults, sliceRanked, truncationHint, type Diagnostic } from "../format.js";
import { checkGraphHealth, graphHealthProse, isUnhealthy, type GraphHealth } from "../graph-health.js";
import { parsePickOption } from "../options.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { activeReadScope, resolveFileOrReport, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";
import { llmLine } from "../llm.js";
import { edgeTargetFor, rankTextUses, withEdgeSites } from "../edge-sites.js";
import { renderWarning } from "../ui.js";
import { currentRunSignal } from "../../client/run-signal.js";
import { clipSnippet } from "./text.js";

const execFileAsync = promisify(execFile);

/** Rows per page of the text fallback. --limit does not apply to it. */
export const TEXT_FALLBACK_PAGE = 10;

/**
 * rg's argv for the text fallback. -F and -e: the name is a literal pattern,
 * never a regex or a flag (a symbol named `--pre=x` would otherwise run an rg
 * preprocessor). `--` ends the options before the root.
 */
export function callersTextSearchArgs(name: string, root: string): string[] {
  return ["--json", "--max-count", "10", "-F", "-e", name, "--", root];
}

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
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix callers verify_token\n  ix callers processPayment --format json\n  ix callers parse --kind method --limit 20\n  ix callers verify_token --offset 50")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; offset: string; format: string }, cmd: Command) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const offset = parseOffset(opts.offset);
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
        // Fallback to text search: pages of TEXT_FALLBACK_PAGE rows, --offset honoured.
        try {
          const root = resolveWorkspaceRoot();
          // The timeout bounds a search that rg could otherwise run for ever.
          const { stdout } = await execFileAsync("rg", callersTextSearchArgs(target.name, root), {
            maxBuffer: 5 * 1024 * 1024, timeout: 10_000, signal: currentRunSignal(),
          });

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
                  // Capped like `ix text`: one minified line must not flood
                  // the context. Ranking still reads the whole line.
                  attrs: { snippet: clipSnippet(data.lines?.text ?? "", data.submatches).trim() },
                  fullLine: data.lines?.text?.trim() ?? "",
                });
              }
            } catch { /* skip malformed lines */ }
          }

          // rg searches files in parallel, so match order varies between runs;
          // sort first so the ranking, and the output, do not.
          allTextResults.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : x.line - y.line));
          // Calls first and the definition out: an unranked fallback led with
          // import lines and the target's own signature.
          const ranked = rankTextUses(
            allTextResults.map((r) => ({ ...r, snippet: r.fullLine as string })),
            target.name,
          ).map(({ snippet: _snippet, fullLine: _fullLine, ...r }) => r);
          const candidatesFound = ranked.length;
          // The ranking is a stable sort of a sorted list, so pages neither
          // overlap nor skip a row.
          const page = sliceRanked(ranked, TEXT_FALLBACK_PAGE, undefined, offset);
          if (page.nextOffset !== undefined) page.next = nextPageCommand(cmd, [symbol], page.nextOffset);
          const textResults = page.rows;
          const pastEnd = candidatesFound > 0 && textResults.length === 0;
          const pastEndMessage = `${candidatesFound} text candidates; --offset ${offset} is past the end.`;
          const pageHint = page.truncated ? truncationHint(page, "text candidates") : undefined;

          if (candidatesFound > 0) {
            if (opts.format === "llm") {
              console.log(llmLine("callers", [
                ["target", target.name], ["source", "text"],
                ["offset", offset > 0 ? offset : undefined],
                ["shown", textResults.length], ["total", candidatesFound],
              ]));
              console.log(llmLine("diagnostic", [
                ["code", "text_fallback_used"],
                ["message", "No graph-backed CALLS/REFERENCES edges; showing text matches."],
              ]));
              if (pageHint) {
                console.log(llmLine("diagnostic", [
                  ["code", "results_truncated"], ["next_offset", page.nextOffset], ["message", pageHint],
                ]));
              }
              if (pastEnd) console.log(llmLine("diagnostic", [["code", "offset_past_end"], ["message", pastEndMessage]]));
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
                  ...(offset > 0 ? { offset } : {}),
                  ...(page.truncated ? { truncated: true } : {}),
                  ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
                },
                diagnostics: [{
                  code: "text_fallback_used",
                  message: `No graph-backed CALLS/REFERENCES edges found. If files were ingested before extraction was added, run: ${remedy}`,
                },
                ...(pageHint ? [{ code: "results_truncated", message: pageHint }] : []),
                ...(pastEnd ? [{ code: "offset_past_end", message: pastEndMessage }] : []),
                ...(health.diagnostics ?? [])],
              });
            } else if (pastEnd) {
              console.log(pastEndMessage);
            } else {
              bannerOverRows(health, opts.format, textResults.length);
              stderr(chalk.dim("No graph-backed CALLS/REFERENCES edges found. Showing text-based candidate usages."));
              stderr(chalk.dim(`Tip: if files were ingested before CALLS extraction, run: ${remedy}\n`));
              for (const r of textResults) {
                const snippet = r.attrs?.snippet ?? "";
                console.log(`  ${chalk.dim(r.name)}  ${snippet}`);
              }
              if (page.truncated || offset > 0) {
                const range = offset > 0 ? `${offset + 1}-${offset + textResults.length}` : `${textResults.length}`;
                const next = page.next ?? (page.nextOffset !== undefined ? `--offset ${page.nextOffset}` : undefined);
                stderr(chalk.dim(`\n  (${candidatesFound} total candidates; showing ${range})${next ? ` next: ${next}` : ""}`));
              }
            }
            return;
          }
        } catch { /* ripgrep not available or no matches */ }

        // Both graph and text empty (also the health-gated path: --offset does not apply).
        formatEdgeResults(sliceEdgeResults([], limit), "callers", target.name, opts.format, target, "graph", health.diagnostics);
      } else {
        const slice = sliceEdgeResults(result.nodes, limit, offset, expandCapped(result));
        if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
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
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix callees processPayment\n  ix callees parse --format json")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; offset: string; format: string }, cmd: Command) => {
      const client = createClient();
      const calleeLimit = parseInt(opts.limit, 10);
      const calleeOffset = parseOffset(opts.offset);
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
      const slice = sliceEdgeResults(result.nodes, calleeLimit, calleeOffset, expandCapped(result));
      if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
      const site = await edgeTargetFor(client, target, "callees");
      formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "callees", site) }, "callees", target.name, opts.format, target, "graph", health.diagnostics);
    });
}
