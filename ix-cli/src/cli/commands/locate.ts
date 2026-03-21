import * as path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import {
  resolveFileOrEntity, resolveEntityFull, printResolved, printAmbiguous,
  looksFileLike, isRawId, type ResolvedEntity,
} from "../resolve.js";
import { isFileStale } from "../stale.js";
import { stderr } from "../stderr.js";
import { getSystemPath, hasMapData } from "../hierarchy.js";
import { humanizeLabel } from "../impact/risk-semantics.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);
const FILE_KINDS = new Set(["file"]);

// Region kinds whose names should be humanized in system path
const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);

interface LocateOutput {
  resolvedTarget: { id: string; kind: string; name: string; path?: string } | null;
  resolutionMode: string;
  lineRange?: { start: number; end: number };
  container?: { kind: string; name: string; id?: string };
  systemPath: Array<{ name: string; kind: string }> | null;
  hasMapData?: boolean;
  stale?: boolean;
  diagnostics: string[];
}

export function registerLocateCommand(program: Command): void {
  program
    .command("locate <symbol>")
    .description("Resolve a symbol to its position in the codebase and system hierarchy")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer results from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", `\nExamples:
  ix locate IngestionService
  ix locate verify_token --kind function
  ix locate ArangoClient --format json
  ix locate scoreCandidate --pick 2`)
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const diagnostics: string[] = [];
      const isJson = opts.format === "json";

      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };

      // Resolution with ambiguity detection
      const { target, ambiguous } = await resolveWithAmbiguity(client, symbol, resolveOpts, isJson);

      if (!target) {
        if (ambiguous) {
          // Ambiguity already printed — stop cleanly
          return;
        }
        const output: LocateOutput = {
          resolvedTarget: null,
          resolutionMode: "none",
          systemPath: null,
          diagnostics: ["No graph entity found."],
        };
        outputLocate(output, symbol, opts.format);
        return;
      }

      if (!isJson) printResolved(target);

      const isContainer = CONTAINER_KINDS.has(target.kind);
      const isFile = FILE_KINDS.has(target.kind);

      // Parallel fetch: system path, parent container (for non-containers), entity details
      const [systemPath, containsResult, details] = await Promise.all([
        getSystemPath(client, target.id),
        isContainer
          ? Promise.resolve({ nodes: [] })
          : client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
        client.entity(target.id),
      ]);

      const node = details.node as any;
      const nodePath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? undefined;

      // Extract line range from attrs
      const lineStart = node.attrs?.line_start ?? node.attrs?.lineStart;
      const lineEnd = node.attrs?.line_end ?? node.attrs?.lineEnd;
      const lineRange = lineStart != null && lineEnd != null
        ? { start: Number(lineStart), end: Number(lineEnd) }
        : undefined;

      // Check staleness
      let stale = false;
      if (nodePath) {
        try { stale = await isFileStale(client, nodePath); } catch {}
      }

      // Container context (parent for callables)
      let container: LocateOutput["container"];
      if (!isContainer && containsResult.nodes.length > 0) {
        const c = containsResult.nodes[0] as any;
        container = {
          kind: c.kind || "unknown",
          name: c.name || c.attrs?.name || "(unknown)",
          id: c.id,
        };
      }

      // Diagnostic for missing map data
      const hasMap = hasMapData(systemPath);
      if (!hasMap) {
        diagnostics.push("No system map. Run `ix map` to see hierarchy.");
      }

      // Build system path: append resolved symbol for non-file targets
      let systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));
      if (!isFile) {
        const lastInPath = systemPathMapped[systemPathMapped.length - 1];
        if (!lastInPath || lastInPath.name !== target.name) {
          systemPathMapped = [...systemPathMapped, { name: target.name, kind: target.kind }];
        }
      }

      // Make path repo-relative
      const displayPath = nodePath ? toRepoRelative(nodePath) : undefined;

      const output: LocateOutput = {
        resolvedTarget: {
          id: target.id,
          kind: target.kind,
          name: target.name,
          path: displayPath,
        },
        resolutionMode: target.resolutionMode,
        lineRange,
        container,
        systemPath: systemPathMapped,
        hasMapData: hasMap,
        diagnostics,
      };
      if (stale) {
        output.stale = true;
      }

      outputLocate(output, symbol, opts.format);
    });
}

// ── Ambiguity-aware resolution ──────────────────────────────────────────────

async function resolveWithAmbiguity(
  client: IxClient,
  symbol: string,
  opts: { kind?: string; path?: string; pick?: number },
  isJson: boolean,
): Promise<{ target: ResolvedEntity | null; ambiguous: boolean }> {
  // For raw IDs and file-like targets, delegate to resolveFileOrEntity (no ambiguity)
  if (isRawId(symbol) || looksFileLike(symbol)) {
    const target = await resolveFileOrEntity(client, symbol, opts);
    return { target, ambiguous: false };
  }

  // Symbol resolution — use full result to detect ambiguity
  const allKinds = ["file", "class", "object", "trait", "interface", "module", "function", "method"];
  const result = await resolveEntityFull(client, symbol, allKinds, opts);

  if (result.resolved) {
    return { target: result.entity, ambiguous: false };
  }

  if (result.ambiguous) {
    if (isJson) {
      console.log(JSON.stringify({
        resolvedTarget: null,
        resolutionMode: "ambiguous",
        candidates: result.result.candidates,
        systemPath: null,
        diagnostics: result.result.diagnostics ?? [],
      }, null, 2));
    } else {
      printAmbiguous(symbol, result.result, opts);
    }
    return { target: null, ambiguous: true };
  }

  return { target: null, ambiguous: false };
}

// ── Repo-relative path ──────────────────────────────────────────────────────

function toRepoRelative(filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  try {
    const cwd = process.cwd();
    const rel = path.relative(cwd, filePath);
    // Only use relative if it doesn't escape the repo (no leading ../)
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  } catch {}
  return filePath;
}

// ── Humanized system path breadcrumb ────────────────────────────────────────

function humanizeBreadcrumb(nodes: Array<{ name: string; kind: string }>): string {
  return nodes.map((n) => {
    if (REGION_KINDS.has(n.kind)) return humanizeLabel(n.name).replace(/ layer$/, "");
    return n.name;
  }).join(" → ");
}

// ── Output ──────────────────────────────────────────────────────────────────

function outputLocate(output: LocateOutput, symbol: string, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (output.stale) stderr(chalk.yellow("⚠ Some results may be stale. Run ix ingest to update.\n"));

  if (!output.resolvedTarget) {
    stderr(`No graph entity found for "${symbol}".`);
    console.log("No matches found.");
    return;
  }

  const t = output.resolvedTarget;

  // Location section
  const hasLocation = t.path || output.lineRange || output.container;
  if (hasLocation) {
    console.log(chalk.bold("\nLocation"));
    if (t.path) {
      console.log(`  ${chalk.dim("File:".padEnd(16))}${t.path}`);
    }
    if (output.lineRange) {
      console.log(`  ${chalk.dim("Lines:".padEnd(16))}${output.lineRange.start}-${output.lineRange.end}`);
    }
    if (output.container) {
      console.log(`  ${chalk.dim("Contained in:".padEnd(16))}${output.container.name}`);
    }
  }

  // System path section
  if (output.systemPath && output.systemPath.length > 1 && output.hasMapData) {
    console.log(chalk.bold("\nSystem path"));
    console.log(`  ${humanizeBreadcrumb(output.systemPath)}`);
  }

  // Diagnostics
  for (const d of output.diagnostics) {
    stderr(chalk.dim(`  ${d}`));
  }
}
