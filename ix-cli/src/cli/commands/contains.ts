// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../../client/factory.js";
import { expandCapped, formatEdgeResults, sliceEdgeResults } from "../format.js";
import { parsePickOption } from "../options.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { resolveFileOrReport, printResolved } from "../resolve.js";

export function registerContainsCommand(program: Command): void {
  program
    .command("contains <symbol>")
    .description("Show members contained by the given entity (class, module, file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", "\nExamples:\n  ix contains IngestionService\n  ix contains auth.py --kind file --format json\n  ix contains MyClass --limit 20\n  ix contains package --path crates/regex/Cargo.toml")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; limit: string; offset: string; format: string }, cmd: Command) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const offset = parseOffset(opts.offset);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;
      if (opts.format === "text") printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] });
      const slice = sliceEdgeResults(result.nodes, limit, offset, expandCapped(result));
      if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
      formatEdgeResults(slice, "contains", target.name, opts.format, target, "graph");
    });
}
