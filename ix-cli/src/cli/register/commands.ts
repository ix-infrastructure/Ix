// Copyright 2026 Ix Infrastructure Inc.

/**
 * Every OSS command, described once.
 *
 * Three things are built from this list and nothing else:
 *
 * - `OSS_COMMAND_TABLE` (`register/oss-table.ts`): which module to load for a
 *   command name or alias, so the CLI can load only the command being run.
 * - `registerOssCommands()` (`register/oss.ts`): every module's registration,
 *   in this order.
 * - The root help (`help-text.ts`): each entry's `help` lines, placed by
 *   `ROOT_HELP_SECTIONS`.
 *
 * To add a command, write `commands/<name>.ts` with a `register…Command`
 * function, add an entry below, and put its help line's name in a section.
 * See "Adding a command" in CONTRIBUTING.md.
 *
 * Only dynamic imports here: `help-text.ts` and the startup fast path read this
 * module on every call, and a static import of a command module would load it,
 * and everything it imports, whether or not that command runs.
 */

import type { Command } from "commander";

export type RegisterCommand = (program: Command) => void;

/** One line of `ix --help`. */
export interface HelpLine {
  /** The command and its arguments as shown, e.g. `callers <symbol>`. Its first word is the command's name. */
  readonly usage: string;
  readonly summary: string;
}

export interface OssCommandEntry {
  /**
   * Every top-level name and alias the module registers, its first command's
   * name first. A module that registers two commands (`callers` and
   * `callees`) or an alias (`overrides`, `implementations`) lists them all,
   * so the fast path can find the module by any of them.
   */
  readonly names: readonly string[];
  /** The module's registration function, loaded on demand. */
  readonly load: () => Promise<RegisterCommand>;
  /**
   * Its lines in `ix --help`. Absent for a command that is deliberately left
   * out: deprecated (`query`, `init`), or not one people run (`help`, `hook`).
   */
  readonly help?: readonly HelpLine[];
}

/**
 * In registration order, which is the order commander keeps them in. Keep a
 * new entry at the end: an extension package registers its commands after
 * these, and a name both register goes to whichever registered first.
 */
export const OSS_COMMANDS: readonly OssCommandEntry[] = [
  {
    names: ["query"],
    load: async () => (await import("../commands/query.js")).registerQueryCommand,
  },
  {
    names: ["ingest"],
    load: async () => (await import("../commands/ingest.js")).registerIngestCommand,
    help: [{ usage: "ingest [path]", summary: "Ingest files or GitHub data" }],
  },
  {
    names: ["search"],
    load: async () => (await import("../commands/search.js")).registerSearchCommand,
    help: [{ usage: "search <term>", summary: "Search system" }],
  },
  {
    names: ["status"],
    load: async () => (await import("../commands/status.js")).registerStatusCommand,
    help: [{ usage: "status", summary: "Check status" }],
  },
  {
    names: ["entity"],
    load: async () => (await import("../commands/entity.js")).registerEntityCommand,
    help: [{ usage: "entity <id>", summary: "Entity details" }],
  },
  {
    names: ["history"],
    load: async () => (await import("../commands/history.js")).registerHistoryCommand,
    help: [{ usage: "history <target>", summary: "Show history" }],
  },
  {
    names: ["conflicts"],
    load: async () => (await import("../commands/conflicts.js")).registerConflictsCommand,
    help: [{ usage: "conflicts", summary: "Detected conflicts" }],
  },
  {
    names: ["diff"],
    load: async () => (await import("../commands/diff.js")).registerDiffCommand,
    help: [{ usage: "diff <from> <to>", summary: "Compare changes" }],
  },
  {
    names: ["init"],
    load: async () => (await import("../commands/init.js")).registerInitCommand,
  },
  {
    names: ["text"],
    load: async () => (await import("../commands/text.js")).registerTextCommand,
    help: [{ usage: "text <term>", summary: "Search text (ripgrep)" }],
  },
  {
    names: ["locate"],
    load: async () => (await import("../commands/locate.js")).registerLocateCommand,
    help: [{ usage: "locate <symbol>", summary: "Find definition" }],
  },
  {
    names: ["explain"],
    load: async () => (await import("../commands/explain.js")).registerExplainCommand,
    help: [{ usage: "explain <symbol>", summary: "Explain behavior" }],
  },
  {
    names: ["callers", "callees"],
    load: async () => (await import("../commands/callers.js")).registerCallersCommand,
    help: [
      { usage: "callers <symbol>", summary: "Who calls it" },
      { usage: "callees <symbol>", summary: "What it calls" },
    ],
  },
  {
    names: ["overrides", "implementations"],
    load: async () => (await import("../commands/overrides.js")).registerOverridesCommand,
    help: [{ usage: "overrides <symbol>", summary: "Its overrides and bases" }],
  },
  {
    names: ["imports", "imported-by"],
    load: async () => (await import("../commands/imports.js")).registerImportsCommand,
    help: [
      { usage: "imports <target>", summary: "What it imports" },
      { usage: "imported-by <target>", summary: "What imports it" },
    ],
  },
  {
    names: ["contains"],
    load: async () => (await import("../commands/contains.js")).registerContainsCommand,
    help: [{ usage: "contains <target>", summary: "Its members" }],
  },
  {
    names: ["stats"],
    load: async () => (await import("../commands/stats.js")).registerStatsCommand,
    help: [{ usage: "stats", summary: "Show stats" }],
  },
  {
    names: ["doctor"],
    load: async () => (await import("../commands/doctor.js")).registerDoctorCommand,
    help: [{ usage: "doctor", summary: "Diagnose issues" }],
  },
  {
    names: ["depends"],
    load: async () => (await import("../commands/depends.js")).registerDependsCommand,
    help: [{ usage: "depends <target>", summary: "Upstream dependents" }],
  },
  {
    names: ["read"],
    load: async () => (await import("../commands/read.js")).registerReadCommand,
    help: [{ usage: "read <target>", summary: "Read source" }],
  },
  {
    names: ["inventory"],
    load: async () => (await import("../commands/inventory.js")).registerInventoryCommand,
    help: [{ usage: "inventory", summary: "List components" }],
  },
  {
    names: ["impact"],
    load: async () => (await import("../commands/impact.js")).registerImpactCommand,
    help: [{ usage: "impact <target>", summary: "Analyze impact" }],
  },
  {
    names: ["rank"],
    load: async () => (await import("../commands/rank.js")).registerRankCommand,
    help: [{ usage: "rank", summary: "Rank importance" }],
  },
  {
    names: ["overview"],
    load: async () => (await import("../commands/overview.js")).registerOverviewCommand,
    help: [{ usage: "overview <target>", summary: "Summarize structure" }],
  },
  {
    names: ["watch"],
    load: async () => (await import("../commands/watch.js")).registerWatchCommand,
    help: [{ usage: "watch", summary: "Watch changes" }],
  },
  {
    names: ["docker"],
    load: async () => (await import("../commands/docker.js")).registerDockerCommand,
    help: [{ usage: "docker <action>", summary: "Manage backend" }],
  },
  {
    names: ["help"],
    load: async () => (await import("../commands/workflows.js")).registerWorkflowsHelpCommand,
  },
  {
    names: ["map"],
    load: async () => (await import("../commands/map.js")).registerMapCommand,
    help: [{ usage: "map [path]", summary: "Map system" }],
  },
  {
    names: ["smells"],
    load: async () => (await import("../commands/smells.js")).registerSmellsCommand,
    help: [{ usage: "smells", summary: "Detect issues" }],
  },
  {
    names: ["subsystems"],
    load: async () => (await import("../commands/subsystems.js")).registerSubsystemsCommand,
    help: [{ usage: "subsystems", summary: "Explore structure" }],
  },
  {
    names: ["reset"],
    load: async () => (await import("../commands/reset.js")).registerResetCommand,
    help: [{ usage: "reset", summary: "Reset map" }],
  },
  {
    names: ["config"],
    load: async () => (await import("../commands/config.js")).registerConfigCommand,
    help: [{ usage: "config", summary: "Update config" }],
  },
  {
    names: ["trace"],
    load: async () => (await import("../commands/trace.js")).registerTraceCommand,
    help: [{ usage: "trace <symbol>", summary: "Trace flow" }],
  },
  {
    names: ["upgrade"],
    load: async () => (await import("../commands/upgrade.js")).registerUpgradeCommand,
    help: [{ usage: "upgrade", summary: "Update ix" }],
  },
  {
    names: ["view"],
    load: async () => (await import("../commands/view.js")).registerViewCommand,
    help: [{ usage: "view", summary: "Open visualizer" }],
  },
  {
    names: ["savings"],
    load: async () => (await import("../commands/savings.js")).registerSavingsCommand,
    help: [{ usage: "savings", summary: "Show token savings" }],
  },
  {
    names: ["patches"],
    load: async () => (await import("../commands/patches.js")).registerPatchesCommand,
    help: [{ usage: "patches", summary: "Recent patches" }],
  },
  {
    names: ["mcp"],
    load: async () => (await import("../commands/mcp.js")).registerMcpCommand,
    help: [{ usage: "mcp [install|doctor]", summary: "Serve agent tools over MCP" }],
  },
  {
    names: ["install"],
    load: async () => (await import("../commands/install.js")).registerInstallCommand,
    help: [{ usage: "install", summary: "Install the Ix skill into agent harnesses" }],
  },
  {
    names: ["context"],
    load: async () => (await import("../commands/context.js")).registerContextCommand,
    help: [{ usage: "context [target]", summary: "Bounded context bundle (start here)" }],
  },
  {
    names: ["around"],
    load: async () => (await import("../commands/around.js")).registerAroundCommand,
    help: [{ usage: "around <path:line>", summary: "Who depends on it" }],
  },
  {
    names: ["hook"],
    load: async () => (await import("../commands/hook.js")).registerHookCommand,
  },
  {
    names: ["verify"],
    load: async () => (await import("../commands/verify.js")).registerVerifyCommand,
    help: [{ usage: "verify", summary: "Compare graph to a re-parse" }],
  },
];

/**
 * Where each help line goes in `ix --help`, by the command name that starts
 * it. Separate from the entries because the help reads in task order and
 * registration order is fixed (see `OSS_COMMANDS`). A test holds the two to
 * the same set of names, so a help line left out of every section fails CI.
 */
export const ROOT_HELP_SECTIONS: readonly { readonly title: string; readonly commands: readonly string[] }[] = [
  { title: "Start", commands: ["map", "watch", "ingest", "config"] },
  {
    title: "Understand",
    commands: ["context", "search", "text", "locate", "explain", "impact", "overview", "read", "around", "smells"],
  },
  {
    title: "Explore",
    commands: [
      "callers", "callees", "overrides", "imports", "imported-by", "contains", "depends", "entity",
      "trace", "subsystems", "inventory", "rank", "history", "diff", "patches", "conflicts",
    ],
  },
  {
    title: "System",
    commands: ["status", "stats", "doctor", "verify", "mcp", "install", "docker", "view", "reset", "savings", "upgrade"],
  },
];
