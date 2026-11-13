// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { printJson } from "../output/json.js";

export function formatDecisions(nodes: any[], format: string): void {
  if (format === "json") {
    printJson(nodes);
    return;
  }
  if (nodes.length === 0) {
    console.log("No decisions found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const rationale = n.attrs?.rationale ?? "";
    console.log(
      `  ${chalk.blue("*")} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
    if (rationale) {
      console.log(`    ${chalk.gray(rationale)}`);
    }
  }
}
