// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import chalk from "chalk";
import { renderSection, renderKeyValue, renderNote, renderResolvedHeader, renderWarning, colorizeKind } from "../ui.js";
import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import { activeReadScope, candidatesCut, resolveTargetSetOrReport, printResolved, type ResolvedEntity, type TargetSet } from "../resolve.js";
import { EXIT_CODES_HELP } from "../outcome.js";
import { checkGraphHealth, graphHealthJson, graphHealthLlmFields, graphHealthProse, isUnhealthy } from "../graph-health.js";
import { bucketByHierarchy, getSystemPath, formatSystemPath, hasMapData, type BucketMember, type SystemPath } from "../hierarchy.js";
import { inferRiskSemantics, humanizeLabel, type ImpactFacts, type RiskSemantics } from "../impact/risk-semantics.js";
import { captureJson, lineSpan, printJson, relativePath, rowLocation, sliceEdgeResults, stripNulls, type Slice } from "../format.js";
import { forMcp, suggest, type Relation } from "../next-step.js";
import { llmLine, llmShortId } from "../llm.js";
import { parsePickOption } from "../options.js";
import { ensureFreshMapState, mapStaleJson, mapStaleLlm, type MapStaleState } from "../map-freshness.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "object", "trait", "interface"]);

export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description("System risk analysis — what behavior is at risk if this changes")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--no-suggest", "Disable did-you-mean candidates on unresolved targets")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--all", "When the target is ambiguous, analyse every candidate; each analysis is tagged with its candidate")
    .option("--depth <n>", "Expansion depth for callers/importers (default 1, max 3)", "1")
    .option("--limit <n>", "Max top-impacted members (and llm caller/callee rows) to show", "10")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .addHelpText(
      "after",
      "\nExamples:\n  ix impact IngestionService\n  ix impact IngestionService --kind class\n  ix impact verify_token --format json\n  ix impact AuthProvider --limit 5\n  ix impact handle --all --format llm\n" +
        EXIT_CODES_HELP
    )
    .action(
      async (
        symbol: string,
        opts: { kind?: string; path?: string; pick?: number; suggest?: boolean; all?: boolean; depth: string; limit: string; format: string }
      ) => {
        const client = createClient({ query: true });
        const limit = parseInt(opts.limit, 10);
        const depth = Math.min(Math.max(parseInt(opts.depth, 10) || 1, 1), 3);

        const resolveOpts = { suggest: opts.suggest, suggestCommand: "impact", missStarted: performance.now(), kind: opts.kind, path: opts.path, pick: opts.pick, all: opts.all };
        const set = await resolveTargetSetOrReport(client, symbol, resolveOpts, opts.format);
        if (!set) return;
        const target = set.entities[0];

        if (opts.format === "text" && !set.all) printResolved(target);

        // An `ix map` after an edit may have left the map for this read (CL-13).
        // Never throws and never moves the exit code. The json and llm output
        // say when it is stale: the region buckets below come from the map.
        const mapState = await ensureFreshMapState();

        // A hollowed graph reports "low risk, no dependents" for anything:
        // the answer is only as good as the edges it counts. Said first, in
        // every format, before the counts it undermines.
        const health = await checkGraphHealth(client, activeReadScope());
        const graph = isUnhealthy(health) ? graphHealthJson(health) : undefined;
        if (graph && opts.format === "llm") console.log(llmLine("graph", graphHealthLlmFields(health)));
        if (graph && opts.format === "text") renderWarning(graphHealthProse(health));

        // `--all` says it once, with the header grouping the candidates.
        const ownState = set.all ? {} : mapState;
        const analyse = (entity: ResolvedEntity) => CONTAINER_KINDS.has(entity.kind)
          ? containerImpact(client, entity, limit, depth, opts.format, graph, ownState)
          : leafImpact(client, entity, depth, limit, opts.format, graph, ownState);

        if (set.all) await impactOfAll(symbol, set, opts.format, analyse, mapState);
        else await analyse(target);
      }
    );
}

/**
 * `--all`: the impact of every candidate of an ambiguous target, one
 * analysis each, in candidate order. Grouped rather than merged: risk and
 * propagation are properties of one entity and do not add up across several.
 *
 *   json  `{ target, resolutionMode: "all", candidates, results: [{ candidate, ...impact }] }`
 *   llm   a `candidate n=<i> ...` record before each candidate's impact records
 *   text  a header per candidate
 */
async function impactOfAll(
  symbol: string,
  set: TargetSet,
  format: string,
  analyse: (entity: ResolvedEntity) => Promise<void>,
  mapState: MapStaleState = {},
): Promise<void> {
  // `n` is the candidate's `--pick` number (resolve.ts candidateSet).
  const candidates = set.entities.map((e, i) => ({ n: e.n ?? i + 1, id: e.id, name: e.name, kind: e.kind, path: relativePath(e.path) ?? e.path }));
  const total = set.all?.total ?? candidates.length;
  const truncation = candidatesCut(set, candidates.length, "Analysed");

  if (format === "json") {
    const results: Record<string, unknown>[] = [];
    for (let i = 0; i < set.entities.length; i += 1) {
      const payloads = await captureJson(() => analyse(set.entities[i]));
      const only = payloads.length === 1 && payloads[0] && typeof payloads[0] === "object" ? payloads[0] as Record<string, unknown> : { results: payloads };
      results.push({ candidate: candidates[i].n, ...only });
    }
    printJson({
      target: symbol,
      resolutionMode: "all",
      candidates,
      results,
      ...(truncation ? { diagnostics: [{ code: "candidates_truncated", message: truncation }] } : {}),
      ...mapStaleJson(mapState),
    });
    return;
  }

  if (format === "llm") {
    console.log(llmLine("impact_all", [["target", symbol], ["candidates", candidates.length], ["total", total]]));
    if (truncation) console.log(llmLine("diagnostic", [["code", "candidates_truncated"], ["message", truncation]]));
    for (const line of mapStaleLlm(mapState)) console.log(line);
  } else if (truncation) {
    renderWarning(truncation);
  }
  for (let i = 0; i < set.entities.length; i += 1) {
    const c = candidates[i];
    if (format === "llm") {
      console.log(llmLine("candidate", [["n", c.n], ["name", c.name], ["kind", c.kind], ["path", c.path], ["id", llmShortId(c.id)]]));
    } else {
      console.log(`${i > 0 ? "\n" : ""}${chalk.bold(`── [${c.n}] ${c.kind} ${c.name}${c.path ? ` in ${c.path}` : ""} ──`)}`);
    }
    await analyse(set.entities[i]);
  }
}

/**
 * The risk a hollowed graph would report is drawn from edges it has lost, so
 * "low risk" there means "no edges left", not "safe to change". Withheld as
 * `unknown` -- a level the type does not hold on purpose, as `ix explain`
 * does for importance: nothing downstream may mistake it for a real `low`.
 */
export function withheldOnDegraded(risk: RiskSemantics, graph: Record<string, unknown> | undefined): RiskSemantics {
  if (!graph) return risk;
  return {
    ...risk,
    riskLevel: "unknown" as unknown as RiskSemantics["riskLevel"],
    riskSummary: "Unknown: this workspace's graph is missing its call and import edges, so what a change reaches cannot be counted.",
  };
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

// ── llm rendering ────────────────────────────────────────────────────────────

export function impactHeaderLlm(
  target: { kind: string; name: string },
  risk: RiskSemantics,
  systemPath: Array<{ name: string; kind: string }>,
): string[] {
  const lines = [llmLine("impact", [
    ["target", target.name],
    ["kind", target.kind],
    ["risk", risk.riskLevel],
    ["category", risk.category],
    ["system_path", systemPath.length > 0 ? systemPath.map((n) => n.name).join(",") : undefined],
    ["summary", risk.riskSummary],
  ])];
  for (const b of risk.behaviorAtRisk) {
    lines.push(llmLine("behavior", [["text", b]]));
  }
  return lines;
}

export function impactPropagationLlm(
  buckets: Array<{ region: { name: string; kind: string }; members: unknown[] }>,
  flow?: { flowName: string; count: number },
): string[] {
  const lines: string[] = [];
  if (flow) {
    lines.push(llmLine("flow", [["name", flow.flowName], ["count", flow.count]]));
  }
  const sorted = [...buckets].sort((a, b) => b.members.length - a.members.length);
  for (const bucket of sorted) {
    lines.push(llmLine("bucket", [
      ["region", humanizeLabel(bucket.region.name)],
      ["kind", bucket.region.kind],
      ["count", bucket.members.length],
    ]));
  }
  return lines;
}

export function impactTailLlm(
  risk: RiskSemantics,
  decisions: Array<{ name: string }>,
  tasks: Array<{ name: string; status: string }>,
  bugs: Array<{ name: string; status: string; severity: string }>,
): string[] {
  const lines: string[] = [];
  if (risk.nextStep) {
    lines.push(llmLine("next", [["text", risk.nextStep]]));
  }
  for (const d of decisions) {
    lines.push(llmLine("decision", [["name", d.name]]));
  }
  for (const t of tasks) {
    lines.push(llmLine("task", [["name", t.name], ["status", t.status]]));
  }
  for (const b of bugs) {
    lines.push(llmLine("bug", [["name", b.name], ["status", b.status], ["severity", b.severity]]));
  }
  return lines;
}

// ── Container impact ─────────────────────────────────────────────────────────

async function containerImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string; path?: string },
  limit: number,
  depth: number,
  format: string,
  graph?: Record<string, unknown>,
  mapState: MapStaleState = {},
): Promise<void> {
  const isJson = format === "json";
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
  const memberCallerCounts: Array<{
    name: string; kind: string; id: string; callerCount: number;
    path?: string; lineStart?: number; lineEnd?: number;
  }> = [];
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
        ...rowLocation(member),
      };
    } catch {
      diagnostics.push(`Failed to expand callers for member ${member.id}`);
      return {
        name: member.name || member.attrs?.name || "(unnamed)",
        kind: member.kind || "unknown",
        id: member.id,
        callerCount: 0,
        ...rowLocation(member),
      };
    }
  });

  // Bucket all dependents by hierarchy. First occurrence of each id wins, as
  // the id list this replaced did; the nodes go in whole so their names and
  // kinds need no second read. `via` remembers which expand that first
  // occurrence came from, for the JSON `dependentList`.
  const uniqueDependents = new Map<string, any>();
  const dependentVia = new Map<string, "importer" | "dependent">();
  for (const [nodes, via] of [[directImporters, "importer"], [directDependents, "dependent"]] as const) {
    for (const n of nodes) {
      if (uniqueDependents.has(n.id)) continue;
      uniqueDependents.set(n.id, n);
      dependentVia.set(n.id, via);
    }
  }
  // Independent of the member counts, so the two run together.
  const [callerResults, propagationBuckets] = await Promise.all([
    Promise.all(callerPromises),
    uniqueDependents.size > 0 ? bucketByHierarchy(client, [...uniqueDependents.values()]) : Promise.resolve([]),
  ]);
  for (const r of callerResults) {
    memberCallerCounts.push(r);
    totalMemberCallers += r.callerCount;
  }

  memberCallerCounts.sort((a, b) => b.callerCount - a.callerCount);
  const topMembers = memberCallerCounts.filter((m) => m.callerCount > 0).slice(0, limit);

  const systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));

  // Infer risk semantics
  const riskFacts: ImpactFacts = {
    name: target.name,
    kind: target.kind,
    targetPath: target.path ? (relativePath(target.path) ?? target.path) : undefined,
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
  const risk = withheldOnDegraded(inferRiskSemantics(riskFacts), graph);

  if (isJson) {
    printJson(
      stripNulls({
        resolvedTarget: { kind: target.kind, name: target.name },
        graph,
        ...mapStaleJson(mapState),
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
          members: b.members.slice(0, 5).map(bucketMemberJson),
        })) : undefined,
        // Every direct importer and dependent, located. Not cut by --limit:
        // JSON keeps every row, as callerList does.
        dependentList: uniqueDependents.size > 0
          ? [...uniqueDependents.values()].map((n: any) => ({ ...impactRowJson(n), via: dependentVia.get(n.id) }))
          : undefined,
        decisions: decisions.length > 0 ? decisions : undefined,
        tasks: tasks.length > 0 ? tasks : undefined,
        bugs: bugs.length > 0 ? bugs : undefined,
        diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
      }),
    );
  } else if (format === "llm") {
    const lines = [
      // With the answer, not before it (mapStaleLlm).
      ...mapStaleLlm(mapState),
      ...impactHeaderLlm(target, risk, systemPathMapped),
      llmLine("counts", [
        ["members", members.length],
        ["importers", directImporters.length],
        ["dependents", directDependents.length],
        ["member_callers", totalMemberCallers],
      ]),
      ...impactPropagationLlm(propagationBuckets, risk.flowPropagation),
      // The rows `ix impact` exists to produce: the members a change reaches.
      // They named a symbol and left the caller to find it.
      ...topMembers.map((m) => llmLine("member", [
        ["name", m.name], ["kind", m.kind], ["callers", m.callerCount],
        ["path", m.path], ["lines", lineSpan(m)],
      ])),
      ...impactTailLlm(risk, decisions, tasks, bugs),
    ];
    for (const line of lines) console.log(line);
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

// ── JSON rows ────────────────────────────────────────────────────────────────

/** The location fields a JSON row adds, each left out when unknown (never null). */
function locationJson(loc: { path?: string; lineStart?: number; lineEnd?: number }): { path?: string; lineStart?: number; lineEnd?: number } {
  return stripNulls({ path: loc.path, lineStart: loc.lineStart, lineEnd: loc.lineEnd });
}

/**
 * One caller, callee or dependent row in `--format json`: `kind` and `name`
 * first, as they always were, then where the node is (`rowLocation`), the same
 * fields `topImpactedMembers` carries.
 */
export function impactRowJson(node: any): { kind: string; name: string; path?: string; lineStart?: number; lineEnd?: number } {
  return {
    kind: node.kind,
    name: node.name || node.attrs?.name || "(unnamed)",
    ...locationJson(rowLocation(node)),
  };
}

/** A propagation bucket member in `--format json`: `name`, `kind`, then its location. */
function bucketMemberJson(m: BucketMember): BucketMember {
  return { name: m.name, kind: m.kind, ...locationJson(m) };
}

// ── Leaf impact ──────────────────────────────────────────────────────────────

/** One caller or callee row, located the way member rows are: `path` and `lines`. */
export function leafRowLlm(kind: string, node: any): string {
  const loc = rowLocation(node);
  return llmLine(kind, [
    ["name", node.name || node.attrs?.name || "(unnamed)"],
    ["kind", node.kind],
    ["path", loc.path],
    ["lines", lineSpan(loc)],
  ]);
}

/**
 * The honest-cut record for a leaf list, or nothing when the list fit.
 *
 * Its own message, not `truncationHint`: `ix impact` has no `--offset`, so it
 * must never print a `next:` page or a `next_offset`, whatever the shared
 * slice helpers grow. The rest of the list is one `--limit` away, or pageable
 * through the edge command for the same relation.
 */
export function leafTruncationLlm(relation: Relation, slice: Slice<unknown>, target: string): string[] {
  if (!slice.truncated) return [];
  const head = `${slice.total} ${relation}; showing ${slice.shown}.`;
  const page = suggest.neighbors(target, relation);
  const message = forMcp()
    ? `${head} To page them: ${page}`
    : `${head} Raise --limit to see them, or page them with ${page}`;
  return [llmLine("diagnostic", [
    ["code", "results_truncated"],
    ["message", message],
  ])];
}

async function leafImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string; path?: string },
  depth: number,
  limit: number,
  format: string,
  graph?: Record<string, unknown>,
  mapState: MapStaleState = {},
): Promise<void> {
  const isJson = format === "json";
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
  const propagationBuckets = callersResult.nodes.length > 0
    ? await bucketByHierarchy(client, callersResult.nodes)
    : [];

  const systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));

  // Extract caller/callee names for rendering
  const callerNames = callersResult.nodes.map((n: any) => n.name || n.attrs?.name || "(unnamed)");
  const calleeNames = calleesResult.nodes.map((n: any) => n.name || n.attrs?.name || "(unnamed)");

  // Infer risk semantics
  const riskFacts: ImpactFacts = {
    name: target.name,
    kind: target.kind,
    targetPath: target.path ? (relativePath(target.path) ?? target.path) : undefined,
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
  const risk = withheldOnDegraded(inferRiskSemantics(riskFacts), graph);

  if (isJson) {
    printJson(
      stripNulls({
        resolvedTarget: { kind: target.kind, name: target.name },
        graph,
        ...mapStaleJson(mapState),
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
        callerList: callersResult.nodes.length > 0 ? callersResult.nodes.map(impactRowJson) : undefined,
        calleeList: calleesResult.nodes.length > 0 ? calleesResult.nodes.map(impactRowJson) : undefined,
        propagationBuckets: propagationBuckets.length > 0 ? propagationBuckets.map((b) => ({
          region: b.region.name,
          regionKind: b.region.kind,
          count: b.members.length,
          members: b.members.slice(0, 5).map(bucketMemberJson),
        })) : undefined,
        decisions: decisions.length > 0 ? decisions : undefined,
        tasks: tasks.length > 0 ? tasks : undefined,
        bugs: bugs.length > 0 ? bugs : undefined,
      }),
    );
  } else if (format === "llm") {
    const callerSlice = sliceEdgeResults(callersResult.nodes, limit);
    const calleeSlice = sliceEdgeResults(calleesResult.nodes, limit);
    const lines = [
      // With the answer, not before it (mapStaleLlm).
      ...mapStaleLlm(mapState),
      ...impactHeaderLlm(target, risk, systemPathMapped),
      llmLine("counts", [
        ["callers", callerSlice.total],
        ["callees", calleeSlice.total],
        ["shown_callers", callerSlice.shown],
        ["shown_callees", calleeSlice.shown],
      ]),
      ...impactPropagationLlm(propagationBuckets, risk.flowPropagation),
      ...callerSlice.rows.map((n: any) => leafRowLlm("caller", n)),
      ...calleeSlice.rows.map((n: any) => leafRowLlm("callee", n)),
      ...leafTruncationLlm("callers", callerSlice, target.name),
      ...leafTruncationLlm("callees", calleeSlice, target.name),
      ...impactTailLlm(risk, decisions, tasks, bugs),
    ];
    for (const line of lines) console.log(line);
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
