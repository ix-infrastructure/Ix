// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { printJson } from "../output/json.js";
import { relativePath, stripNulls } from "../output/rows.js";
import type { Diagnostic, EntityRef } from "../output/types.js";

export interface ExplainResult {
  kind: string;
  name: string;
  id: string;
  file?: string;
  chunkKind?: string;
  container?: { kind: string; name: string };
  introducedRev: number;
  calledBy: number;
  calls: number;
  contains: number;
  historyLength: number;
  signature?: string;
  docstring?: string;
  callList?: EntityRef[];
  diagnostics?: Diagnostic[];
}

export function formatExplain(result: ExplainResult, format: string): void {
  if (format === "json") {
    const output: any = {
      resolvedTarget: { id: result.id, kind: result.kind, name: result.name },
      result: stripNulls({
        kind: result.kind,
        name: result.name,
        id: result.id,
        file: relativePath(result.file),
        chunkKind: result.chunkKind ?? null,
        container: result.container,
        introducedRev: result.introducedRev,
        calledBy: result.calledBy,
        calls: result.calls,
        contains: result.contains,
        historyLength: result.historyLength,
        signature: result.signature ?? null,
        docstring: result.docstring ?? null,
        callList: result.callList,
      }),
    };
    if (result.diagnostics && result.diagnostics.length > 0) {
      output.diagnostics = result.diagnostics;
    }
    printJson(output);
    return;
  }
  const shortId = result.id.slice(0, 8);
  if (result.signature) {
    console.log(`  ${chalk.green(result.signature)}`);
  } else {
    console.log(`  ${chalk.cyan(result.kind)} ${chalk.bold(result.name)} ${chalk.dim(shortId)}`);
  }
  if (result.docstring) {
    console.log(`  ${chalk.dim('"' + result.docstring + '"')}`);
  }
  if (result.container) {
    console.log(`  ${chalk.dim("in")} ${chalk.cyan(result.container.kind)} ${result.container.name}`);
  }
  if (result.file) {
    console.log(`  ${chalk.dim("file")} ${result.file}`);
  }
  if (result.chunkKind) {
    console.log(`  ${chalk.dim("chunk kind")} ${result.chunkKind}`);
  }
  console.log(`  ${chalk.dim("introduced rev")} ${result.introducedRev}`);
  if (result.calledBy > 0) console.log(`  ${chalk.dim("called by")} ${result.calledBy} methods`);
  if (result.callList && result.callList.length > 0) {
    console.log(`  ${chalk.dim("calls:")}`);
    for (const c of result.callList) {
      const label = c.resolved
        ? c.name
        : chalk.dim(`${c.name} (unresolved)`);
      console.log(`    ${label}`);
    }
  } else if (result.calls > 0) {
    console.log(`  ${chalk.dim("calls")} ${result.calls} methods`);
  }
  if (result.contains > 0) console.log(`  ${chalk.dim("contains")} ${result.contains} members`);
  if (result.historyLength > 0) console.log(`  ${chalk.dim("history")} ${result.historyLength} patches`);
  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const d of result.diagnostics) {
      console.log(`  ${chalk.dim(`[${d.code}]`)} ${d.message}`);
    }
  }
}
