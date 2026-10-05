// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { formatEdgeResults, sliceEdgeResults } from "../format.js";
import { resolveFileOrReport, printResolved } from "../resolve.js";
import { parsePickOption } from "../options.js";
import { edgeTargetFor, withEdgeSites } from "../edge-sites.js";

export function registerImportsCommand(program: Command): void {
  program
    .command("imports <symbol>")
    .description("Show what the given entity imports")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix imports auth.py\n  ix imports IngestionService --format json")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; format: string }) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;
      if (opts.format === "text") printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] });
      const slice = sliceEdgeResults(result.nodes, limit);
      const site = await edgeTargetFor(client, target, "imports");
      formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "imports", site) }, "imports", target.name, opts.format, target, "graph");
    });

  program
    .command("imported-by <symbol>")
    .description("Show what imports the given entity")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix imported-by AuthProvider\n  ix imported-by io.circe.Json --format json")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; format: string }) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;
      if (opts.format === "text") printResolved(target);
      const result = await client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] });
      const slice = sliceEdgeResults(result.nodes, limit);
      const site = await edgeTargetFor(client, target, "imported-by");
      formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "imported-by", site) }, "imported-by", target.name, opts.format, target, "graph");
    });
}
