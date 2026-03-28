import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, isRawId } from "../resolve.js";
import { stderr } from "../stderr.js";
import { buildDependencyTree } from "./depends.js";
import { renderSection, renderKeyValue, renderResolvedHeader, colorizeKind } from "../ui.js";

// ── Types ────────────────────────────────────────────────────────────

interface TraceNode {
  id: string;
  name: string;
  kind: string;
  resolved: boolean;
  path?: string;
  children: TraceNode[];
  cycle?: boolean;
}

interface PathNode {
  id: string;
  name: string;
  kind: string;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = Infinity;
const MAX_NODES = Infinity;

// ── Helpers ──────────────────────────────────────────────────────────

const ALL_PREDICATES = ["CALLS", "IMPORTS", "REFERENCES", "EXTENDS", "IMPLEMENTS"];

/** Map --kind flag to API predicates. If no kind specified, use all predicates (same as depends). */
function kindToPredicates(kind?: string): string[] {
  if (!kind) return ALL_PREDICATES;
  switch (kind.toLowerCase()) {
    case "calls":    return ["CALLS", "REFERENCES"];
    case "imports":  return ["IMPORTS"];
    case "depends":  return ["IMPORTS"];
    case "contains": return ["CONTAINS"];
    default:         return ALL_PREDICATES;
  }
}

// ── Tree traversal ───────────────────────────────────────────────────

async function buildTraceTree(
  client: IxClient,
  rootId: string,
  opts: {
    direction: "in" | "out";
    predicates: string[];
    maxDepth: number;
    maxNodes: number;
  },
): Promise<{ tree: TraceNode[]; truncated: boolean; nodesVisited: number; maxDepthReached: number }> {
  const { direction, predicates, maxDepth, maxNodes } = opts;
  const visited = new Set<string>([rootId]);
  let nodesVisited = 0;
  let truncated = false;
  let maxDepthReached = 0;

  async function expand(nodeId: string, depth: number): Promise<TraceNode[]> {
    if (depth > maxDepth) { truncated = true; return []; }
    if (nodesVisited >= maxNodes) { truncated = true; return []; }
    maxDepthReached = Math.max(maxDepthReached, depth);

    // One call per predicate (matches depends.ts behaviour — order and dedup are stable)
    const results = await Promise.all(
      predicates.map((p) => client.expand(nodeId, { direction, predicates: [p], hops: 1 })),
    );

    const children: TraceNode[] = [];
    const levelSeen = new Set<string>();

    for (const result of results) {
      for (const n of result.nodes) {
        if (nodesVisited >= maxNodes) { truncated = true; break; }
        if (levelSeen.has(n.id)) continue;

        const name = n.name || n.attrs?.name || "";
        const resolved = !!name && !isRawId(name);
        const isCycle = visited.has(n.id);

        nodesVisited++;
        levelSeen.add(n.id);
        visited.add(n.id);

        const child: TraceNode = {
          id: n.id,
          name: resolved ? name : n.id.slice(0, 8),
          kind: n.kind ?? "unknown",
          resolved,
          path: n.provenance?.sourceUri ?? n.provenance?.source_uri ?? undefined,
          children: [],
          ...(isCycle ? { cycle: true } : {}),
        };

        if (!isCycle && resolved) {
          child.children = await expand(n.id, depth + 1);
        }

        children.push(child);
      }
    }

    return children;
  }

  const tree = await expand(rootId, 1);
  return { tree, truncated, nodesVisited, maxDepthReached };
}

// ── Path search (BFS) ────────────────────────────────────────────────

export async function findPath(
  client: IxClient,
  fromId: string,
  toId: string,
  predicates: string[],
  maxDepth: number = 10,
): Promise<PathNode[] | null> {
  const nodeMap = new Map<string, { name: string; kind: string }>();

  const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];
  const visited = new Set<string>([fromId]);

  while (queue.length > 0) {
    const entry = queue.shift()!;
    const { id, path } = entry;
    if (path.length >= maxDepth) continue;

    const [outResult, inResult] = await Promise.all([
      client.expand(id, { direction: "out", predicates, hops: 1 }),
      client.expand(id, { direction: "in", predicates, hops: 1 }),
    ]);

    for (const n of [...outResult.nodes, ...inResult.nodes]) {
      const name = n.name || n.attrs?.name || n.id.slice(0, 8);
      if (!nodeMap.has(n.id)) {
        nodeMap.set(n.id, { name, kind: n.kind ?? "unknown" });
      }

      if (n.id === toId) {
        const fullPath = [...path, n.id];
        return fullPath.map((nodeId) => {
          if (nodeId === fromId) return { id: nodeId, name: "", kind: "" }; // filled below
          const meta = nodeMap.get(nodeId) ?? { name: nodeId.slice(0, 8), kind: "unknown" };
          return { id: nodeId, ...meta };
        });
      }

      if (visited.has(n.id)) continue;
      visited.add(n.id);
      queue.push({ id: n.id, path: [...path, n.id] });
    }
  }

  return null;
}

// ── Text rendering ───────────────────────────────────────────────────

function renderTraceTree(children: Array<{ name: string; kind?: string; children: any[]; cycle?: boolean }>, isLast: boolean[]): string[] {
  const lines: string[] = [];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const last = i === children.length - 1;
    const connector = last ? "└─ " : "├─ ";

    let indent = "";
    for (const il of isLast) {
      indent += il ? "   " : "│  ";
    }

    const kindStr = child.cycle
      ? chalk.dim((child.kind ?? "").padEnd(10))
      : colorizeKind(child.kind ?? "");
    const nameStr = child.cycle
      ? chalk.dim(child.name) + chalk.yellow(" ↺")
      : child.name;

    lines.push(`${indent}${connector}${kindStr} ${nameStr}`);

    if (child.children.length > 0) {
      lines.push(...renderTraceTree(child.children, [...isLast, last]));
    }
  }

  return lines;
}


const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);


// ── Command ──────────────────────────────────────────────────────────

export function registerTraceCommand(program: Command): void {
  program
    .command("trace <symbol>")
    .description("Follow how it connects")
    .option("--to <target>", "Find path to target symbol")
    .option("--upstream", "Show who calls/imports this (same as depends)")
    .option("--downstream", "Show what this calls/imports (outward flow)")
    .option("--kind <kind>", "Relationship kind: calls|imports|depends|contains")
    .option("--depth <n>", "Cap traversal depth")
    .option("--cap <n>", "Cap number of nodes visited, per direction")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--include-tests", "Include test and fixture entities")
    .option("--tests-only", "Show only test and fixture entities")
    .addHelpText(
      "after",
      `\nExamples:
  ix trace IxClient
  ix trace IxClient --downstream
  ix trace resolve --upstream
  ix trace registerImpactCommand --to IxClient
  ix trace api.ts --kind imports
  ix trace IxClient --depth 3 --format json`,
    )
    .action(
      async (
        symbol: string,
        opts: {
          to?: string;
          upstream?: boolean;
          downstream?: boolean;
          kind?: string;
          depth?: string;
          cap?: string;
          pick?: string;
          path?: string;
          format: string;
          includeTests?: boolean;
          testsOnly?: boolean;
        },
      ) => {
        const client = new IxClient(getEndpoint());

        // Validate --pick
        if (opts.pick !== undefined) {
          const pickVal = parseInt(opts.pick, 10);
          if (isNaN(pickVal) || pickVal < 1) {
            stderr("Invalid value for --pick: must be a positive integer.");
            return;
          }
        }

        const resolveOpts = {
          path: opts.path,
          pick: opts.pick ? parseInt(opts.pick, 10) : undefined,
          includeTests: opts.includeTests,
          testsOnly: opts.testsOnly,
        };

        const maxDepth = opts.depth ? parseInt(opts.depth, 10) : DEFAULT_MAX_DEPTH;
        const maxNodes = opts.cap ? parseInt(opts.cap, 10) : MAX_NODES;

        // ── Path mode (--to) ────────────────────────────────────────
        if (opts.to) {
          const toResolveOpts = {
            ...resolveOpts,
            path: undefined,
          };
          const [fromTarget, toTarget] = await Promise.all([
            resolveFileOrEntity(client, symbol, resolveOpts),
            resolveFileOrEntity(client, opts.to, toResolveOpts),
          ]);
          if (!fromTarget || !toTarget) return;

          const relKind = opts.kind ?? "mixed";
          const predicates = kindToPredicates(opts.kind);

          const rawPath = await findPath(client, fromTarget.id, toTarget.id, predicates, maxDepth + 7);

          // Fill in the from-node name (was left blank above)
          const pathNodes: PathNode[] = rawPath
            ? rawPath.map((n, i) =>
                i === 0 ? { id: n.id, name: fromTarget.name, kind: fromTarget.kind } : n,
              )
            : [];

          // ── JSON output ────────────────────────────────────────
          if (opts.format === "json") {
            const output: Record<string, unknown> = {
              mode: "path",
              from: { name: fromTarget.name, kind: fromTarget.kind, path: fromTarget.path },
              to: { name: toTarget.name, kind: toTarget.kind, path: toTarget.path },
              kind: relKind,
            };
            if (pathNodes.length > 0) {
              const mapped = pathNodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind }));
              output.path = mapped;
              output.summary = { path_length: pathNodes.length };
            } else {
              output.path = null;
              output.diagnostics = [
                {
                  code: "no_path",
                  message: `No route found from ${fromTarget.name} to ${toTarget.name}.`,
                },
              ];
            }
            console.log(JSON.stringify(output, null, 2));
            return;
          }

          // ── Text output ────────────────────────────────────────
          renderResolvedHeader(fromTarget.kind, fromTarget.name);
          renderSection("Trace");
          renderKeyValue("From", fromTarget.name);
          renderKeyValue("To", toTarget.name);
          renderKeyValue("Kind", cap(relKind));

          if (pathNodes.length === 0) {
            console.log(`\nNo route found from ${chalk.bold(fromTarget.name)} to ${chalk.bold(toTarget.name)}.`);
            return;
          }

          renderSection("Route");
          for (let i = 0; i < pathNodes.length; i++) {
            const n = pathNodes[i];
            const kindStr = colorizeKind(n.kind ?? "");
            if (i === 0) {
              console.log(`  ${kindStr} ${n.name}`);
            } else {
              console.log(`  ${chalk.dim("→")} ${kindStr} ${n.name}`);
            }
          }

          renderSection("Summary");
          renderKeyValue("Path length", String(pathNodes.length));
          return;
        }

        // ── Directional mode ────────────────────────────────────────
        const target = await resolveFileOrEntity(client, symbol, resolveOpts);
        if (!target) return;

        const predicates = kindToPredicates(opts.kind);
        const relKind = opts.kind ?? "mixed";

        // Determine direction(s)
        const doUpstream = opts.upstream === true;
        const doDownstream = opts.downstream === true;
        const doBoth = !doUpstream && !doDownstream;
        const direction = doBoth ? "both" : doUpstream ? "upstream" : "downstream";

        // upstream   = "in" (who depends on this — same as depends)
        // downstream = "out" (what this depends on — inverse of depends)

        // ── Both: run up + down in parallel ────────────────────────
        if (doBoth) {
          const [upResult, downResult] = await Promise.all([
            buildDependencyTree(client, target.id, { maxDepth, maxNodes, predicates }),
            buildTraceTree(client, target.id, {
              direction: "out",
              predicates,
              maxDepth,
              maxNodes,
            }),
          ]);

          // ── JSON ──────────────────────────────────────────────
          if (opts.format === "json") {
            console.log(
              JSON.stringify(
                {
                  mode: "directional",
                  target: { name: target.name, kind: target.kind, path: target.path },
                  direction: "both",
                  kind: relKind,
                  depth: maxDepth,
                  upstream: {
                    tree: upResult.tree,
                    summary: { nodes_visited: upResult.nodesVisited, max_depth: upResult.maxDepthReached },
                  },
                  downstream: {
                    tree: downResult.tree,
                    summary: { nodes_visited: downResult.nodesVisited, max_depth: downResult.maxDepthReached },
                  },
                },
                null,
                2,
              ),
            );
            return;
          }

          // ── Text ──────────────────────────────────────────────
          renderResolvedHeader(target.kind, target.name);
          renderSection("Trace");
          renderKeyValue("Direction", "Both");
          renderKeyValue("Kind", cap(relKind));

          // Upstream section (in edges — who depends on this)
          renderSection("Upstream");
          console.log(`  ${target.name}`);
          if (upResult.tree.length === 0) {
            console.log(chalk.dim("  (none)"));
          } else {
            for (const line of renderTraceTree(upResult.tree, [])) {
              console.log(`  ${line}`);
            }
          }

          // Downstream section (out edges — what this depends on)
          renderSection("Downstream");
          console.log(`  ${target.name}`);
          if (downResult.tree.length === 0) {
            console.log(chalk.dim("  (none)"));
          } else {
            for (const line of renderTraceTree(downResult.tree, [])) {
              console.log(`  ${line}`);
            }
          }

          const totalNodes = upResult.nodesVisited + downResult.nodesVisited;
          const maxD = Math.max(upResult.maxDepthReached, downResult.maxDepthReached);
          renderSection("Summary");
          renderKeyValue("Nodes visited", String(totalNodes));
          renderKeyValue("Max depth", String(maxD));
          return;
        }

        // ── Single direction ────────────────────────────────────────
        const { tree, truncated, nodesVisited, maxDepthReached } = doUpstream
          ? await buildDependencyTree(client, target.id, { maxDepth, maxNodes, predicates })
          : await buildTraceTree(client, target.id, { direction: "out", predicates, maxDepth, maxNodes });

        // ── JSON ────────────────────────────────────────────────────
        if (opts.format === "json") {
          // Build flat nodes + edges lists for JSON output
          const nodes: Array<{ id: string; name: string; kind: string }> = [
            { id: target.id, name: target.name, kind: target.kind },
          ];
          const edges: Array<{ from: string; to: string; kind: string }> = [];

          function collectJson(parentId: string, children: TraceNode[]): void {
            for (const child of children) {
              nodes.push({ id: child.id, name: child.name, kind: child.kind });
              // downstream = in edges (child → parent), upstream = out edges (parent → child)
              edges.push({ from: doUpstream ? child.id : parentId, to: doUpstream ? parentId : child.id, kind: relKind });
              collectJson(child.id, child.children);
            }
          }
          collectJson(target.id, tree);

          function toJsonTree(children: TraceNode[]): unknown[] {
            return children.map((c) => ({ id: c.id, children: toJsonTree(c.children) }));
          }

          const output: Record<string, unknown> = {
            mode: "directional",
            target: { name: target.name, kind: target.kind, path: target.path },
            direction,
            kind: relKind,
            depth: maxDepth,
            nodes,
            edges,
            tree: { id: target.id, children: toJsonTree(tree) },
            summary: { nodes_visited: nodesVisited, max_depth: maxDepthReached },
          };

          if (tree.length === 0) {
            output.diagnostics = [
              { code: "no_edges", message: `No ${direction} ${relKind} found for ${target.name}.` },
            ];
          }
          if (truncated) {
            const diags = (output.diagnostics as unknown[]) ?? [];
            (diags as unknown[]).push({ code: "truncated", message: `Traversal truncated (depth: ${maxDepth}, node cap: ${maxNodes}).` });
            output.diagnostics = diags;
          }

          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // ── Text ────────────────────────────────────────────────────
        renderResolvedHeader(target.kind, target.name);
        renderSection("Trace");
        renderKeyValue("Direction", cap(direction));
        renderKeyValue("Kind", cap(relKind));

        if (tree.length === 0) {
          const relDir = doUpstream ? "upstream" : "downstream";
          console.log(`\nNo ${relDir} ${relKind} found for ${chalk.bold(target.name)}.`);
          return;
        }

        renderSection("Path");
        console.log(`  ${target.name}`);
        for (const line of renderTraceTree(tree, [])) {
          console.log(`  ${line}`);
        }


        renderSection("Summary");
        renderKeyValue("Nodes visited", String(nodesVisited));
        renderKeyValue("Max depth", String(maxDepthReached));
      },
    );
}
