// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import type { IxClient } from "../../client/api.js";
import { disambiguatingIds, lineSpan, locationLabel, printJson } from "../format.js";
import { llmLine } from "../llm.js";
import { runPerTarget } from "../multi-target.js";
import { parsePickOption } from "../options.js";
import { EXIT_CODES_HELP } from "../outcome.js";
import { isQuiet, projectRow } from "../output-shape.js";
import { printResolved, resolveFileOrReport } from "../resolve.js";
import { overrideFamily, type OverrideRelation, type OverrideRow } from "../type-walk.js";

interface OverridesOpts {
  kind?: string; path?: string; pick?: number; limit: string; format: string;
}

const TEXT_HEADINGS: Record<OverrideRelation, string> = {
  overrides: "overrides",
  implements: "implements",
  overridden_by: "overridden by",
  sibling: "siblings",
};

export function registerOverridesCommand(program: Command): void {
  program
    .command("overrides <symbols...>")
    .alias("implementations")
    .description("Show the other definitions of a method: what it overrides or implements, its overrides, and sibling implementations")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `\nExamples:
  ix overrides handle --path src/handlers/Base.java
  ix overrides render --format llm
  ix implementations run --kind method --format json

Before changing a method's signature or behaviour: the base declarations it
overrides or implements, the overrides below it, and the sibling
implementations of the same base method. Matched by name, through the
EXTENDS (extends and implements) edges in the graph; up to 5 levels each way
and 32 types.
Several symbols answer in one call, grouped per symbol (json: {targets: [...]}).
${EXIT_CODES_HELP}`)
    .action(async (symbols: string[], opts: OverridesOpts) => {
      const client = createClient();
      await runPerTarget(symbols, opts.format, (symbol) => overridesOne(client, symbol, opts));
    });
}

async function overridesOne(client: IxClient, symbol: string, opts: OverridesOpts): Promise<void> {
  const limit = parseInt(opts.limit, 10);
  const target = await resolveFileOrReport(client, symbol, { kind: opts.kind, path: opts.path, pick: opts.pick }, opts.format);
  if (!target) return;
  if (opts.format === "text") printResolved(target);
  const family = await overrideFamily(client, target);
  const total = family.rows.length;
  const rows = family.rows.slice(0, Math.max(0, limit));
  const diagnostics: Array<{ code: string; message: string; cap?: string }> = [...family.diagnostics];
  if (rows.length < total) {
    diagnostics.push({ code: "results_truncated", message: `${total} rows; showing ${rows.length}. Raise --limit to see them.` });
  }
  const truncated = family.truncated || rows.length < total;

  if (opts.format === "json") {
    printJson({
      target: symbol,
      resolvedTarget: { id: target.id, name: target.name, kind: target.kind, ...(target.path ? { path: target.path } : {}) },
      ...(family.owner ? { owner: family.owner } : {}),
      ...(family.root ? { root: family.root } : {}),
      rows,
      total,
      truncated,
      diagnostics,
    });
    return;
  }

  const qualified = family.owner ? `${family.owner.name}.${target.name}` : target.name;
  if (opts.format === "llm") {
    console.log(llmLine("overrides", [
      ["target", qualified], ["owner", family.owner?.name], ["root", family.root],
      ["shown", rows.length], ["total", total], ["truncated", truncated ? true : undefined],
    ]));
    for (const d of diagnostics) {
      console.log(llmLine("diagnostic", [["code", d.code], ["cap", d.cap], ["message", d.message]]));
    }
    const ids = disambiguatingIds(rows, (r) => `${r.owner.name}.${r.name}\0${r.path ?? ""}`, (r) => r.id);
    rows.forEach((r, i) => console.log(llmLine("override", projectRow(llmRow(r, ids[i])))));
    return;
  }

  for (const d of diagnostics) {
    if (d.code !== "no_owner_type") process.stderr.write(chalk.yellow(`${d.message}\n`));
  }
  if (rows.length === 0) {
    const why = family.diagnostics.find((d) => d.code === "no_owner_type");
    console.log(why?.message ?? `No overrides, base declarations or sibling implementations of ${qualified} in the graph.`);
    return;
  }
  if (!isQuiet()) console.log(`${chalk.bold("Overrides")} of ${chalk.cyan(qualified)}:`);
  let heading: string | undefined;
  for (const r of rows) {
    const title = r.relation === "sibling" && r.via ? `${TEXT_HEADINGS.sibling} (via ${r.via})` : TEXT_HEADINGS[r.relation];
    if (title !== heading) {
      heading = title;
      console.log(`  ${chalk.dim(title)}`);
    }
    const where = locationLabel(r);
    console.log(`    ${chalk.bold(`${r.owner.name}.${r.name}`)}${where ? `  ${chalk.dim(where)}` : ""}  ${chalk.dim(`depth ${r.depth}`)}`);
  }
}

function llmRow(r: OverrideRow, id: string | undefined): Array<[string, string | number | undefined]> {
  return [
    ["name", r.name], ["relation", r.relation], ["owner", r.owner.name], ["kind", r.kind], ["id", id],
    ["path", r.path], ["lines", lineSpan(r)], ["depth", r.depth], ["via", r.via],
  ];
}
