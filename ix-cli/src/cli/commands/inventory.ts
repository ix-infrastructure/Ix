// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { resolveReadSystemId } from "../resolve.js";
import { relativePath, printJson } from "../format.js";
import { llmLine } from "../llm.js";
import { projectRow } from "../output-shape.js";
import { normalizePathSeparators } from "../path-match.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";

/**
 * The most rows one /v1/list call returns. The backend clamps the request's
 * `limit` to this (Ix-memory ListRoutes.scala: `ReadBounds.limit(body.limit,
 * 200, 5000)`), and /v1/list has no offset, so no page can reach past it.
 */
export const LIST_MAX_ROWS = 5000;

/** Where an `ix inventory` page starts, and the command for the next one. */
export interface InventoryPaging {
  offset?: number;
  nextOffset?: number;
  next?: string;
  /**
   * The server stopped at LIST_MAX_ROWS before the page's rows (plus the one
   * past them) were in: how many entities exist is unknown past that row.
   */
  capped?: boolean;
}

/**
 * Render `ix inventory` as llm records: a header line then one `file` row per
 * source file with its entity names comma-joined (entities without a path
 * become standalone `item` rows). Grouping mirrors the json renderer to avoid
 * repeating the path on every entity.
 *
 * The header says `shown`, not `total`. The backend applies `--limit` itself,
 * so this side never sees how many entities of that kind exist — it only knows
 * whether the window it asked for came back full. Printing the length of a
 * capped list as a total is the claim that made `ix callers` report 50 callers
 * for a symbol with 212.
 *
 * Paged (`--offset`), the header says `offset=` and the truncation diagnostic
 * carries `next_offset=` with the command for the next page.
 */
export function renderInventoryLlm(
  kind: string, scope: string | null, nodes: any[], truncated = false, paging?: InventoryPaging,
): string[] {
  const offset = paging?.offset ?? 0;
  const byFile = new Map<string, string[]>();
  const ungrouped: Array<{ name: string; kind: string }> = [];
  for (const n of nodes) {
    const name = String(n.name || n.attrs?.name || "(unnamed)");
    const rawPath = (n as any).provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path;
    const path = relativePath(rawPath);
    if (path) {
      const names = byFile.get(path) ?? [];
      names.push(name);
      byFile.set(path, names);
    } else {
      ungrouped.push({ name, kind: String(n.kind) });
    }
  }
  const lines = [llmLine("inventory", [
    ["kind", kind],
    ["scope", scope ?? undefined],
    ["offset", offset > 0 ? offset : undefined],
    ["shown", nodes.length],
    ["truncated", truncated || undefined],
  ])];
  if (truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["next_offset", paging?.nextOffset],
      ["message", inventoryTruncationMessage(kind, offset, nodes.length, paging)],
    ]));
  }
  if (nodes.length === 0 && offset > 0 && !truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "offset_past_end"],
      ["message", inventoryPastEndMessage(kind, offset)],
    ]));
  }
  for (const [path, names] of byFile) {
    lines.push(llmLine("file", projectRow([["path", path], ["items", names.join(",")]])));
  }
  for (const u of ungrouped) {
    lines.push(llmLine("item", projectRow([["name", u.name], ["kind", u.kind]])));
  }
  return lines;
}

function inventoryTruncationMessage(kind: string, offset: number, shown: number, paging?: InventoryPaging): string {
  if (paging?.capped && paging.nextOffset === undefined) return inventoryCapMessage(kind, offset, shown);
  const more = `More than ${offset + shown} ${kind} entities exist.`;
  if (paging?.nextOffset === undefined) return `${more} Raise --limit, or narrow with --path.`;
  return `${more} next: ${paging.next ?? `--offset ${paging.nextOffset}`}, or narrow with --path.`;
}

/** A page at or past the server's row cap: the list goes on, but no offset reaches it. */
function inventoryCapMessage(kind: string, offset: number, shown: number): string {
  const head = `The server returns at most ${LIST_MAX_ROWS} ${kind} entities, so how many exist is unknown`;
  const where = shown > 0
    ? `this page ends at row ${offset + shown}, the last it returns`
    : `--offset ${offset} is beyond the rows it returns`;
  return `${head}; ${where}. Narrow with --path (or a more specific --kind) to see the rest.`;
}

function inventoryPastEndMessage(kind: string, offset: number): string {
  return `Fewer than ${offset + 1} ${kind} entities exist; --offset ${offset} is past the end.`;
}

export function registerInventoryCommand(program: Command): void {
  program
    .command("inventory")
    .description("List entities by kind with optional path scoping")
    .requiredOption("--kind <kind>", "Entity kind to list (class, method, function, file, module, etc.)")
    .option("--path <path>", "Filter by source file path substring")
    .option("--limit <n>", "Max results", "50")
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `
Examples:
  ix inventory --kind class
  ix inventory --kind class --path memory-layer
  ix inventory --kind file --path ix-cli/src
  ix inventory --kind method --limit 100
  ix inventory --kind class --offset 50
  ix inventory --format json --kind class`)
    .action(async (opts: {
      kind: string; path?: string; limit: string; offset?: string; format: string;
    }, cmd: Command) => {
      const client = createClient();
      const limit = parseInt(opts.limit, 10);
      const offset = parseOffset(opts.offset);

      // Pass --path as a server-side scope so the LIMIT is applied AFTER path
      // filtering (otherwise a capped fetch can truncate away the target before
      // the client-side filter below ever sees it). The client-side filter is
      // kept as a fallback for older servers that ignore the scope field.
      const systemId = await resolveReadSystemId(client);
      // Separators only, on both the scope sent to the backend and the
      // client-side fallback below. source_uris are always POSIX, so a Windows
      // `--path src\cli` matched nothing in either place (Ix#636). Case is
      // untouched — see path-match.ts.
      const pathNeedle = opts.path ? normalizePathSeparators(opts.path) : undefined;
      // One past the limit, so a full window is distinguishable from an exact
      // fit. The backend has no count endpoint, so this is the only honest
      // answer available: "there is at least one more". /v1/list has no
      // offset, so a page past the first fetches the rows before it too and
      // drops them here. /v1/list orders newest first (created_at DESC, then
      // _key), so pages line up only while the graph does not change: an
      // ingest between two pages shifts every later page, and rows repeat or
      // are skipped.
      //
      // The server returns at most LIST_MAX_ROWS rows. A request over that
      // which comes back full may have been cut, so the list is not known to
      // end there: it stays truncated and no offset is called past the end.
      // That is a count heuristic: exactly LIST_MAX_ROWS entities reads as
      // "count unknown". The server does say whether it cut (Ix-memory 1.0.34+
      // sets `X-Ix-Truncated: true` on /v1/list), but the client's post()
      // returns only the parsed body, so the header is not visible here yet.
      const wanted = offset + limit + 1;
      let nodes = await client.listByKind(opts.kind, { limit: Math.min(wanted, LIST_MAX_ROWS), workspaceId: systemId ? undefined : resolveWorkspaceId(), scope: pathNeedle, systemId });
      const capped = wanted > LIST_MAX_ROWS && nodes.length >= LIST_MAX_ROWS;
      const moreFetched = nodes.length > offset + limit;
      const truncated = moreFetched || capped;

      if (pathNeedle) {
        nodes = nodes.filter((n) => {
          const uri = normalizePathSeparators(String(
            (n as any).provenance?.source_uri ??
            n.provenance?.sourceUri ??
            n.attrs?.path ??
            ""
          ));
          return uri.includes(pathNeedle);
        });
      }

      nodes = nodes.slice(offset, offset + limit);
      const scope = opts.path ?? null;
      const paging: InventoryPaging = { offset, ...(capped ? { capped } : {}) };
      if (moreFetched && nodes.length > 0) {
        paging.nextOffset = offset + nodes.length;
        paging.next = nextPageCommand(cmd, [], paging.nextOffset);
      }

      if (opts.format === "json") {
        // Group by file to avoid repeating the same path on every entry
        const byFile = new Map<string, string[]>();
        const ungrouped: Array<{ name: string; kind: string; path?: string }> = [];
        for (const n of nodes) {
          const name = String(n.name || n.attrs?.name || "(unnamed)");
          const rawPath = (n as any).provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path;
          const path = relativePath(rawPath);
          if (path) {
            const existing = byFile.get(path) ?? [];
            existing.push(name);
            byFile.set(path, existing);
          } else {
            ungrouped.push({ name, kind: String(n.kind) });
          }
        }
        const grouped = Array.from(byFile.entries()).map(([path, names]) => ({
          path,
          items: names,
        }));
        const output: any = {
          kind: opts.kind,
          scope: scope ?? undefined,
          offset,
          shown: nodes.length,
          truncated,
          ...(paging.nextOffset !== undefined ? { nextOffset: paging.nextOffset } : {}),
          // The server's row cap was reached: the entity count is unknown.
          ...(capped ? { capped: true } : {}),
          byFile: grouped,
        };
        if (ungrouped.length > 0) output.ungrouped = ungrouped;
        printJson(output);
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderInventoryLlm(opts.kind, scope, nodes, truncated, paging)) console.log(line);
        return;
      }

      if (nodes.length === 0) {
        console.log(capped
          ? inventoryCapMessage(opts.kind, offset, 0)
          : offset > 0 && !truncated
            ? inventoryPastEndMessage(opts.kind, offset)
            : `No ${opts.kind} entities found${scope ? ` in ${scope}` : ""}.`);
        return;
      }

      const more = truncated
        ? paging.next ? ` (more exist — next: ${paging.next})`
          : capped ? ` (${inventoryCapMessage(opts.kind, offset, nodes.length)})`
          : " (more exist — raise --limit)"
        : "";
      console.log(`Inventory: ${nodes.length} ${opts.kind} entities${scope ? ` in ${scope}` : ""}${more}`);
      for (const n of nodes) {
        const name = n.name || n.attrs?.name || "(unnamed)";
        const path = String(
          (n as any).provenance?.source_uri ??
          n.provenance?.sourceUri ??
          n.attrs?.path ??
          ""
        );
        console.log(
          `  ${chalk.cyan(n.kind.padEnd(10))}  ${chalk.bold(String(name).padEnd(30))}  ${chalk.dim(path)}`
        );
      }
    });
}
