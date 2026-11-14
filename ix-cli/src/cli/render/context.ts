// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { printJson } from "../output/json.js";
import { confidenceColor } from "../output/rows.js";
import type { ContextView } from "../output/types.js";

export function formatContext(result: ContextView, format: string): void {
  if (format === "json") {
    printJson(result);
    return;
  }

  // Text format
  const { conflicts, decisions, intents, metadata } = result;

  console.log(
    "\n" + chalk.bold.cyan(`--- Ix Context: "${metadata.query}" ---`)
  );
  console.log(
    chalk.dim(
      `Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`
    )
  );

  // The compact claims when the backend sent any, else the full ones.
  const compact = result.compactClaims ?? [];
  const claims = result.claims ?? [];
  const useCompact = compact.length > 0;
  const total = useCompact ? compact.length : claims.length;
  const maxShow = 10;

  if (total > 0) {
    console.log(chalk.bold("\nClaims:"));
    if (useCompact) {
      for (const c of compact.slice(0, maxShow)) {
        const pct = Math.round((c.score ?? 0) * 100);
        const color = confidenceColor(c.score ?? 0);
        const loc = c.lineRange ? `:${c.lineRange[0]}-${c.lineRange[1]}` : '';
        const pathStr = c.path ? chalk.dim(` (${c.path}${loc})`) : '';
        console.log(`  ${color(`[${pct}%]`)} ${c.field}${pathStr}`);
      }
    } else {
      for (const c of claims.slice(0, maxShow)) {
        const pct = Math.round((c.finalScore ?? 0) * 100);
        const color = confidenceColor(c.finalScore ?? 0);
        console.log(`  ${color(`[${pct}%]`)} ${c.claim?.statement || 'unknown'}`);
      }
    }
    if (total > maxShow) {
      console.log(chalk.dim(`  ... and ${total - maxShow} more`));
    }
  }

  if (conflicts && conflicts.length > 0) {
    console.log(`\nConflicts (${conflicts.length}):`);
    for (const c of conflicts) {
      console.log(
        `  ${chalk.red.bold("!")} ${c.reason}: ${c.recommendation}`
      );
    }
  }

  if (decisions && decisions.length > 0) {
    console.log(`\nDecisions (${decisions.length}):`);
    for (const d of decisions) {
      console.log(`  ${chalk.blue("*")} ${d.title}: ${d.rationale}`);
    }
  }

  if (intents && intents.length > 0) {
    console.log(`\nIntents (${intents.length}):`);
    for (const i of intents) {
      console.log(
        `  ${chalk.magenta(">")} ${i.statement} [${i.status}]`
      );
    }
  }
  console.log();
}
