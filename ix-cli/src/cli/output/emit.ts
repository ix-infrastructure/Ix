// Copyright 2026 Ix Infrastructure Inc.

import { printJson } from "./json.js";

/**
 * One command's answer in each output format.
 *
 * A renderer says what to print; {@link emit} decides which form to print, so
 * the `--format` switch lives in one place instead of in every command. A new
 * command implements this and calls `emit` rather than comparing `format`
 * itself. The renderers in `render/` are the examples.
 */
export interface Renderer<T> {
  /** Human output. Prints its own lines: colour and layout are the renderer's. */
  text(value: T): void;
  /**
   * The `--format json` payload, returned rather than printed: `emit` prints it
   * with `printJson`, which adds queued resolution notices and picks the
   * indentation. The shape is a contract with the plugins and `ix mcp`.
   */
  json(value: T): unknown;
  /**
   * The `--format llm` records, one string per line (see docs/llm-format.md).
   * A row builds its fields with `projectRow` so `--fields` applies to rows
   * and never to the header.
   */
  llm(value: T): string[];
}

/**
 * Print `value` in `format`: `json` and `llm` by name, anything else as text.
 *
 * Anything else is text because that is what every hand-written switch did:
 * `text` is the default, and a format this CLI does not know reached the text
 * branch rather than printing nothing.
 */
export function emit<T>(renderer: Renderer<T>, value: T, format: string): void {
  if (format === "json") {
    printJson(renderer.json(value));
    return;
  }
  if (format === "llm") {
    for (const line of renderer.llm(value)) console.log(line);
    return;
  }
  renderer.text(value);
}
