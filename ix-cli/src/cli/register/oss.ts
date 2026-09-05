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
import { validateCliOptions } from "../options.js";

const PRO_COMMANDS: { name: string; desc: string }[] = [
  { name: "briefing", desc: "Session-resume briefing" },
  { name: "bug", desc: "Manage bugs" },
  { name: "decide", desc: "Record a design decision" },
  { name: "decisions", desc: "List recorded design decisions" },
  { name: "goal", desc: "Manage project goals" },
  { name: "goals", desc: "List all goals" },
  // `patches` is deliberately absent: ix-cli owns the real implementation
  // (commands/patches.ts, registered above). It sat in this list while never
  // being registered, so `ix patches` answered "requires Ix Pro" on OSS and
  // shadowed a working command — see #371.
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

const DEFAULT_FORMAT_CHOICES = ["text", "json", "llm"];
const OPTION_CHOICES: Record<string, Record<string, string[]>> = {
  query: { depth: ["shallow", "standard", "deep"], format: ["text", "json"] },
  map: { format: [...DEFAULT_FORMAT_CHOICES, "silent"], sort: ["importance", "confidence", "size", "alpha"] },
  subsystems: { sort: ["importance", "confidence", "size", "alpha"] },
  savings: { model: ["opus", "sonnet", "haiku", "gpt-4o"] },
  context: { depth: ["compact", "standard", "full", "shallow", "deep"] },
};

/**
 * Every command this file registered, so the preAction hook below can tell an
 * OSS option from a Pro one. Pro commands are registered later, against the
 * same root program, from a package this repo cannot see -- so their option
 * domains are not ours to infer.
 */
const ossCommands = new WeakSet<Command>();

function configureOssOptionChoices(root: Command): void {
  const visit = (command: Command): void => {
    ossCommands.add(command);
    const commandChoices = OPTION_CHOICES[command.name()] ?? {};
    for (const option of command.options) {
      const choices = commandChoices[option.attributeName()]
        ?? (option.long === "--format" ? DEFAULT_FORMAT_CHOICES : undefined);
      if (choices) option.choices(choices);
    }
    for (const child of command.commands) visit(child);
  };
  visit(root);
}

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

  configureOssOptionChoices(program);

  program.hook("preAction", (_thisCommand, actionCommand) => {
    // OSS commands only. The rules below read an option's *shape* -- `<n>`
    // means a non-negative integer, `--min-confidence` means 0..1 -- which is
    // a claim about commands whose declarations live in this repo. A Pro
    // command declaring `--threshold <n>` for a float would be rejected by a
    // rule its author never opted into, and no test here could catch it.
    if (!ossCommands.has(actionCommand)) return;
    validateCliOptions(actionCommand);
  });

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
      // Swallow whatever the caller passed. `allowUnknownOption` alone only
      // covers flags; commander still rejects excess *operands*, and it does so
      // before the action runs. So `ix bug` reached this message but
      // `ix bug create "title" --affects Entity` — the form the docs and every
      // agent actually use — died with "too many arguments for 'bug'" and never
      // said anything about Pro. The subcommand and its arguments are
      // deliberately ignored: the only thing worth saying here is that the
      // whole command needs Pro.
      .argument("[args...]")
      .allowUnknownOption(true)
      .allowExcessArguments(true)
      .action(() => {
        console.error(`The '${name}' command requires Ix Pro.`);
        console.error(`Install @ix/pro to enable premium features.`);
        process.exitCode = 1;
      });
    (stub as any).hidden = true;
  }
}
