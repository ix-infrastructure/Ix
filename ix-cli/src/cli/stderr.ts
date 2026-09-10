// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";

/** Write a diagnostic/status message to stderr (never pollutes stdout/JSON). */
export function stderr(message: string): void {
  process.stderr.write(message + "\n");
}

/** Write a styled diagnostic to stderr. */
export function stderrDim(message: string): void {
  process.stderr.write(chalk.dim(message) + "\n");
}

/**
 * Whether stderr can render a redrawing progress line.
 *
 * A progress bar animates by returning to the start of the line with `\r` and
 * overwriting what is there. That only overwrites on a terminal. Into a
 * redirect, a pipe, a CI log or an agent capturing tool output, every frame is
 * *retained* — so an 80 ms interval turns a sub-second command into dozens of
 * stacked frames, and a long one into unbounded output that grows with
 * duration rather than with work done.
 *
 * Read at each call rather than cached at module load: the tests drive this by
 * setting `process.stderr.isTTY`, and a captured constant would answer for
 * whatever the first import happened to see.
 */
export function canRenderProgress(): boolean {
  return Boolean(process.stderr.isTTY);
}
