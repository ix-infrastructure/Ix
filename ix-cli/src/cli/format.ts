import chalk from "chalk";

export function confidenceColor(score: number): (text: string) => string {
  if (score >= 0.8) return chalk.green;
  if (score >= 0.5) return chalk.yellow;
  return chalk.red;
}

export function formatContext(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text format
  const { claims, conflicts, decisions, intents, metadata } = result;

  console.log(
    "\n" + chalk.bold.cyan(`--- Ix Context: "${metadata.query}" ---`)
  );
  console.log(
    chalk.dim(
      `Seeds: ${metadata.seedEntities.length} | Hops: ${metadata.hopsExpanded} | Rev: ${metadata.asOfRev}`
    )
  );

  const useCompact = result.compactClaims?.length > 0;
  const displayClaims = useCompact ? result.compactClaims : (claims || []);
  const maxShow = 10;

  if (displayClaims.length > 0) {
    console.log(chalk.bold("\nClaims:"));
    displayClaims.slice(0, maxShow).forEach((c: any) => {
      if (useCompact) {
        const pct = Math.round((c.score ?? 0) * 100);
        const color = confidenceColor(c.score ?? 0);
        const loc = c.lineRange ? `:${c.lineRange[0]}-${c.lineRange[1]}` : '';
        const pathStr = c.path ? chalk.dim(` (${c.path}${loc})`) : '';
        console.log(`  ${color(`[${pct}%]`)} ${c.field}${pathStr}`);
      } else {
        const pct = Math.round((c.finalScore ?? 0) * 100);
        const color = confidenceColor(c.finalScore ?? 0);
        console.log(`  ${color(`[${pct}%]`)} ${c.claim?.statement || 'unknown'}`);
      }
    });
    if (displayClaims.length > maxShow) {
      console.log(chalk.dim(`  ... and ${displayClaims.length - maxShow} more`));
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

export function formatNodes(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    if (n.kind === "decision") {
      const title = n.attrs?.title ?? n.name ?? "(untitled)";
      console.log(
        `  ${chalk.blue("decision")}  ${chalk.dim(shortId)}  ${title}`
      );
    } else {
      console.log(
        `  ${chalk.cyan(n.kind)}  ${chalk.dim(shortId)}  ${n.attrs?.name ?? n.name ?? JSON.stringify(n.attrs)}`
      );
    }
  }
}

export function formatDecisions(nodes: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log("No decisions found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const title = n.attrs?.title ?? n.name ?? "(untitled)";
    const rationale = n.attrs?.rationale ?? "";
    console.log(
      `  ${chalk.blue("*")} ${chalk.dim(shortId)}  ${chalk.bold(title)}`
    );
    if (rationale) {
      console.log(`    ${chalk.gray(rationale)}`);
    }
  }
}

export function formatPatches(patches: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(patches, null, 2));
    return;
  }
  if (patches.length === 0) {
    console.log("No patches found.");
    return;
  }
  for (const p of patches) {
    const shortPatchId =
      p.patch_id.length > 8 ? p.patch_id.slice(0, 8) : p.patch_id;
    const intentPart = p.intent
      ? chalk.white(p.intent)
      : chalk.dim("(no intent)");
    console.log(
      `  rev ${chalk.cyan.bold(String(p.rev))}  ${chalk.dim(shortPatchId)}  ${intentPart}`
    );
  }
}

export function formatIntents(intents: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(intents, null, 2));
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

export function formatDiff(result: any, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(chalk.cyan.bold(`Diff: rev ${result.fromRev} → ${result.toRev}`));
  if (!result.changes?.length) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }
  for (const change of result.changes) {
    const icon = change.changeType === "removed" ? chalk.red("- ")
      : change.changeType === "added" ? chalk.green("+ ")
      : chalk.yellow("~ ");
    const name = change.atToRev?.attrs?.name || change.entityId?.substring(0, 8);
    const kind = change.atToRev?.kind || "unknown";
    console.log(`  ${icon}${chalk.bold(name)} (${kind}) [${change.changeType}]`);
  }
}

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

export function formatTextResults(results: TextResult[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("No text matches found.");
    return;
  }
  for (const r of results) {
    const lang = r.language ? chalk.magenta(`[${r.language}]`) + " " : "";
    const sym = r.symbol_hint ? chalk.yellow(`(${r.symbol_hint})`) + " " : "";
    console.log(
      `  ${lang}${chalk.dim(r.path)}${chalk.cyan(":" + r.line_start)}  ${sym}${r.snippet.trim()}`
    );
  }
}

export interface LocateResult {
  kind: string;
  id?: string;
  name: string;
  file?: string;
  line?: number;
  source: "graph" | "ripgrep";
}

export function formatLocateResults(results: LocateResult[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const r of results) {
    const shortId = r.id ? chalk.dim(r.id.slice(0, 8)) + "  " : "";
    const filePart = r.file ? chalk.dim(r.file) + (r.line ? chalk.cyan(`:${r.line}`) : "") : "";
    console.log(`  ${chalk.cyan(r.kind)}  ${shortId}${chalk.bold(r.name)}`);
    if (filePart) {
      console.log(`    ${filePart}`);
    }
  }
}

export function formatEdgeResults(nodes: any[], relation: string, symbol: string, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  if (nodes.length === 0) {
    console.log(`No ${relation} found for "${symbol}".`);
    return;
  }
  console.log(`${chalk.bold(relation)} of ${chalk.cyan(symbol)}:`);
  for (const n of nodes) {
    const shortId = n.id?.slice(0, 8) ?? "";
    const name = n.attrs?.name ?? n.name ?? n.id;
    console.log(`  ${chalk.cyan(n.kind)}  ${chalk.dim(shortId)}  ${name}`);
  }
}

export function formatConflicts(conflicts: any[], format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(conflicts, null, 2));
    return;
  }
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

export interface ExplainResult {
  kind: string;
  name: string;
  id: string;
  file?: string;
  container?: { kind: string; name: string };
  introducedRev: number;
  calledBy: number;
  calls: number;
  contains: number;
  historyLength: number;
}

export function formatExplain(result: ExplainResult, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const shortId = result.id.slice(0, 8);
  console.log(`  ${chalk.cyan(result.kind)} ${chalk.bold(result.name)} ${chalk.dim(shortId)}`);
  if (result.container) {
    console.log(`  ${chalk.dim("in")} ${chalk.cyan(result.container.kind)} ${result.container.name}`);
  }
  if (result.file) {
    console.log(`  ${chalk.dim("file")} ${result.file}`);
  }
  console.log(`  ${chalk.dim("introduced rev")} ${result.introducedRev}`);
  if (result.calledBy > 0) console.log(`  ${chalk.dim("called by")} ${result.calledBy} methods`);
  if (result.calls > 0) console.log(`  ${chalk.dim("calls")} ${result.calls} methods`);
  if (result.contains > 0) console.log(`  ${chalk.dim("contains")} ${result.contains} members`);
  if (result.historyLength > 0) console.log(`  ${chalk.dim("history")} ${result.historyLength} patches`);
}
