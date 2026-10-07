// Copyright 2026 Ix Infrastructure Inc.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { z } from "zod";
import { isReadablePath } from "../cli/config.js";

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
  // First, as it is registered first: tools/list leads with where to start.
  "ix_context",
  "ix_health",
  "ix_locate",
  // `ix search` is the command every other one starts from, and it was the one
  // command with no tool at all — an agent over MCP could follow an edge from
  // a symbol it already knew, and had no way to find the first symbol.
  "ix_search",
  "ix_text",
  "ix_impact",
  "ix_map",
  "ix_overview",
  "ix_read",
  "ix_diff",
  // One tool for four relations. The four singles stay in the catalog for
  // `--tools=all`; `--tools=core` advertises this instead.
  "ix_neighbors",
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

// Titles are display labels, a few words each. What a tool is FOR — when to
// reach for it, what it returns that Grep and Read cannot, and when not to use
// it — is in its description, which is the text a model actually weighs.
const TOOL_ANNOTATIONS: Record<(typeof IX_MCP_TOOL_NAMES)[number], ToolAnnotations> = {
  ix_health: { ...READ_ONLY, title: "Graph health" },
  ix_locate: { ...READ_ONLY, title: "Locate a definition" },
  ix_search: { ...READ_ONLY, title: "Find definitions by name" },
  ix_text: { ...READ_ONLY, title: "Ranked text search" },
  ix_impact: { ...READ_ONLY, title: "Change impact" },
  ix_map: { ...WRITE, title: "Re-map the workspace" },
  ix_overview: { ...READ_ONLY, title: "Structural overview" },
  // Not "graph-bounded": `ix read` resolves an exact file path before it
  // consults the graph at all, so the title has to describe the whole command.
  ix_read: { ...READ_ONLY, title: "Read source by symbol or range" },
  ix_diff: { ...READ_ONLY, title: "Graph diff between revisions" },
  ix_neighbors: { ...READ_ONLY, title: "Callers, callees, imports, importers" },
  ix_callers: { ...READ_ONLY, title: "Callers" },
  ix_callees: { ...READ_ONLY, title: "Callees" },
  ix_imported_by: { ...READ_ONLY, title: "Importers" },
  ix_imports: { ...READ_ONLY, title: "Imports" },
  ix_depends: { ...READ_ONLY, title: "Dependent tree" },
  ix_trace: { ...READ_ONLY, title: "Trace paths" },
  ix_explain: { ...READ_ONLY, title: "Explain a symbol" },
  ix_rank: { ...READ_ONLY, title: "Rank by connectivity" },
  ix_inventory: { ...READ_ONLY, title: "Inventory by kind" },
  ix_smells: { ...WRITE, title: "Architecture smells" },
  ix_stats: { ...READ_ONLY, title: "Graph statistics" },
  ix_subsystems: { ...READ_ONLY, title: "Subsystems" },
  ix_history: { ...READ_ONLY, title: "Patch history" },
  ix_ingest: { ...WRITE_OPEN_WORLD, title: "Ingest a path or GitHub repo" },
  // Reads the graph and composes a bundle; the CLI's --save and --out, which are
  // the only parts of `ix context` that write anything, are not exposed here.
  ix_context: { ...READ_ONLY, title: "Context bundle" },
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
  // `ix_smells` is not here any more, and neither is `ix_context`'s bundle
  // schema. An outputSchema is a promise that EVERY result carries structured
  // content, so a tool whose structured copy is opt-in cannot declare one.
  // `ix_context`'s was 4,671 of the 15,365 bytes of tools/list — 30% of the
  // always-on cost of connecting to this server, for a shape only a caller
  // passing `structured: true` receives.
};

/** Which catalog to advertise. */
export type ToolsetName = "core" | "all";

/**
 * The tools an agent actually needs, and the default.
 *
 * `tools/list` is paid on every session before a single call is made, and the
 * full catalog is 26 tools of which a recorded run used four. The cost is not
 * only bytes: a model choosing between near-identical names picks worse than
 * one choosing between a few that each answer a different question.
 *
 * Ten was still too many. With Ix connected and told to use it, recorded
 * agents called `ix_context`, `ix_read` and `ix_search` and never `ix_explain`,
 * `ix_impact`, `ix_overview` or `ix_locate` — four of the ten answered "tell me
 * about X" and two were name lookups, so the graph's own answers (who calls
 * this, what does a change reach) went unasked. The five kept are one per
 * question, each something Grep/Glob/Read cannot answer in one step:
 *
 * - `ix_context`: where to start on a target or an issue, ranked.
 * - `ix_search`: which definition a name means, definitions first.
 * - `ix_neighbors`: who calls / is called by / imports / is imported by X.
 * - `ix_impact`: what a change to X reaches.
 * - `ix_read`: a definition's source by name, without knowing its file.
 *
 * Left for `--tools=all`: `ix_health` (every tool reports backend and graph
 * failures itself), `ix_text` (ripgrep with a ranking — the caller already has
 * Grep), and `ix_locate` / `ix_overview` / `ix_explain`, which `ix_search` and
 * `ix_context` cover. Nothing is removed: `--tools=all` advertises the whole
 * catalog, including the four `ix_neighbors` singles.
 */
export const IX_MCP_CORE_TOOL_NAMES = [
  "ix_context",
  "ix_search",
  "ix_neighbors",
  "ix_impact",
  "ix_read",
] as const;

/**
 * Server instructions, sent in the `initialize` result.
 *
 * The one channel that reaches the model when a host defers tool schemas.
 * Claude Code shows a deferred server's tools as bare names until the model
 * searches for them, and in 32 recorded runs no agent ever did, so not one
 * tool description was read and Ix went uncalled. Instructions go into the
 * system prompt either way.
 *
 * Written for an agent that already has Grep, Glob and Read: when the graph
 * answers something they cannot, which tool, and when not to bother. Every
 * tool it names is in the core set, so it is true for every session.
 */
export const IX_MCP_INSTRUCTIONS = [
  "Ix is a code graph of this repository: definitions, calls and imports parsed from the source, not matched as text. Use it next to Grep/Glob/Read for what they cannot answer in one step:",
  "- Where to start on an issue or task, or what a file or symbol touches: ix_context (target=<name or path>, or issue=<issue text>). Ranked evidence, each row path:lines.",
  "- Who calls or imports X across files, or what X calls or imports: ix_neighbors (relation=callers|callees|imports|imported_by).",
  "- What a change to X would reach, before you edit it: ix_impact.",
  "- Which definition a name means when several share it: ix_search (definitions first); ix_read returns a definition's source by name.",
  "Not for a literal string, a regex, or a line in a file you already have open: use Grep/Read.",
  "No health check is needed first; a tool that cannot answer says why.",
].join("\n");

interface CreateServerOptions {
  version?: string;
  runIx?: IxRunner;
  /** Advertise the Pro tools. Resolved by {@link detectPro} at startup. */
  proAvailable?: boolean;
  /** Which catalog to advertise. Defaults to `core`. */
  tools?: ToolsetName;
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

  const server = new McpServer(
    {
      // Not renamed: every existing registration is keyed by this name.
      name: "ix-memory",
      version,
    },
    { instructions: IX_MCP_INSTRUCTIONS },
  );

  // `core` unless asked otherwise. A tool left out here is not removed from the
  // CLI, only from what this session is told about.
  const toolset: ToolsetName = options.tools ?? "core";
  const core = new Set<string>(IX_MCP_CORE_TOOL_NAMES);
  // The Pro tools are exempt from the core gate. They are already conditional
  // on Pro being installed, and "Pro is installed, so its tools are offered"
  // is a contract a toolset choice has no business silently reversing.
  const ctx: RegisterContext = {
    server,
    advertise: (name: string) =>
      toolset === "all"
      || core.has(name)
      || (IX_MCP_PRO_TOOL_NAMES as readonly string[]).includes(name),
  };

  // First, so it heads tools/list: it is where a session should start.
  registerTool(
    ctx,
    "ix_context",
    "Use first on an issue, a task, or an unfamiliar symbol or file (target=<name or path>, or issue=<text>). Returns ranked evidence (definition, members, callers, importers, related files, recent commits), each row path:lines, then next calls. Not for a literal string: use Grep.",
    {
      target: z.string().min(1).optional(),
      issue: z.string().min(1).max(200_000).optional().describe("issue or task text, instead of target"),
      kind: SYMBOL_TOOL_INPUT.kind,
      path: SYMBOL_TOOL_INPUT.path,
      pick: SYMBOL_TOOL_INPUT.pick,
      as_of_rev: z.number().int().nonnegative().optional(),
      max_entities: z.number().int().min(1).max(500).optional(),
      max_relationships: z.number().int().min(1).max(1000).optional(),
      max_evidence: z.number().int().min(1).max(200).optional(),
      max_tokens: z.number().int().min(500).max(200_000).optional().describe("default 3000"),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(1_000_000)
        .optional()
        .describe("exact character budget, instead of max_tokens"),
      structured: z
        .boolean()
        .optional()
        .describe("JSON bundle as structuredContent, not records"),
    },
    async (input) => {
      const hasTarget = typeof input.target === "string";
      const hasIssue = typeof input.issue === "string";
      // Checked here rather than left to the CLI, whose refusals name flags an
      // MCP caller does not have.
      const refusal =
        hasTarget === hasIssue
          ? "pass exactly one of target or issue"
          : hasIssue && ["kind", "path", "pick"].some((key) => input[key] !== undefined)
            ? "kind, path and pick narrow a named target; they do not combine with issue"
            : input.max_tokens !== undefined && input.max_chars !== undefined
              ? "pass max_tokens or max_chars, not both; they bound the same evidence in different units"
              : undefined;
      if (refusal) return textResult(JSON.stringify({ error: refusal, tool: "ix_context" }), true);
      const options: string[] = symbolOptions(input, { limit: false });
      if (typeof input.as_of_rev === "number") options.push(`--as-of-rev=${numberArg(input, "as_of_rev")}`);
      if (typeof input.max_entities === "number") options.push(`--max-entities=${numberArg(input, "max_entities")}`);
      if (typeof input.max_relationships === "number")
        options.push(`--max-relationships=${numberArg(input, "max_relationships")}`);
      if (typeof input.max_evidence === "number") options.push(`--max-evidence=${numberArg(input, "max_evidence")}`);
      if (typeof input.max_tokens === "number") options.push(`--max-tokens=${numberArg(input, "max_tokens")}`);
      if (typeof input.max_chars === "number") options.push(`--max-chars=${numberArg(input, "max_chars")}`);
      const run = (argv: IxArgv) =>
        // Once, in the format the reader is: an agent. The bundle used to go out
        // twice on every call — the JSON text AND the same object again as
        // structuredContent — so a 20 KB bundle cost 40 KB, and the copy a model
        // actually reads is the smaller `llm` one that was not being sent at all.
        input.structured === true
          ? runJsonStructured(runIx, "ix_context", argv)
          : runFormatted(runIx, "ix_context", argv);
      if (hasTarget) return run(ix("context", [stringArg(input, "target")], options));
      // `--from-issue` reads a file. The in-process runner has no stdin to give
      // it, so the text goes through a private temp file that lives only for
      // this call.
      return withIssueFile(stringArg(input, "issue"), (file) =>
        run(ix("context", [], [...options, `--from-issue=${file}`])),
      );
    },
  );
  registerTool(ctx, "ix_health", "Use only when a result suggests the graph is missing or stale. Returns backend reachability, workspace mapping and freshness. Not needed before other calls: each reports its own failure.", {}, async () =>
    runFormatted(runIx, "ix_health", ix("status")),
  );
  registerTool(
    ctx,
    "ix_locate",
    "Use when a name has several definitions and you want the canonical one. Returns one definition with path:lines, or the candidates when it cannot choose. For a ranked list use ix_search.",
    { symbol: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_locate", ix("locate", [stringArg(input, "symbol")])),
  );
  registerTool(
    ctx,
    "ix_search",
    "Use when you know a name, or part of one, and need its definition, or which of several same-named definitions you mean. Returns entities ranked definitions-first, each with kind and path:lines, not every text occurrence. Not for strings, comments or regex: use Grep.",
    {
      term: z.string().min(1),
      kind: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      language: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(200).default(10),
      // Search hides test and fixture entities, and says how many it hid; this
      // is the argument that hint names.
      include_tests: z.boolean().optional(),
    },
    async (input) => {
      const options = [`--limit=${numberArg(input, "limit")}`];
      pushOption(options, "--kind", input.kind);
      pushOption(options, "--path", input.path);
      pushOption(options, "--language", input.language);
      if (input.include_tests === true) options.push("--include-tests");
      return runFormatted(runIx, "ix_search", ix("search", [stringArg(input, "term")], options));
    },
  );
  registerTool(
    ctx,
    "ix_text",
    "Use for a literal or regex match when you want code ranked above tests above docs. Returns matching lines with path:line. The same matches Grep finds; prefer Grep when you have it.",
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
    ctx,
    "ix_impact",
    "Use before changing a symbol or file, to see what the change reaches. Returns a risk level, dependents grouped by subsystem and the most affected members with path:lines, which grep cannot compute. For a flat list of direct callers use ix_neighbors.",
    {
      target: z.string().min(1),
      // The disambiguation the CLI already has. Without them an ambiguous name
      // had no second call that could get past it.
      kind: SYMBOL_TOOL_INPUT.kind,
      path: SYMBOL_TOOL_INPUT.path,
      pick: SYMBOL_TOOL_INPUT.pick,
    },
    async (input) =>
      runFormatted(runIx, "ix_impact", ix("impact", [stringArg(input, "target")], symbolOptions(input, { limit: false }))),
  );
  registerTool(
    ctx,
    "ix_map",
    "Use after editing code, when later answers must see the change. Re-maps the whole workspace; unchanged files are skipped. Slow; not needed before reading.",
    {},
    // No path argument. `ix map` takes a workspace root and rejects a file
    // ("Map path is not a directory"), and a subdirectory would be mapped as a
    // workspace of its own. The old optional `file` is dropped from the schema,
    // so a caller that still sends it gets the workspace map.
    async () => runJson(runIx, "ix_map", ix("map"), 120_000),
  );
  registerTool(
    ctx,
    "ix_overview",
    "Use for a one-call summary of a file, symbol or subsystem: what it is, what it holds, and what it touches. For ranked evidence around a task use ix_context.",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_overview", ix("overview", [stringArg(input, "target")])),
  );
  registerTool(
    ctx,
    "ix_read",
    "Use when you have a symbol name but not its file or lines. Returns exactly that definition's source; also takes a path or path:start-end. Not needed when you already know path and range: Read does that.",
    {
      symbol: z.string().min(1).describe("a symbol, a path, or `path:start-end`"),
      kind: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      pick: z.number().int().min(1).max(50).optional().describe("Nth candidate, 1-based"),
    },
    // Nothing is forwarded as a size bound: `ix read` owns its own cap, and a
    // second one here would be a number to keep in sync with it. A range goes
    // in the target, where the CLI already takes one: `read src/a.ts:40-80`.
    async (input) =>
      runFormatted(runIx, "ix_read", ix("read", [stringArg(input, "symbol")], symbolOptions(input, { limit: false }))),
  );
  registerTool(
    ctx,
    "ix_diff",
    "Use to see what changed between two graph revisions. Returns added, removed and modified entities rather than changed lines.",
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
  registerTool(
    ctx,
    "ix_neighbors",
    "Use when you need who calls X, what X calls, what X imports, or which files import X, across the repo. Returns one row per resolved edge with path:lines, where grep finds every same-named symbol too. For transitive reach use ix_impact.",
    {
      ...SYMBOL_TOOL_INPUT,
      relation: z
        .enum(["callers", "callees", "imports", "imported_by"])
        .describe("callers = who calls it; callees = what it calls"),
    },
    async (input) => {
      const relation = stringArg(input, "relation");
      // The CLI spells one of them with a dash.
      const command = relation === "imported_by" ? "imported-by" : relation;
      return runFormatted(
        runIx,
        "ix_neighbors",
        ix(command, [stringArg(input, "symbol")], symbolOptions(input)),
      );
    },
  );
  registerSymbolTool(ctx, runIx, "ix_callers", "Who calls this. Rows carry path:lines. Prefer ix_neighbors relation=callers.", "callers");
  registerSymbolTool(ctx, runIx, "ix_callees", "What this calls. Rows carry path:lines. Prefer ix_neighbors relation=callees.", "callees");
  registerSymbolTool(ctx, runIx, "ix_imported_by", "What imports this. Rows carry path:lines. Prefer ix_neighbors relation=imported_by.", "imported-by");
  registerSymbolTool(ctx, runIx, "ix_imports", "What this imports. Rows carry path:lines. Prefer ix_neighbors relation=imports.", "imports");
  registerTool(
    ctx,
    "ix_depends",
    "The dependent tree, bounded. Use when one hop of ix_neighbors is not enough",
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
    ctx,
    "ix_trace",
    "Use to follow edges through a symbol, or find a path from it to another (to=). Returns the chain, bounded by depth.",
    {
      symbol: z.string().min(1),
      to: z.string().min(1).optional(),
      // The one tool whose traversal had no bound it could be told about:
      // `ix_depends` has had a `depth` since it was written and this did not,
      // so a trace through a hub ran as deep as the graph goes.
      depth: z.number().int().min(1).max(10).default(3),
    },
    async (input) => {
      const options = [`--depth=${numberArg(input, "depth")}`];
      pushOption(options, "--to", input.to);
      return runFormatted(runIx, "ix_trace", ix("trace", [stringArg(input, "symbol")], options));
    },
  );
  registerSymbolTool(
    ctx,
    runIx,
    "ix_explain",
    "Use to learn what a symbol is for from how it is used. Returns its role, importance and main users with path:lines, inferred from graph edges. For ranked evidence around a task use ix_context.",
    "explain",
    // No `--limit`: `ix explain` has none, and forwarding a flag the command
    // rejects turns a resolvable call into a usage error.
    { symbol: SYMBOL_TOOL_INPUT.symbol, kind: SYMBOL_TOOL_INPUT.kind, path: SYMBOL_TOOL_INPUT.path, pick: SYMBOL_TOOL_INPUT.pick },
  );
  registerTool(
    ctx,
    "ix_rank",
    "The most connected entities of a kind. Use to find where to start in an unfamiliar repo",
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
    ctx,
    "ix_inventory",
    "Every entity of one kind, grouped by file. Use instead of a glob to enumerate symbols",
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
    ctx,
    "ix_smells",
    "Orphans, god modules and cycles the graph can see. Not a linter.",
    {
      path: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(50),
      structured: z
        .boolean()
        .optional()
        .describe("also return the payload as structuredContent"),
    },
    async (input) => runSmells(runIx, input),
  );
  registerTool(ctx, "ix_stats", "Node and edge counts by kind. Use to tell an empty graph from a missing symbol.", {}, async () =>
    runFormatted(runIx, "ix_stats", ix("stats")),
  );
  registerTool(ctx, "ix_subsystems", "The regions the map grouped this repo into, with health and confidence.", {}, async () =>
    runFormatted(runIx, "ix_subsystems", ix("subsystems")),
  );
  registerTool(
    ctx,
    "ix_history",
    "Which revisions touched this, and what each patch said it was doing",
    { target: z.string().min(1) },
    async (input) => runFormatted(runIx, "ix_history", ix("history", [stringArg(input, "target")])),
  );
  registerTool(
    ctx,
    "ix_ingest",
    "Add a path or a GitHub repo to the graph. A path inside a mapped workspace refreshes just that part of it. Slow; ix_map is the usual way in",
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
      // Confined like ix_read. An ingested path's workspace becomes a root
      // ix_read may open files from, so an unconfined path let a caller turn
      // any directory into a readable one (ix_ingest, then ix_read).
      if (typeof input.path === "string" && !isReadablePath(resolvePath(process.cwd(), input.path))) {
        return textResult(
          JSON.stringify({
            error: "path_outside_workspace",
            message: `Refusing to ingest a path outside the workspace: ${input.path}. Run ix map in that directory to make it a workspace.`,
            tool: "ix_ingest",
          }),
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
    registerTool(ctx, "ix_briefing", "Load the Ix Pro session briefing", {}, async () =>
      runJson(runIx, "ix_briefing", ix("briefing")),
    );
    registerTool(
      ctx,
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
      ctx,
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

export async function startIxMcpServer(version = "0.0.0", tools: ToolsetName = "core"): Promise<void> {
  // Before anything can throw: the CLI's own handlers exit the process on any
  // stray error, which for a server means losing every tool mid-session.
  installServerErrorHandlers();
  const server = createIxMcpServer({ version, tools, proAvailable: await detectPro() });
  // A dedicated handle on fd 1 rather than process.stdout, which the in-process
  // runner patches to capture command output.
  await server.connect(new StdioServerTransport(process.stdin, createProtocolStdout()));
}

/**
 * The flags that let a caller resolve an ambiguous symbol.
 *
 * Every one of these tools took a bare `symbol` and nothing else, so a name
 * with three definitions answered "Ambiguous symbol" and there was no second
 * call that could get past it — the CLI's own `--pick`, `--kind` and `--path`
 * were unreachable over MCP. An agent's only move was to shell out, which is
 * the thing this server exists to avoid.
 */
const SYMBOL_TOOL_INPUT = {
  symbol: z.string().min(1),
  kind: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  pick: z.number().int().min(1).max(50).optional().describe("Nth candidate, 1-based"),
  limit: z.number().int().min(1).max(500).optional(),
} as const;

/** Turn the shared disambiguation input into CLI flags. */
function symbolOptions(input: ToolInput, opts: { limit?: boolean } = {}): string[] {
  const options: string[] = [];
  pushOption(options, "--kind", input.kind);
  pushOption(options, "--path", input.path);
  if (typeof input.pick === "number") options.push(`--pick=${numberArg(input, "pick")}`);
  if (opts.limit !== false && typeof input.limit === "number") {
    options.push(`--limit=${numberArg(input, "limit")}`);
  }
  return options;
}

function registerSymbolTool(
  ctx: RegisterContext,
  runIx: IxRunner,
  name: string,
  description: string,
  command: string,
  input: z.ZodRawShape = SYMBOL_TOOL_INPUT,
): void {
  registerTool(ctx, name, description, input, async (args) =>
    runFormatted(runIx, name, ix(command, [stringArg(args, "symbol")], symbolOptions(args))),
  );
}

/** The server being built, and whether this session advertises a given tool. */
interface RegisterContext {
  server: McpServer;
  advertise: (name: string) => boolean;
}

function registerTool(
  ctx: RegisterContext,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (input: ToolInput) => Promise<CallToolResult>,
  outputSchema?: z.ZodType,
): void {
  // Not registered at all rather than registered and hidden: a tool the client
  // cannot see but can still call is a surface with no documentation.
  if (!ctx.advertise(name)) return;
  ctx.server.registerTool(
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

/**
 * How much of one tool result a client should have to hold.
 *
 * The only bound before this was the runner's 16 MiB heap guard, which exists
 * to stop a long-lived server growing — not to stop a single `ix text` filling
 * a model's context. Most hosts truncate a tool result themselves, from the
 * end, with no marker: the caller then cannot tell a short answer from a
 * chopped one.
 */
const MAX_TOOL_RESULT_BYTES = 24 * 1024;

/**
 * The failure text an error result carries. A command's stderr can be a whole
 * stack trace or a multi-megabyte proxy page, and an error result goes into
 * the model's context the same as a success does.
 */
const MAX_ERROR_DETAIL_CHARS = 4000;
export function capErrorDetail(detail: string): string {
  return detail.length > MAX_ERROR_DETAIL_CHARS
    ? `${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}… (${detail.length - MAX_ERROR_DETAIL_CHARS} more characters)`
    : detail;
}

/**
 * Cap a record stream, on a line boundary, and say so in a record.
 *
 * Record streams only. Cutting JSON produces something that does not parse,
 * which is worse than something large — so `runJson`, `runJsonStructured` and
 * `runSmells` are deliberately uncapped, and their size is bounded by the
 * command's own budgets instead.
 */
export function capRecordStream(text: string, tool: string): string {
  if (text.length <= MAX_TOOL_RESULT_BYTES) return text;
  const boundary = text.lastIndexOf("\n", MAX_TOOL_RESULT_BYTES);
  const head = text.slice(0, boundary > 0 ? boundary : MAX_TOOL_RESULT_BYTES);
  return `${head}\ntruncated tool=${tool} shown_bytes=${head.length} total_bytes=${text.length} hint="Narrow the call — every one of these tools takes a limit, a path or a depth."`;
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
  if (semanticError) return { ...result, isError: true };
  if (first?.type !== "text") return result;
  const capped = capRecordStream(first.text, tool);
  return capped === first.text
    ? result
    : { ...result, content: [{ type: "text", text: capped }, ...result.content.slice(1)] };
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
    return textResult(JSON.stringify({ error: capErrorDetail(detail), tool }), true);
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
    const machineError = machineErrorOutput(result.stdout);
    if (machineError) return textResult(machineError, true);

    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `${args.slice(0, 2).join(" ")} failed without output`;
    return textResult(JSON.stringify({ error: capErrorDetail(detail), tool }), true);
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
  const structured = input.structured === true;
  const result = await runIx(toArgv(ix("smells"), "json"), DEFAULT_TIMEOUT_MS);
  if (!result.ok) {
    const detail = result.stderr.trim() || result.stdout.trim() || "smells failed without output";
    return textResult(JSON.stringify({ error: capErrorDetail(detail), tool: "ix_smells" }), true);
  }

  const parsed = parseJsonOutput(result.stdout);
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
    const text = textResult(result.stdout.trim() || "{}");
    return structured ? withStructuredContent(text) : text;
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
  // Compact, and the object once rather than twice. The indent was two spaces
  // per level of a list of smell candidates, and the structured copy was the
  // same bytes again.
  const text = textResult(JSON.stringify(payload));
  return structured ? { ...text, structuredContent: payload } : text;
}

/** Hand `work` a private file holding `text`, and remove it afterwards whatever happens. */
async function withIssueFile<T>(text: string, work: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ix-mcp-issue-"));
  try {
    const file = join(dir, "issue.md");
    await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
    return await work(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

function machineErrorOutput(output: string): string | null {
  const text = output.trim();
  if (text.startsWith("error code=")) return text;

  const parsed = parseJsonOutput(text);
  if (isRecord(parsed) && typeof parsed.error === "string") return text;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}
