// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { printJson } from "../output/json.js";
import { confidenceColor } from "../output/rows.js";

export function formatIntents(intents: any[], format: string): void {
  if (format === "json") {
    printJson(intents);
    return;
  }
  if (intents.length === 0) {
    console.log("No intents found.");
    return;
  }

  // Build parent-child map
  const childrenMap = new Map<string, any[]>();
  const roots: any[] = [];

  for (const intent of intents) {
    const parentId = intent.attrs?.parent_intent ?? intent.parentIntent;
    if (parentId) {
      const siblings = childrenMap.get(parentId) || [];
      siblings.push(intent);
      childrenMap.set(parentId, siblings);
    } else {
      roots.push(intent);
    }
  }

  function printIntent(intent: any, indent: string, isChild: boolean): void {
    const prefix = isChild
      ? `${indent}${chalk.dim("\u2514\u2500")} `
      : `${indent}${chalk.magenta(">")} `;
    const statement = intent.attrs?.statement ?? intent.statement ?? "(unknown)";
    const status = intent.attrs?.status ?? intent.status ?? "unknown";
    const conf = intent.attrs?.confidence ?? intent.confidence ?? 0;
    const pctStr = `(${(conf * 100).toFixed(0)}%)`;
    const color = confidenceColor(conf);
    console.log(
      `${prefix}${statement} [${status}] ${color(pctStr)}`
    );

    const children = childrenMap.get(intent.id) || [];
    for (const child of children) {
      printIntent(child, indent + "  ", true);
    }
  }

  for (const root of roots) {
    printIntent(root, "  ", false);
  }
}
