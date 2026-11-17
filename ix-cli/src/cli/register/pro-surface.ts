// Copyright 2026 Ix Infrastructure Inc.

/**
 * The command surface the optional `@ix/pro` package provides, in one place.
 *
 * Every list of Pro command names in ix-cli is derived from this table: the
 * OSS stubs (`pro-stubs.ts`), the collapsed `ix help <plural>` topics and the
 * "needs Ix Pro" note on `ix help workflows` (`commands/workflows.ts`), the MCP
 * Pro tool names (`mcp/server.ts`), and the plugin contract allowlist
 * (`scripts/check-plugin-contract.mjs`, which reads the build output). The
 * docs' lists of Pro commands are held to it by `pro-surface.test.ts`.
 *
 * Retiring or renaming a Pro command is an edit here (move the old name to
 * `PRO_RETIRED`) plus the docs. Hand-kept copies of this list drifted apart
 * (#371, #932).
 *
 * Keep this module free of imports: the plugin contract script loads it from
 * `dist/` with plain Node.
 */

export interface ProCommand {
  /** Top-level command name `@ix/pro` registers. */
  readonly name: string;
  /** One-line description, shown by the OSS stub's `--help`. */
  readonly description: string;
  /** The MCP tool that runs this command, when there is one. */
  readonly mcpTool?: string;
}

export const PRO_COMMANDS = [
  { name: "briefing", description: "Session-resume briefing", mcpTool: "ix_briefing" },
  { name: "bug", description: "Manage bugs" },
  // `decisions` before `decide`: the MCP Pro tools are advertised in table order,
  // and `ix_decisions` has always come first.
  { name: "decisions", description: "List recorded design decisions", mcpTool: "ix_decisions" },
  { name: "decide", description: "Record a design decision", mcpTool: "ix_decide" },
  { name: "goal", description: "Manage project goals" },
  // `patches` is deliberately absent: ix-cli owns the real implementation
  // (commands/patches.ts, registered by `registerOssCommands` in oss.ts and
  // listed in oss-table.ts). A stub for it shadowed a working command — #371.
  { name: "plan", description: "Manage plans and plan tasks" },
  { name: "plans", description: "List all plans" },
  { name: "task", description: "Manage tasks" },
  { name: "tasks", description: "List all tasks across plans" },
  { name: "truth", description: "Manage project intents (truth)" },
  { name: "workflow", description: "Attach, show, validate, or run staged workflows" },
] as const satisfies readonly ProCommand[];

/**
 * Pro command names that no longer exist, mapped to the form that replaced
 * them. The first word of the replacement must be a current Pro command.
 */
export const PRO_RETIRED: Readonly<Record<string, string>> = {
  // Ix-pro#103 collapsed `ix goals` into `ix goal list`.
  goals: "goal list",
  // Ix-pro#108 collapsed `ix bugs` into `ix bug list`.
  bugs: "bug list",
};

type ProMcpToolName = Extract<(typeof PRO_COMMANDS)[number], { mcpTool: string }>["mcpTool"];

/** Current Pro command names, in table order. */
export const PRO_COMMAND_NAMES: readonly string[] = PRO_COMMANDS.map((c) => c.name);

/** MCP tools that need Pro, in table order. */
export const PRO_MCP_TOOL_NAMES: readonly ProMcpToolName[] = PRO_COMMANDS.flatMap((c) =>
  "mcpTool" in c ? [c.mcpTool] : [],
);

/**
 * Marks a command object as an OSS stub for a Pro command, so a caller can
 * tell "Pro registered `plan`" from "the stub for `plan` is registered".
 */
export const PRO_STUB = Symbol.for("ix.proStub");

/** True when `command` is the OSS stand-in registered by `registerProStubs`. */
export function isProStub(command: object): boolean {
  return (command as Record<symbol, unknown>)[PRO_STUB] === true;
}

/**
 * True when `@ix/pro` registered its commands on `program`: some current Pro
 * command name is present and is not an OSS stub.
 */
export function proCommandsRegistered(program: { commands: readonly { name(): string }[] }): boolean {
  const names = new Set(PRO_COMMAND_NAMES);
  return program.commands.some((c) => names.has(c.name()) && !isProStub(c));
}
