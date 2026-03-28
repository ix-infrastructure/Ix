import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { relativePath, stripNulls } from "../format.js";

export function registerEntityCommand(program: Command): void {
  program
    .command("entity <id>")
    .description("Get entity details with claims and edges")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (id: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolvedId = await client.resolvePrefix(id);
      const result = await client.entity(resolvedId);
      if (opts.format === "json") {
        console.log(JSON.stringify(compactEntity(result), null, 2));
      } else {
        const name = result.node.name || (result.node.attrs as any)?.name || "(unnamed)";
        console.log(`Entity: ${result.node.id} ${chalk.bold(name)} (${result.node.kind})`);
        console.log(`Claims: ${(result.claims as unknown[]).length}`);
        console.log(`Edges:  ${(result.edges as unknown[]).length}`);
      }
    });
}

function compactEntity(result: any): any {
  // Deduplicate provenance: collect unique provenance objects, reference by index
  const provMap = new Map<string, number>();
  const provenances: any[] = [];

  function provIndex(prov: any): number | undefined {
    if (!prov) return undefined;
    const uri = prov.sourceUri ?? prov.source_uri ?? "";
    const key = `${uri}|${prov.sourceHash ?? prov.source_hash ?? ""}`;
    if (provMap.has(key)) return provMap.get(key)!;
    const idx = provenances.length;
    provenances.push(stripNulls({
      uri: relativePath(uri),
      hash: (prov.sourceHash ?? prov.source_hash ?? "").slice(0, 12) || undefined,
      extractor: prov.extractor,
    }));
    provMap.set(key, idx);
    return idx;
  }

  const node = result.node;
  const compactNode: any = stripNulls({
    id: node.id,
    kind: node.kind,
    name: node.name,
    attrs: filterAttrs(node.attrs),
    prov: provIndex(node.provenance),
    rev: node.createdRev,
  });

  const edges = (result.edges ?? []).map((e: any) => stripNulls({
    src: e.src,
    dst: e.dst,
    pred: e.predicate,
    prov: provIndex(e.provenance),
    rev: e.createdRev,
  }));

  return stripNulls({
    node: compactNode,
    claims: result.claims?.length > 0 ? result.claims : undefined,
    edges,
    provenances,
  });
}

function filterAttrs(attrs: any): any {
  if (!attrs || typeof attrs !== "object") return undefined;
  // Drop internal-only attrs
  const { role_source, ...rest } = attrs;
  return Object.keys(rest).length > 0 ? rest : undefined;
}
