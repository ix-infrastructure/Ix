// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import { resolveFileOrReport, printResolved, isRawId } from "../resolve.js";
import { walkTree, type TreeWalkResult } from "../tree-walk.js";
import { compactTreeNode, relativePath, printJson } from "../format.js";
import { llmLine, llmShortId } from "../llm.js";
import { parsePickOption } from "../options.js";

// ── Tree types ──────────────────────────────────────────────────────

export interface DependencyNode {
  id: string;
  name: string;
  kind: string;
  resolved: boolean;
  relation: "called_by" | "imported_by" | "referenced_by" | "extended_by" | "implemented_by";
  sourceEdge: "CALLS" | "IMPORTS" | "REFERENCES" | "EXTENDS" | "IMPLEMENTS";
  path?: string;
  children: DependencyNode[];
  cycle?: boolean;
}

/**
 * What an unasked-for traversal is allowed to cost.
 *
 * Both were `Infinity`. `ix depends` on a hub walks the whole upstream cone,
 * which on this graph is thousands of nodes and 5-50 KB of output for a
 * question that is usually answered by the first level or two — and the caller
 * pays for all of it before seeing any of it.
 *
 * Depth 3 is far enough to show a path through an intermediate; 100 nodes is
 * more than fits on a screen. `--depth` and `--cap` still take anything,
 * including a larger number, and the output says when a bound was reached.
 */
const MAX_NODES = 100;
const DEFAULT_MAX_DEPTH = 3;

const PREDICATE_META: Record<string, { relation: DependencyNode["relation"]; sourceEdge: DependencyNode["sourceEdge"] }> = {
  CALLS:      { relation: "called_by",      sourceEdge: "CALLS" },
  IMPORTS:    { relation: "imported_by",    sourceEdge: "IMPORTS" },
  REFERENCES: { relation: "referenced_by", sourceEdge: "REFERENCES" },
  EXTENDS:    { relation: "extended_by",   sourceEdge: "EXTENDS" },
  IMPLEMENTS: { relation: "implemented_by", sourceEdge: "IMPLEMENTS" },
};
const ALL_DEPENDENCY_PREDICATES = Object.keys(PREDICATE_META);

/** Followable first: a name and a path, then a name, then a dangling id. */
function nodePriority(n: any): number {
  const name = n.name || n.attrs?.name || "";
  if (!name || isRawId(name)) return 2;
  return (n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path) ? 0 : 1;
}

// ── Tree building ───────────────────────────────────────────────────

/**
 * Build a full dependency tree by one-hop expansion (see tree-walk.ts for the
 * order requests go out in and the tree that comes back).
 * Stops at: frontier end, cycle, depth limit, or node cap.
 */
export async function buildDependencyTree(
  client: IxClient,
  rootId: string,
  opts?: { maxDepth?: number; maxNodes?: number; predicates?: string[] },
): Promise<TreeWalkResult<DependencyNode>> {
  const activePredicates = (opts?.predicates ?? ALL_DEPENDENCY_PREDICATES).filter((p) => p in PREDICATE_META);
  return walkTree<DependencyNode>({
    rootId,
    maxDepth: opts?.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxNodes: opts?.maxNodes ?? MAX_NODES,
    predicates: activePredicates,
    expand: (nodeId, p) => client.expand(nodeId, { direction: "in", predicates: [p], hops: 1 }),
    // Rank before the cap, or the cap keeps whatever the graph returned
    // first. A node whose name is a raw id is a dangling reference nothing
    // can follow, and one with no path costs a `locate` before it can be
    // read; neither should displace a node carrying both. Stable within a
    // band, and the predicate order (CALLS before IMPLEMENTS) is untouched.
    order: (nodes) => [...nodes].sort((a, b) => nodePriority(a) - nodePriority(b)),
    makeNode: (n, p, { name, resolved, cycle }) => ({
      id: n.id,
      name: resolved ? name : n.id.slice(0, 8),
      kind: n.kind ?? "unknown",
      resolved,
      relation: PREDICATE_META[p].relation,
      sourceEdge: PREDICATE_META[p].sourceEdge,
      path: n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path ?? undefined,
      children: [],
      ...(cycle ? { cycle: true } : {}),
    }),
  });
}

// ── Tree rendering ──────────────────────────────────────────────────

function renderTree(children: DependencyNode[], prefix: string, isLast: boolean[]): string[] {
  const lines: string[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const last = i === children.length - 1;
    const connector = last ? "└─ " : "├─ ";

    // Build indent from parent structure
    let indent = "";
    for (let j = 0; j < isLast.length; j++) {
      indent += isLast[j] ? "   " : "│  ";
    }

    const kindStr = child.cycle
      ? chalk.dim((child.kind ?? "").padEnd(10))
      : chalk.cyan((child.kind ?? "").padEnd(10));
    const nameStr = child.cycle
      ? chalk.dim(child.name) + chalk.yellow(" ↺")
      : child.resolved ? chalk.bold(child.name) : chalk.dim(child.name);

    lines.push(`${indent}${connector}${kindStr} ${nameStr}`);

    if (child.children.length > 0) {
      lines.push(...renderTree(child.children, prefix, [...isLast, last]));
    }
  }

  return lines;
}

/**
 * Render the dependency tree as flat llm records: a header line then one `dep`
 * row per node with an explicit `parent=<id>` (top-level nodes point at the
 * target). Consumers re-tree from id/parent alone. Ids are 8-char prefixes.
 */
/** What stopped the walk, and the flag that lifts it. */
export function traversalHint(
  maxDepth: number,
  maxNodes: number,
  what: { truncated: boolean; depthLimited: boolean },
): string {
  if (what.truncated) {
    return `Node cap of ${maxNodes} reached; nodes were dropped. Raise --cap, or start from a narrower target.`;
  }
  return `Stopped descending at depth ${maxDepth}; there may be more below. Raise --depth to look further.`;
}

export function renderDependsLlm(
  target: { id: string; name: string; kind: string; path?: string },
  tree: DependencyNode[], truncated: boolean, nodesVisited: number, maxDepthReached: number,
  bounds?: { maxDepth: number; maxNodes: number; depthLimited?: boolean },
): string[] {
  const lines = [llmLine("depends", [
    ["target", target.name],
    ["kind", target.kind],
    ["target_id", target.id?.slice(0, 8)],
    ["semantics", "downstream_dependents"],
    ["nodes", nodesVisited],
    ["depth", maxDepthReached],
    ["truncated", truncated ? true : undefined],
    ["depth_limited", bounds?.depthLimited ? true : undefined],
  ])];
  if (tree.length === 0) {
    lines.push(llmLine("diagnostic", [["code", "no_edges"], ["message", "No upstream dependents found."]]));
  }
  if (bounds && (truncated || bounds.depthLimited)) {
    lines.push(llmLine("diagnostic", [
      ["code", truncated ? "truncated" : "depth_limited"],
      ["message", traversalHint(bounds.maxDepth, bounds.maxNodes, { truncated, depthLimited: !!bounds.depthLimited })],
    ]));
  }
  const emit = (node: DependencyNode, parentId: string): void => {
    lines.push(llmLine("dep", [
      ["name", node.resolved ? node.name : undefined],
      ["kind", node.kind],
      ["id", llmShortId(node.id)],
      ["parent", parentId?.slice(0, 8)],
      ["rel", node.relation],
      ["path", relativePath(node.path)],
      ["cycle", node.cycle ? true : undefined],
      ["resolved", node.resolved ? undefined : false],
    ]));
    for (const child of node.children) emit(child, node.id);
  };
  for (const node of tree) emit(node, target.id);
  return lines;
}

// ── CLI command ─────────────────────────────────────────────────────

export function registerDependsCommand(program: Command): void {
  program
    .command("depends <symbol>")
    .description("Show upstream dependents of the given entity (full tree by default)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--depth <n>", "Cap traversal depth")
    .option("--cap <n>", "Cap number of nodes visited")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--include-tests", "Include test and fixture entities in results")
    .option("--tests-only", "Show only test and fixture entities")
    .addHelpText("after", `\nExamples:
  ix depends verify_token
  ix depends pickBest --format json
  ix depends AuthProvider --depth 2
  ix depends parser.py --kind file
  ix depends NodeKind --pick 1 --cap 500`)
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; depth?: string; cap?: string; format: string; includeTests?: boolean; testsOnly?: boolean }) => {
      const client = createClient();

      const resolveOpts = {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick,
        includeTests: opts.includeTests,
        testsOnly: opts.testsOnly,
      };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;

      const maxDepth = opts.depth ? parseInt(opts.depth, 10) : DEFAULT_MAX_DEPTH;
      const maxNodes = opts.cap ? parseInt(opts.cap, 10) : MAX_NODES;

      const { tree, truncated, depthLimited, nodesVisited, maxDepthReached } = await buildDependencyTree(
        client, target.id, { maxDepth, maxNodes },
      );

      // ── JSON output ──────────────────────────────────────────────
      if (opts.format === "json") {
        const output: any = {
          resolvedTarget: {
            name: target.name,
            kind: target.kind,
            path: relativePath(target.path),
          },
          semantics: "downstream_dependents",
          tree: tree.map(compactTreeNode),
          traversal: {
            nodesVisited,
            maxDepthReached,
            truncated,
            depthLimited,
            // Always, not only when the caller passed a flag: there is a
            // default now, and a bound nobody is told about is a bound nobody
            // can raise.
            depthLimit: maxDepth,
            nodeCap: maxNodes,
          },
        };
        if (tree.length === 0) {
          output.diagnostics = [{ code: "no_edges", message: `No upstream dependents found for resolved entity.` }];
        }
        if (truncated || depthLimited) {
          output.diagnostics = output.diagnostics ?? [];
          output.diagnostics.push({
            code: truncated ? "truncated" : "depth_limited",
            message: traversalHint(maxDepth, maxNodes, { truncated, depthLimited }),
          });
        }
        printJson(output);
        return;
      }

      // ── llm output ───────────────────────────────────────────────
      if (opts.format === "llm") {
        for (const line of renderDependsLlm(target, tree, truncated, nodesVisited, maxDepthReached, { maxDepth, maxNodes, depthLimited })) console.log(line);
        return;
      }

      // ── Text output ──────────────────────────────────────────────
      printResolved(target);

      if (tree.length === 0) {
        console.log(`  No upstream dependents found at current graph state.`);
        return;
      }

      console.log(chalk.bold(`Dependents`));
      const rootLine = `  ${chalk.cyan((target.kind ?? "").padEnd(10))} ${chalk.bold(target.name)}`;
      console.log(rootLine);

      const treeLines = renderTree(tree, "  ", []);
      for (const line of treeLines) {
        console.log(`  ${line}`);
      }

      if (truncated || depthLimited) {
        console.log(chalk.yellow(`\n  (${nodesVisited} nodes visited, depth ${maxDepthReached})`));
        console.log(chalk.dim(`  ${traversalHint(maxDepth, maxNodes, { truncated, depthLimited })}`));
      }

      console.log(chalk.dim(`\n  ${nodesVisited} upstream dependents, depth ${maxDepthReached}`));

    });
}
