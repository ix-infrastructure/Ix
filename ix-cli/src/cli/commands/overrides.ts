// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import type { IxClient } from "../../client/api.js";
import { disambiguatingIds, lineSpan, locationLabel, printJson, sliceRanked, truncationHint } from "../format.js";
import { llmLine } from "../llm.js";
import { runPerTarget } from "../multi-target.js";
import { parseCountOption, parsePickOption } from "../options.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { EXIT_CODES_HELP } from "../outcome.js";
import { isQuiet, projectRow } from "../output-shape.js";
import { printResolved, resolveFileOrReport } from "../resolve.js";
import { reportError } from "./around.js";
import { overrideFamily, type OverrideRelation, type OverrideRow } from "../type-walk.js";

interface OverridesOpts {
  kind?: string; path?: string; pick?: number; limit: string; offset: string; format: string;
}

/** `--limit` as a count, or undefined when it is not one (`abc`, `-1`, `10abc`). */
export function parseOverridesLimit(value: string): number | undefined {
  try { return parseCountOption(value, "50"); } catch { return undefined; }
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
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `\nExamples:
  ix overrides handle --path src/handlers/Base.java
  ix overrides render --format llm
  ix implementations run --kind method --format json
  ix overrides handle --limit 20 --offset 20

Before changing a method's signature or behaviour: the base declarations it
overrides or implements, the overrides below it, and the sibling
implementations of the same base method. Matched by name, through the
EXTENDS (extends and implements) edges in the graph; up to 5 levels each way
and 32 types.
Several symbols answer in one call, grouped per symbol (json: {targets: [...]}).
${EXIT_CODES_HELP}`)
    .action(async (symbols: string[], opts: OverridesOpts, cmd: Command) => {
      // The root hook refuses a malformed <n> already; this holds where it is
      // not installed, so `abc` never becomes NaN and silently zero rows.
      if (parseOverridesLimit(opts.limit) === undefined) {
        reportError("invalid_limit", `--limit must be a non-negative integer (for example, 50), not "${opts.limit}".`, opts.format);
        return;
      }
      const client = createClient();
      await runPerTarget(symbols, opts.format, (symbol) => overridesOne(client, symbol, opts, cmd));
    });
}

async function overridesOne(client: IxClient, symbol: string, opts: OverridesOpts, cmd: Command): Promise<void> {
  const limit = parseOverridesLimit(opts.limit) ?? 0;
  const offset = parseOffset(opts.offset);
  const target = await resolveFileOrReport(client, symbol, { kind: opts.kind, path: opts.path, pick: opts.pick }, opts.format);
  if (!target) return;
  if (opts.format === "text") printResolved(target);
  const family = await overrideFamily(client, target);
  const page = sliceRanked(family.rows, Math.max(0, limit), undefined, offset);
  const { rows, total } = page;
  const diagnostics: Array<{ code: string; message: string; cap?: string; next_offset?: number }> = [...family.diagnostics];
  if (page.nextOffset !== undefined) page.next = nextPageCommand(cmd, [symbol], page.nextOffset);
  if (page.truncated) {
    diagnostics.push({
      code: "results_truncated", ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {}),
      message: truncationHint(page, "rows"),
    });
  } else if (total > 0 && offset >= total) {
    diagnostics.push({ code: "offset_past_end", message: `${total} rows; --offset ${offset} is past the end.` });
  }
  const truncated = family.truncated || page.truncated;

  if (opts.format === "json") {
    printJson({
      target: symbol,
      resolvedTarget: { id: target.id, name: target.name, kind: target.kind, ...(target.path ? { path: target.path } : {}) },
      ...(family.owner ? { owner: family.owner } : {}),
      ...(family.root ? { root: family.root } : {}),
      rows,
      total,
      ...(offset > 0 ? { offset } : {}),
      truncated,
      diagnostics,
    });
    return;
  }

  const qualified = family.owner ? `${family.owner.name}.${target.name}` : target.name;
  if (opts.format === "llm") {
    console.log(llmLine("overrides", [
      ["target", qualified], ["owner", family.owner?.name], ["root", family.root],
      ["offset", offset > 0 ? offset : undefined], ["shown", rows.length], ["total", total], ["truncated", truncated ? true : undefined],
    ]));
    for (const d of diagnostics) {
      console.log(llmLine("diagnostic", [["code", d.code], ["cap", d.cap], ["next_offset", d.next_offset], ["message", d.message]]));
    }
    const ids = disambiguatingIds(rows, (r) => `${r.owner.name}.${r.name}\0${r.path ?? ""}`, (r) => r.id);
    rows.forEach((r, i) => console.log(llmLine("override", projectRow(llmRow(r, ids[i])))));
    return;
  }

  for (const d of diagnostics) {
    if (d.code !== "no_owner_type") process.stderr.write(chalk.yellow(`${d.message}\n`));
  }
  // A page with nothing on it (`--limit 0`, an offset past the end): the diagnostics said why.
  if (rows.length === 0 && total > 0) return;
  if (rows.length === 0) {
    const why = family.diagnostics.find((d) => d.code === "no_owner_type");
    console.log(why?.message ?? `No overrides, base declarations or sibling implementations of ${qualified} in the graph.`);
    return;
  }
  if (!isQuiet()) console.log(`${chalk.bold("Overrides")} of ${chalk.cyan(qualified)}:`);
  // `overrides` and `implements` rows share a rank and interleave by depth:
  // one heading per relation, in order of first appearance.
  const groups = new Map<string, OverrideRow[]>();
  for (const r of rows) {
    const title = r.relation === "sibling" && r.via ? `${TEXT_HEADINGS.sibling} (via ${r.via})` : TEXT_HEADINGS[r.relation];
    const group = groups.get(title);
    if (group) group.push(r);
    else groups.set(title, [r]);
  }
  for (const [title, group] of groups) {
    console.log(`  ${chalk.dim(title)}`);
    for (const r of group) {
      const where = locationLabel(r);
      console.log(`    ${chalk.bold(`${r.owner.name}.${r.name}`)}${where ? `  ${chalk.dim(where)}` : ""}  ${chalk.dim(`depth ${r.depth}`)}`);
    }
  }
}

function llmRow(r: OverrideRow, id: string | undefined): Array<[string, string | number | undefined]> {
  return [
    ["name", r.name], ["relation", r.relation], ["owner", r.owner.name], ["kind", r.kind], ["id", id],
    ["path", r.path], ["lines", lineSpan(r)], ["depth", r.depth], ["via", r.via],
  ];
}
