// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { applyOssSetup } from "./oss-setup.js";
import { proIsAbsent } from "./pro-loader.js";

/**
 * Which module registers each OSS command, so the CLI can load only the one
 * being run.
 *
 * `registerOssCommands()` (`register/oss.ts`) imports all ~40 command modules
 * and everything they depend on: ~100 ms on every call, `--version` included,
 * before the command does anything. Agents and plugin hooks call `ix` far more
 * often than a person does, and compare it with `rg`, which has answered by
 * then. So `run-cli.ts` asks `planStartup` first and, where it can, registers
 * the one command instead.
 *
 * Keyed by every top-level name and alias `registerOssCommands()` registers;
 * a module that registers two commands (`callers` and `callees`) appears under
 * both. A test holds this table and `registerOssCommands()` to the same set of
 * names, so a command added there and not here fails CI rather than silently
 * taking the slow path.
 */
type RegisterCommand = (program: Command) => void;

export const OSS_COMMAND_TABLE: Readonly<Record<string, () => Promise<RegisterCommand>>> = {
  query: async () => (await import("../commands/query.js")).registerQueryCommand,
  ingest: async () => (await import("../commands/ingest.js")).registerIngestCommand,
  search: async () => (await import("../commands/search.js")).registerSearchCommand,
  status: async () => (await import("../commands/status.js")).registerStatusCommand,
  entity: async () => (await import("../commands/entity.js")).registerEntityCommand,
  history: async () => (await import("../commands/history.js")).registerHistoryCommand,
  conflicts: async () => (await import("../commands/conflicts.js")).registerConflictsCommand,
  diff: async () => (await import("../commands/diff.js")).registerDiffCommand,
  init: async () => (await import("../commands/init.js")).registerInitCommand,
  text: async () => (await import("../commands/text.js")).registerTextCommand,
  locate: async () => (await import("../commands/locate.js")).registerLocateCommand,
  explain: async () => (await import("../commands/explain.js")).registerExplainCommand,
  callers: async () => (await import("../commands/callers.js")).registerCallersCommand,
  callees: async () => (await import("../commands/callers.js")).registerCallersCommand,
  imports: async () => (await import("../commands/imports.js")).registerImportsCommand,
  "imported-by": async () => (await import("../commands/imports.js")).registerImportsCommand,
  contains: async () => (await import("../commands/contains.js")).registerContainsCommand,
  stats: async () => (await import("../commands/stats.js")).registerStatsCommand,
  doctor: async () => (await import("../commands/doctor.js")).registerDoctorCommand,
  depends: async () => (await import("../commands/depends.js")).registerDependsCommand,
  read: async () => (await import("../commands/read.js")).registerReadCommand,
  inventory: async () => (await import("../commands/inventory.js")).registerInventoryCommand,
  impact: async () => (await import("../commands/impact.js")).registerImpactCommand,
  rank: async () => (await import("../commands/rank.js")).registerRankCommand,
  overview: async () => (await import("../commands/overview.js")).registerOverviewCommand,
  watch: async () => (await import("../commands/watch.js")).registerWatchCommand,
  docker: async () => (await import("../commands/docker.js")).registerDockerCommand,
  help: async () => (await import("../commands/workflows.js")).registerWorkflowsHelpCommand,
  map: async () => (await import("../commands/map.js")).registerMapCommand,
  smells: async () => (await import("../commands/smells.js")).registerSmellsCommand,
  subsystems: async () => (await import("../commands/subsystems.js")).registerSubsystemsCommand,
  reset: async () => (await import("../commands/reset.js")).registerResetCommand,
  config: async () => (await import("../commands/config.js")).registerConfigCommand,
  trace: async () => (await import("../commands/trace.js")).registerTraceCommand,
  upgrade: async () => (await import("../commands/upgrade.js")).registerUpgradeCommand,
  view: async () => (await import("../commands/view.js")).registerViewCommand,
  savings: async () => (await import("../commands/savings.js")).registerSavingsCommand,
  patches: async () => (await import("../commands/patches.js")).registerPatchesCommand,
  mcp: async () => (await import("../commands/mcp.js")).registerMcpCommand,
  context: async () => (await import("../commands/context.js")).registerContextCommand,
  around: async () => (await import("../commands/around.js")).registerAroundCommand,
  hook: async () => (await import("../commands/hook.js")).registerHookCommand,
};

/**
 * Commands that read the registry itself. `ix help <topic>` looks the topic up
 * among every registered command, so it needs all of them.
 */
const NEEDS_EVERY_COMMAND = new Set(["help"]);

/** Set to `1` to register every command, as before the table existed. */
export const LOAD_ALL_COMMANDS_ENV = "IX_LOAD_ALL_COMMANDS";

export type StartupPlan =
  | { kind: "all" }
  | { kind: "version" }
  | { kind: "command"; name: string; load: () => Promise<RegisterCommand> };

/**
 * How much of the command registry this invocation needs. `args` is argv
 * without the node and script paths.
 *
 * Only two shapes get less than everything, and only with Pro absent:
 *
 * - `ix --version` / `ix -V` alone: no command at all.
 * - `ix <name> ...` where `<name>` is the first token and in the table: that
 *   command's module.
 *
 * Everything else registers all of them, because commander needs the whole
 * list to answer it: root help (`ix`, `ix --help`, `ix help ...`), an unknown
 * word ("did you mean"), a Pro command or stub, or an option before the
 * command word. With Pro installed it is always everything: Pro registers
 * against the same program after OSS and can collide with an OSS name
 * (`patches`), where whichever registered first wins.
 */
export function planStartup(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  isProAbsent: () => boolean = proIsAbsent,
): StartupPlan {
  if (env[LOAD_ALL_COMMANDS_ENV] === "1") return { kind: "all" };
  const word = args[0];
  if (word === undefined) return { kind: "all" };
  const versionOnly = args.length === 1 && (word === "--version" || word === "-V");
  const known = !NEEDS_EVERY_COMMAND.has(word) && Object.hasOwn(OSS_COMMAND_TABLE, word);
  if (!versionOnly && !known) return { kind: "all" };
  // Last: the only check here that touches the filesystem.
  if (!isProAbsent()) return { kind: "all" };
  return versionOnly ? { kind: "version" } : { kind: "command", name: word, load: OSS_COMMAND_TABLE[word] };
}

/**
 * Register what `plan` calls for on `program`, with the same per-command setup
 * `registerOssCommands()` applies. True when that was less than every command
 * -- which `planStartup` only allows with Pro absent.
 */
export async function registerForPlan(program: Command, plan: StartupPlan): Promise<boolean> {
  if (plan.kind === "all") {
    const { registerOssCommands } = await import("./oss.js");
    registerOssCommands(program);
    return false;
  }
  if (plan.kind === "command") (await plan.load())(program);
  applyOssSetup(program);
  return true;
}
