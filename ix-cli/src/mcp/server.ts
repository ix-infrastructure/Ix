import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { contextBundleSchema } from "../cli/context-bundle-schema.js";

import {
  createProtocolStdout,
  DEFAULT_TIMEOUT_MS,
  detectPro,
  installServerErrorHandlers,
  resolveDefaultRunner,
  type IxRunner,
} from "./runner.js";

export type { IxRunner } from "./runner.js";

/**
 * Tools every install can run.
 *
 * This set is the union of what the per-host Ix plugins expose, minus three
 * deliberate drops: `ix_query` is the deprecated command the CLI docs tell
 * agents not to use, and `ix_neighbors` / `ix_docs_tool` are convenience
 * composites of `ix_callers` + `ix_callees` + `ix_depends` and of
 * `ix_overview`, all of which are here individually.
 */
export const IX_MCP_OSS_TOOL_NAMES = [
  "ix_health",
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
  "ix_history",
  "ix_context",
  "ix_ingest",
] as const;

/**
 * Tools that need Ix Pro.
 *
 * Advertised only when the Pro package actually loads. Listing them
 * unconditionally — as this server did for `ix_briefing` and `ix_decisions` —
 * hands an OSS agent tools whose every call returns "requires Ix Pro", which it
 * cannot tell apart from a real failure.
 */
export const IX_MCP_PRO_TOOL_NAMES = ["ix_briefing", "ix_decisions", "ix_decide"] as const;

/** Every tool this server can serve, across both tiers. */
export const IX_MCP_TOOL_NAMES = [...IX_MCP_OSS_TOOL_NAMES, ...IX_MCP_PRO_TOOL_NAMES] as const;

/**
 * Semantic annotations for the tool catalog.
 *
 * These are advisory hints for MCP clients: they describe each tool's intent so
 * a client can present and route it sensibly. They are NOT security controls —
 * the hardening that actually matters (argv construction, timeouts, output
 * bounds, process cleanup) lives in the runner and is unchanged. The table is
 * keyed by {@link IX_MCP_TOOL_NAMES}, so the typechecker rejects any tool
 * added to the catalog without a truthful classification.
 */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Mutates backend state, so it is neither read-only nor idempotent. */
const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/** Mutates backend state and reaches outside the host (GitHub): open-world. */
const WRITE_OPEN_WORLD: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/**
 * A title and nothing else — for tools whose behavior cannot be verified from
 * this repository.
 *
 * The Pro tools are implemented in the separate `@ix/pro` package, which is why
 * they are also left out of TOOL_OUTPUT_SCHEMA below. The same reasoning applies
 * with more force to the behavioral hints: clients use `readOnlyHint` to decide
 * whether a call needs the user's approval, so asserting it for code that is not
 * in this tree would trade away a confirmation prompt on an unverified claim. An
 * absent hint costs a prompt; a wrong one costs the prompt itself.
 */
const UNVERIFIED = (title: string): ToolAnnotations => ({ title });

const TOOL_ANNOTATIONS: Record<(typeof IX_MCP_TOOL_NAMES)[number], ToolAnnotations> = {
  ix_health: { ...READ_ONLY, title: "Check Ix backend and graph readiness" },
  ix_locate: { ...READ_ONLY, title: "Resolve a symbol to its canonical target" },
  ix_text: { ...READ_ONLY, title: "Search text across the indexed repository" },
  ix_impact: { ...READ_ONLY, title: "Analyze the blast radius of changing a symbol" },
  ix_map: { ...WRITE, title: "Ingest or refresh the workspace architecture map" },
  ix_overview: { ...READ_ONLY, title: "Show the structural overview of a target" },
  // Not "graph-bounded": `ix read` resolves an exact file path before it
  // consults the graph at all, so the title has to describe the whole command.
  ix_read: { ...READ_ONLY, title: "Read source from the workspace" },
  ix_diff: { ...READ_ONLY, title: "Show the structural diff between revisions" },
  ix_callers: { ...READ_ONLY, title: "List incoming call edges" },
  ix_callees: { ...READ_ONLY, title: "List outgoing call edges" },
  ix_imported_by: { ...READ_ONLY, title: "List incoming import edges" },
  ix_imports: { ...READ_ONLY, title: "List outgoing import edges" },
  ix_depends: { ...READ_ONLY, title: "Show downstream dependencies" },
  ix_trace: { ...READ_ONLY, title: "Trace execution paths through a symbol" },
  ix_explain: { ...READ_ONLY, title: "Explain a symbol using graph evidence" },
  ix_rank: { ...READ_ONLY, title: "Rank graph entities by importance" },
  ix_inventory: { ...READ_ONLY, title: "List graph entities by kind" },
  ix_smells: { ...WRITE, title: "Detect graph-backed architecture smells" },
  ix_stats: { ...READ_ONLY, title: "Return graph-wide statistics" },
  ix_subsystems: { ...READ_ONLY, title: "List graph-derived subsystems" },
  ix_history: { ...READ_ONLY, title: "Show provenance and patch history" },
  ix_ingest: { ...WRITE_OPEN_WORLD, title: "Ingest a path or GitHub repository into the graph" },
  // Reads the graph and composes a bundle; the CLI's --save and --out, which are
  // the only parts of `ix context` that write anything, are not exposed here.
  ix_context: { ...READ_ONLY, title: "Build a bounded context bundle for a target" },
  // Implemented in @ix/pro, so nothing here can check these are true.
  ix_briefing: UNVERIFIED("Load the Ix Pro session briefing"),
  ix_decisions: UNVERIFIED("List Ix Pro architecture decisions"),
  ix_decide: UNVERIFIED("Record an architecture decision"),
};

/**
 * The output schema for tools that return a stable JSON object whose field
 * shape is backend- and version-defined.
 *
 * `z.object({}).passthrough()` accepts any object without promising specific
 * fields, so a backend addition or rename cannot turn a formatting surprise
 * into a failed tool call. It is deliberately not `z.record(...)`: the MCP SDK
 * only recognizes object schemas as output schemas, and a record schema is
 * silently dropped from tools/list.
 */
const JSON_OBJECT_SCHEMA = z.object({}).passthrough();

/**
 * Tools whose `--format=json` output is a stable object, exposed as MCP
 * structured content.
 *
 * The Pro tools are omitted because their command implementations live in the
 * separate `@ix/pro` package, so their output shape cannot be verified from
 * this repository.
 */
const TOOL_OUTPUT_SCHEMA: Partial<Record<(typeof IX_MCP_TOOL_NAMES)[number], z.ZodTypeAny>> = {
  ix_map: JSON_OBJECT_SCHEMA,
  ix_ingest: JSON_OBJECT_SCHEMA,
  ix_smells: JSON_OBJECT_SCHEMA,
};

interface CreateServerOptions {
  version?: string;
  runIx?: IxRunner;
  /** Advertise the Pro tools. Resolved by {@link detectPro} at startup. */
  proAvailable?: boolean;
}

type ToolInput = Record<string, unknown>;

/**
 * `ix_context` output schema — shared contract from the CLI bundle module so
 * the MCP surface and persisted investigation state validate the same shape.
 */

/**
 * One Ix invocationation, with its options kept apart from its positional values.
 *
 * The split is what lets every positional go behind a `--` separator. Appending
 * them as bare tokens let commander read any value beginning with `-` as a
 * flag: `ix_text` searching for `--force` failed outright, and searching for
 * `--path` quietly consumed the following `--limit` as its value and ranked
 * hits for the literal text `20` instead — a wrong answer the caller had no way
 * to detect.
 */
interface IxArgv {
  command: string;
  positionals: string[];
  options: string[];
}

function ix(command: string, positionals: string[] = [], options: string[] = []): IxArgv {
  return { command, positionals, options };
}

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
    runFormatted(runIx, "ix_health", ix("status")),
  );
  registerTool(
    server,
    "ix_locate",
    "Resolve a symbol to its canonical graph-backed target",
    { symbol: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_locate", ix("locate", [stringArg(input, "symbol")])),
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
      const options = [`--limit=${numberArg(input, "limit")}`];
      pushOption(options, "--path", input.path);
      pushOption(options, "--language", input.language);
      return runFormatted(runIx, "ix_text", ix("text", [stringArg(input, "pattern")], options));
    },
  );
  registerTool(
    server,
    "ix_impact",
    "Analyze the blast radius and risk of changing a symbol or file",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_impact", ix("impact", [stringArg(input, "target")])),
  );
  registerTool(
    server,
    "ix_map",
    "Ingest one path or refresh the full workspace architecture map",
    { file: z.string().min(1).optional() },
    async (input) => {
      const positionals = typeof input.file === "string" ? [input.file] : [];
      return runJson(runIx, "ix_map", ix("map", positionals), 120_000);
    },
  );
  registerTool(
    server,
    "ix_overview",
    "Return the structural overview of a symbol, file, or subsystem",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_overview", ix("overview", [stringArg(input, "target")])),
  );
  registerTool(
    server,
    "ix_read",
    "Read graph-bounded source for a symbol or indexed file",
    { symbol: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_read", ix("read", [stringArg(input, "symbol")])),
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
      const positionals = [
        numberArg(input, "from_rev").toString(),
        numberArg(input, "to_rev").toString(),
      ];
      if (typeof input.target === "string") positionals.push(input.target);
      return runFormatted(runIx, "ix_diff", ix("diff", positionals, input.summary === true ? ["--summary"] : []));
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
      runFormatted(runIx, "ix_depends", ix("depends", [stringArg(input, "symbol")], [
        `--depth=${numberArg(input, "depth")}`,
      ])),
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
      const options: string[] = [];
      pushOption(options, "--to", input.to);
      return runFormatted(runIx, "ix_trace", ix("trace", [stringArg(input, "symbol")], options));
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
      const options = [
        `--by=${stringArg(input, "by")}`,
        `--kind=${stringArg(input, "kind")}`,
        `--top=${numberArg(input, "top")}`,
      ];
      pushOption(options, "--path", input.path);
      return runFormatted(runIx, "ix_rank", ix("rank", [], options));
    },
  );
  registerTool(
    server,
    "ix_inventory",
    "List graph entities by kind, optionally scoped to a repository path",
    {
      // Optional, and `--limit` is forwarded, because the CLI's own contract is
      // `--kind` required and `--path` an optional filter. Requiring a path
      // made the documented `ix inventory --kind function` call impossible over
      // MCP, and dropping the limit capped every answer at the CLI's default 50
      // with no way to ask for more.
      kind: z.string().min(1).default("file"),
      path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    async (input) => {
      const options = [`--kind=${stringArg(input, "kind")}`, `--limit=${numberArg(input, "limit")}`];
      pushOption(options, "--path", input.path);
      return runFormatted(runIx, "ix_inventory", ix("inventory", [], options));
    },
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
    runFormatted(runIx, "ix_stats", ix("stats")),
  );
  registerTool(server, "ix_subsystems", "List graph-derived subsystems", {}, async () =>
    runFormatted(runIx, "ix_subsystems", ix("subsystems")),
  );
  registerTool(
    server,
    "ix_history",
    "Show provenance and patch history for a file or symbol",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_history", ix("history", [stringArg(input, "target")])),
  );
  registerTool(
    server,
    "ix_context",
    "Build a bounded, deterministic context bundle for a symbol, file, or entity",
    {
      target: z.string().min(1),
      as_of_rev: z.number().int().nonnegative().optional().describe("graph revision for historical context"),
      max_entities: z.number().int().min(1).max(500).optional(),
      max_relationships: z.number().int().min(1).max(1000).optional(),
      max_evidence: z.number().int().min(1).max(200).optional(),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(1_000_000)
        .optional()
        .describe("exact serialized-character budget for the evidence list"),
    },
    async (input) => {
      const options: string[] = [];
      if (typeof input.as_of_rev === "number") options.push(`--as-of-rev=${numberArg(input, "as_of_rev")}`);
      if (typeof input.max_entities === "number") options.push(`--max-entities=${numberArg(input, "max_entities")}`);
      if (typeof input.max_relationships === "number")
        options.push(`--max-relationships=${numberArg(input, "max_relationships")}`);
      if (typeof input.max_evidence === "number") options.push(`--max-evidence=${numberArg(input, "max_evidence")}`);
      if (typeof input.max_chars === "number") options.push(`--max-chars=${numberArg(input, "max_chars")}`);
      return runJsonStructured(runIx, "ix_context", ix("context", [stringArg(input, "target")], options));
    },
    contextBundleSchema,
  );
  registerTool(
    server,
    "ix_ingest",
    "Ingest a path, or issues/PRs/commits from a GitHub repository, into the graph",
    {
      path: z.string().min(1).optional(),
      github: z.string().min(1).optional().describe("owner/repo"),
      limit: z.number().int().min(1).max(500).default(50),
      since: z.string().min(1).optional().describe("ISO 8601 date"),
    },
    async (input) => {
      if (typeof input.path === "string" && typeof input.github === "string") {
        return textResult(
          JSON.stringify({ error: "path and github are mutually exclusive; provide only one", tool: "ix_ingest" }),
          true,
        );
      }
      const options: string[] = [];
      pushOption(options, "--github", input.github);
      pushOption(options, "--since", input.since);
      if (typeof input.github === "string") options.push(`--limit=${numberArg(input, "limit")}`);
      const positionals = typeof input.path === "string" ? [input.path] : [];
      // Ingestion walks the tree or pages a GitHub API, so it gets the same
      // headroom as ix_map rather than the default read timeout.
      return runJson(runIx, "ix_ingest", ix("ingest", positionals, options), 120_000);
    },
  );

  if (options.proAvailable) {
    registerTool(server, "ix_briefing", "Load the Ix Pro session briefing", {}, async () =>
      runJson(runIx, "ix_briefing", ix("briefing")),
    );
    registerTool(
      server,
      "ix_decisions",
      "List Ix Pro architecture decisions, optionally scoped to a path",
      { path: z.string().min(1).optional() },
      async (input) => {
        const options: string[] = [];
        pushOption(options, "--path", input.path);
        return runJson(runIx, "ix_decisions", ix("decisions", [], options));
      },
    );
    registerTool(
      server,
      "ix_decide",
      "Record an architecture decision with its rationale",
      {
        title: z.string().min(1),
        rationale: z.string().min(1),
        affects: z.string().min(1).optional().describe("entity the decision affects"),
      },
      async (input) => {
        const options = [`--rationale=${stringArg(input, "rationale")}`];
        pushOption(options, "--affects", input.affects);
        return runJson(runIx, "ix_decide", ix("decide", [stringArg(input, "title")], options));
      },
    );
  }

  return server;
}

export async function startIxMcpServer(version = "0.0.0"): Promise<void> {
  // Before anything can throw: the CLI's own handlers exit the process on any
  // stray error, which for a server means losing every tool mid-session.
  installServerErrorHandlers();
  const server = createIxMcpServer({ version, proAvailable: await detectPro() });
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
    runFormatted(runIx, name, ix(command, [stringArg(input, "symbol")])),
  );
}

function registerTool(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (input: ToolInput) => Promise<CallToolResult>,
  outputSchema?: z.ZodType,
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: TOOL_ANNOTATIONS[name as keyof typeof TOOL_ANNOTATIONS],
      // ix_context passes its schema as an argument rather than through the
      // table, because the shape is owned by the CLI bundle module.
      outputSchema: outputSchema ?? TOOL_OUTPUT_SCHEMA[name as keyof typeof TOOL_OUTPUT_SCHEMA],
    },
    async (input) => handler(input as ToolInput),
  );
}

/**
 * Flatten to argv: options first, then every positional behind `--`.
 *
 * Option values use the `--flag=value` form for the same reason, so a value of
 * `--rationale` cannot be mistaken for the next flag.
 */
function toArgv(argv: IxArgv, format: string): string[] {
  const args = [argv.command, ...argv.options, `--format=${format}`];
  if (argv.positionals.length > 0) args.push("--", ...argv.positionals);
  return args;
}

async function runFormatted(
  runIx: IxRunner,
  tool: string,
  argv: IxArgv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CallToolResult> {
  const result = await runCommand(runIx, tool, toArgv(argv, "llm"), timeoutMs);
  if (result.isError) return result;

  const first = result.content[0];
  // Only the leading record governs status. `ix_read` may contain error-like
  // source lines after its successful `content` record.
  const semanticError = first?.type === "text" && first.text.startsWith("error code=");
  return semanticError ? { ...result, isError: true } : result;
}

async function runJson(
  runIx: IxRunner,
  tool: string,
  argv: IxArgv,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CallToolResult> {
  const result = await runCommand(runIx, tool, toArgv(argv, "json"), timeoutMs);
  // Only for tools that declared an outputSchema. runJson also serves the three
  // Pro tools, whose shape cannot be checked from this package — which is the
  // stated reason they have no schema. Attaching structuredContent to them
  // anyway would hand clients the unverified object regardless, just without the
  // contract that would let them validate it.
  return declaresOutputSchema(tool) ? withStructuredContent(result) : result;
}

function declaresOutputSchema(tool: string): boolean {
  return tool in TOOL_OUTPUT_SCHEMA;
}

/**
 * Run a command in JSON format and surface the parsed result as MCP
 * `structuredContent` alongside the text payload. The context bundle carries
 * its own versioned schema (`ix-context-bundle/1`), so the structured copy is
 * stable across releases; when the output does not parse into a usable object
 * we omit structured content and keep the text result authoritative rather
 * than throwing.
 */
async function runJsonStructured(
  runIx: IxRunner,
  tool: string,
  argv: IxArgv,
): Promise<CallToolResult> {
  const result = await runIx(toArgv(argv, "json"), DEFAULT_TIMEOUT_MS);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${argv.command} failed without output`;
    return textResult(JSON.stringify({ error: detail, tool }), true);
  }
  const text = result.stdout.trim() || "{}";
  const parsed = parseJsonOutput(text);
  // The CLI contract for `--format=json` is a parseable bundle; when stdout is
  // not a usable object the tool genuinely failed, and returning an MCP error
  // is more truthful than inventing a bundle (the output schema requires
  // schema-valid structured content on every result).
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    return textResult(text || JSON.stringify({ error: `${argv.command} produced no parseable JSON`, tool }), true);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: parsed,
  };
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

/**
 * Expose the parsed JSON object as structuredContent so clients receive a typed
 * value instead of a string to re-parse.
 *
 * Falls back to `{}` — never throws — when the output is not a JSON object; the
 * human-readable text content is always preserved. The fallback keeps tools
 * with an outputSchema valid even if a future backend returns an unexpected
 * shape, rather than turning a formatting surprise into a failed tool call.
 */
function withStructuredContent(result: CallToolResult): CallToolResult {
  if (result.isError) return result;
  const first = result.content?.[0];
  const text = first?.type === "text" ? first.text : "";
  const parsed = parseJsonOutput(text);
  return { ...result, structuredContent: isRecord(parsed) ? parsed : {} };
}

async function runSmells(runIx: IxRunner, input: ToolInput): Promise<CallToolResult> {
  const result = await runIx(toArgv(ix("smells"), "json"), DEFAULT_TIMEOUT_MS);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || "smells failed without output";
    return textResult(JSON.stringify({ error: detail, tool: "ix_smells" }), true);
  }

  const parsed = parseJsonOutput(result.stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
    return withStructuredContent(textResult(result.stdout.trim() || "{}"));
  }

  const path = typeof input.path === "string" ? normalizePath(input.path) : null;
  const limit = numberArg(input, "limit");
  const candidates = parsed.candidates
    .filter((candidate) => {
      if (path === null || !isRecord(candidate) || typeof candidate.file !== "string") {
        return path === null;
      }
      // Substring, matching what `--path` means everywhere else in the CLI
      // ("Filter by source file path substring" on inventory, the same on
      // rank). Prefix matching answered `{"count": 0}` — a confident "no
      // architecture smells here" — for the `src` an agent had just used
      // successfully against ix_inventory on files stored as `ix-cli/src/...`.
      return normalizePath(candidate.file).includes(path);
    })
    .slice(0, limit);

  const payload = { ...parsed, count: candidates.length, candidates };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
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

function pushOption(options: string[], flag: string, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    options.push(`${flag}=${value}`);
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
