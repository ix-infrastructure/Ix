import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved, isRawId } from "../resolve.js";
import { roleHint } from "../role-filter.js";
import { stderr } from "../stderr.js";

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

const MAX_NODES = 200;
const DEFAULT_MAX_DEPTH = 20;

// ── Tree building ───────────────────────────────────────────────────

/**
 * Build a full dependency tree by recursive one-hop expansion.
 * Stops at: frontier end, cycle, depth limit, or node cap.
 */
export async function buildDependencyTree(
  client: IxClient,
  rootId: string,
  opts?: { maxDepth?: number; maxNodes?: number },
): Promise<{ tree: DependencyNode[]; truncated: boolean; nodesVisited: number; maxDepthReached: number }> {
  const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = opts?.maxNodes ?? MAX_NODES;
  const visited = new Set<string>([rootId]);
  let nodesVisited = 0;
  let truncated = false;
  let maxDepthReached = 0;

  async function expand(nodeId: string, depth: number): Promise<DependencyNode[]> {
    if (depth > maxDepth) { truncated = true; return []; }
    if (nodesVisited >= maxNodes) { truncated = true; return []; }

    maxDepthReached = Math.max(maxDepthReached, depth);

    const [callResult, importResult, refResult, extendsResult, implementsResult] = await Promise.all([
      client.expand(nodeId, { direction: "in", predicates: ["CALLS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["IMPORTS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["REFERENCES"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["EXTENDS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["IMPLEMENTS"], hops: 1 }),
    ]);

    const children: DependencyNode[] = [];
    // Track IDs added at this level to suppress same-level duplicates from
    // multiple edge types (e.g. a node that both EXTENDS and REFERENCES the
    // root would otherwise appear twice, the second time as a spurious cycle).
    const levelSeen = new Set<string>();

    const processNodes = async (nodes: any[], relation: "called_by" | "imported_by" | "referenced_by" | "extended_by" | "implemented_by", sourceEdge: "CALLS" | "IMPORTS" | "REFERENCES" | "EXTENDS" | "IMPLEMENTS") => {
      for (const n of nodes) {
        if (nodesVisited >= maxNodes) { truncated = true; break; }
        // Skip if already emitted at this level via a different edge type.
        if (levelSeen.has(n.id)) continue;
        const name = n.name || n.attrs?.name || "";
        const resolved = !!name && !isRawId(name);
        const isCycle = visited.has(n.id);

        nodesVisited++;
        levelSeen.add(n.id);
        visited.add(n.id);

        const child: DependencyNode = {
          id: n.id,
          name: resolved ? name : n.id.slice(0, 8),
          kind: n.kind ?? "unknown",
          resolved,
          relation,
          sourceEdge,
          path: n.provenance?.source_uri ?? n.provenance?.sourceUri ?? n.attrs?.path ?? undefined,
          children: [],
          ...(isCycle ? { cycle: true } : {}),
        };

        if (!isCycle && resolved) {
          child.children = await expand(n.id, depth + 1);
        }

        children.push(child);
      }
    };

    await processNodes(callResult.nodes, "called_by", "CALLS");
    await processNodes(importResult.nodes, "imported_by", "IMPORTS");
    await processNodes(refResult.nodes, "referenced_by", "REFERENCES");
    await processNodes(extendsResult.nodes, "extended_by", "EXTENDS");
    await processNodes(implementsResult.nodes, "implemented_by", "IMPLEMENTS");

    return children;
  }

  const tree = await expand(rootId, 1);
  return { tree, truncated, nodesVisited, maxDepthReached };
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

// ── CLI command ─────────────────────────────────────────────────────

export function registerDependsCommand(program: Command): void {
  program
    .command("depends <symbol>")
    .description("Show downstream dependents of the given entity (full tree by default)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--depth <n>", "Limit traversal depth (default: full tree)")
    .option("--all", "Remove the 200-node cap and show the complete tree")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--include-tests", "Include test and fixture entities in results")
    .option("--tests-only", "Show only test and fixture entities")
    .addHelpText("after", `\nExamples:
  ix depends verify_token
  ix depends pickBest --format json
  ix depends AuthProvider --depth 2
  ix depends parser.py --kind file
  ix depends NodeKind --pick 1 --all`)
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: string; depth?: string; all?: boolean; format: string; includeTests?: boolean; testsOnly?: boolean }) => {
      const client = new IxClient(getEndpoint());

      // Validate --pick
      if (opts.pick !== undefined) {
        const pickVal = parseInt(opts.pick, 10);
        if (isNaN(pickVal) || pickVal < 1) {
          stderr(`Invalid value for --pick: must be a positive integer.`);
          return;
        }
      }

      const resolveOpts = {
        kind: opts.kind,
        path: opts.path,
        pick: opts.pick ? parseInt(opts.pick, 10) : undefined,
        includeTests: opts.includeTests,
        testsOnly: opts.testsOnly,
      };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;

      const maxDepth = opts.depth ? parseInt(opts.depth, 10) : DEFAULT_MAX_DEPTH;
      const maxNodes = opts.all ? Infinity : MAX_NODES;

      const { tree, truncated, nodesVisited, maxDepthReached } = await buildDependencyTree(
        client, target.id, { maxDepth, maxNodes },
      );

      // ── JSON output ──────────────────────────────────────────────
      if (opts.format === "json") {
        const output: any = {
          resolvedTarget: target,
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          semantics: "downstream_dependents",
          tree,
          traversal: {
            nodesVisited,
            maxDepthReached,
            truncated,
            ...(opts.depth ? { depthLimit: maxDepth } : {}),
          },
        };
        if (tree.length === 0) {
          output.diagnostics = [{ code: "no_edges", message: `No downstream dependents found for resolved entity.` }];
        }
        if (truncated) {
          output.diagnostics = output.diagnostics ?? [];
          output.diagnostics.push({ code: "truncated", message: `Traversal truncated (depth: ${maxDepth}, node cap: ${MAX_NODES}).` });
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // ── Text output ──────────────────────────────────────────────
      printResolved(target);

      if (tree.length === 0) {
        console.log(`  No downstream dependents found at current graph state.`);
        return;
      }

      console.log(chalk.bold(`\n  Downstream dependents of ${target.kind} ${target.name}:\n`));

      const rootLine = `  ${chalk.cyan((target.kind ?? "").padEnd(10))} ${chalk.bold(target.name)}`;
      console.log(rootLine);

      const treeLines = renderTree(tree, "  ", []);
      for (const line of treeLines) {
        console.log(`  ${line}`);
      }

      if (truncated) {
        console.log(chalk.yellow(`\n  (tree truncated — ${nodesVisited} nodes visited, depth ${maxDepthReached})`));
      }

      console.log(chalk.dim(`\n  ${nodesVisited} downstream dependents, depth ${maxDepthReached}`));

      if (!opts.includeTests) {
        console.log(chalk.dim('\nUse --include-tests to include test entities in tree.'));
      }
    });
}
