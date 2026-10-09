// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { renderSection, renderKeyValue, renderWarning, renderNote, renderSuccess } from "../ui.js";
import { createClient } from "../../client/factory.js";
import { readBackendHealth } from "./upgrade.js";
import { findWorkspaceForCwd, getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { detectStaleFiles } from "../stale.js";
import { llmError, llmLine, printLlmLines } from "../llm.js";
import { backendUnreachableError, isBackendUnreachable } from "../errors.js";
import { printJson } from "../format.js";
import {
  checkGraphHealth,
  describeReplayedChanges,
  graphHealthJson,
  graphHealthLlmFields,
  graphHealthProse,
  isUnhealthy,
  type GraphHealth,
  type GraphHealthScope,
} from "../graph-health.js";
import { detectSystem } from "../system.js";

interface StatusStaleInfo {
  graphCompleted: boolean;
  mapCompleted: boolean;
  currentRev: number;
  lastIngestAt: string | null;
  staleFiles: number;
  sampleChangedFiles: string[];
  /** Changed files the last run could not get applied (F-01); see `IngestBaseline.replayedFiles`. */
  replayedFiles?: string[];
  /** Files skipped because their parse ran past the budget; see `IngestBaseline.parseTimeouts`. */
  parseTimeouts?: string[];
}

/**
 * `ix status --format llm`.
 *
 * The reason to call `status` from an agent is to decide one thing: is the
 * source graph current enough to trust, or does it need `ix map` first. `text` buries
 * that behind section headers, a "Last ingest" field humanised to "3h ago", and
 * a sampled file list. The `stale` field answers it directly, and
 * `last_ingest_at` stays ISO so the consumer can do its own arithmetic instead
 * of parsing prose. `map_complete` separately reports whether an architecture
 * hierarchy exists for that source revision.
 */
export function renderStatusLlm(
  backend: string,
  endpoint: string,
  staleInfo: StatusStaleInfo | null,
  graph?: GraphHealth,
): string[] {
  const lines = [llmLine("status", [
    ["backend", backend],
    ["endpoint", endpoint],
    ["graph_health", graph ? graphHealthWord(graph) : null],
    ["graph_complete", staleInfo ? String(staleInfo.graphCompleted) : null],
    ["map_complete", staleInfo ? String(staleInfo.mapCompleted) : null],
    ["rev", staleInfo ? String(staleInfo.currentRev) : null],
    ["last_ingest_at", staleInfo?.lastIngestAt ?? null],
    ["stale_files", staleInfo ? String(staleInfo.staleFiles) : null],
    ["not_applied", staleInfo ? String(staleInfo.replayedFiles?.length ?? 0) : null],
    ["parse_timeouts", staleInfo ? String(staleInfo.parseTimeouts?.length ?? 0) : null],
    ["stale", staleInfo
      ? (!staleInfo.graphCompleted || staleInfo.staleFiles > 0 || (staleInfo.replayedFiles?.length ?? 0) > 0
        || (staleInfo.parseTimeouts?.length ?? 0) > 0 ? "true" : "false")
      : null],
  ])];
  if (graph && isUnhealthy(graph)) lines.push(llmLine("graph", graphHealthLlmFields(graph)));
  for (const f of staleInfo?.sampleChangedFiles ?? []) {
    lines.push(llmLine("changed", [["path", f]]));
  }
  for (const f of staleInfo?.replayedFiles ?? []) {
    lines.push(llmLine("not_applied", [["path", f]]));
  }
  for (const f of staleInfo?.parseTimeouts ?? []) {
    lines.push(llmLine("parse_timeout", [["path", f]]));
  }
  return lines;
}

/**
 * The graph verdict as `ix status` says it. "unknown" reads as "unverified":
 * the check could not run (no workspace here, an old backend, a slow stats
 * probe), which is not the same as a graph that was checked and is fine.
 */
export function graphHealthWord(graph: GraphHealth): string {
  return graph.status === "unknown" ? "unverified" : graph.status;
}

/**
 * The read scope for the status root: its system when it is in one, else the
 * workspace containing it. None when the root is in no registered workspace,
 * so the graph check answers "unverified" rather than judging another repo.
 */
export function statusGraphScope(root: string): GraphHealthScope | undefined {
  const systemId = detectSystem(root)?.systemId;
  if (systemId) return { systemId };
  const workspaceId = findWorkspaceForCwd(root)?.workspace_id;
  return workspaceId ? { workspaceId } : undefined;
}

/** The `ix status` warning for files the last run skipped on the parse budget. */
function describeStatusParseTimeouts(files: readonly string[], sample = 5): string {
  const shown = files.slice(0, sample).join(", ");
  const more = files.length > sample ? ` and ${files.length - sample} more` : "";
  return `${files.length} file(s) are not in the graph: their parse ran past the per-file budget (${shown}${more}). ` +
    "Raise IX_PARSE_BUDGET_MS (milliseconds, 0 = none) and run ix map.";
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show Ix backend health and status")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--root <dir>", "Workspace root directory")
    .action(async (opts: { format: string; root?: string }) => {
      const client = createClient();
      try {
        const health = await readBackendHealth(client);
        const root = resolveWorkspaceRoot(opts.root);
        // "No files changed" is about mtimes; whether the graph behind them is
        // whole is a separate question, asked of the backend. Cached per
        // backend revision, bounded, and never throws.
        const scope = statusGraphScope(root);
        const graphCheck: Promise<GraphHealth> = scope
          ? checkGraphHealth(client, scope)
          : Promise.resolve({ status: "unknown" });

        // Detect stale files
        let staleInfo;
        try {
          staleInfo = detectStaleFiles(root);
        } catch {
          staleInfo = null;
        }

        const graph = await graphCheck;

        if (opts.format === "llm") {
          printLlmLines(renderStatusLlm(health.status, getEndpoint(), staleInfo ?? null, graph));
        } else if (opts.format === "json") {
          const result: any = {
            backend: health.status,
            graphCompleted: staleInfo?.graphCompleted ?? null,
            mapCompleted: staleInfo?.mapCompleted ?? null,
            currentRev: staleInfo?.currentRev ?? null,
            lastIngestAt: staleInfo?.lastIngestAt ?? null,
            staleFiles: staleInfo?.staleFiles ?? 0,
            sampleChangedFiles: staleInfo?.sampleChangedFiles ?? [],
            replayedFiles: staleInfo?.replayedFiles ?? [],
            parseTimeouts: staleInfo?.parseTimeouts ?? [],
            graphHealth: { ...graphHealthJson(graph), status: graphHealthWord(graph) },
          };
          printJson(result);
        } else {
          renderSection("Status");
          renderKeyValue("Ix Memory", health.status);
          renderKeyValue("Endpoint", getEndpoint());
          renderKeyValue("Graph", graphHealthWord(graph));
          if (staleInfo) {
            renderKeyValue("Revision", String(staleInfo.currentRev));
            if (staleInfo.lastIngestAt) {
              const ago = timeSince(staleInfo.lastIngestAt);
              renderKeyValue("Last ingest", ago);
            }
            if (!staleInfo.graphCompleted) {
              renderWarning("No completed source graph ingest is recorded for this workspace.");
              renderNote("Run ix map to build a trustworthy graph.");
            } else if ((staleInfo.replayedFiles?.length ?? 0) > 0) {
              // Ahead of the stale-file check: a restored file can look current
              // by mtime while the graph still holds the content in between.
              renderWarning(describeReplayedChanges(staleInfo.replayedFiles!));
            } else if (staleInfo.staleFiles > 0) {
              renderWarning(`${staleInfo.staleFiles} file(s) changed since last ingest:`);
              for (const f of staleInfo.sampleChangedFiles) {
                console.log(`    ${f}`);
              }
              if (staleInfo.staleFiles > staleInfo.sampleChangedFiles.length) {
                renderNote(`... and ${staleInfo.staleFiles - staleInfo.sampleChangedFiles.length} more`);
              }
              renderNote("Run ix map to update.");
            } else if (staleInfo.parseTimeouts.length === 0) {
              // Only what was checked: no file's mtime moved. The graph's own
              // state is the "Graph" line above and the warning below.
              renderSuccess("No files changed since the last ingest.");
            }
            if (staleInfo.graphCompleted && staleInfo.parseTimeouts.length > 0) {
              // Beside the other states, not instead of them: another map
              // will not bring these files in, a larger budget will.
              renderWarning(describeStatusParseTimeouts(staleInfo.parseTimeouts));
            }
            if (staleInfo.graphCompleted && !staleInfo.mapCompleted) {
              renderWarning("No completed architecture map is recorded for this source revision.");
              renderNote("Source graph reads remain available, but hierarchy views may be incomplete.");
            }
          }
          if (isUnhealthy(graph)) renderWarning(graphHealthProse(graph));
        }
      } catch (err) {
        // Only a transport failure is "not reachable". Anything else — a 500
        // from a backend that is up, a malformed response — went out under
        // this message too, which sent people to restart a container that was
        // running fine. Those now reach the shared boundary, which names them.
        if (!isBackendUnreachable(err)) throw err;
        // The spec's uniform error record, so a consumer that pipes `--format
        // llm` parses the failure the same way it parses a result rather than
        // hitting an unparseable human sentence. Exit code is unchanged.
        const unreachable = backendUnreachableError(getEndpoint());
        if (opts.format === "llm") {
          console.log(llmError(unreachable.error, unreachable.message, [["hint", unreachable.next ?? null]]));
        } else {
          console.error(unreachable.message);
          if (unreachable.next) console.error(unreachable.next);
        }
        process.exit(1);
      }
    });
}

function timeSince(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
