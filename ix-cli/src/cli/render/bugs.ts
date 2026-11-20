// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { printJson } from "../output/json.js";

const BUG_STATUS_ICONS: Record<string, string> = {
  open: "○",
  investigating: "◐",
  resolved: "●",
  closed: "✓",
};

export function formatBugs(nodes: any[], format: string): void {
  if (format === "json") {
    printJson(nodes);
    return;
  }
  if (nodes.length === 0) {
    console.log("No bugs found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.name || n.attrs?.title || n.attrs?.name || "(untitled)";
    const status = n.attrs?.status ?? "open";
    const severity = n.attrs?.severity ?? "medium";
    const icon = BUG_STATUS_ICONS[status] ?? "?";
    console.log(
      `  ${icon} ${chalk.dim(`[${status}]`.padEnd(16))} ${chalk.red(severity.padEnd(8))} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
  }
}
