// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";

import { issueSourcePath } from "./explain/issue.js";
import { printJson, relativePath } from "./format.js";
import { llmLine } from "./llm.js";
import type { Suggestion } from "./resolve.js";
import { didYouMeanRows, type TargetCandidate } from "./target-suggestions.js";
import type { TextMatchesJson } from "./contracts/miss.js";

/**
 * A name a graph command could not resolve, answered with the source files
 * that mention it.
 *
 * Configuration keys (`redrivePolicy`, `provisionedConcurrency`) are no code
 * symbol, so the graph has no entity for them, but they are exactly what an
 * agent asks about. An `unresolved_target` error with exit 3 sends it back to
 * grep after a wasted call; the miss probe (miss-reason.ts) has already run
 * the one bounded `rg` that grep would, so its hits are the answer. Clearly
 * labelled as not a code symbol, and exit 0.
 *
 * Only source files count: generated files, docs, examples, site, tests and
 * build output are not (`issueSourcePath`, the test `--from-issue` uses). A
 * name that only those mention stays the plain miss, and so does a key that
 * appears only in a data file (YAML, JSON, TOML, Terraform): the answer is
 * the code that reads or sets the key, and a key no code mentions has none.
 *
 * A qualified target (`Router.handle`, `pkg::name`) is never answered this
 * way: the probe searches its last segment only, so its hits are about
 * `handle`, not `Router.handle`, and the miss with its suggestions (`handle`
 * is a method of another class) is the true answer. The resolver's near
 * names ride along with an answer, so it never loses them either.
 */

/** One line of a file that mentions the name: the first, as rg found it. */
export interface TextMatch {
  /** Workspace-relative. */
  path: string;
  line: number;
  snippet: string;
}

/** At most this many files are listed. */
export const TEXT_MATCH_LIMIT = 10;

/** A listed line is cut to this many characters. */
const SNIPPET_MAX = 160;

/** The `--format json` note slug, and the llm `note code=`. */
export const TEXT_MATCHES_CODE = "text_matches";

/** The last segment of `Class.method` / `pkg::name`: that is the token in the text. */
function probedName(target: string): string {
  return target.split(/::|[.#]/).filter(Boolean).pop() ?? target;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetOf(text: string): string {
  const line = text.trim();
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line;
}

/**
 * The source files among a miss's text hits, best first, at most
 * TEXT_MATCH_LIMIT. Best: a line that sets the name (`name:`, `name =`,
 * `"name":`) before one that only reads it; otherwise the probe's (path)
 * order. Empty when no source file mentions it.
 */
export function sourceTextMatches(target: string, matches: readonly TextMatch[] | undefined): TextMatch[] {
  if (!matches?.length || probedName(target) !== target) return [];
  const name = escapeRegExp(target);
  const sets = new RegExp(`(?:^|[^\\w$])["']?${name}["']?\\s*(?::|=(?!=))`);
  return matches
    .filter((m) => issueSourcePath(m.path))
    .map((m, index) => ({ m, index, rank: sets.test(m.snippet) ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, TEXT_MATCH_LIMIT)
    .map(({ m }) => ({ path: m.path, line: m.line, snippet: snippetOf(m.snippet) }));
}

export function textMatchesMessage(target: string): string {
  return `"${target}" is not a code symbol in the graph; source files that mention it:`;
}

/** What the miss probe found, as far as this answer needs it. */
export interface TextMatchSource {
  reason?: string;
  /** The probe's own message: printed only when it says to run `ix map`. */
  message?: string;
  remap?: boolean;
  matches?: TextMatch[];
  /** The resolver's near names (entities), as the miss would list them. */
  suggestions?: Suggestion[];
  /** The bounded probe's did-you-mean names, as the miss would list them. */
  didYouMean?: TargetCandidate[];
  retryCommand?: string;
}

const SUGGESTIONS_HINT = "A code symbol with a similar name: re-run with one of these names.";

/** The `--format json` record: the answer, without an `error`. */
export function textMatchesRecord(target: string, miss: TextMatchSource, rows: TextMatch[]): TextMatchesJson {
  const total = (miss.matches ?? []).filter((m) => issueSourcePath(m.path)).length;
  return {
    note: TEXT_MATCHES_CODE,
    target,
    ...(miss.reason ? { reason: miss.reason } : {}),
    message: textMatchesMessage(target),
    ...(miss.remap && miss.message ? { detail: miss.message } : {}),
    textMatches: rows,
    shown: rows.length,
    total,
    ...(miss.suggestions?.length ? { suggestions: miss.suggestions } : {}),
    ...(miss.didYouMean?.length ? { didYouMean: miss.didYouMean } : {}),
  };
}

/** The llm records: one `note`, then one `match` row per file. */
export function textMatchesLlm(target: string, miss: TextMatchSource, rows: TextMatch[]): string[] {
  const total = (miss.matches ?? []).filter((m) => issueSourcePath(m.path)).length;
  return [
    llmLine("note", [
      ["code", TEXT_MATCHES_CODE],
      ["target", target],
      ["reason", miss.reason],
      ["shown", rows.length],
      ["total", total],
      ["message", textMatchesMessage(target)],
    ]),
    ...rows.map((m, i) => llmLine("match", [["n", i + 1], ["path", m.path], ["line", m.line], ["text", m.snippet]])),
    ...(miss.remap && miss.message ? [llmLine("hint", [["text", miss.message]])] : []),
    ...suggestionLines(miss),
  ];
}

/** The text answer, on stdout: it is the answer, not a diagnostic. */
export function textMatchesText(target: string, miss: TextMatchSource, rows: TextMatch[]): string[] {
  const width = Math.max(...rows.map((m) => `${m.path}:${m.line}`.length));
  return [
    textMatchesMessage(target),
    ...rows.map((m) => `  ${chalk.cyan(`${m.path}:${m.line}`.padEnd(width))}  ${chalk.dim(m.snippet)}`),
    ...(miss.remap && miss.message ? [chalk.dim(miss.message)] : []),
    ...suggestionText(miss),
  ];
}

/**
 * The miss's `suggestion` rows and retry hint, after the matches: the same
 * records `unresolved_target` carries, so a near entity is never lost.
 */
function suggestionLines(miss: TextMatchSource): string[] {
  const near = miss.suggestions ?? [];
  if (!near.length) return [];
  return [
    ...near.map((c, i) => llmLine("suggestion", [
      ["n", i + 1], ["name", c.name], ["kind", c.kind],
      ["path", c.path ? relativePath(c.path) ?? c.path : undefined],
      ["id", c.id ? c.id.slice(0, 8) : undefined],
    ])),
    llmLine("hint", [["text", miss.retryCommand ?? SUGGESTIONS_HINT]]),
  ];
}

/** For a person: the near names (topped up from the probe), as the miss lists them. */
function suggestionText(miss: TextMatchSource): string[] {
  const near = didYouMeanRows(miss.suggestions, miss.didYouMean);
  if (!near.length) return [];
  return [
    "Code symbols with a similar name:",
    ...near.map((s) => `  ${chalk.cyan((s.kind || "").padEnd(10))} ${s.name}${s.path ? chalk.dim(` in ${s.path}`) : ""}`),
    ...(miss.retryCommand ? [`Try: ${miss.retryCommand}`] : []),
  ];
}

/**
 * The `--format json` answer of a graph command: the command's own keys,
 * empty (`results: []` for an edge list, `tree: []` for `depends`; the
 * caller's `shape`), with `resolvedTarget: null` and `resolutionMode: "text"`
 * as `locate` prints them, then the text matches. A script that reads the
 * command's keys on exit 0 finds them, holding no entity.
 */
export function textMatchesJson<S extends object = Record<never, never>>(
  target: string, miss: TextMatchSource, rows: TextMatch[], shape?: S,
): { resolvedTarget: null; resolutionMode: "text" } & S & TextMatchesJson {
  return { resolvedTarget: null, resolutionMode: "text" as const, ...(shape as S), ...textMatchesRecord(target, miss, rows) };
}

/** The empty json body of an edge list (`callers`, `callees`, `contains`, `imports`, `imported-by`). */
export function emptyEdgeResultsJson(): Record<string, unknown> {
  return { results: [], resultSource: "graph" };
}

/**
 * Answer a miss with its source text matches, in the caller's format, and say
 * whether it did. False (nothing printed) when no source file mentions the
 * name: the caller reports the miss as before. `shape` is the command's own
 * json body with nothing in it (`textMatchesJson`).
 */
export function reportTextMatches(
  target: string, miss: TextMatchSource, format: string | undefined, shape?: Record<string, unknown>,
): boolean {
  const rows = sourceTextMatches(target, miss.matches);
  if (rows.length === 0) return false;
  if (format === "json") printJson(textMatchesJson(target, miss, rows, shape));
  else if (format === "llm") console.log(textMatchesLlm(target, miss, rows).join("\n"));
  else console.log(textMatchesText(target, miss, rows).join("\n"));
  return true;
}
