import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity, printResolved } from "../resolve.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);
const CALLABLE_KINDS = new Set(["method", "function"]);

interface KeyMember {
  name: string;
  kind: string;
  callerCount: number;
}

interface OverviewResult {
  resolvedTarget: { id: string; kind: string; name: string };
  resolutionMode: string;
  resultSource: string;
  path: string | null;
  summary: {
    members?: number;
    imports?: number;
    inboundDependents?: number;
    callers?: number;
    callees?: number;
  };
  keyMembers: KeyMember[] | null;
  container: { kind: string; name: string } | null;
  signature: string | null;
  diagnostics: string[];
  decisions: { id: string; title: string; rationale?: string }[];
  tasks: { id: string; title: string; status: string }[];
}

export function registerOverviewCommand(program: Command): void {
  program
    .command("overview <target>")
    .description("Compact one-shot structural summary of an entity")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      `\nExamples:
  ix overview IngestionService
  ix overview IngestionService --kind class
  ix overview verify_token --kind function --format json
  ix overview auth.py --kind file`
    )
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const allKinds = [...CONTAINER_KINDS, ...CALLABLE_KINDS];
      const target = await resolveEntity(client, symbol, allKinds, opts);
      if (!target) return;

      if (opts.format !== "json") printResolved(target);

      const isContainer = CONTAINER_KINDS.has(target.kind);

      if (isContainer) {
        await overviewContainer(client, target, opts.format);
      } else {
        await overviewCallable(client, target, opts.format);
      }
    });
}

async function overviewContainer(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];

  // Fetch entity details, members, imports, and inbound dependents in parallel
  const [details, membersResult, importsResult, inboundResult, decisionsResult] = await Promise.all([
    client.entity(target.id),
    client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] }),
    client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "IMPORTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["DECISION_AFFECTS"] }),
  ]);

  const node = details.node as any;
  const path = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;

  const members = membersResult.nodes;
  const imports = importsResult.nodes;
  const inbound = inboundResult.nodes;

  const decisions = decisionsResult.nodes.map((n: any) => ({
    id: n.id,
    title: n.name || n.attrs?.name || "(unnamed)",
    rationale: n.attrs?.rationale ?? undefined,
  }));

  // Get top 5 members by name and their inbound CALLS count
  const sortedMembers = [...members]
    .filter((m: any) => m.name || m.attrs?.name)
    .sort((a: any, b: any) => {
      const nameA = a.name || a.attrs?.name || "";
      const nameB = b.name || b.attrs?.name || "";
      return nameA.localeCompare(nameB);
    })
    .slice(0, 5);

  let keyMembers: KeyMember[] = [];
  if (sortedMembers.length > 0) {
    const callerCounts = await Promise.all(
      sortedMembers.map(async (m: any) => {
        try {
          const callersResult = await client.expand(m.id, {
            direction: "in",
            predicates: ["CALLS"],
          });
          return callersResult.nodes.length;
        } catch {
          return 0;
        }
      })
    );

    keyMembers = sortedMembers.map((m: any, i: number) => ({
      name: m.name || m.attrs?.name || "(unnamed)",
      kind: m.kind || "unknown",
      callerCount: callerCounts[i],
    }));

    // Sort by callerCount descending for display
    keyMembers.sort((a, b) => b.callerCount - a.callerCount);
  }

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    resultSource: "graph",
    path,
    summary: {
      members: members.length,
      imports: imports.length,
      inboundDependents: inbound.length,
    },
    keyMembers: keyMembers.length > 0 ? keyMembers : null,
    container: null,
    signature: null,
    diagnostics,
    decisions,
    tasks: [],
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Overview: ${chalk.bold(target.name)} (${chalk.cyan(target.kind)})`);
    if (path) console.log(`  path:     ${chalk.dim(path)}`);
    console.log(`  members:  ${members.length}`);
    console.log(`  imports:  ${imports.length}`);
    console.log(`  inbound:  ${inbound.length} dependents`);

    if (keyMembers.length > 0) {
      console.log(`\nKey members:`);
      for (const km of keyMembers) {
        const kindStr = chalk.cyan(km.kind.padEnd(10));
        const nameStr = km.name.padEnd(20);
        console.log(`  ${kindStr} ${nameStr} ${km.callerCount} callers`);
      }
    }

    if (decisions.length > 0) {
      console.log(`\nDecisions:`);
      for (const d of decisions) {
        console.log(`  ${chalk.yellow(d.title)}`);
      }
    }
  }
}

async function overviewCallable(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];

  // Fetch entity details, callers, and callees in parallel
  const [details, callersResult, calleesResult, decisionsResult] = await Promise.all([
    client.entity(target.id),
    client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),
    client.expand(target.id, { direction: "in", predicates: ["DECISION_AFFECTS"] }),
  ]);

  const node = details.node as any;
  const path = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;
  const signature = node.attrs?.signature || null;

  // Find container via CONTAINS edge (parent class/file)
  const edges = (details.edges ?? []) as any[];
  const containsEdge = edges.find(
    (e: any) => e.predicate === "CONTAINS" && e.dst === target.id
  );

  let container: { kind: string; name: string } | null = null;
  if (containsEdge) {
    try {
      const containerDetails = await client.entity(containsEdge.src);
      const cNode = containerDetails.node as any;
      container = {
        kind: cNode.kind || "unknown",
        name: cNode.name || cNode.attrs?.name || "(unknown)",
      };
    } catch {
      diagnostics.push("Could not resolve container entity");
    }
  }

  const callers = callersResult.nodes;
  const callees = calleesResult.nodes;

  const decisions = decisionsResult.nodes.map((n: any) => ({
    id: n.id,
    title: n.name || n.attrs?.name || "(unnamed)",
    rationale: n.attrs?.rationale ?? undefined,
  }));

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    resultSource: "graph",
    path,
    summary: {
      callers: callers.length,
      callees: callees.length,
    },
    keyMembers: null,
    container,
    signature,
    diagnostics,
    decisions,
    tasks: [],
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Overview: ${chalk.bold(target.name)} (${chalk.cyan(target.kind)})`);
    if (path) console.log(`  path:       ${chalk.dim(path)}`);
    if (container) console.log(`  container:  ${chalk.cyan(container.kind)} ${container.name}`);
    if (signature) console.log(`  signature:  ${chalk.dim(signature)}`);
    console.log(`  callers:    ${callers.length}`);
    console.log(`  callees:    ${callees.length}`);

    if (decisions.length > 0) {
      console.log(`\nDecisions:`);
      for (const d of decisions) {
        console.log(`  ${chalk.yellow(d.title)}`);
      }
    }
  }
}
