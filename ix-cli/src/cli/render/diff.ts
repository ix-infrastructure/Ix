// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine } from "../llm.js";
import { emit, type Renderer } from "../output/emit.js";

/** Render a revision diff as llm records: a header then one `change` row per entity change. */
export function renderDiffLlm(result: any): string[] {
  const changes = result.changes ?? [];
  const lines = [llmLine("diff", [["from", result.fromRev], ["to", result.toRev], ["changes", changes.length]])];
  for (const c of changes) {
    const node = c.changeType === "removed" ? c.atFromRev : c.atToRev;
    const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
    lines.push(llmLine("change", [
      ["type", c.changeType],
      ["kind", node?.kind],
      ["name", name],
      ["summary", c.summary || undefined],
    ]));
  }
  return lines;
}

/** A revision diff (`ix diff`): the result as json, `diff`/`change` records as llm. */
export const diffRenderer: Renderer<any> = {
  json: (result) => result,
  llm: renderDiffLlm,
  text: printDiffText,
};

export function formatDiff(result: any, format: string): void {
  emit(diffRenderer, result, format);
}

function printDiffText(result: any): void {
  console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
  if (!result.changes?.length) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }

  const added = result.changes.filter((c: any) => c.changeType === "added");
  const modified = result.changes.filter((c: any) => c.changeType === "modified");
  const removed = result.changes.filter((c: any) => c.changeType === "removed");
  const legacy = result.changes.filter((c: any) => c.changeType === "added_or_modified");

  if (added.length > 0) {
    console.log(chalk.green.bold(`\n  Added (${added.length}):`));
    for (const c of added) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.green("+")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (modified.length > 0) {
    console.log(chalk.yellow.bold(`\n  Modified (${modified.length}):`));
    for (const c of modified) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      const summary = c.summary ? chalk.dim(` — ${c.summary}`) : "";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}${summary}`);
    }
  }

  if (removed.length > 0) {
    console.log(chalk.red.bold(`\n  Removed (${removed.length}):`));
    for (const c of removed) {
      const node = c.atFromRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.red("-")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }

  if (legacy.length > 0) {
    console.log(chalk.yellow.bold(`\n  Changed (${legacy.length}):`));
    for (const c of legacy) {
      const node = c.atToRev;
      const name = node?.name || node?.attrs?.name || c.entityId?.substring(0, 8);
      const kind = node?.kind || "unknown";
      console.log(`    ${chalk.yellow("~")} ${chalk.cyan(kind.padEnd(10))} ${chalk.bold(name)}`);
    }
  }
  console.log();
}
