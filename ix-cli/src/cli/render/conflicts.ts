// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine, llmShortId } from "../llm.js";
import { emit, type Renderer } from "../output/emit.js";

/** Render detected conflicts as llm `conflict` records. */
export function renderConflictsLlm(conflicts: any[]): string[] {
  const lines = [llmLine("conflicts", [["count", conflicts.length]])];
  for (const c of conflicts) {
    lines.push(llmLine("conflict", [
      ["reason", c.reason],
      ["recommendation", c.recommendation],
      ["claim_a", llmShortId(c.claimA)],
      ["claim_b", llmShortId(c.claimB)],
    ]));
  }
  return lines;
}

/** Detected conflicts (`ix conflicts`): the list as json, `conflict` records as llm. */
export const conflictsRenderer: Renderer<any[]> = {
  json: (conflicts) => conflicts,
  llm: renderConflictsLlm,
  text: printConflictsText,
};

export function formatConflicts(conflicts: any[], format: string): void {
  emit(conflictsRenderer, conflicts, format);
}

function printConflictsText(conflicts: any[]): void {
  if (conflicts.length === 0) {
    console.log("No conflicts detected.");
    return;
  }
  for (const c of conflicts) {
    console.log(`  ${chalk.red.bold("!")} ${c.reason}`);
    console.log(`    ${chalk.yellow(c.recommendation)}`);
    console.log(`    Claims: ${c.claimA} vs ${c.claimB}`);
  }
}
