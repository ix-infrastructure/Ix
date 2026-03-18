import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "object", "trait", "interface"]);

export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description("Whats affected")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--depth <n>", "Expansion depth for callers/importers (default 1, max 3)", "1")
    .option("--limit <n>", "Max top-impacted members to show", "10")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      "\nExamples:\n  ix impact IngestionService\n  ix impact IngestionService --kind class\n  ix impact verify_token --format json\n  ix impact AuthProvider --limit 5"
    )
    .action(
      async (
        symbol: string,
        opts: { kind?: string; pick?: string; depth: string; limit: string; format: string }
      ) => {
        const client = new IxClient(getEndpoint());
        const limit = parseInt(opts.limit, 10);
        const depth = Math.min(Math.max(parseInt(opts.depth, 10) || 1, 1), 3);
        const isJson = opts.format === "json";

        const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
        const target = await resolveFileOrEntity(client, symbol, resolveOpts);
        if (!target) return;

        if (!isJson) printResolved(target);

        if (CONTAINER_KINDS.has(target.kind)) {
          await containerImpact(client, target, limit, depth, isJson);
        } else {
          await leafImpact(client, target, depth, isJson);
        }
      }
    );
}

async function containerImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  limit: number,
  depth: number,
  isJson: boolean
): Promise<void> {
  const diagnostics: string[] = [];

  // 1. Get contained members, importers, dependents, and developer-cycle context in parallel
  const [containsResult, importersResult, dependentsResult, decisionsResult, tasksResult, bugsResult] = await Promise.all([
    client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] }),
    client.expand(target.id, { direction: "in", predicates: ["IMPORTS"], hops: depth }),
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"], hops: depth }),
    client.expand(target.id, { direction: "in", predicates: ["DECISION_AFFECTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["TASK_AFFECTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["BUG_AFFECTS"] }),
  ]);
  const members = containsResult.nodes;
  const directImporters = importersResult.nodes;
  const directDependents = dependentsResult.nodes;

  const decisions = decisionsResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)",
  }));
  const tasks = tasksResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)", status: String(n.attrs?.status ?? "pending"),
  }));
  const bugs = bugsResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)", status: String(n.attrs?.status ?? "open"), severity: String(n.attrs?.severity ?? "medium"),
  }));

  // 4. For each member (up to 20), get inbound callers
  const membersToCheck = members.slice(0, 20);
  const memberCallerCounts: { name: string; kind: string; id: string; callerCount: number }[] = [];
  let totalMemberCallers = 0;

  const callerPromises = membersToCheck.map(async (member: any) => {
    try {
      const callersResult = await client.expand(member.id, {
        direction: "in",
        predicates: ["CALLS", "REFERENCES"],
      });
      return {
        name: member.name || member.attrs?.name || "(unnamed)",
        kind: member.kind || "unknown",
        id: member.id,
        callerCount: callersResult.nodes.length,
      };
    } catch {
      diagnostics.push(`Failed to expand callers for member ${member.id}`);
      return {
        name: member.name || member.attrs?.name || "(unnamed)",
        kind: member.kind || "unknown",
        id: member.id,
        callerCount: 0,
      };
    }
  });

  const callerResults = await Promise.all(callerPromises);
  for (const r of callerResults) {
    memberCallerCounts.push(r);
    totalMemberCallers += r.callerCount;
  }

  // 5. Rank by caller count, top N
  memberCallerCounts.sort((a, b) => b.callerCount - a.callerCount);
  const topMembers = memberCallerCounts.filter((m) => m.callerCount > 0).slice(0, limit);

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          depth,
          summary: {
            members: members.length,
            callers: 0,
            callees: 0,
            directImporters: directImporters.length,
            directDependents: directDependents.length,
            memberLevelCallers: totalMemberCallers,
          },
          callerList: [],
          calleeList: [],
          topImpactedMembers: topMembers,
          decisions,
          tasks,
          bugs,
          diagnostics,
        },
        null,
        2
      )
    );
  } else {
    const depthNote = depth > 1 ? chalk.dim(` (depth ${depth})`) : "";
    console.log(chalk.bold(`Target: ${target.kind} ${target.name}\n`));
    console.log(chalk.bold("Impact summary:") + depthNote);
    console.log(`  members:              ${members.length}`);
    console.log(`  importers:            ${directImporters.length}`);
    console.log(`  dependents:           ${directDependents.length}`);
    console.log(`  member-level callers: ${totalMemberCallers}`);

    if (topMembers.length > 0) {
      console.log(chalk.bold("\nTop impacted members:"));
      for (const m of topMembers) {
        const kindStr = chalk.cyan(m.kind.padEnd(10));
        const nameStr = chalk.white(m.name.padEnd(20));
        console.log(`  ${kindStr} ${nameStr} ${m.callerCount} callers`);
      }
    } else {
      console.log(chalk.dim("\nNo member-level callers found."));
    }

    if (decisions.length > 0) {
      console.log(chalk.bold("\nDecisions:"));
      for (const d of decisions) {
        console.log(`  ${chalk.yellow(d.name)}`);
      }
    }

    if (tasks.length > 0) {
      console.log(chalk.bold("\nTasks:"));
      for (const t of tasks) {
        const icon = t.status === "done" ? "✓" : "○";
        console.log(`  ${icon} [${t.status}] ${t.name}`);
      }
    }

    if (bugs.length > 0) {
      console.log(chalk.bold("\nBugs:"));
      for (const b of bugs) {
        const icon = b.status === "closed" || b.status === "resolved" ? "✓" : "○";
        console.log(`  ${icon} [${b.status}] ${chalk.red(b.severity)} ${b.name}`);
      }
    }

    if (diagnostics.length > 0) {
      console.log(chalk.dim(`\nDiagnostics: ${diagnostics.join("; ")}`));
    }
  }
}

async function leafImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  depth: number,
  isJson: boolean
): Promise<void> {
  // Fetch callers, callees, and developer-cycle context in parallel
  const [callersResult, calleesResult, decisionsResult, tasksResult, bugsResult] = await Promise.all([
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"], hops: depth }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS", "REFERENCES"] }),
    client.expand(target.id, { direction: "in", predicates: ["DECISION_AFFECTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["TASK_AFFECTS"] }),
    client.expand(target.id, { direction: "in", predicates: ["BUG_AFFECTS"] }),
  ]);

  const decisions = decisionsResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)",
  }));
  const tasks = tasksResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)", status: String(n.attrs?.status ?? "pending"),
  }));
  const bugs = bugsResult.nodes.map((n: any) => ({
    id: n.id, name: n.name || n.attrs?.name || "(unnamed)", status: String(n.attrs?.status ?? "open"), severity: String(n.attrs?.severity ?? "medium"),
  }));

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          depth,
          summary: {
            members: 0,
            callers: callersResult.nodes.length,
            callees: calleesResult.nodes.length,
            directImporters: 0,
            directDependents: 0,
            memberLevelCallers: 0,
          },
          callerList: callersResult.nodes.map((n: any) => ({
            id: n.id,
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })),
          calleeList: calleesResult.nodes.map((n: any) => ({
            id: n.id,
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })),
          topImpactedMembers: [],
          decisions,
          tasks,
          bugs,
          diagnostics: [],
        },
        null,
        2
      )
    );
  } else {
    const depthNote = depth > 1 ? chalk.dim(` (depth ${depth})`) : "";
    console.log(chalk.bold(`Target: ${target.kind} ${target.name}\n`));
    console.log(chalk.bold("Impact summary:") + depthNote);
    console.log(`  callers: ${callersResult.nodes.length}`);
    console.log(`  callees: ${calleesResult.nodes.length}`);

    if (callersResult.nodes.length > 0) {
      console.log(chalk.bold("\nCallers:"));
      for (const n of callersResult.nodes) {
        const node = n as any;
        const kindStr = chalk.cyan((node.kind || "").padEnd(10));
        const name = node.name || node.attrs?.name || "(unnamed)";
        console.log(`  ${kindStr} ${name}`);
      }
    }

    if (calleesResult.nodes.length > 0) {
      console.log(chalk.bold("\nCallees:"));
      for (const n of calleesResult.nodes) {
        const node = n as any;
        const kindStr = chalk.cyan((node.kind || "").padEnd(10));
        const name = node.name || node.attrs?.name || "(unnamed)";
        console.log(`  ${kindStr} ${name}`);
      }
    }

    if (decisions.length > 0) {
      console.log(chalk.bold("\nDecisions:"));
      for (const d of decisions) {
        console.log(`  ${chalk.yellow(d.name)}`);
      }
    }

    if (tasks.length > 0) {
      console.log(chalk.bold("\nTasks:"));
      for (const t of tasks) {
        const icon = t.status === "done" ? "✓" : "○";
        console.log(`  ${icon} [${t.status}] ${t.name}`);
      }
    }

    if (bugs.length > 0) {
      console.log(chalk.bold("\nBugs:"));
      for (const b of bugs) {
        const icon = b.status === "closed" || b.status === "resolved" ? "✓" : "○";
        console.log(`  ${icon} [${b.status}] ${chalk.red(b.severity)} ${b.name}`);
      }
    }
  }
}
