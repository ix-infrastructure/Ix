import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  createProtocolStdout,
  DEFAULT_TIMEOUT_MS,
  resolveDefaultRunner,
  type IxRunner,
} from "./runner.js";

export { runCurrentIx, type IxRunner, type IxRunResult } from "./runner.js";

export const IX_MCP_TOOL_NAMES = [
  "ix_health",
  "ix_briefing",
  "ix_locate",
  "ix_text",
  "ix_impact",
  "ix_map",
  "ix_overview",
  "ix_read",
  "ix_diff",
  "ix_callers",
  "ix_callees",
  "ix_imported_by",
  "ix_imports",
  "ix_depends",
  "ix_trace",
  "ix_explain",
  "ix_rank",
  "ix_inventory",
  "ix_smells",
  "ix_stats",
  "ix_subsystems",
  "ix_decisions",
  "ix_history",
] as const;

interface CreateServerOptions {
  version?: string;
  runIx?: IxRunner;
}

type ToolInput = Record<string, unknown>;

export function createIxMcpServer(options: CreateServerOptions = {}): McpServer {
  const version = options.version ?? "0.0.0";

  // Built on first use, not here: constructing the default runner takes over
  // process.stdout and process.exit, which a caller supplying its own runner
  // (every test, and any embedder) must not have done to it.
  let fallback: IxRunner | undefined;
  const runIx: IxRunner =
    options.runIx ??
    ((args, timeoutMs) =>
      (fallback ??= resolveDefaultRunner({ version, redirectIdleStdout: true }))(args, timeoutMs));

  const server = new McpServer({
    name: "ix-memory",
    version,
  });

  registerTool(server, "ix_health", "Check Ix backend and graph readiness", {}, async () =>
    runFormatted(runIx, "ix_health", ["status"]),
  );
  registerTool(server, "ix_briefing", "Load the Ix Pro session briefing", {}, async () =>
    runJson(runIx, "ix_briefing", ["briefing"]),
  );
  registerTool(
    server,
    "ix_locate",
    "Resolve a symbol to its canonical graph-backed target",
    { symbol: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_locate", ["locate", stringArg(input, "symbol")]),
  );
  registerTool(
    server,
    "ix_text",
    "Search text across the indexed repository and return ranked hits",
    {
      pattern: z.string().min(1),
      limit: z.number().int().min(1).max(100).default(20),
      path: z.string().min(1).optional(),
      language: z.string().min(1).optional(),
    },
    async (input) => {
      const args = [
        "text",
        stringArg(input, "pattern"),
        "--limit",
        numberArg(input, "limit").toString(),
      ];
      pushOption(args, "--path", input.path);
      pushOption(args, "--language", input.language);
      return runFormatted(runIx, "ix_text", args);
    },
  );
  registerTool(
    server,
    "ix_impact",
    "Analyze the blast radius and risk of changing a symbol or file",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_impact", ["impact", stringArg(input, "target")]),
  );
  registerTool(
    server,
    "ix_map",
    "Ingest one path or refresh the full workspace architecture map",
    { file: z.string().min(1).optional() },
    async (input) => {
      const args = ["map"];
      if (typeof input.file === "string") args.push(input.file);
      return runJson(runIx, "ix_map", args, 120_000);
    },
  );
  registerTool(
    server,
    "ix_overview",
    "Return the structural overview of a symbol, file, or subsystem",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_overview", ["overview", stringArg(input, "target")]),
  );
  registerTool(
    server,
    "ix_read",
    "Read graph-bounded source for a symbol or indexed file",
    { symbol: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_read", ["read", stringArg(input, "symbol")]),
  );
  registerTool(
    server,
    "ix_diff",
    "Show the structural diff between two graph revisions",
    {
      from_rev: z.number().int().nonnegative(),
      to_rev: z.number().int().nonnegative(),
      target: z.string().min(1).optional(),
      summary: z.boolean().default(false),
    },
    async (input) => {
      const args = [
        "diff",
        numberArg(input, "from_rev").toString(),
        numberArg(input, "to_rev").toString(),
      ];
      if (typeof input.target === "string") args.push(input.target);
      if (input.summary === true) args.push("--summary");
      return runFormatted(runIx, "ix_diff", args);
    },
  );
  registerSymbolTool(server, runIx, "ix_callers", "List incoming call edges", "callers");
  registerSymbolTool(server, runIx, "ix_callees", "List outgoing call edges", "callees");
  registerSymbolTool(server, runIx, "ix_imported_by", "List incoming import edges", "imported-by");
  registerSymbolTool(server, runIx, "ix_imports", "List outgoing import edges", "imports");
  registerTool(
    server,
    "ix_depends",
    "Show downstream dependencies to a bounded depth",
    {
      symbol: z.string().min(1),
      depth: z.number().int().min(1).max(5).default(2),
    },
    async (input) =>
      runFormatted(runIx, "ix_depends", [
        "depends",
        stringArg(input, "symbol"),
        "--depth",
        numberArg(input, "depth").toString(),
      ]),
  );
  registerTool(
    server,
    "ix_trace",
    "Trace execution paths through a symbol",
    {
      symbol: z.string().min(1),
      to: z.string().min(1).optional(),
    },
    async (input) => {
      const args = ["trace", stringArg(input, "symbol")];
      pushOption(args, "--to", input.to);
      return runFormatted(runIx, "ix_trace", args);
    },
  );
  registerSymbolTool(
    server,
    runIx,
    "ix_explain",
    "Explain a symbol using graph evidence",
    "explain",
  );
  registerTool(
    server,
    "ix_rank",
    "Rank graph entities by importance or connectivity",
    {
      by: z.string().min(1).default("dependents"),
      kind: z.string().min(1).default("class"),
      top: z.number().int().min(1).max(100).default(10),
      path: z.string().min(1).optional(),
    },
    async (input) => {
      const args = [
        "rank",
        "--by",
        stringArg(input, "by"),
        "--kind",
        stringArg(input, "kind"),
        "--top",
        numberArg(input, "top").toString(),
      ];
      pushOption(args, "--path", input.path);
      return runFormatted(runIx, "ix_rank", args);
    },
  );
  registerTool(
    server,
    "ix_inventory",
    "List graph entities within a repository path",
    {
      path: z.string().min(1),
      kind: z.string().min(1).default("file"),
    },
    async (input) =>
      runFormatted(runIx, "ix_inventory", [
        "inventory",
        "--kind",
        stringArg(input, "kind"),
        "--path",
        stringArg(input, "path"),
      ]),
  );
  registerTool(
    server,
    "ix_smells",
    "Detect graph-backed architecture smells",
    {
      path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async (input) => runSmells(runIx, input),
  );
  registerTool(server, "ix_stats", "Return graph-wide statistics", {}, async () =>
    runFormatted(runIx, "ix_stats", ["stats"]),
  );
  registerTool(server, "ix_subsystems", "List graph-derived subsystems", {}, async () =>
    runFormatted(runIx, "ix_subsystems", ["subsystems"]),
  );
  registerTool(
    server,
    "ix_decisions",
    "List Ix Pro architecture decisions, optionally scoped to a path",
    { path: z.string().min(1).optional() },
    async (input) => {
      const args = ["decisions"];
      pushOption(args, "--path", input.path);
      return runJson(runIx, "ix_decisions", args);
    },
  );
  registerTool(
    server,
    "ix_history",
    "Show provenance and patch history for a file or symbol",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_history", ["history", stringArg(input, "target")]),
  );

  return server;
}

export async function startIxMcpServer(version = "0.0.0"): Promise<void> {
  const server = createIxMcpServer({ version });
  // A dedicated handle on fd 1 rather than process.stdout, which the in-process
  // runner patches to capture command output.
  await server.connect(new StdioServerTransport(process.stdin, createProtocolStdout()));
}

function registerSymbolTool(
  server: McpServer,
  runIx: IxRunner,
  name: string,
  description: string,
  command: string,
): void {
  registerTool(server, name, description, { symbol: z.string().min(1) }, async (input) =>
    runFormatted(runIx, name, [command, stringArg(input, "symbol")]),
  );
}

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (input: ToolInput) => Promise<CallToolResult>,
): void {
  server.registerTool(name, { description, inputSchema }, async (input) =>
    handler(input as ToolInput),
  );
}

async function runFormatted(
  runIx: IxRunner,
  tool: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CallToolResult> {
  return runCommand(runIx, tool, [...args, "--format", "llm"], timeoutMs);
}

async function runJson(
  runIx: IxRunner,
  tool: string,
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CallToolResult> {
  return runCommand(runIx, tool, [...args, "--format", "json"], timeoutMs);
}

async function runCommand(
  runIx: IxRunner,
  tool: string,
  args: string[],
  timeoutMs: number,
): Promise<CallToolResult> {
  const result = await runIx(args, timeoutMs);
  if (!result.ok) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `${args.slice(0, 2).join(" ")} failed without output`;
    return textResult(JSON.stringify({ error: detail, tool }), true);
  }

  return textResult(result.stdout.trim() || "{}");
}

async function runSmells(runIx: IxRunner, input: ToolInput): Promise<CallToolResult> {
  const result = await runIx(["smells", "--format", "json"], DEFAULT_TIMEOUT_MS);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || "smells failed without output";
    return textResult(JSON.stringify({ error: detail, tool: "ix_smells" }), true);
  }

  const parsed = parseJsonOutput(result.stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
    return textResult(result.stdout.trim() || "{}");
  }

  const path = typeof input.path === "string" ? normalizePath(input.path) : null;
  const limit = numberArg(input, "limit");
  const candidates = parsed.candidates
    .filter((candidate) => {
      if (path === null || !isRecord(candidate) || typeof candidate.file !== "string") {
        return path === null;
      }
      const file = normalizePath(candidate.file);
      return file === path || file.startsWith(`${path}/`);
    })
    .slice(0, limit);

  return textResult(JSON.stringify({ ...parsed, count: candidates.length, candidates }, null, 2));
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function stringArg(input: ToolInput, key: string): string {
  return input[key] as string;
}

function numberArg(input: ToolInput, key: string): number {
  return input[key] as number;
}

function pushOption(args: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    args.push(flag, value);
  }
}

function parseJsonOutput(output: string): unknown {
  const text = output.trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{" && text[index] !== "[") continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // A startup notice can contain punctuation before the actual JSON body.
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}
