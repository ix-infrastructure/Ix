import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { isFileStale } from "../stale.js";
import { stderr } from "../stderr.js";

const execFileAsync = promisify(execFile);

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);

interface RelatedItem {
  name: string;
  kind: string;
  id?: string;
  relationship: "contains" | "contained-by" | "depends-on" | "imported-by" | "calls" | "called-by" | "referenced-by";
}

interface TextMatch {
  path: string;
  line: number;
}

interface LocateOutput {
  resolvedTarget: { id: string; kind: string; name: string; path?: string } | null;
  resolutionMode: string;
  structuralContext: {
    container?: { kind: string; name: string; id?: string };
    members?: Array<{ name: string; kind: string; id?: string }>;
    signature?: string;
  };
  relationships: RelatedItem[];
  textMatches: TextMatch[];
  resultSource: "graph" | "text" | "graph+text";
  stale?: boolean;
  warning?: string;
  diagnostics: string[];
}

export function registerLocateCommand(program: Command): void {
  program
    .command("locate <symbol>")
    .description("Resolve a symbol to its definition, show structural and relationship context")
    .option("--limit <n>", "Max text hits to check", "10")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer results from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", `\nExamples:
  ix locate IngestionService
  ix locate verify_token --kind function
  ix locate ArangoClient --format json
  ix locate scoreCandidate --pick 2`)
    .action(async (symbol: string, opts: { limit: string; kind?: string; path?: string; pick?: string; format: string; root?: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const root = resolveWorkspaceRoot(opts.root);
      const diagnostics: string[] = [];

      // --- Step 1: Resolve the target entity ---
      // Prefer structural container kinds — locate wants real definitions, not incidental helpers
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);

      if (!target) {
        // Fall back to text-only search
        const textMatches = await runRipgrep(symbol, root, limit);
        const output: LocateOutput = {
          resolvedTarget: null,
          resolutionMode: "none",
          structuralContext: {},
          relationships: [],
          textMatches,
          resultSource: "text",
          diagnostics: ["No graph entity found; showing text matches only."],
        };
        outputLocate(output, symbol, opts.format);
        return;
      }

      if (opts.format !== "json") printResolved(target);

      // --- Step 2: Fetch structural context and relationships in parallel ---
      const isContainer = CONTAINER_KINDS.has(target.kind);

      const [
        details,
        containsResult,       // members (for containers) or container (for callables)
        callersResult,
        calleesResult,
        importsResult,
        importedByResult,
        referencedByResult,
      ] = await Promise.all([
        client.entity(target.id),
        isContainer
          ? client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] })
          : client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
        client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] }),
        client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] }),
        client.expand(target.id, { direction: "in", predicates: ["REFERENCES"] }),
      ]);

      const node = details.node as any;
      const nodePath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? undefined;
      const signature = node.attrs?.signature ?? undefined;

      // Check staleness
      let stale = false;
      if (nodePath) {
        try { stale = await isFileStale(client, nodePath); } catch {}
      }

      // Build structural context
      const structuralContext: LocateOutput["structuralContext"] = {};
      if (signature) structuralContext.signature = signature;

      if (isContainer) {
        // Members
        const members = containsResult.nodes.slice(0, 10).map((n: any) => ({
          name: n.name || n.attrs?.name || "(unnamed)",
          kind: n.kind || "unknown",
          id: n.id,
        }));
        if (members.length > 0) structuralContext.members = members;
      } else {
        // Container (parent class/file)
        if (containsResult.nodes.length > 0) {
          const c = containsResult.nodes[0] as any;
          structuralContext.container = {
            kind: c.kind || "unknown",
            name: c.name || c.attrs?.name || "(unknown)",
            id: c.id,
          };
        }
      }

      // Build relationships
      const relationships: RelatedItem[] = [];

      for (const n of callersResult.nodes) {
        relationships.push(nodeToRelated(n, "called-by"));
      }
      for (const n of calleesResult.nodes) {
        relationships.push(nodeToRelated(n, "calls"));
      }
      for (const n of importsResult.nodes) {
        relationships.push(nodeToRelated(n, "depends-on"));
      }
      for (const n of importedByResult.nodes) {
        relationships.push(nodeToRelated(n, "imported-by"));
      }
      for (const n of referencedByResult.nodes) {
        relationships.push(nodeToRelated(n, "referenced-by"));
      }

      // If container, show contained members as relationships too
      if (isContainer) {
        for (const n of containsResult.nodes.slice(0, 10)) {
          relationships.push(nodeToRelated(n, "contains"));
        }
      } else if (structuralContext.container) {
        relationships.push({
          name: structuralContext.container.name,
          kind: structuralContext.container.kind,
          id: structuralContext.container.id,
          relationship: "contained-by",
        });
      }

      // --- Step 3: Text matches (secondary) ---
      const textMatches = await runRipgrep(symbol, root, limit);

      // Filter out text matches from the same file as the resolved entity
      const filteredTextMatches = textMatches.filter(tm => tm.path !== nodePath);

      const resultSource: LocateOutput["resultSource"] =
        filteredTextMatches.length > 0 ? "graph+text" : "graph";

      const output: LocateOutput = {
        resolvedTarget: {
          id: target.id,
          kind: target.kind,
          name: target.name,
          path: nodePath,
        },
        resolutionMode: target.resolutionMode,
        structuralContext,
        relationships,
        textMatches: filteredTextMatches,
        resultSource,
        diagnostics,
      };
      if (stale) {
        output.stale = true;
        output.warning = "Results may be stale; files have changed since last ingest.";
      }

      outputLocate(output, symbol, opts.format);
    });
}

function nodeToRelated(n: any, rel: RelatedItem["relationship"]): RelatedItem {
  return {
    name: n.name || n.attrs?.name || "(unnamed)",
    kind: n.kind || "unknown",
    id: n.id,
    relationship: rel,
  };
}

async function runRipgrep(symbol: string, root: string, limit: number): Promise<TextMatch[]> {
  const hits: TextMatch[] = [];
  try {
    const rgArgs = [
      "--json", "--max-count", String(limit),
      "--no-heading", "--word-regexp",
      symbol, root,
    ];
    const { stdout } = await execFileAsync("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024 });
    const seenPaths = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          const p = parsed.data.path?.text ?? "";
          if (!seenPaths.has(p)) {
            seenPaths.add(p);
            hits.push({ path: p, line: parsed.data.line_number ?? 0 });
          }
        }
      } catch { /* skip */ }
    }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      stderr(chalk.yellow("⚠ ripgrep (rg) is not installed — text fallback skipped. Install it: https://github.com/BurntSushi/ripgrep#installation"));
    } else if (err.code !== 1 && err.status !== 1) {
      throw err;
    }
  }
  return hits.slice(0, 10);
}

function outputLocate(output: LocateOutput, symbol: string, format: string): void {
  if (format === "json") {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (output.stale) stderr(chalk.yellow("⚠ Some results may be stale. Run ix ingest to update.\n"));

  if (!output.resolvedTarget) {
    stderr(`No graph entity found for "${symbol}".`);
    if (output.textMatches.length > 0) {
      console.log(chalk.dim("\nText matches:"));
      for (const tm of output.textMatches) {
        console.log(`  ${chalk.dim(tm.path)}${chalk.cyan(`:${tm.line}`)}`);
      }
    } else {
      console.log("No matches found.");
    }
    return;
  }

  const t = output.resolvedTarget;
  if (t.path) console.log(chalk.dim(`  ${t.path}`));

  // Structural context
  const ctx = output.structuralContext;
  if (ctx.signature) console.log(`  ${chalk.green(ctx.signature)}`);
  if (ctx.container) console.log(`  ${chalk.dim("in")} ${chalk.cyan(ctx.container.kind)} ${ctx.container.name}`);
  if (ctx.members && ctx.members.length > 0) {
    console.log(chalk.dim("\nMembers:"));
    for (const m of ctx.members) {
      console.log(`  ${chalk.cyan(m.kind.padEnd(10))} ${m.name}`);
    }
  }

  // Relationships grouped by type
  const relGroups = new Map<string, RelatedItem[]>();
  for (const r of output.relationships) {
    const group = relGroups.get(r.relationship) || [];
    group.push(r);
    relGroups.set(r.relationship, group);
  }

  const relOrder: RelatedItem["relationship"][] = [
    "contained-by", "contains", "called-by", "calls", "imported-by", "depends-on",
  ];

  const LABELS: Record<string, string> = {
    "contained-by": "Contained by",
    "contains": "Contains",
    "called-by": "Called by",
    "calls": "Calls",
    "imported-by": "Imported by",
    "depends-on": "Depends on",
  };

  let hasRelationships = false;
  for (const rel of relOrder) {
    const items = relGroups.get(rel);
    if (!items || items.length === 0) continue;
    if (!hasRelationships) {
      console.log(chalk.dim("\nRelationships:"));
      hasRelationships = true;
    }
    console.log(`  ${chalk.bold(LABELS[rel])} (${items.length}):`);
    for (const item of items.slice(0, 5)) {
      console.log(`    ${chalk.cyan(item.kind.padEnd(10))} ${item.name}`);
    }
    if (items.length > 5) {
      console.log(chalk.dim(`    ... and ${items.length - 5} more`));
    }
  }

  // Text matches (secondary)
  if (output.textMatches.length > 0) {
    console.log(chalk.dim("\nText matches (other files):"));
    for (const tm of output.textMatches.slice(0, 5)) {
      console.log(`  ${chalk.dim(tm.path)}${chalk.cyan(`:${tm.line}`)}`);
    }
    if (output.textMatches.length > 5) {
      console.log(chalk.dim(`  ... and ${output.textMatches.length - 5} more`));
    }
  }
}
