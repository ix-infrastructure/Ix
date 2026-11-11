// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { createClient } from "../client/factory.js";
import type { IxClient } from "../client/api.js";
import { expandCapped, formatEdgeResults, sliceEdgeResults, type Diagnostic } from "./format.js";
import {
  addFormatOption,
  addPagingOptions,
  addTargetOptions,
  pagingValues,
  targetOptionValues,
  type PagingOptionValues,
  type TargetOptionValues,
} from "./options.js";
import { nextPageCommand } from "./paging.js";
import { printResolved, resolveFileOrReport, resolveTargetSetOrReport, type TargetSet } from "./resolve.js";
import { emptyEdgeResultsJson } from "./text-matches.js";
import { edgeTargetFor, withEdgeSites } from "./edge-sites.js";

/** What a one-hop edge command's action receives. */
export interface EdgeCommandOpts extends TargetOptionValues, PagingOptionValues {
  format: string;
  all?: boolean;
}

/**
 * `--all` on an edge command: the help line, and what answers once the
 * symbol resolved to every candidate.
 */
export interface EdgeAllMode {
  help: string;
  run(client: IxClient, symbol: string, set: TargetSet, limit: number, offset: number, format: string, cmd: Command): Promise<void>;
}

/**
 * One command that answers with the entities one edge away from its target.
 *
 * `name` is also the relation the rows are rendered under (`formatEdgeResults`)
 * and, with `withSites`, the relation their call or import sites are looked
 * up for (`edge-sites.ts`).
 */
export interface EdgeCommandSpec {
  name: string;
  description: string;
  /** The text after "Examples:" ... in `--help`, verbatim, leading newline included. */
  helpAfter: string;
  direction: "in" | "out";
  predicates: string[];
  /** Attach each row's call or import site. */
  withSites: boolean;
  /**
   * `--all`, declared after `--strict`. With it the target resolves through
   * `resolveTargetSetOrReport`, which offers `--all` on an ambiguous name;
   * without it through `resolveFileOrReport`.
   */
  all?: EdgeAllMode;
  /**
   * Started alongside the expand, settled once its rows are known; what it
   * returns goes on the answer as diagnostics. `callees` uses it for the graph
   * health check.
   */
  diagnose?: (client: IxClient) => (rows: number, format: string) => Promise<Diagnostic[] | undefined>;
}

/**
 * Register a one-hop edge command: resolve the target, expand one edge, slice
 * a page, write the next-page hint, attach sites, format. `imports`,
 * `imported-by`, `contains` and `callees` are this sequence with a different
 * direction and predicate; `callers` adds a text fallback and dispatch
 * callers, so it keeps its own action.
 */
export function registerEdgeCommand(program: Command, spec: EdgeCommandSpec): Command {
  const cmd = program
    .command(`${spec.name} <symbol>`)
    .description(spec.description);
  addTargetOptions(cmd);
  if (spec.all) cmd.option("--all", spec.all.help);
  addPagingOptions(cmd);
  addFormatOption(cmd);
  return cmd
    .addHelpText("after", spec.helpAfter)
    .action(async (symbol: string, opts: EdgeCommandOpts, command: Command) => {
      await runEdgeCommand(spec, symbol, opts, command);
    });
}

async function runEdgeCommand(spec: EdgeCommandSpec, symbol: string, opts: EdgeCommandOpts, cmd: Command): Promise<void> {
  const client = createClient();
  const { limit, offset } = pagingValues(opts);
  const resolveOpts = { ...targetOptionValues(opts), textAnswerJson: emptyEdgeResultsJson() };

  let target;
  if (spec.all) {
    const set = await resolveTargetSetOrReport(client, symbol, { ...resolveOpts, all: opts.all }, opts.format);
    if (!set) return;
    if (set.all) {
      await spec.all.run(client, symbol, set, limit, offset, opts.format, cmd);
      return;
    }
    target = set.entities[0];
  } else {
    target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
    if (!target) return;
  }

  if (opts.format === "text") printResolved(target);
  const settle = spec.diagnose?.(client);
  // Expand by entity id, not by name: a name would aggregate every same-named entity.
  const result = await client.expand(target.id, { direction: spec.direction, predicates: spec.predicates });
  const diagnostics = settle ? await settle(result.nodes.length, opts.format) : undefined;
  const slice = sliceEdgeResults(result.nodes, limit, offset, expandCapped(result));
  if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
  const rows = spec.withSites
    ? withEdgeSites(slice.rows, spec.name, await edgeTargetFor(client, target, spec.name))
    : slice.rows;
  formatEdgeResults({ ...slice, rows }, spec.name, target.name, opts.format, target, "graph", diagnostics);
}
