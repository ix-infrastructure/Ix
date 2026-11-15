// Copyright 2026 Ix Infrastructure Inc.

import type { Caller, Hint, Lever } from "../cli/next-step.js";

/**
 * The MCP reader of a command's hints (see `cli/next-step.ts`).
 *
 * The only place that turns a hint into a tool call, so the command layer
 * never names a tool. A hint is phrased only when the session was offered the
 * tool that runs it; otherwise it is dropped, because a hint naming a tool the
 * session does not have is worse than none.
 */

type ArgValue = string | number | boolean | undefined | null;

/**
 * One MCP tool call as a caller would write it: `ix_neighbors symbol=X relation=callers`.
 *
 * Empty arguments are dropped, and a value with whitespace or a quote is
 * JSON-quoted so the call still reads as one token per argument.
 */
export function toolCall(tool: string, args: Record<string, ArgValue> = {}): string {
  const parts = [tool];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === "") continue;
    const text = String(value);
    parts.push(`${key}=${/[\s"'=]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.join(" ");
}

/**
 * The tool that runs each action, and the call. An action with no entry has no
 * tool (`contains`, `conflicts`), so it is never suggested over MCP.
 */
const TOOL_CALLS: { [A in Hint["action"]]?: { tool: string; call: (hint: Extract<Hint, { action: A }>) => string } } = {
  neighbors: {
    tool: "ix_neighbors",
    call: (h) => toolCall("ix_neighbors", { symbol: h.symbol, relation: h.relation, path: h.path }),
  },
  impact: { tool: "ix_impact", call: (h) => toolCall("ix_impact", { target: h.target, path: h.path }) },
  context: {
    tool: "ix_context",
    call: (h) => (h.target === undefined ? "ix_context" : toolCall("ix_context", { target: h.target, path: h.path })),
  },
  read: { tool: "ix_read", call: (h) => toolCall("ix_read", { symbol: h.target, path: h.path }) },
  text: { tool: "ix_text", call: (h) => (h.pattern === undefined ? "ix_text" : toolCall("ix_text", { pattern: h.pattern })) },
  explain: { tool: "ix_explain", call: (h) => toolCall("ix_explain", { symbol: h.symbol }) },
  depends: { tool: "ix_depends", call: (h) => toolCall("ix_depends", { symbol: h.symbol, depth: h.depth }) },
  map: { tool: "ix_map", call: () => "ix_map" },
};

/** Every tool a hint can name. */
export const HINT_TOOL_NAMES: readonly string[] = Object.values(TOOL_CALLS).map((entry) => entry!.tool);

/**
 * Tool arguments for each lever. `all` has none: no tool answers for every
 * candidate at once. `max_tokens` is `ix_context`'s budget.
 */
const MCP_LEVERS: Partial<Record<Lever, string>> = {
  pick: "pick=<n>",
  kind: "kind=<kind>",
  path: "path=<file substring>",
  include_tests: "include_tests=true",
  max_tokens: "max_tokens (default 3000)",
};

/** Every core tool that takes a symbol also takes these, so the hint holds whichever tool printed it. */
const MCP_DISAMBIGUATION = "Pass pick=<n> (1-based), kind=<kind> or path=<file substring> to disambiguate.";

/** An MCP session's reader: phrases hints as calls to the tools in `advertised`. */
export interface McpCaller extends Caller {
  /** The tools this session was offered. */
  readonly advertised: ReadonlySet<string>;
}

/**
 * The reader for an MCP session that was offered `advertised`. With none
 * given, no tool is assumed, so no hint names one.
 */
export function mcpCaller(advertised: Iterable<string> = []): McpCaller {
  const offered = new Set(advertised);
  return {
    style: "tool",
    hosted: true,
    advertised: offered,
    command(hint: Hint): string | undefined {
      // The next page is an argument of the tool that printed this one.
      if (hint.action === "page") return `offset=${hint.offset}`;
      const entry = TOOL_CALLS[hint.action] as { tool: string; call: (h: Hint) => string } | undefined;
      if (!entry || !offered.has(entry.tool)) return undefined;
      return entry.call(hint);
    },
    lever: (lever) => MCP_LEVERS[lever],
    disambiguation: () => MCP_DISAMBIGUATION,
  };
}

/** True when `caller` is an MCP session's reader. */
export function isMcpCaller(caller: Caller): caller is McpCaller {
  return caller.style === "tool" && "advertised" in caller;
}

/**
 * Carries an MCP session's tools into the child-process runner, which runs
 * each command in a fresh process (`IX_MCP_SUBPROCESS=1`).
 */
const IX_MCP_HINT_TOOLS_ENV = "IX_MCP_HINT_TOOLS";

/** The environment a child command needs to phrase its hints for `caller`. */
export function childHintEnv(caller: McpCaller): Record<string, string> {
  return { [IX_MCP_HINT_TOOLS_ENV]: [...caller.advertised].join(",") };
}

/** The reader a child command was started for, from {@link childHintEnv}. */
export function callerFromChildEnv(env: NodeJS.ProcessEnv): McpCaller {
  return mcpCaller((env[IX_MCP_HINT_TOOLS_ENV] ?? "").split(",").filter(Boolean));
}
