/**
 * ui.ts — Ix CLI brand presentation layer.
 *
 * Centralizes color, formatting, and layout for all CLI commands.
 * Do not add command logic here. Do not extend format.ts.
 */

import chalk from "chalk";

import { llmError } from "./llm.js";
import type { AmbiguousResult, ResolveResult } from "./resolve.js";

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

/** Advisory hint, stale data, or informational note. */
export function renderNote(text: string): void {
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

export function reportUnresolvedTarget(target: string | string[], format?: string): void {
  const message = unresolvedTargetMessage(target);
  if (format === "json") {
    console.log(JSON.stringify(unresolvedTargetRecord(target), null, 2));
  } else if (format === "llm") {
    console.log(llmError("unresolved_target", message));
  }
  process.exitCode = 1;
}

export function reportAmbiguousTarget(
  target: string,
  result: AmbiguousResult,
  format?: string,
  opts?: { kind?: string; path?: string },
): void {
  const message = `Ambiguous symbol "${target}".`;
  if (format === "json") {
    console.log(JSON.stringify({
      error: "ambiguous_target",
      message,
      candidates: result.candidates,
      diagnostics: result.diagnostics ?? [],
    }, null, 2));
    return;
  }
  if (format === "llm") {
    console.log(llmError("ambiguous_target", message, [
      ["candidates", result.candidates.map((candidate, index) => `${index + 1}:${candidate.name}`).join(",")],
    ]));
    return;
  }

  console.error(`Ambiguous symbol "${target}":`);
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
  console.error(chalk.dim(`\nUse ${hints.join(" or ")} to disambiguate.`));
}

export function reportResolutionFailure(
  target: string,
  result: Exclude<ResolveResult, { resolved: true }>,
  format?: string,
  opts?: { kind?: string; path?: string },
): void {
  if (result.ambiguous) reportAmbiguousTarget(target, result.result, format, opts);
  else reportUnresolvedTarget(target, format);
  process.exitCode = 1;
}
