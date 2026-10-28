// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { createClient } from "../../client/factory.js";
import { resolveWorkspaceId } from "../bootstrap.js";
import { resolveReadSystemId } from "../resolve.js";
import { llmLine, llmError, type LlmValue } from "../llm.js";
import { printJson, sliceRanked, truncationHint, type Slice } from "../format.js";
import { parseWaitSecondsOption } from "../options.js";
import { canRenderProgress } from "../stderr.js";

export interface SmellCandidate {
  file_id: string;
  file: string;
  smell: string;
  confidence: number;
  signals: Record<string, unknown>;
  inference_version: string;
}

export interface SmellReport {
  rev: number;
  run_at: string;
  count: number;
  candidates: SmellCandidate[];
}

/** Default cap on text and llm output. JSON is uncapped unless --limit is given. */
const DEFAULT_LIMIT = 50;

/**
 * Extensions of files that hold no parsed code: docs, templates and
 * data/config. An orphan of one of these is not an architecture finding.
 * CSS, HTML, SQL and shell stay out of this set: an orphan stylesheet, page
 * or script can be a real finding.
 */
const NON_SOURCE_EXTENSIONS = new Set([
  // docs
  ".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc",
  // templates
  ".hbs", ".handlebars", ".ejs", ".mustache", ".njk", ".j2", ".jinja", ".jinja2",
  ".liquid", ".tmpl", ".tpl", ".template",
  // data / config
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".lock", ".csv", ".svg",
]);

/** Extensionless basenames that are build files, so still source. */
const EXTENSIONLESS_SOURCE = new Set([
  "dockerfile", "containerfile", "makefile", "gnumakefile", "rakefile", "gemfile",
  "justfile", "jenkinsfile", "vagrantfile", "procfile", "podfile", "brewfile",
  "fastfile", "guardfile", "berksfile", "capfile", "snakefile", "tiltfile",
  "build", "workspace",
  // shell dotfiles the ingester parses as Bash
  ".bashrc", ".bash_profile", ".bash_aliases", ".bash_logout", ".zshrc", ".zprofile", ".zshenv", ".profile",
]);

/**
 * True for an Orphan File row whose path is a doc, template or data/config
 * file, or an extensionless file such as README or LICENSE that is not a
 * known build file. Never true for any other smell kind.
 */
export function isNonSourceOrphan(c: SmellCandidate): boolean {
  if (c.smell !== "has_smell.orphan_file") return false;
  const path = c.file ?? "";
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (base === "") return false;
  const dot = base.lastIndexOf(".");
  // No extension (README, LICENSE, CODEOWNERS) or a bare dotfile (.gitignore):
  // non-source unless it is a known build file.
  if (dot <= 0) return !EXTENSIONLESS_SOURCE.has(base);
  return NON_SOURCE_EXTENSIONS.has(base.slice(dot));
}

export interface SmellSelection {
  slice: Slice<SmellCandidate>;
  /** Orphan File rows dropped as non-source before the cut. */
  filteredNonSource: number;
}

/**
 * Drop non-source orphan rows, rank by confidence (highest first, stable among
 * ties), then cut to `limit`. `total` on the slice counts what survived the
 * filter.
 */
export function selectSmells(report: SmellReport, limit: number, filterNonSource = true): SmellSelection {
  const kept = filterNonSource ? report.candidates.filter(c => !isNonSourceOrphan(c)) : report.candidates;
  const sorted = [...kept].sort((a, b) => b.confidence - a.confidence);
  return {
    slice: sliceRanked(sorted, limit),
    filteredNonSource: report.candidates.length - kept.length,
  };
}

/**
 * The cap to apply: an explicit --limit wins (0 = all). Without one, text and
 * llm stop at DEFAULT_LIMIT and JSON returns everything, because MCP ix_smells
 * and plugin fallbacks filter the JSON by path themselves.
 */
function resolveLimit(raw: string | undefined, format: string): number {
  if (raw === undefined) return format === "json" ? Infinity : DEFAULT_LIMIT;
  const n = parseInt(raw, 10);
  return !Number.isFinite(n) || n <= 0 ? Infinity : n;
}

/**
 * How long `ix smells` waits for a fresh analysis, in seconds. An agent's
 * formats (json, llm) get a short budget and fall back to the stored results;
 * a person at a terminal (text) waits longer, with a progress line.
 */
const AGENT_WAIT_SECONDS = 20;
const TEXT_WAIT_SECONDS = 10 * 60;
const PROGRESS_EVERY_MS = 10_000;

/** The wait budget: --wait, then IX_SMELLS_WAIT (whole seconds), then the format's default. */
function smellsWaitSeconds(format: string, wait?: number, env = process.env.IX_SMELLS_WAIT): number {
  if (wait !== undefined) return wait;
  const raw = env?.trim();
  // Matched, not parsed: `parseInt("15m")` is 15. A malformed value is ignored.
  if (raw && /^\d+$/.test(raw) && Number(raw) > 0 && Number.isSafeInteger(Number(raw))) return Number(raw);
  return format === "json" || format === "llm" ? AGENT_WAIT_SECONDS : TEXT_WAIT_SECONDS;
}

function formatWait(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** Why a fresh analysis was not shown: the budget ran out, or the backend refused it (kOS: admin only). */
type StaleReason = "timeout" | "not_permitted";

/**
 * Node's fetch (undici) gives up on a response whose headers have not arrived
 * after 300 s, whatever the request's own timeout, and rejects with `TypeError:
 * fetch failed` carrying this code in its `cause`. `POST /v1/smells` sends its
 * headers only when the analysis is done, so a wait over 5 minutes ends here.
 */
function isHeadersTimeout(err: unknown): boolean {
  for (let e: unknown = err, hops = 0; e && hops < 5; hops++) {
    if ((e as { code?: unknown }).code === "UND_ERR_HEADERS_TIMEOUT") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The reasons that fall back to stored results. A timeout is the request's
 * own `AbortSignal.timeout` firing (fetch rejects with its `TimeoutError`), or
 * the HTTP client's own limit on waiting for a response; a 403 is the backend
 * refusing to run analysis for this caller. Anything else is today's error.
 */
function staleReasonOf(err: unknown): StaleReason | undefined {
  const e = err as { name?: unknown; message?: unknown } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  if (e?.name === "TimeoutError" || /aborted due to timeout/i.test(message) || isHeadersTimeout(err)) return "timeout";
  if (/^403:/.test(message)) return "not_permitted";
  return undefined;
}

/**
 * Which run the stored claims are from: the newest `rev` a stored row (or the
 * response itself) carries, and that row's `run_at`. Either is null when the
 * backend's stored rows do not carry it.
 */
function storedSmellsAsOf(stored: any): { computed_rev: number | null; computed_at: string | null } {
  let rev: number | null = typeof stored?.rev === "number" ? stored.rev : null;
  let at: string | null = typeof stored?.run_at === "string" ? stored.run_at : null;
  if (rev === null && at === null) {
    for (const row of Array.isArray(stored?.smells) ? stored.smells : []) {
      if (typeof row?.rev !== "number" || (rev !== null && row.rev <= rev)) continue;
      rev = row.rev;
      at = typeof row.run_at === "string" ? row.run_at : null;
    }
  }
  return { computed_rev: rev, computed_at: at };
}

/**
 * What the stale header says happened. `waitedSeconds` is set when the HTTP
 * client stopped waiting before the budget ran out, so the message gives the
 * time actually waited rather than the budget.
 */
function staleCause(reason: StaleReason, waitSeconds: number, waitedSeconds?: number): string {
  if (reason === "not_permitted") return "not permitted to run a fresh analysis";
  return waitedSeconds === undefined
    ? `fresh analysis did not finish within ${formatWait(waitSeconds)}`
    : `fresh analysis did not finish within ${formatWait(waitedSeconds)}, the longest the HTTP client waits for an answer`;
}

function staleMessage(cause: string, asOf: { computed_rev: number | null; computed_at: string | null }): string {
  const from = asOf.computed_rev !== null
    ? `rev ${asOf.computed_rev}${asOf.computed_at ? ` (${asOf.computed_at})` : ""}`
    : asOf.computed_at ?? "an earlier run";
  return `${cause}; showing stored results from ${from}`;
}

/**
 * While a text-format run waits, rewrite one stderr line about every 10 s
 * ("analysing smells… 40 s"); only on a terminal. Returns the stop function,
 * which clears the line.
 */
function startSmellsProgress(): () => void {
  if (!canRenderProgress()) return () => {};
  const started = Date.now();
  let drawn = false;
  const timer = setInterval(() => {
    drawn = true;
    const seconds = Math.round((Date.now() - started) / 1000);
    process.stderr.write(`\r${chalk.dim(`analysing smells… ${seconds} s`)}`);
  }, PROGRESS_EVERY_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    if (drawn) process.stderr.write("\r\x1b[K");
  };
}

const SMELL_LABELS: Record<string, string> = {
  "has_smell.orphan_file":          "Orphan File",
  "has_smell.god_module":           "God Module",
  "has_smell.weak_component_member":"Weak Component",
};

export function registerSmellsCommand(program: Command): void {
  program
    .command("smells")
    .description("Detect architecture smells in the codebase")
    .option("--format <fmt>",              "Output format (text|json|llm)",    "text")
    .option("--orphan-max-connections <n>","Max connections for orphan files",  "0")
    .option("--god-module-chunks <n>",     "Min chunks for god module",         "20")
    .option("--god-module-fan <n>",        "Min fan-in/out for god module",     "15")
    .option("--weak-max-neighbors <n>",    "Max neighbors for weak component",  "1")
    .option("--list",                      "List existing smell claims without rerunning")
    .option("--limit <n>",                 "Max candidates to show, highest confidence first (0 = all, non-source orphans included; with --list, caps the stored claims)")
    .option("--wait <seconds>",            "How long to wait for a fresh analysis before showing stored results instead (default 20 for json/llm, 600 for text; IX_SMELLS_WAIT)", parseWaitSecondsOption)
    .addHelpText("after", `
Runs graph-query-based architecture smell detection and stores results as
versioned claims (inference_version=smell_v1) on affected File nodes.

Smells detected:
  orphan_file          Files with no import or call connections
  god_module           Files with high chunk count or fan-in/fan-out
  weak_component_member Files connected to very few others

Examples:
  ix smells
  ix smells --god-module-chunks 15 --god-module-fan 10
  ix smells --format json
  ix smells --limit 200
  ix smells --limit 0
  ix smells --list
  ix smells --format json --wait 60

json and llm wait 20 s for a fresh analysis, text 10 minutes (--wait or
IX_SMELLS_WAIT, in seconds, changes it). If the analysis has not finished by
then, or the backend does not permit running it, the stored results from the
last completed run are shown instead, marked stale. The HTTP client itself
stops waiting for an answer after 5 minutes, so a longer wait ends there.`)
    .action(async (opts: {
      format: string;
      orphanMaxConnections: string;
      godModuleChunks: string;
      godModuleFan: string;
      weakMaxNeighbors: string;
      list?: boolean;
      limit?: string;
      wait?: number;
    }) => {
      const client = createClient();
      const systemId = await resolveReadSystemId(client);

      if (opts.list) {
        let result: any;
        try {
          result = await client.listSmells({ workspaceId: systemId ? undefined : resolveWorkspaceId(), systemId });
        } catch (err: any) {
          if (opts.format === "llm") console.log(llmError("backend_error", err.message ?? "smells request failed"));
          else console.error(chalk.red("Error:"), err.message);
          process.exitCode = 1;
          return;
        }
        // Without --limit, --list prints every stored claim, as before. With
        // one, it keeps the highest-confidence claims (0 = all). Claim rows
        // carry only an entity id, so no path filter applies here.
        const listLimit = opts.limit === undefined ? undefined : resolveLimit(opts.limit, opts.format);
        const listSlice = sliceRanked<any>(
          result.smells ?? [],
          listLimit ?? Infinity,
          listLimit === undefined ? undefined : (s) => -(Number(s.confidence) || 0),
        );
        if (opts.format === "json") {
          printJson({
            count: listSlice.total,
            ...(listLimit === undefined ? {} : { shown: listSlice.shown, truncated: listSlice.truncated }),
            inference_version: "smell_v1",
            smells: listSlice.rows.map((s: any) => ({
              smell: s.smell,
              entity_id: s.entity_id?.slice(0, 12),
              confidence: s.confidence,
            })),
          });
          return;
        }
        if (opts.format === "llm") {
          for (const line of renderSmellsListLlm(listSlice.rows, listLimit === undefined ? undefined : listSlice)) console.log(line);
          return;
        }
        if (listSlice.total === 0) {
          console.log(chalk.dim("No smell claims found. Run `ix smells` to detect."));
          return;
        }
        printSmellsListText(listSlice);
        return;
      }

      if (opts.format !== "json") {
        process.stderr.write(chalk.dim("Running smell detection...\n"));
      }

      const waitSeconds = smellsWaitSeconds(opts.format, opts.wait);
      const stopProgress = opts.format === "json" || opts.format === "llm" ? () => {} : startSmellsProgress();
      const startedAt = Date.now();
      let report: SmellReport;
      try {
        report = await client.runSmells({
          orphanMaxConnections: parseInt(opts.orphanMaxConnections, 10),
          godModuleChunks:      parseInt(opts.godModuleChunks, 10),
          godModuleFan:         parseInt(opts.godModuleFan, 10),
          weakMaxNeighbors:     parseInt(opts.weakMaxNeighbors, 10),
          workspaceId:          systemId ? undefined : resolveWorkspaceId(),
          systemId,
          timeoutMs:            waitSeconds * 1000,
        }) as SmellReport;
      } catch (err: any) {
        stopProgress();
        const reason = staleReasonOf(err);
        if (reason !== undefined) {
          // The client gave up or was refused. Whether the backend carries on
          // is not ours to know, so say only what the stored results are.
          const waited = isHeadersTimeout(err) ? Math.round((Date.now() - startedAt) / 1000) : undefined;
          await printStoredSmells(client, { workspaceId: systemId ? undefined : resolveWorkspaceId(), systemId }, opts, staleCause(reason, waitSeconds, waited), reason);
          return;
        }
        if (opts.format === "llm") console.log(llmError("backend_error", err.message ?? "smells request failed"));
        else console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }
      stopProgress();

      // Plain `--format json` is the raw contract MCP ix_smells and plugin
      // fallbacks path-filter themselves, so it neither caps nor drops rows
      // unless --limit is passed. An explicit `--limit 0` means everything,
      // so it drops nothing either, in every format.
      const rawJson = opts.format === "json" && opts.limit === undefined;
      const limit = resolveLimit(opts.limit, opts.format);
      const everything = opts.limit !== undefined && limit === Infinity;
      const selection = selectSmells(report, limit, !(rawJson || everything));
      const { slice, filteredNonSource } = selection;

      if (opts.format === "json") {
        // Compact: hoist inference_version to top, drop file_id UUIDs
        const compact: Record<string, unknown> = {
          rev: report.rev,
          run_at: report.run_at,
          count: slice.total,
          shown: slice.shown,
          truncated: slice.truncated,
          ...(filteredNonSource > 0 ? { filtered_non_source: filteredNonSource } : {}),
          inference_version: "smell_v1",
          candidates: slice.rows.map(c => ({
            file: c.file,
            smell: c.smell,
            confidence: c.confidence,
            signals: c.signals,
          })),
        };
        printJson(compact);
        return;
      }

      if (opts.format === "llm") {
        for (const line of renderSmellsRunLlm(report, selection)) console.log(line);
        return;
      }

      const countText = slice.truncated
        ? `${slice.total} candidates · showing ${slice.shown}`
        : `${slice.total} candidates`;
      const hiddenText = filteredNonSource > 0
        ? ` (${filteredNonSource} non-source orphan files hidden)`
        : "";
      console.log(
        `\n${chalk.bold("Architecture Smells")}  ` +
        chalk.dim(`rev ${report.rev} · ${countText}${hiddenText}`)
      );

      if (slice.total === 0) {
        console.log(chalk.green("\n  No smell candidates found."));
        return;
      }

      // Group the shown rows by smell kind; each group stays confidence-sorted.
      const byKind = new Map<string, SmellCandidate[]>();
      for (const c of slice.rows) {
        if (!byKind.has(c.smell)) byKind.set(c.smell, []);
        byKind.get(c.smell)!.push(c);
      }

      for (const [kind, candidates] of byKind) {
        const label = SMELL_LABELS[kind] ?? kind;
        console.log(`\n${chalk.bold(label)}  ${chalk.dim(`(${candidates.length})`)}`);

        for (const c of candidates) {
          const conf = confidenceBar(c.confidence);
          const fileName = c.file.length > 45
            ? "…" + c.file.slice(-44)
            : c.file.padEnd(45);
          const signalStr = formatSignals(c.smell, c.signals);
          console.log(`  ${conf} ${chalk.dim(fileName)}  ${chalk.dim(signalStr)}`);
        }
      }

      if (slice.truncated) console.log(chalk.dim(`\n${truncationHint(slice, "smell candidates")}`));

      console.log(chalk.dim(`\nSmell claims stored with inference_version=smell_v1. Use 'ix smells --list' to retrieve.`));
    });
}

/** The text rendering of stored smell claims (`--list`, and the stale fallback). */
function printSmellsListText(listSlice: Slice<any>): void {
  const shownNote = listSlice.truncated ? ` · showing ${listSlice.shown}` : "";
  console.log(`\n${chalk.bold("Smell Claims")}  ${chalk.dim(`(${listSlice.total} total${shownNote})`)}\n`);
  for (const s of listSlice.rows) {
    const label = SMELL_LABELS[s.smell] ?? s.smell;
    console.log(`  ${chalk.yellow(label.padEnd(20))} ${chalk.dim(s.entity_id?.slice(0, 8))}  ${chalk.dim(s.inference_version ?? "")}`);
  }
  if (listSlice.truncated) console.log(chalk.dim(`\n${truncationHint(listSlice, "smell claims")}`));
}

/**
 * Answer with the stored smell claims (`GET /v1/smells`, what `--list`
 * reads) when a fresh run timed out or was refused, marked stale: json gains
 * `stale`, `computed_at`, `computed_rev` and a `smells_stale` diagnostic, llm
 * one `diagnostic code=smells_stale` record after its header, text a "Stale:"
 * line. Rows are ranked by confidence and capped like a fresh run (50 for
 * text and llm, all for json, unless --limit). With nothing stored, or the
 * stored results unreadable, it is today's error: exit 1, `backend_error`.
 */
async function printStoredSmells(
  client: { listSmells(opts: { workspaceId?: string; systemId?: string }): Promise<any> },
  scope: { workspaceId?: string; systemId?: string },
  opts: { format: string; limit?: string },
  cause: string,
  reason: StaleReason,
): Promise<void> {
  const hint = reason === "timeout"
    ? "Run ix smells interactively, or with a longer --wait."
    : "Ask someone permitted to run analysis on this backend to run ix smells.";
  const fail = (message: string) => {
    if (opts.format === "llm") console.log(llmError("backend_error", `${message}. ${hint}`));
    else console.error(chalk.red("Error:"), `${message}. ${hint}`);
    process.exitCode = 1;
  };

  let stored: any;
  try {
    stored = await client.listSmells(scope);
  } catch (err: any) {
    fail(`${cause}, and stored results could not be read (${err?.message ?? "smells request failed"})`);
    return;
  }
  const rows: any[] = Array.isArray(stored?.smells) ? stored.smells : [];
  if (rows.length === 0) {
    fail(`${cause} and no stored results exist`);
    return;
  }

  const asOf = storedSmellsAsOf(stored);
  const message = staleMessage(cause, asOf);
  const slice = sliceRanked<any>(rows, resolveLimit(opts.limit, opts.format), (s) => -(Number(s.confidence) || 0));

  if (opts.format === "json") {
    printJson({
      count: slice.total,
      shown: slice.shown,
      truncated: slice.truncated,
      inference_version: "smell_v1",
      smells: slice.rows.map((s: any) => ({
        smell: s.smell,
        entity_id: s.entity_id?.slice(0, 12),
        confidence: s.confidence,
      })),
      stale: true,
      computed_at: asOf.computed_at,
      computed_rev: asOf.computed_rev,
      diagnostics: [{ code: "smells_stale", reason, message }],
    });
    return;
  }
  if (opts.format === "llm") {
    const lines = renderSmellsListLlm(slice.rows, slice);
    lines.splice(1, 0, llmLine("diagnostic", [
      ["code", "smells_stale"],
      ["reason", reason],
      ["computed_rev", asOf.computed_rev ?? undefined],
      ["computed_at", asOf.computed_at ?? undefined],
      ["message", message],
    ]));
    for (const line of lines) console.log(line);
    return;
  }
  console.log(chalk.yellow(`\nStale: ${message}.`));
  printSmellsListText(slice);
}

function confidenceBar(conf: number): string {
  const filled = Math.round(conf * 5);
  const bar    = "█".repeat(filled) + "░".repeat(5 - filled);
  const color  = conf >= 0.75 ? chalk.red : conf >= 0.5 ? chalk.yellow : chalk.dim;
  return color(bar);
}

/**
 * Render `ix smells --list` claims as llm records. With a slice (an explicit
 * --limit), the header carries the total and `shown`, plus a truncation
 * diagnostic when rows were cut.
 */
export function renderSmellsListLlm(smells: any[], slice?: Slice<unknown>): string[] {
  const lines = [llmLine("smells", [
    ["count", slice ? slice.total : smells.length],
    ["shown", slice ? slice.shown : undefined],
    ["version", "smell_v1"],
  ])];
  if (slice?.truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["message", truncationHint(slice, "smell claims")],
    ]));
  }
  for (const s of smells) {
    lines.push(llmLine("smell", [
      ["kind", s.smell],
      ["entity", s.entity_id?.slice(0, 12)],
      ["confidence", s.confidence],
      ["version", s.inference_version],
    ]));
  }
  return lines;
}

/**
 * Render a fresh `ix smells` detection run as llm records, highest-confidence
 * first. Without a selection, every candidate is shown (no filter, no cap).
 */
export function renderSmellsRunLlm(report: SmellReport, selection?: SmellSelection): string[] {
  const { slice, filteredNonSource } = selection ?? {
    slice: sliceRanked([...report.candidates].sort((a, b) => b.confidence - a.confidence), Infinity),
    filteredNonSource: 0,
  };
  const lines = [llmLine("smells", [
    ["rev", report.rev],
    ["count", slice.total],
    ["shown", slice.shown],
    ["filtered_non_source", filteredNonSource > 0 ? filteredNonSource : undefined],
    ["version", "smell_v1"],
  ])];
  if (slice.truncated) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["message", truncationHint(slice, "smell candidates")],
    ]));
  }
  for (const c of slice.rows) {
    lines.push(llmLine("smell", [
      ["kind", c.smell],
      ["file", c.file],
      ["confidence", c.confidence],
      ...signalFields(c.smell, c.signals),
    ]));
  }
  return lines;
}

/**
 * Structured signal fields per smell kind for the llm format. Mirrors the
 * fields shown in text mode. A god_module's chunk count is dropped when 0
 * (uncomputed / no signal); fan-in/out are the defining signals and kept.
 */
function signalFields(smellKind: string, signals: Record<string, unknown>): Array<[string, LlmValue]> {
  const num = (v: unknown): LlmValue =>
    typeof v === "number" || typeof v === "string" ? v : undefined;
  switch (smellKind) {
    case "has_smell.orphan_file":
      return [["connections", num(signals["connectivity"]) ?? 0]];
    case "has_smell.god_module": {
      const chunks = num(signals["chunks"]);
      return [
        ["chunks", chunks === 0 ? undefined : chunks],
        ["fan_in", num(signals["fan_in"])],
        ["fan_out", num(signals["fan_out"])],
      ];
    }
    case "has_smell.weak_component_member":
      return [["neighbors", num(signals["neighbor_count"]) ?? 0]];
    default:
      return [];
  }
}

function formatSignals(smellKind: string, signals: Record<string, unknown>): string {
  switch (smellKind) {
    case "has_smell.orphan_file":
      return `connections=${signals["connectivity"] ?? 0}`;
    case "has_smell.god_module":
      return [
        signals["chunks"]  !== undefined ? `chunks=${signals["chunks"]}` : null,
        signals["fan_in"]  !== undefined ? `fan_in=${signals["fan_in"]}` : null,
        signals["fan_out"] !== undefined ? `fan_out=${signals["fan_out"]}` : null,
      ].filter(Boolean).join(" ");
    case "has_smell.weak_component_member":
      return `neighbors=${signals["neighbor_count"] ?? 0}`;
    default:
      return "";
  }
}
