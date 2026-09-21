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
import { validateCliOptions } from "../options.js";
import { setPrettyJson } from "../format.js";
import { setOutputShape } from "../output-shape.js";
import {
  BUILT_IN_DEFAULT_FORMAT,
  DEFAULT_FORMAT_CHOICES,
  resolveDefaultFormat,
} from "../default-format.js";
import { loadConfig } from "../config.js";
import { stderrDim } from "../stderr.js";

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

const OPTION_CHOICES: Record<string, Record<string, string[]>> = {
  query: { depth: ["shallow", "standard", "deep"], format: ["text", "json"] },
  map: { format: [...DEFAULT_FORMAT_CHOICES, "silent"], sort: ["importance", "confidence", "size", "alpha"] },
  subsystems: { sort: ["importance", "confidence", "size", "alpha"] },
  savings: { model: ["opus", "sonnet", "haiku", "gpt-4o"] },
  context: { depth: ["compact", "standard", "full", "shallow", "deep"] },
  mcp: { tools: ["core", "all"] },
};

/**
 * Every command this file registered, so the preAction hook below can tell an
 * OSS option from a Pro one. Pro commands are registered later, against the
 * same root program, from a package this repo cannot see -- so their option
 * domains are not ours to infer.
 */
const ossCommands = new WeakSet<Command>();

function configureOssOptions(root: Command): void {
  const { format: defaultFormat, ignored } = resolveDefaultFormat(
    process.env,
    // Never let an unreadable or half-written config.yaml stop the CLI from
    // registering its commands; loadConfig already falls back to defaults on a
    // parse error, and this covers the rest (an unresolvable IX_HOME).
    () => { try { return loadConfig().format; } catch { return undefined; } },
  );

  // Only where a person will read it: an agent captures stderr, and one more
  // line at the top of its tool result is exactly what this change is for.
  if (ignored && process.stderr.isTTY) {
    stderrDim(
      `Ignoring ${ignored.source}=${ignored.value}: not one of ` +
      `${DEFAULT_FORMAT_CHOICES.join(", ")}. Using ${defaultFormat}.`
    );
  }

  const visit = (command: Command): void => {
    ossCommands.add(command);
    const commandChoices = OPTION_CHOICES[command.name()] ?? {};
    let rendersRows = false;
    let rendersJson = false;
    for (const option of command.options) {
      const choices = commandChoices[option.attributeName()]
        ?? (option.long === "--format" ? [...DEFAULT_FORMAT_CHOICES] : undefined);
      if (choices) option.choices(choices);
      applyDefaultFormat(command, option, choices, defaultFormat);
      if (option.long === "--format") rendersRows = true;
      if (option.long === "--format" && (choices ?? []).includes("json")) rendersJson = true;
    }
    // Declared here rather than 32 times by hand, and only where it means
    // something: a command with no `--format json` has no JSON to shape.
    if (rendersJson && !command.options.some((option) => option.long === "--pretty")) {
      command.option("--pretty", "Indent JSON output (the default only when stdout is a terminal)");
    }
    // Declared here rather than on 33 commands by hand, and only where there
    // is an answer to shape. A command with no `--format` prints a status
    // line or nothing.
    if (rendersRows) {
      if (!command.options.some((option) => option.long === "--quiet")) {
        command.option("--quiet", "Drop headers, section titles and advisory hints");
      }
      if (!command.options.some((option) => option.long === "--fields")) {
        command.option("--fields <list>", "Keep only these fields on each row, in this order (e.g. name,path,lines)");
      }
    }
    for (const child of command.commands) visit(child);
  };
  visit(root);
}

/**
 * Point a `--format` option at the configured default.
 *
 * Only an option still sitting on the built-in `text` is moved: a command that
 * declares a different default has a reason for it, and `ix config set format`
 * is not an instruction to override it. The default must also be a format that
 * command accepts — `query` renders text and json only, so `IX_FORMAT=llm`
 * leaves it where it is rather than handing the renderer a format it has no
 * branch for.
 */
function applyDefaultFormat(
  command: Command,
  option: Command["options"][number],
  choices: string[] | undefined,
  defaultFormat: string,
): void {
  if (option.long !== "--format") return;
  if (defaultFormat === BUILT_IN_DEFAULT_FORMAT) return;
  if (option.defaultValue !== BUILT_IN_DEFAULT_FORMAT) return;
  if (!choices?.includes(defaultFormat)) return;

  option.default(defaultFormat);
  // `.option()` copies the default into the command's option values as it
  // registers, so moving the Option's default afterwards changes the help text
  // and nothing else. The stored value has to be moved with it -- and only
  // while it is still the default, which at registration time it always is.
  if (command.getOptionValueSource(option.attributeName()) === "default") {
    command.setOptionValueWithSource(option.attributeName(), defaultFormat, "default");
  }
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

  configureOssOptions(program);

  program.hook("preAction", (_thisCommand, actionCommand) => {
    // Before anything prints. All three are properties of the run, not of a
    // payload, so the renderers read them from one place rather than every
    // signature growing parameters it only forwards.
    const opts = actionCommand.opts();
    setPrettyJson(opts.pretty === true);
    setOutputShape({ quiet: opts.quiet === true, fields: typeof opts.fields === "string" ? opts.fields : undefined });

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
