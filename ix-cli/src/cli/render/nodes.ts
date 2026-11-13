// Copyright 2026 Ix Infrastructure Inc.

import chalk from "chalk";
import { llmLine, llmShortId } from "../llm.js";
import { projectRow } from "../output-shape.js";
import { emit, type Renderer } from "../output/emit.js";
import { lineSpan, locationLabel, rowLocation } from "../output/rows.js";

/** Render a flat node list as llm `node` records. */
export function renderNodesLlm(nodes: any[]): string[] {
  return nodes.map((n) => {
    const loc = rowLocation(n);
    return llmLine("node", projectRow([
      ["kind", n.kind],
      ["id", llmShortId(n.id)],
      ["name", n.name || n.attrs?.name || n.attrs?.title || "(unnamed)"],
      ["path", loc.path],
      ["lines", lineSpan(loc)],
    ]));
  });
}

/** A flat node list (`ix search`): the nodes as json, `node` records as llm. */
export const nodesRenderer: Renderer<any[]> = {
  json: (nodes) => nodes,
  llm: renderNodesLlm,
  text: printNodesText,
};

export function formatNodes(nodes: any[], format: string): void {
  emit(nodesRenderer, nodes, format);
}

function printNodesText(nodes: any[]): void {
  if (nodes.length === 0) {
    console.log("No results found.");
    return;
  }
  for (const n of nodes) {
    const shortId = n.id.length > 8 ? n.id.slice(0, 8) : n.id;
    const name = n.name || n.attrs?.name || n.attrs?.title || "(unnamed)";
    if (n.kind === "decision") {
      console.log(
        `  ${chalk.blue("decision")}  ${chalk.dim(shortId)}  ${name}`
      );
    } else {
      // The path is what makes a search row a place rather than a word: a
      // graph with four `config.ts` modules in it answered `ix search config`
      // with four identical-looking rows.
      const where = locationLabel(rowLocation(n));
      console.log(
        `  ${chalk.cyan(n.kind.padEnd(10))}  ${chalk.dim(shortId)}  ${chalk.bold(name)}`
        + (where ? `  ${chalk.dim(where)}` : ""),
      );
    }
  }
}
