import type { Command } from "commander";
import chalk from "chalk";
import { renderSection, renderKeyValue, renderNote, renderResolvedHeader, colorizeKind } from "../ui.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { bucketByHierarchy, getSystemPath, formatSystemPath, hasMapData, type SystemPath } from "../hierarchy.js";
import { inferRiskSemantics, humanizeLabel, type ImpactFacts, type RiskSemantics } from "../impact/risk-semantics.js";
import { stripNulls } from "../format.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "object", "trait", "interface"]);

export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description("System risk analysis — what behavior is at risk if this changes")
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

// ── Risk level coloring ──────────────────────────────────────────────────────

function riskColor(level: string): typeof chalk {
  if (level === "critical") return chalk.red.bold;
  if (level === "high") return chalk.red;
  if (level === "medium") return chalk.yellow;
  return chalk.dim;
}

// ── Shared text rendering ────────────────────────────────────────────────────

function renderRiskHeader(
  target: { kind: string; name: string },
  risk: RiskSemantics,
  systemPath: SystemPath,
): void {
  renderResolvedHeader(target.kind, target.name);
  console.log();

  if (systemPath.length > 1 && hasMapData(systemPath)) {
    renderKeyValue("System path", formatSystemPath(systemPath));
  }

  // Risk summary — the lead section
  const color = riskColor(risk.riskLevel);
  renderSection("Risk summary");
  console.log(`  ${color(risk.riskSummary)}`);

  // At-risk behavior
  if (risk.behaviorAtRisk.length > 0) {
    renderSection("At-risk behavior");
    for (const b of risk.behaviorAtRisk) {
      console.log(`  • ${b}`);
    }
  }
}

function renderPropagationBuckets(
  propagationBuckets: Array<{ region: { name: string; kind: string }; members: Array<{ name: string; kind: string }> }>,
  flowPropagation?: { flowName: string; count: number },
): void {
  if (propagationBuckets.length === 0 && !flowPropagation) return;
  renderSection("Propagation");

  // Flow propagation line first
  if (flowPropagation) {
    const flowLabel = capitalize(flowPropagation.flowName) + " flow";
    console.log(`  ${chalk.cyan(flowLabel.padEnd(30))} ${flowPropagation.count} downstream dependents`);
  }

  const sorted = [...propagationBuckets].sort((a, b) => b.members.length - a.members.length);
  for (const bucket of sorted) {
    const regionLabel = humanizeLabel(bucket.region.name);
    console.log(`  ${chalk.cyan(regionLabel.padEnd(30))} ${bucket.members.length} dependents`);
  }
}

function renderMostAffected(
  risk: RiskSemantics,
  topMembers: Array<{ name: string; kind: string; callerCount: number }>,
  callerNames?: string[],
  calleeNames?: string[],
): void {
  const items: string[] = [];

  if (topMembers.length > 0) {
    const names = topMembers.slice(0, 3).map((m) => m.name);
    const suffix = topMembers.length > 3 ? ` and ${topMembers.length - 3} more` : "";
    items.push(`${names.join(", ")}${suffix} in the ${risk.category === "boundary" ? "client boundary" : "container"}`);
  }

  if (risk.mostAffectedHint) {
    // For flow hints with ";", split into separate items
    const hintParts = risk.mostAffectedHint.split("; ");
    for (const part of hintParts) {
      if (items.length < 3) items.push(part);
    }
  }

  if (callerNames && callerNames.length > 0 && items.length < 3) {
    const shown = callerNames.slice(0, 2).join(", ");
    const more = callerNames.length > 2 ? ` and ${callerNames.length - 2} more` : "";
    items.push(`Callers: ${shown}${more}`);
  }

  if (items.length > 0) {
    renderSection("Most affected");
    for (const item of items.slice(0, 3)) {
      console.log(`  • ${item}`);
    }
  }
}

function renderNextStep(risk: RiskSemantics): void {
  if (risk.nextStep) {
    renderSection("Next");
    renderNote(risk.nextStep);
  }
}

function renderSupportingContext(
  counts: Record<string, number>,
): void {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  if (entries.length === 0) return;
  renderSection("Supporting context");
  for (const [label, value] of entries) {
    renderKeyValue(label.replace(/:$/, ""), String(value));
  }
}

function renderDecisionsTasksBugs(
  decisions: Array<{ name: string }>,
  tasks: Array<{ name: string; status: string }>,
  bugs: Array<{ name: string; status: string; severity: string }>,
): void {
  if (decisions.length > 0) {
    renderSection("Decisions");
    for (const d of decisions) {
      console.log(`  ${chalk.yellow(d.name)}`);
    }
  }

  if (tasks.length > 0) {
    renderSection("Tasks");
    for (const t of tasks) {
      const icon = t.status === "done" ? "✓" : "○";
      console.log(`  ${icon} [${t.status}] ${t.name}`);
    }
  }

  if (bugs.length > 0) {
    renderSection("Bugs");
    for (const b of bugs) {
      const icon = b.status === "closed" || b.status === "resolved" ? "✓" : "○";
      console.log(`  ${icon} [${b.status}] ${chalk.red(b.severity)} ${b.name}`);
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Container impact ─────────────────────────────────────────────────────────

async function containerImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  limit: number,
  depth: number,
  isJson: boolean
): Promise<void> {
  const diagnostics: string[] = [];

  const [containsResult, importersResult, dependentsResult, systemPath, decisionsResult, tasksResult, bugsResult] = await Promise.all([
    client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] }),
    client.expand(target.id, { direction: "in", predicates: ["IMPORTS"], hops: depth }),
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"], hops: depth }),
    getSystemPath(client, target.id),
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

  // For each member (up to 20), get inbound callers
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

  memberCallerCounts.sort((a, b) => b.callerCount - a.callerCount);
  const topMembers = memberCallerCounts.filter((m) => m.callerCount > 0).slice(0, limit);

  // Bucket all dependents by hierarchy
  const allDependentIds = [
    ...directImporters.map((n: any) => n.id),
    ...directDependents.map((n: any) => n.id),
  ];
  const uniqueDependentIds = [...new Set(allDependentIds)];
  const propagationBuckets = uniqueDependentIds.length > 0
    ? await bucketByHierarchy(client, uniqueDependentIds)
    : [];

  const systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));

  // Infer risk semantics
  const riskFacts: ImpactFacts = {
    name: target.name,
    kind: target.kind,
    container: undefined,
    systemPath: systemPathMapped,
    members: members.length,
    callers: 0,
    callees: 0,
    directImporters: directImporters.length,
    directDependents: directDependents.length,
    memberLevelCallers: totalMemberCallers,
    propagationBuckets: propagationBuckets.map((b) => ({
      region: b.region.name,
      regionKind: b.region.kind,
      count: b.members.length,
    })),
  };
  const risk = inferRiskSemantics(riskFacts);

  if (isJson) {
    console.log(
      JSON.stringify(
        stripNulls({
          resolvedTarget: { kind: target.kind, name: target.name },
          depth,
          systemPath: systemPathMapped.length > 0 ? systemPathMapped : undefined,
          riskSummary: risk.riskSummary,
          riskLevel: risk.riskLevel,
          riskCategory: risk.category,
          atRiskBehavior: risk.behaviorAtRisk,
          nextStep: risk.nextStep || undefined,
          flowPropagation: risk.flowPropagation || undefined,
          summary: {
            members: members.length,
            directImporters: directImporters.length,
            directDependents: directDependents.length,
            memberLevelCallers: totalMemberCallers,
          },
          topImpactedMembers: topMembers.length > 0 ? topMembers : undefined,
          propagationBuckets: propagationBuckets.length > 0 ? propagationBuckets.map((b) => ({
            region: b.region.name,
            regionKind: b.region.kind,
            count: b.members.length,
            members: b.members.slice(0, 5).map((m) => ({ name: m.name, kind: m.kind })),
          })) : undefined,
          decisions: decisions.length > 0 ? decisions : undefined,
          tasks: tasks.length > 0 ? tasks : undefined,
          bugs: bugs.length > 0 ? bugs : undefined,
          diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
        }),
        null,
        2
      )
    );
  } else {
    // 1. Risk summary + At-risk behavior
    renderRiskHeader(target, risk, systemPath);

    // 2. Propagation
    renderPropagationBuckets(propagationBuckets, risk.flowPropagation);

    // 3. Most affected
    renderMostAffected(risk, topMembers);

    // 4. Supporting context
    renderSupportingContext({
      "Members:": members.length,
      "Importers:": directImporters.length,
      "Direct dependents:": directDependents.length,
      "Member-level callers:": totalMemberCallers,
    });

    // 5. Next step
    renderNextStep(risk);

    // 6. Decisions / Tasks / Bugs
    renderDecisionsTasksBugs(decisions, tasks, bugs);

    if (diagnostics.length > 0) {
      renderNote(`Diagnostics: ${diagnostics.join("; ")}`);
    }
  }
}

// ── Leaf impact ──────────────────────────────────────────────────────────────

async function leafImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  depth: number,
  isJson: boolean
): Promise<void> {
  const [callersResult, calleesResult, systemPath, decisionsResult, tasksResult, bugsResult] = await Promise.all([
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"], hops: depth }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS", "REFERENCES"] }),
    getSystemPath(client, target.id),
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

  // Bucket callers by hierarchy
  const callerIds = callersResult.nodes.map((n: any) => n.id);
  const propagationBuckets = callerIds.length > 0
    ? await bucketByHierarchy(client, callerIds)
    : [];

  const systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));

  // Extract caller/callee names for rendering
  const callerNames = callersResult.nodes.map((n: any) => n.name || n.attrs?.name || "(unnamed)");
  const calleeNames = calleesResult.nodes.map((n: any) => n.name || n.attrs?.name || "(unnamed)");

  // Infer risk semantics
  const riskFacts: ImpactFacts = {
    name: target.name,
    kind: target.kind,
    container: undefined,
    systemPath: systemPathMapped,
    members: 0,
    callers: callersResult.nodes.length,
    callees: calleesResult.nodes.length,
    directImporters: 0,
    directDependents: 0,
    memberLevelCallers: 0,
    propagationBuckets: propagationBuckets.map((b) => ({
      region: b.region.name,
      regionKind: b.region.kind,
      count: b.members.length,
    })),
    topCallerNames: callerNames.slice(0, 3),
  };
  const risk = inferRiskSemantics(riskFacts);

  if (isJson) {
    console.log(
      JSON.stringify(
        stripNulls({
          resolvedTarget: { kind: target.kind, name: target.name },
          depth,
          systemPath: systemPathMapped.length > 0 ? systemPathMapped : undefined,
          riskSummary: risk.riskSummary,
          riskLevel: risk.riskLevel,
          riskCategory: risk.category,
          atRiskBehavior: risk.behaviorAtRisk,
          nextStep: risk.nextStep || undefined,
          flowPropagation: risk.flowPropagation || undefined,
          summary: {
            callers: callersResult.nodes.length,
            callees: calleesResult.nodes.length,
          },
          callerList: callersResult.nodes.length > 0 ? callersResult.nodes.map((n: any) => ({
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })) : undefined,
          calleeList: calleesResult.nodes.length > 0 ? calleesResult.nodes.map((n: any) => ({
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })) : undefined,
          propagationBuckets: propagationBuckets.length > 0 ? propagationBuckets.map((b) => ({
            region: b.region.name,
            regionKind: b.region.kind,
            count: b.members.length,
            members: b.members.slice(0, 5).map((m) => ({ name: m.name, kind: m.kind })),
          })) : undefined,
          decisions: decisions.length > 0 ? decisions : undefined,
          tasks: tasks.length > 0 ? tasks : undefined,
          bugs: bugs.length > 0 ? bugs : undefined,
        }),
        null,
        2
      )
    );
  } else {
    // 1. Risk summary + At-risk behavior
    renderRiskHeader(target, risk, systemPath);

    // 2. Propagation
    renderPropagationBuckets(propagationBuckets, risk.flowPropagation);

    // 3. Most affected
    renderMostAffected(risk, [], callerNames, calleeNames);

    // 4. Supporting context
    renderSupportingContext({
      "Direct callers:": callersResult.nodes.length,
      "Direct callees:": calleesResult.nodes.length,
    });

    // 5. Next step
    renderNextStep(risk);

    // 6. Callees (as supporting detail)
    if (calleesResult.nodes.length > 0) {
      renderSection("Calls");
      for (const n of calleesResult.nodes) {
        const node = n as any;
        const name = node.name || node.attrs?.name || "(unnamed)";
        console.log(`  ${colorizeKind(node.kind || "")} ${name}`);
      }
    }

    // 7. Decisions / Tasks / Bugs
    renderDecisionsTasksBugs(decisions, tasks, bugs);
  }
}
