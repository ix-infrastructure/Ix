// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { createClient } from "../../client/factory.js";
import { formatExplain, relativePath, printJson, type ExplainResult, type EntityRef, type Diagnostic } from "../format.js";
import { resolveFileOrReport, isRawId, activeReadScope } from "../resolve.js";
import { isFileStale } from "../stale.js";
import { collectFacts } from "../explain/facts.js";
import { inferRole } from "../explain/role-inference.js";
import { inferImportance } from "../explain/importance.js";
import { renderExplanation } from "../explain/render.js";
import { renderExplainLlm, renderExplainRawLlm } from "../explain/llm.js";
import { printLlmLines } from "../llm.js";
import { parsePickOption } from "../options.js";
import { renderSection, renderWarning, renderNote } from "../ui.js";
import { forMcp, toolCall } from "../next-step.js";
import {
  assessTargetStructure, checkGraphHealth, graphHealthJson, graphHealthProse, isUnhealthy, worseHealth,
} from "../graph-health.js";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain <symbol>")
    .description("Explain an entity — infers role, importance, and structural context")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Restrict to symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)", parsePickOption)
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--raw", "Show raw metadata dump (legacy format)")
    .addHelpText("after", "\nExamples:\n  ix explain IngestionService\n  ix explain expand --path memory-layer\n  ix explain verify_token --kind function --format json\n  ix explain IxClient --raw")
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: number; format: string; raw?: boolean }) => {
      const client = createClient({ query: true });
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick };
      const target = await resolveFileOrReport(client, symbol, resolveOpts, opts.format);
      if (!target) return;

      if (opts.raw) {
        await rawExplain(client, target, opts.format);
        return;
      }

      // New pipeline: collect facts → infer role → infer importance → render.
      // The workspace health check runs alongside: cached per backend
      // revision, so on a warm cache it is one ~10 ms request in parallel.
      const healthCheck = checkGraphHealth(client, activeReadScope());
      const facts = await collectFacts(client, target.id, target.name, target.kind);
      const health = worseHealth(await healthCheck, assessTargetStructure(facts));
      const degraded = isUnhealthy(health);
      let role = inferRole(facts);
      let importance = inferImportance(facts);
      const rendered = renderExplanation(facts, role, importance);
      if (degraded) {
        // Every inference below is drawn from edge counts the graph has lost,
        // so "localized-helper, low importance, 0 callers" would be a confident
        // wrong answer. Withheld, with the reason attached.
        const why = `graph degraded: ${health.reason}`;
        role = { role: "unknown", confidence: "low", reasons: [why] };
        importance = { level: "low", category: "normal", reasons: [why] };
        rendered.explanation =
          `\`${facts.name}\` is a ${facts.kind}${facts.path ? ` in ${facts.path}` : ""}; its role cannot be ` +
          "inferred from this graph." + (facts.signature ? ` Signature: \`${facts.signature}\`.` : "");
        rendered.whyItMatters =
          "Unknown: the graph for this workspace is missing structural edges, so callers, callees and " +
          "dependents cannot be counted. Counts shown here are floors, and a zero means unknown.";
      }

      if (opts.format === "llm") {
        printLlmLines(renderExplainLlm(facts, role, importance, rendered, health));
      } else if (opts.format === "json") {
        const output: any = {
          resolvedTarget: { kind: target.kind, name: target.name },
          facts,
          role,
          importance,
          rendered,
        };
        if (degraded) {
          output.graph = graphHealthJson(health);
          // Not a level the type can hold on purpose: nothing downstream may
          // mistake it for a real `low`.
          output.importance = { level: "unknown", category: "unknown", reasons: importance.reasons };
          facts.diagnostics.unshift({ code: "graph_degraded", message: graphHealthProse(health) });
        }
        if (facts.diagnostics.length > 0) output.diagnostics = facts.diagnostics;
        printJson(output);
      } else {
        if (degraded) renderWarning(graphHealthProse(health));
        if (facts.stale) {
          renderWarning("Source has changed since last ingest. Run ix map to update.");
        }

        renderSection("Explanation");
        console.log(`  ${rendered.explanation}`);

        renderSection("Context");
        for (const line of rendered.context.split("\n")) {
          console.log(`  ${line}`);
        }

        if (rendered.usedBy) {
          renderSection("Used by");
          console.log(`  ${rendered.usedBy}`);
        }

        renderSection("Why it matters");
        console.log(`  ${rendered.whyItMatters}`);

        if (rendered.notes.length > 0) {
          for (const note of rendered.notes) {
            renderNote(note);
          }
        }
        console.log();
      }
    });
}

/** Legacy raw metadata dump — preserves old behavior behind --raw flag. */
async function rawExplain(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string,
): Promise<void> {
  const details = await client.entity(target.id);

  let history: any = { entityId: target.id, chain: [] };
  try {
    history = await client.provenance(target.id);
  } catch { /* no history */ }

  const edges = (details.edges ?? []) as any[];
  const containsEdge = edges.find((e: any) =>
    e.predicate === "CONTAINS" && e.dst === target.id
  );
  let container: any = undefined;
  if (containsEdge) {
    try {
      const containerDetails = await client.entity(containsEdge.src);
      container = containerDetails.node;
    } catch { /* no container */ }
  }

  const callEdges = edges.filter((e: any) => e.predicate === "CALLS");
  const containedEdges = edges.filter((e: any) =>
    e.predicate === "CONTAINS" && e.src === target.id
  );

  const node = details.node as any;

  // Check staleness
  let stale = false;
  const sourceUri = node.provenance?.source_uri ?? node.provenance?.sourceUri;
  if (sourceUri) {
    try { stale = isFileStale(sourceUri); } catch {}
  }

  // Extract snippet fields from attrs
  const signature = node.attrs?.signature || node.attrs?.summary;
  const docstring = node.attrs?.docstring || node.attrs?.description;
  const chunkKind = node.attrs?.chunk_kind || node.attrs?.chunkKind || (node.kind === "section" ? "section" : undefined);

  // Get actual callee details from outgoing CALLS edges
  const calleeEdges = callEdges.filter((e: any) => e.src === target.id);
  const diagnostics: Diagnostic[] = [];
  let callList: EntityRef[] | undefined;
  if (calleeEdges.length > 0 && calleeEdges.length <= 20) {
    const refs = await Promise.all(
      calleeEdges.map(async (e: any): Promise<EntityRef> => {
        try {
          const callee = await client.entity(e.dst);
          const calleeNode = callee.node as any;
          const name = calleeNode.name || calleeNode.attrs?.name || "";
          if (!name || isRawId(name)) {
            return {
              name: name || e.dst,
              kind: calleeNode.kind,
              resolved: false,
              suggestedCommand: forMcp() ? toolCall("ix_text", { pattern: e.dst.slice(0, 8) }) : `ix text "${e.dst.slice(0, 8)}"`,
            };
          }
          return {
            name,
            kind: calleeNode.kind,
            id: e.dst,
            resolved: true,
            path: relativePath(calleeNode.provenance?.source_uri ?? calleeNode.provenance?.sourceUri),
            suggestedCommand: forMcp() ? toolCall("ix_explain", { symbol: name }) : `ix explain "${name}"`,
          };
        } catch {
          return {
            name: e.dst,
            resolved: false,
            diagnostic: "unresolved_call_target",
            suggestedCommand: forMcp() ? toolCall("ix_text", { pattern: e.dst.slice(0, 8) }) : `ix text "${e.dst.slice(0, 8)}"`,
          } as EntityRef;
        }
      })
    );
    callList = refs;
    const unresolvedCount = refs.filter(r => !r.resolved).length;
    if (unresolvedCount > 0) {
      diagnostics.push({
        code: "unresolved_call_target",
        message: `${unresolvedCount} callee(s) could not be resolved to named entities. Use ${forMcp() ? "ix_text" : "ix text"} to locate them.`,
      });
    }
  }

  if (stale) {
    diagnostics.push({
      code: "stale_source",
      message: "Results may be stale; file has changed since last ingest.",
    });
  }

  const result: ExplainResult & { stale?: boolean; warning?: string } = {
    kind: node.kind,
    name: node.name || node.attrs?.name || target.name,
    id: target.id,
    file: relativePath(sourceUri),
    chunkKind,
    container: container ? { kind: container.kind, name: container.name || container.attrs?.name || "(unknown)" } : undefined,
    introducedRev: node.createdRev ?? node.created_rev,
    calledBy: callEdges.filter((e: any) => e.dst === target.id).length,
    calls: callEdges.filter((e: any) => e.src === target.id).length,
    contains: containedEdges.length,
    historyLength: (history as any)?.chain?.length ?? 0,
    signature,
    docstring,
    callList,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };

  if (stale) {
    (result as any).stale = true;
    (result as any).warning = "Results may be stale; file has changed since last ingest.";
  }

  if (format === "llm") {
    printLlmLines(renderExplainRawLlm(result));
  } else if (format === "json") {
    const output: any = {
      resolvedTarget: { kind: target.kind, name: target.name },
      result,
    };
    if (stale) {
      output.stale = true;
      output.warning = "Results may be stale; file has changed since last ingest.";
    }
    printJson(output);
  } else {
    if (stale) renderWarning("Source has changed since last ingest. Run ix map to update.");
    formatExplain(result, "text");
  }
}
