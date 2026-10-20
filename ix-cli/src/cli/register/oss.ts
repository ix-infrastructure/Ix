// Copyright 2026 Ix Infrastructure Inc.

import type { Command } from "commander";
import { registerQueryCommand } from "../commands/query.js";
import { registerIngestCommand } from "../commands/ingest.js";
import { registerSearchCommand } from "../commands/search.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerEntityCommand } from "../commands/entity.js";
import { registerHistoryCommand } from "../commands/history.js";
import { registerConflictsCommand } from "../commands/conflicts.js";
import { registerDiffCommand } from "../commands/diff.js";
import { registerInitCommand } from "../commands/init.js";
import { registerTextCommand } from "../commands/text.js";
import { registerLocateCommand } from "../commands/locate.js";
import { registerExplainCommand } from "../commands/explain.js";
import { registerCallersCommand } from "../commands/callers.js";
import { registerImportsCommand } from "../commands/imports.js";
import { registerContainsCommand } from "../commands/contains.js";
import { registerStatsCommand } from "../commands/stats.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerDependsCommand } from "../commands/depends.js";
import { registerReadCommand } from "../commands/read.js";
import { registerInventoryCommand } from "../commands/inventory.js";
import { registerImpactCommand } from "../commands/impact.js";
import { registerRankCommand } from "../commands/rank.js";
import { registerOverviewCommand } from "../commands/overview.js";
import { registerWatchCommand } from "../commands/watch.js";
import { registerDockerCommand } from "../commands/docker.js";
import { registerWorkflowsHelpCommand } from "../commands/workflows.js";
import { registerMapCommand } from "../commands/map.js";
import { registerResetCommand } from "../commands/reset.js";
import { registerConfigCommand } from "../commands/config.js";
import { registerTraceCommand } from "../commands/trace.js";
import { registerSmellsCommand } from "../commands/smells.js";
import { registerSubsystemsCommand } from "../commands/subsystems.js";
import { registerUpgradeCommand } from "../commands/upgrade.js";
import { registerViewCommand } from "../commands/view.js";
import { registerSavingsCommand } from "../commands/savings.js";
import { registerPatchesCommand } from "../commands/patches.js";
import { registerMcpCommand } from "../commands/mcp.js";
import { registerContextCommand } from "../commands/context.js";
import { registerAroundCommand } from "../commands/around.js";
import { registerHookCommand } from "../commands/hook.js";
import { registerDaemonCommand } from "../commands/daemon.js";
import { applyOssSetup } from "./oss-setup.js";

export { registerProStubs } from "./pro-stubs.js";

/**
 * Register every OSS command on `program`, then the setup they share.
 *
 * A command added here must also go into `OSS_COMMAND_TABLE`
 * (`register/oss-table.ts`), which the CLI uses to load only the command being
 * run. One that is missing still works -- the CLI falls back to this function
 * for any name the table does not know -- but it fails a test, so it gets
 * added rather than quietly paying for all of the others on every call.
 */
export function registerOssCommands(program: Command): void {
  registerQueryCommand(program);
  registerIngestCommand(program);
  registerSearchCommand(program);
  registerStatusCommand(program);
  registerEntityCommand(program);
  registerHistoryCommand(program);
  registerConflictsCommand(program);
  registerDiffCommand(program);
  registerInitCommand(program);
  registerTextCommand(program);
  registerLocateCommand(program);
  registerExplainCommand(program);
  registerCallersCommand(program);
  registerImportsCommand(program);
  registerContainsCommand(program);
  registerStatsCommand(program);
  registerDoctorCommand(program);
  registerDependsCommand(program);
  registerReadCommand(program);
  registerInventoryCommand(program);
  registerImpactCommand(program);
  registerRankCommand(program);
  registerOverviewCommand(program);
  registerWatchCommand(program);
  registerDockerCommand(program);
  registerWorkflowsHelpCommand(program);
  registerMapCommand(program);
  registerSmellsCommand(program);
  registerSubsystemsCommand(program);
  registerResetCommand(program);
  registerConfigCommand(program);
  registerTraceCommand(program);
  registerUpgradeCommand(program);
  registerViewCommand(program);
  registerSavingsCommand(program);
  registerPatchesCommand(program);
  registerMcpCommand(program);
  registerContextCommand(program);
  registerAroundCommand(program);
  registerHookCommand(program);
  registerDaemonCommand(program);

  applyOssSetup(program);
}

