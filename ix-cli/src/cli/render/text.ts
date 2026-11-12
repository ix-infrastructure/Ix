// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine } from "../llm.js";
import { emit, type Renderer } from "../output/emit.js";
import { relativePath } from "../output/rows.js";
import { isPastEnd, pageRange, pastEndMessage, type Slice } from "../output/slice.js";

export interface TextResult {
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  engine: string;
  score: number;
  language?: string;
  symbol_hint?: string;
}

/** How `ix text` paged: whether the scan window filled before ripgrep ran out of matches. */
export interface TextPaging {
  /**
   * More matches existed than the scan window kept. Pages are cut from that
   * window, so the page that reaches its end has no next page even though the
   * search does — the caller has to narrow the search instead.
   */
  windowFull?: boolean;
}

/**
 * Whether a text page starts past the last match. Only when the scan window
 * held every match: a full window is not the end of the search, so an offset
 * beyond it is not past the end of anything the caller can know.
 */
function isTextPastEnd(slice: Slice<TextResult>, paging?: TextPaging): boolean {
  return !paging?.windowFull && isPastEnd(slice);
}

/**
 * What a text page left out, and how to get it: the next page while the scan
 * window has rows left, a narrower search once the page reached the window's
 * end. Undefined when nothing was left out.
 */
function textTruncationMessage(slice: Slice<TextResult>, paging?: TextPaging): string | undefined {
  if (isTextPastEnd(slice, paging)) return undefined;
  const range = pageRange(slice);
  if (slice.nextOffset !== undefined) {
    return `${slice.total} matches scanned; showing ${range}. next: ${slice.next ?? `--offset ${slice.nextOffset}`}`;
  }
  if (paging?.windowFull && slice.shown > 0) {
    return `${slice.total} matches scanned; showing ${range}; the scan stops at ${slice.total}. Narrow with --path or --language, or raise --limit.`;
  }
  if (paging?.windowFull && (slice.offset ?? 0) >= slice.total) {
    return `${slice.total} matches scanned; --offset ${slice.offset ?? 0} is past the scan window, which stops at ${slice.total}. Narrow with --path or --language, or raise --limit.`;
  }
  if (slice.truncated) {
    return `${slice.total} matches scanned; showing ${range}. Narrow with --path or --language, or raise --limit.`;
  }
  return undefined;
}

/**
 * Render lexical search hits as llm `match` records (one per line).
 *
 * No `lang=`: the extension on `path` already says it, and on a 20-row answer
 * the field was ~80 tokens of nothing. `--format json` keeps `language`.
 *
 * `scanned` is the size of the ranked scan window, not the number of matches
 * in the repo; pages (`--offset`) are cut from that window.
 */
export function renderTextResultsLlm(slice: Slice<TextResult>, paging?: TextPaging): string[] {
  const message = textTruncationMessage(slice, paging);
  const lines = [llmLine("text", [
    ["offset", slice.offset ? slice.offset : undefined],
    ["shown", slice.shown],
    ["scanned", slice.total],
    ["truncated", slice.truncated || message !== undefined || undefined],
  ])];
  if (message !== undefined) {
    lines.push(llmLine("diagnostic", [
      ["code", "results_truncated"],
      ["next_offset", slice.nextOffset],
      ["message", message],
    ]));
  }
  if (slice.rows.length === 0 && isTextPastEnd(slice, paging)) {
    lines.push(llmLine("diagnostic", [
      ["code", "offset_past_end"],
      ["message", pastEndMessage(slice, "matches scanned")],
    ]));
  }
  for (const r of slice.rows) {
    lines.push(llmLine("match", [
      ["path", relativePath(r.path) ?? r.path],
      ["line", r.line_start],
      ["symbol", r.symbol_hint],
      ["snippet", r.snippet.trim()],
    ]));
  }
  return lines;
}

/** One page of `ix text` hits and how the scan that found them paged. */
export interface TextPage {
  slice: Slice<TextResult>;
  paging?: TextPaging;
}

/** `ix text`: a bare array of hits as json, `text`/`match` records as llm. */
export const textResultsRenderer: Renderer<TextPage> = {
  // A bare array: its shape is published in contracts/fields.ts (`text`)
  // and pinned by json-fields.test.ts. Paging state stays out of it; a JSON
  // caller's next offset is its offset plus the array's length.
  json: ({ slice }) => slice.rows.map(r => ({
    ...r,
    path: relativePath(r.path) ?? r.path,
  })),
  llm: ({ slice, paging }) => renderTextResultsLlm(slice, paging),
  text: printTextResults,
};

export function formatTextResults(slice: Slice<TextResult>, format: string, paging?: TextPaging): void {
  emit(textResultsRenderer, { slice, paging }, format);
}

function printTextResults({ slice, paging }: TextPage): void {
  const results = slice.rows;
  if (results.length === 0) {
    console.log(isTextPastEnd(slice, paging)
      ? pastEndMessage(slice, "matches scanned")
      : textTruncationMessage(slice, paging) ?? "No text matches found.");
    return;
  }
  for (const r of results) {
    const lang = r.language ? chalk.magenta(`[${r.language}]`) + " " : "";
    const sym = r.symbol_hint ? chalk.yellow(`(${r.symbol_hint})`) + " " : "";
    console.log(
      `  ${lang}${chalk.dim(r.path)}${chalk.cyan(":" + r.line_start)}  ${sym}${r.snippet.trim()}`
    );
  }
  const message = textTruncationMessage(slice, paging);
  if (message !== undefined) console.log(chalk.dim(`  ${message}`));
}
