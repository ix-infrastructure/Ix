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
import { registerLoadCommand } from "../commands/load.js";

const PRO_COMMANDS: { name: string; desc: string }[] = [
  { name: "briefing", desc: "Session-resume briefing" },
  { name: "bug", desc: "Manage bugs" },
  { name: "bugs", desc: "List all bugs" },
  { name: "decide", desc: "Record a design decision" },
  { name: "decisions", desc: "List recorded design decisions" },
  { name: "goal", desc: "Manage project goals" },
  { name: "goals", desc: "List all goals" },
  { name: "patches", desc: "List recent patches" },
  { name: "plan", desc: "Manage plans and plan tasks" },
  { name: "task", desc: "Manage tasks" },
  { name: "plans", desc: "List all plans" },
  { name: "tasks", desc: "List all tasks across plans" },
  { name: "truth", desc: "Manage project intents (truth)" },
  { name: "workflow", desc: "Attach, show, validate, or run staged workflows" },
];

/** Commands hidden from default help but still callable. */
const ADVANCED_COMMANDS = [
  "contains", "callers", "callees", "imports", "imported-by",
  "depends", "entity", "text", "conflicts", "query",
  // init is deprecated; ingest is now an implementation detail
  "init", "ingest",
];

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
  registerLoadCommand(program);

  // Hide advanced commands from default help
  const advancedSet = new Set(ADVANCED_COMMANDS);
  for (const cmd of program.commands) {
    if (advancedSet.has(cmd.name())) {
      (cmd as any).hidden = true;
    }
  }
}

export function registerProStubs(program: Command): void {
  const registered = new Set(program.commands.map((c: Command) => c.name()));
  for (const { name, desc } of PRO_COMMANDS) {
    if (registered.has(name)) continue;
    const stub = program
      .command(name)
      .description(desc)
      .allowUnknownOption(true)
      .action(() => {
        console.error(`The '${name}' command requires Ix Pro.`);
        console.error(`Install @ix/pro to enable premium features.`);
        process.exitCode = 1;
      });
    (stub as any).hidden = true;
  }
}
