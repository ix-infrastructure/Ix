// Copyright 2026 Ix Infrastructure Inc.

/**
 * ui.ts — Ix CLI brand presentation layer.
 *
 * Centralizes color, formatting, and layout for all CLI commands.
 * Do not add command logic here. Do not extend format.ts.
 */

import chalk from "chalk";

import { llmError, llmLine } from "./llm.js";
import { noteResolutionNotices, printJson, relativePath } from "./format.js";
import { isQuiet } from "./output-shape.js";
import type { AmbiguousResult, ResolutionNotice, ResolveResult, Suggestion } from "./resolve.js";
import { forMcp } from "./next-step.js";
import { graphHealthJson, graphHealthLlmFields, graphHealthProse, type GraphHealth } from "./graph-health.js";
import { setOutcome } from "./outcome.js";

// ── Brand palette ─────────────────────────────────────────────────────────────
//
//   Primary / kind accent   chalk.cyan
//   Entity names / values   chalk.bold
//   Section titles          chalk.bold
//   Success                 chalk.green
//   Warning / note          chalk.yellow / chalk.dim
//   Error                   chalk.red
//   Muted labels            chalk.dim

// ── Section / structure ───────────────────────────────────────────────────────

/** Print a bold section title preceded by a blank line. */
export function renderSection(title: string): void {
  if (isQuiet()) return;
  console.log(chalk.bold(`\n${title}`));
}

/**
 * Print a dim label + value row.
 * Label is colon-suffixed and padded to 18 characters.
 */
export function renderKeyValue(label: string, value: string, indent = "  "): void {
  console.log(`${indent}${chalk.dim((label + ":").padEnd(18))}${value}`);
}

// ── Entity emphasis ───────────────────────────────────────────────────────────

/** Render an entity kind: cyan, padded to 10 characters. */
export function colorizeKind(kind: string): string {
  return chalk.cyan((kind ?? "").padEnd(10));
}

/** Render a resolved entity name: bold. */
export function colorizeEntity(name: string): string {
  return chalk.bold(name);
}

// ── Hierarchy / breadcrumb ────────────────────────────────────────────────────

/**
 * Render a breadcrumb path as a string.
 * Node names are joined with a dim separator.
 * Pass pre-humanized node names when applicable.
 */
export function renderBreadcrumb(
  nodes: Array<{ name: string; kind?: string }>,
  separator = " → ",
): string {
  return nodes.map((n) => n.name).join(chalk.dim(separator));
}

// ── Alerts ────────────────────────────────────────────────────────────────────

/**
 * Advisory hint, stale data, or informational note.
 *
 * Silenced by `--quiet`. A warning is not: `renderWarning` says something is
 * wrong with the answer, and a caller asking for less output is not asking to
 * be told less about that.
 */
export function renderNote(text: string): void {
  if (isQuiet()) return;
  console.log(`  ${chalk.dim("Note")}  ${chalk.dim(text)}`);
}

/** Partial or degraded result. */
export function renderWarning(text: string): void {
  console.log(`  ${chalk.yellow("Warning")}  ${chalk.yellow(text)}`);
}

/**
 * The same warning, on stderr.
 *
 * Every renderer here writes to stdout, which is where a command's payload
 * goes: a warning printed alongside a `--format json` bundle lands inside what
 * the caller pipes to `jq`, and inside the record stream for `--format llm`.
 * When a command has a machine format, its prose belongs on the other stream.
 *
 * Same padding and same colour as `renderWarning`, deliberately — this had been
 * hand-rolled twice as `console.error("  Warning  " + text)`, which put the
 * convention in three places and dropped the colour humans were getting.
 */
export function renderWarningErr(text: string): void {
  console.error(`  ${chalk.yellow("Warning")}  ${chalk.yellow(text)}`);
}

/** Success confirmation. */
export function renderSuccess(text: string): void {
  console.log(`  ${chalk.green(text)}`);
}

/** Command failure or unresolved target. */
export function renderError(text: string): void {
  console.log(`  ${chalk.red("Error")}  ${chalk.red(text)}`);
}

// ── Resolved header ───────────────────────────────────────────────────────────

/** Print the "Resolved: kind name" header shown at the top of most command text output. */
export function renderResolvedHeader(kind: string, name: string): void {
  if (isQuiet()) return;
  console.log(`${chalk.bold("Resolved:")} ${chalk.cyan(kind)} ${chalk.bold(name)}`);
}

/**
 * Report a command failure in the format the caller asked for, and mark the run
 * failed.
 *
 * Both halves matter. `--format llm` gets the `error code=... message="..."`
 * record on stdout that `callers.ts`, `contains.ts`, `depends.ts`, `diff.ts` and
 * `history.ts` already emit and that docs/llm-format.md specifies: an agent is
 * told to pass the flag unconditionally, so an error it cannot parse is an
 * error it cannot act on. Every other format gets the human line on stderr, so
 * a `--format json` caller piping to `jq` never finds prose in the payload.
 *
 * One function because it was otherwise written twice, byte for byte including
 * its docblock, in `context.ts` and `diff.ts`, while five more refusals in the
 * same handler wrote `renderWarning` — which is `console.log` — and left the
 * exit code at 0, so a script could not tell a refusal from an empty success.
 * `subsystems.ts` carries six more copies of the stderr half.
 *
 * Here rather than in `llm.ts`: this is an output-routing decision, and putting
 * it there forced `chalk` into the module documented as the token-minimal wire
 * format renderer, for the sake of one human-facing line.
 */
export function reportFailure(code: string, message: string, format?: string): void {
  if (format === "llm") console.log(llmError(code, message));
  else console.error(chalk.red("Error:"), message);
  process.exitCode = 1;
}

/** Report a resolver miss without corrupting machine-readable stdout. */
/**
 * The one message for a target that does not exist.
 *
 * Split out from `reportUnresolvedTarget` so a command can emit the shared
 * record *without* the exit code. `ix diff` needs exactly that: its payload is
 * wrong today and can be fixed now, while the exit-code half is queued behind
 * the plugin work (CONTRIBUTING -> CLI Standards -> Exit codes).
 */
export function unresolvedTargetMessage(target: string | string[]): string {
  if (Array.isArray(target)) {
    return `No entities found matching ${target.map((value) => `"${value}"`).join(" or ")}.`;
  }
  return `No entity found matching "${target}".`;
}

/** The `--format json` record for a target that does not exist. */
export function unresolvedTargetRecord(target: string | string[]): { error: string; message: string; targets?: string[] } {
  return {
    error: "unresolved_target",
    message: unresolvedTargetMessage(target),
    ...(Array.isArray(target) ? { targets: target } : {}),
  };
}

export function reportUnresolvedTarget(
  target: string | string[],
  format?: string,
  suggestions?: Suggestion[],
  detail?: { reason?: string; message?: string; graph?: GraphHealth; files?: string[] },
): void {
  // A file target's miss says which of "not ingested" and "does not exist" it
  // is; the code stays `unresolved_target` so a consumer routes on one slug.
  const message = detail?.message ?? unresolvedTargetMessage(target);
  const near = suggestions ?? [];
  if (format === "json") {
    printJson({
      ...unresolvedTargetRecord(target),
      message,
      ...(detail?.reason ? { reason: detail.reason } : {}),
      ...(detail?.files?.length ? { files: detail.files } : {}),
      ...(near.length ? { suggestions: near } : {}),
      ...(detail?.graph ? { graph: graphHealthJson(detail.graph) } : {}),
    });
  } else if (format === "llm") {
    const lines = [
      llmError("unresolved_target", message, [
        ...(detail?.reason ? [["reason", detail.reason]] as Array<[string, string]> : []),
        ...(detail?.files?.length ? [["files", detail.files.join(",")]] as Array<[string, string]> : []),
      ]),
      ...(detail?.graph ? [llmLine("graph", graphHealthLlmFields(detail.graph))] : []),
      ...candidateLines(near, "suggestion"),
    ];
    if (near.length) {
      lines.push(llmLine("hint", [["text", "Re-run with one of these names, or narrow with --path."]]));
    }
    console.log(lines.join("\n"));
  } else {
    if (detail?.graph) console.error(chalk.yellow(graphHealthProse(detail.graph)));
    if (!near.length) {
      setOutcome("not_found");
      return;
    }
    // The resolver already wrote the miss itself for a person; this adds the
    // part that makes it actionable.
    console.error(chalk.dim("Did you mean:"));
    for (const s of near) {
      console.error(`  ${chalk.cyan((s.kind || "").padEnd(10))} ${s.name}${s.path ? chalk.dim(` in ${s.path}`) : ""}`);
    }
  }
  setOutcome("not_found");
}

/**
 * Candidate records for the llm format.
 *
 * `read` has emitted name, kind, path and id per candidate since its own
 * renderer landed; everything else emitted `candidates=1:config.ts,2:config.ts,
 * 3:config.ts` -- three entries that differ in nothing an agent can choose by,
 * from the only field that was included. One call has to be enough to pick.
 */
function candidateLines(
  candidates: ReadonlyArray<{ id?: string; name: string; kind?: string; path?: string }>,
  record: "candidate" | "suggestion",
): string[] {
  return candidates.map((candidate, index) => llmLine(record, [
    ["n", String(index + 1)],
    ["name", candidate.name],
    ["kind", candidate.kind],
    ["path", candidate.path ? relativePath(candidate.path) ?? candidate.path : undefined],
    // Short form: the full uuid is four times the tokens and nothing here needs
    // it -- `--pick <n>` is the way to choose, and a prefix resolves an entity.
    ["id", candidate.id ? candidate.id.slice(0, 8) : undefined],
  ]));
}

export function reportAmbiguousTarget(
  target: string,
  result: AmbiguousResult,
  format?: string,
  opts?: { kind?: string; path?: string; offerAll?: boolean },
): void {
  const message = `Ambiguous symbol "${target}".`;
  if (format === "json") {
    printJson({
      error: "ambiguous_target",
      message,
      candidates: result.candidates,
      ...(result.total != null ? { total: result.total } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      diagnostics: result.diagnostics ?? [],
    });
    return;
  }
  if (format === "llm") {
    // Over MCP the same three levers are tool arguments, not flags.
    const mcp = forMcp();
    const hints = [mcp ? "pick=<n>" : "--pick <n>"];
    if (!opts?.kind) hints.push(mcp ? "kind=<kind>" : "--kind");
    if (!opts?.path) hints.push(mcp ? "path=<file substring>" : "--path");
    if (opts?.offerAll && !mcp) hints.push("--all");
    const lines = [
      llmError("ambiguous_target", message, [
        ["count", String(result.candidates.length)],
        ...(result.total != null ? [["shown", String(result.candidates.length)], ["total", String(result.total)]] as Array<[string, string]> : []),
        ...(result.truncated ? [["truncated", "true"]] as Array<[string, string]> : []),
      ]),
      ...candidateLines(result.candidates, "candidate"),
      llmLine("hint", [["text", `${mcp ? "Pass" : "Use"} ${hints.join(" or ")} to disambiguate.`]]),
      ...(result.diagnostics ?? []).map((d) => llmLine("diagnostic", [["code", d.code], ["message", d.message]])),
    ];
    console.log(lines.join("\n"));
    return;
  }

  console.error(`Ambiguous symbol "${target}":`);
  if (result.total != null && (result.truncated || result.total > result.candidates.length)) {
    console.error(chalk.dim(`  Showing ${result.candidates.length} of ${result.truncated ? ">=" : ""}${result.total}`));
  }
  for (let index = 0; index < result.candidates.length; index += 1) {
    const candidate = result.candidates[index];
    const shortPath = candidate.path ? ` in ${candidate.path}` : "";
    console.error(
      `  ${index + 1}. ${chalk.cyan((candidate.kind ?? "").padEnd(10))} ${chalk.dim(candidate.id.slice(0, 8))}  ${candidate.name}${chalk.dim(shortPath)}`,
    );
  }
  const hints = ["--pick <n>"];
  if (!opts?.kind) hints.push("--kind");
  if (!opts?.path) hints.push("--path");
  if (opts?.offerAll) hints.push("--all");
  console.error(chalk.dim(`\nUse ${hints.join(" or ")} to disambiguate${opts?.offerAll ? " (--all answers for every candidate)" : ""}.`));
}

/**
 * Report what a resolver guessed, for a target that DID resolve (exit 0).
 *
 * llm: `diagnostic` records on stdout before the command's own output, never
 * `error code=` (plugin runners treat that as a failure). json: queued for
 * `printJson`, which merges them into the command's object as
 * `resolutionNotices`. text: a line on stderr.
 */
export function reportResolutionNotices(
  notices: readonly ResolutionNotice[],
  format?: string,
  opts?: { kind?: string; path?: string },
): void {
  if (notices.length === 0) return;
  if (format === "json") {
    noteResolutionNotices(notices);
    return;
  }
  if (format === "llm") {
    const mcp = forMcp();
    const lines: string[] = [];
    for (const notice of notices) {
      if (notice.code === "fuzzy_match") {
        lines.push(llmLine("diagnostic", [
          ["code", "fuzzy_match"],
          ["resolution", "fuzzy"],
          ["target", notice.target],
          ["chosen", notice.chosen.name],
          ["message", notice.message],
        ]));
        continue;
      }
      lines.push(llmLine("diagnostic", [
        ["code", "ambiguous_target"],
        ["target", notice.target],
        ["chosen", notice.chosen.name],
        ["shown", String(notice.candidates.length)],
        ["total", String(notice.total)],
        ...(notice.truncated ? [["truncated", "true"]] as Array<[string, string]> : []),
        ["message", notice.message],
      ]));
      lines.push(...candidateLines(notice.candidates, "candidate"));
      for (const d of notice.diagnostics ?? []) {
        lines.push(llmLine("diagnostic", [["code", d.code], ["message", d.message]]));
      }
      const hints = [mcp ? "pick=<n>" : "--pick <n>"];
      if (!opts?.path) hints.push(mcp ? "path=<file substring>" : "--path");
      lines.push(llmLine("hint", [["text", `${mcp ? "Pass" : "Use"} ${hints.join(" or ")} to choose another.`]]));
    }
    console.log(lines.join("\n"));
    return;
  }
  if (isQuiet()) return;
  for (const notice of notices) {
    console.error(chalk.dim(notice.message));
    if (notice.code !== "ambiguous_target") continue;
    for (let index = 0; index < notice.candidates.length; index += 1) {
      const candidate = notice.candidates[index];
      const where = candidate.path ? ` in ${candidate.path}` : "";
      console.error(chalk.dim(`  ${index + 1}. ${(candidate.kind ?? "").padEnd(10)} ${candidate.id.slice(0, 8)}  ${candidate.name}${where}`));
    }
    if (notice.total > notice.candidates.length || notice.truncated) {
      console.error(chalk.dim(`  Showing ${notice.candidates.length} of ${notice.truncated ? ">=" : ""}${notice.total}`));
    }
    console.error(chalk.dim(`  Use --pick <n>${opts?.path ? "" : " or --path"} to choose another.`));
  }
}

export function reportResolutionFailure(
  target: string,
  result: Exclude<ResolveResult, { resolved: true }>,
  format?: string,
  opts?: { kind?: string; path?: string; offerAll?: boolean },
): void {
  if (result.ambiguous) {
    reportAmbiguousTarget(target, result.result, format, opts);
    setOutcome("ambiguous");
  } else {
    reportUnresolvedTarget(target, format, result.suggestions, {
      reason: result.reason, message: result.message, graph: result.graph, files: result.files,
    });
  }
}
