import type { Command } from "commander";
import { renderSection, renderKeyValue, renderWarning, renderNote, renderSuccess } from "../ui.js";
import { IxClient } from "../../client/api.js";
import { readBackendHealth } from "./upgrade.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { detectStaleFiles } from "../stale.js";
import { llmError, llmLine, printLlmLines } from "../llm.js";

interface StatusStaleInfo {
  currentRev: number;
  lastIngestAt: string | null;
  staleFiles: number;
  sampleChangedFiles: string[];
}

/**
 * `ix status --format llm`.
 *
 * The reason to call `status` from an agent is to decide one thing: is the
 * graph current enough to trust, or does it need `ix map` first. `text` buries
 * that behind section headers, a "Last ingest" field humanised to "3h ago", and
 * a sampled file list. The `stale` field answers it directly, and
 * `last_ingest_at` stays ISO so the consumer can do its own arithmetic instead
 * of parsing prose.
 */
export function renderStatusLlm(
  backend: string,
  endpoint: string,
  staleInfo: StatusStaleInfo | null,
): string[] {
  const lines = [llmLine("status", [
    ["backend", backend],
    ["endpoint", endpoint],
    ["rev", staleInfo ? String(staleInfo.currentRev) : null],
    ["last_ingest_at", staleInfo?.lastIngestAt ?? null],
    ["stale_files", staleInfo ? String(staleInfo.staleFiles) : null],
    ["stale", staleInfo ? (staleInfo.staleFiles > 0 ? "true" : "false") : null],
  ])];
  for (const f of staleInfo?.sampleChangedFiles ?? []) {
    lines.push(llmLine("changed", [["path", f]]));
  }
  return lines;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show Ix backend health and status")
    .option("--format <fmt>", "Output format (text|json|llm)", "text")
    .option("--root <dir>", "Workspace root directory")
    .action(async (opts: { format: string; root?: string }) => {
      const client = new IxClient(getEndpoint());
      try {
        const health = await readBackendHealth(client);
        const root = resolveWorkspaceRoot(opts.root);

        // Detect stale files
        let staleInfo;
        try {
          staleInfo = detectStaleFiles(root);
        } catch {
          staleInfo = null;
        }

        if (opts.format === "llm") {
          printLlmLines(renderStatusLlm(health.status, getEndpoint(), staleInfo ?? null));
        } else if (opts.format === "json") {
          const result: any = {
            backend: health.status,
            currentRev: staleInfo?.currentRev ?? null,
            lastIngestAt: staleInfo?.lastIngestAt ?? null,
            staleFiles: staleInfo?.staleFiles ?? 0,
            sampleChangedFiles: staleInfo?.sampleChangedFiles ?? [],
          };
          console.log(JSON.stringify(result, null, 2));
        } else {
          renderSection("Status");
          renderKeyValue("Ix Memory", health.status);
          renderKeyValue("Endpoint", getEndpoint());
          if (staleInfo) {
            renderKeyValue("Revision", String(staleInfo.currentRev));
            if (staleInfo.lastIngestAt) {
              const ago = timeSince(staleInfo.lastIngestAt);
              renderKeyValue("Last ingest", ago);
            }
            if (staleInfo.staleFiles > 0) {
              renderWarning(`${staleInfo.staleFiles} file(s) changed since last ingest:`);
              for (const f of staleInfo.sampleChangedFiles) {
                console.log(`    ${f}`);
              }
              if (staleInfo.staleFiles > staleInfo.sampleChangedFiles.length) {
                renderNote(`... and ${staleInfo.staleFiles - staleInfo.sampleChangedFiles.length} more`);
              }
              renderNote("Run ix map to update.");
            } else {
              renderSuccess("Graph is up to date.");
            }
          }
        }
      } catch (err) {
        // The spec's uniform error record, so a consumer that pipes `--format
        // llm` parses the failure the same way it parses a result rather than
        // hitting an unparseable human sentence. Exit code is unchanged.
        if (opts.format === "llm") {
          console.log(llmError("backend_unreachable", `Ix backend not reachable at ${getEndpoint()}`));
        } else {
          console.error(`Ix backend not reachable at ${getEndpoint()}`);
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
