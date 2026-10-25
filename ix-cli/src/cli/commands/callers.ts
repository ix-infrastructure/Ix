// Copyright 2026 Ix Infrastructure Inc.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceRoot } from "../config.js";
import { expandCapped, formatEdgeResults, printJson, relativePath, sliceEdgeResults, sliceRanked, truncationHint, type Diagnostic, type EdgeCandidate } from "../format.js";
import { checkGraphHealth, graphHealthProse, isUnhealthy, type GraphHealth } from "../graph-health.js";
import { parsePickOption } from "../options.js";
import { nextPageCommand, OFFSET_FLAG, parseOffset } from "../paging.js";
import { activeReadScope, candidatesCut, resolveTargetSetOrReport, printResolved, type TargetSet } from "../resolve.js";
import { EXIT_CODES_HELP } from "../outcome.js";
import { runPerTarget } from "../multi-target.js";
import type { IxClient } from "../../client/api.js";
import { stderr } from "../stderr.js";
import { llmLine } from "../llm.js";
import { edgeTargetFor, rankTextUses, SourceFiles, withEdgeSites } from "../edge-sites.js";
import { renderWarning } from "../ui.js";
import { currentRunSignal } from "../../client/run-signal.js";
import { mapLimit } from "../../client/request-memo.js";
import { clipSnippet } from "./text.js";

const execFileAsync = promisify(execFile);

/** Edge queries `--all` keeps in flight at once: a 200-way tie is not a 400-request burst. */
export const ALL_CONCURRENCY = 4;

/** Rows per page of the text fallback. --limit does not apply to it. */
export const TEXT_FALLBACK_PAGE = 10;

/** Supertype levels walked for a Java method's dispatch callers. */
export const DISPATCH_DEPTH = 5;
/** Supertypes looked at, at most, for one target: each costs one small expand. */
export const DISPATCH_MAX_TYPES = 16;

const TYPE_KINDS = new Set(["class", "interface", "enum", "record", "trait", "object", "annotation"]);
const byName = (a: any, b: any): number =>
  String(a.name ?? "").localeCompare(String(b.name ?? "")) || String(a.id ?? "").localeCompare(String(b.id ?? ""));

/**
 * Callers that reach a Java method through a supertype. For a target `C.m`,
 * the callers of `S.m` for each supertype `S` of `C` (EXTENDS edges, which
 * include `implements`) that declares `m`: a call typed against `S` targets
 * `S.m` statically and may run `C.m`. Each row carries `dispatchVia: "S.m"`
 * (printed as `via`). Nothing for another language, or for a class with no
 * supertype in the graph (two requests then).
 */
export async function dispatchCallers(
  client: Pick<IxClient, "expand">,
  target: { id: string; name: string; path?: string },
): Promise<{ rows: any[]; capped: boolean }> {
  const none = { rows: [], capped: false };
  if (!/\.java$/i.test(target.path ?? "")) return none;
  const owners = (await client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] })).nodes
    .filter((n: any) => TYPE_KINDS.has(String(n.kind ?? "").toLowerCase()));
  if (owners.length !== 1) return none;
  const seen = new Set<string>([owners[0].id]);
  const members: Array<{ id: string; via: string }> = [];
  let frontier: any[] = owners;
  for (let depth = 0; depth < DISPATCH_DEPTH && frontier.length > 0 && seen.size <= DISPATCH_MAX_TYPES; depth++) {
    const parents = await mapLimit(frontier, ALL_CONCURRENCY, (n) => client.expand(n.id, { direction: "out", predicates: ["EXTENDS"] }));
    const next: any[] = [];
    for (const n of parents.flatMap((r) => r.nodes).sort(byName)) {
      if (!n?.id || seen.has(n.id) || seen.size > DISPATCH_MAX_TYPES) continue;
      seen.add(n.id);
      next.push(n);
    }
    const contained = await mapLimit(next, ALL_CONCURRENCY, (n) => client.expand(n.id, { direction: "out", predicates: ["CONTAINS"] }));
    next.forEach((type, i) => {
      for (const m of contained[i].nodes) {
        if (m?.id && m.id !== target.id && m.name === target.name && /^(method|function)$/i.test(String(m.kind ?? ""))) {
          members.push({ id: m.id, via: `${type.name}.${target.name}` });
        }
      }
    });
    frontier = next;
  }
  const calls = await mapLimit(members, ALL_CONCURRENCY, (m) => client.expand(m.id, { direction: "in", predicates: ["CALLS"] }));
  return {
    rows: calls.flatMap((r, i) => r.nodes.map((n: any) => ({ ...n, dispatchVia: members[i].via }))),
    capped: calls.some((r) => expandCapped(r)),
  };
}

/**
 * Direct rows as the graph gave them, then dispatch rows for callers not
 * already listed (a direct row wins; the first supertype wins among the rest).
 */
async function withDispatch(
  client: IxClient, target: { id: string; name: string; path?: string }, direct: any[],
): Promise<{ rows: any[]; capped: boolean }> {
  const dispatch = await dispatchCallers(client, target);
  if (dispatch.rows.length === 0) return { rows: direct, capped: false };
  const listed = new Set(direct.map((n) => n.id).filter(Boolean));
  const extra: any[] = [];
  for (const n of dispatch.rows) {
    if (n.id && listed.has(n.id)) continue;
    if (n.id) listed.add(n.id);
    extra.push(n);
  }
  return { rows: [...direct, ...extra], capped: dispatch.capped };
}

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

interface EdgeOpts {
  kind?: string; path?: string; pick?: number; suggest?: boolean; all?: boolean; limit: string; offset: string; format: string;
}

const ALL_FLAG = "When the symbol is ambiguous, answer for every candidate; rows are tagged with their candidate";

/**
 * `--all`: one edge query per candidate of an ambiguous symbol, unioned into
 * one paged list whose rows carry `candidate: <n>` (numbering the candidate
 * list printed with them). The whole blast radius of a name in one call,
 * still attributable row by row. No text fallback: an empty union is the
 * graph's answer for every candidate.
 */
async function edgesOfAll(
  client: IxClient,
  symbol: string,
  set: TargetSet,
  relation: "callers" | "callees",
  limit: number,
  offset: number,
  format: string,
  cmd: Command,
): Promise<void> {
  const healthCheck = checkGraphHealth(client, activeReadScope());
  // `n` is the candidate's `--pick` number (resolve.ts candidateSet).
  const candidates: EdgeCandidate[] = set.entities.map((e, i) => ({ n: e.n ?? i + 1, id: e.id, name: e.name, kind: e.kind, path: e.path }));
  const expanded = await mapLimit(set.entities, ALL_CONCURRENCY, (e) => client.expand(e.id, {
    direction: relation === "callers" ? "in" : "out",
    predicates: ["CALLS", "REFERENCES"],
  }));
  // Callers of a Java method also include its dispatch callers, per candidate.
  const merged = relation === "callers"
    ? await mapLimit(set.entities, ALL_CONCURRENCY, (e, i) => withDispatch(client, e, expanded[i].nodes))
    : expanded.map((r) => ({ rows: r.nodes, capped: false }));
  const rows = merged.flatMap((result, i) => result.rows.map((n: any) => ({ ...n, candidate: candidates[i].n })));
  const health = await healthDiagnostics(healthCheck);
  bannerOverRows(health, format, rows.length);
  const slice = sliceEdgeResults(rows, limit, offset, expanded.some((r) => expandCapped(r)) || merged.some((m) => m.capped));
  if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
  // Call sites are looked up against the candidate the row belongs to.
  const sites = await mapLimit(set.entities, ALL_CONCURRENCY, (e) => edgeTargetFor(client, e, relation));
  const files = new SourceFiles();
  const siteOf = new Map(candidates.map((c, i) => [c.n, sites[i]]));
  const sited = slice.rows.map((row: any) => withEdgeSites([row], relation, siteOf.get(row.candidate)!, { files })[0]);
  const diagnostics = [...(health.diagnostics ?? [])];
  const cut = candidatesCut(set, candidates.length, "Answered for");
  if (cut) diagnostics.push({ code: "candidates_truncated", message: cut });
  formatEdgeResults({ ...slice, rows: sited }, relation, symbol, format, undefined, "graph",
    diagnostics.length ? diagnostics : undefined, candidates);
}

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbols...>")
    .description("Show methods/functions that call the given symbols (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--no-suggest", "Disable did-you-mean candidates on unresolved targets")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--all", ALL_FLAG)
    .option("--limit <n>", "Max results to show", "50")
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `\nExamples:
  ix callers verify_token
  ix callers processPayment --format json
  ix callers parse --kind method --limit 20
  ix callers verify_token --offset 50
  ix callers handle --all --format llm
  ix callers parseConfig loadConfig --format llm

Several symbols answer in one call, grouped per symbol (json: {targets: [...]}).
${EXIT_CODES_HELP}`)
    .action(async (symbols: string[], opts: EdgeOpts, cmd: Command) => {
      const client = createClient();
      await runPerTarget(symbols, opts.format, (symbol) => callersOne(client, symbol, opts, cmd));
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--all", ALL_FLAG)
    .option("--limit <n>", "Max results to show", "50")
    .option("--offset <n>", OFFSET_FLAG, "0")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText("after", `\nExamples:
  ix callees processPayment
  ix callees parse --format json
  ix callees handle --all --format llm
${EXIT_CODES_HELP}`)
    .action(async (symbol: string, opts: EdgeOpts, cmd: Command) => {
      const client = createClient();
      const calleeLimit = parseInt(opts.limit, 10);
      const calleeOffset = parseOffset(opts.offset);
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick, all: opts.all };
      const set = await resolveTargetSetOrReport(client, symbol, resolveOpts, opts.format);
      if (!set) return;
      if (set.all) {
        await edgesOfAll(client, symbol, set, "callees", calleeLimit, calleeOffset, opts.format, cmd);
        return;
      }
      const target = set.entities[0];
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

async function callersOne(client: IxClient, symbol: string, opts: EdgeOpts, cmd: Command): Promise<void> {
  const limit = parseInt(opts.limit, 10);
  const offset = parseOffset(opts.offset);
  const resolveOpts = { suggest: opts.suggest, suggestCommand: "callers", kind: opts.kind, path: opts.path, pick: opts.pick, all: opts.all };
  const set = await resolveTargetSetOrReport(client, symbol, resolveOpts, opts.format);
  if (!set) return;
  if (set.all) {
    await edgesOfAll(client, symbol, set, "callers", limit, offset, opts.format, cmd);
    return;
  }
  const target = set.entities[0];
  if (opts.format === "text") printResolved(target);
  const healthCheck = checkGraphHealth(client, activeReadScope());
  // Use expand by entity ID to avoid aggregating results across all same-named entities
  const direct = await client.expand(target.id, {
    direction: "in",
    predicates: ["CALLS", "REFERENCES"],
  });
  const merged = await withDispatch(client, target, direct.nodes);
  const result = { ...direct, nodes: merged.rows };
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
    const slice = sliceEdgeResults(result.nodes, limit, offset, expandCapped(direct) || merged.capped);
    if (slice.nextOffset !== undefined) slice.next = nextPageCommand(cmd, [symbol], slice.nextOffset);
    const site = await edgeTargetFor(client, target, "callers");
    formatEdgeResults({ ...slice, rows: withEdgeSites(slice.rows, "callers", site) }, "callers", target.name, opts.format, target, "graph", health.diagnostics);
  }
}
