#!/usr/bin/env node
import { Command } from "commander";
import { registerQueryCommand } from "./commands/query.js";
import { registerIngestCommand } from "./commands/ingest.js";
import { registerDecideCommand } from "./commands/decide.js";
import { registerDecisionsCommand } from "./commands/decisions.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerTruthCommand } from "./commands/truth.js";
import { registerPatchesCommand } from "./commands/patches.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerEntityCommand } from "./commands/entity.js";
import { registerHistoryCommand } from "./commands/history.js";
import { registerConflictsCommand } from "./commands/conflicts.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerInitCommand } from "./commands/init.js";
import { registerTextCommand } from "./commands/text.js";
import { registerLocateCommand } from "./commands/locate.js";
import { registerExplainCommand } from "./commands/explain.js";
import { registerCallersCommand } from "./commands/callers.js";
import { registerImportsCommand } from "./commands/imports.js";
import { registerContainsCommand } from "./commands/contains.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDependsCommand } from "./commands/depends.js";
import { registerReadCommand } from "./commands/read.js";
import { registerInventoryCommand } from "./commands/inventory.js";
import { registerImpactCommand } from "./commands/impact.js";
import { registerRankCommand } from "./commands/rank.js";
import { registerOverviewCommand } from "./commands/overview.js";
import { registerGoalCommand } from "./commands/goal.js";
import { registerPlanCommand, registerTaskCommand } from "./commands/plan.js";
import { registerBugCommand } from "./commands/bug.js";
import { registerBugsCommand } from "./commands/bugs.js";
import { registerPlansCommand } from "./commands/plans.js";
import { registerWatchCommand } from "./commands/watch.js";
import { registerBriefingCommand } from "./commands/briefing.js";
import { registerWorkflowsHelpCommand } from "./commands/workflows.js";
import { registerWorkflowCommand } from "./commands/workflow.js";
import { registerTasksCommand } from "./commands/tasks.js";
import { registerGoalsCommand } from "./commands/goals.js";
import { registerDockerCommand } from "./commands/docker.js";

const HELP_HEADER = `
Workflow Commands (start here):
  briefing              Session-resume briefing
  overview <target>     One-shot structural summary
  impact <target>       Blast-radius / dependency analysis
  rank                  Hotspot discovery by metric
  inventory             List entities by kind

Planning & Tracking:
  plan                  Manage plans (create, task, status, next)
  task                  Manage tasks (show, update)
  tasks                 List all tasks across plans
  workflow              Attach, show, validate, or run staged workflows
  bug                   Manage bugs (create, show, update)
  bugs                  List bugs
  decide <title>        Record a design decision
  goal                  Manage project goals
  goals                 List all goals

Core Graph / Code Commands:
  read <target>         Read file content or symbol source code
  search <term>         Search the knowledge graph by term
  locate <symbol>       Resolve symbol to definition with context
  contains <symbol>     Show members of a class/module/file
  callers <symbol>      Show callers of a function/method
  callees <symbol>      Show callees of a function/method
  imports <symbol>      Show what an entity imports
  imported-by <symbol>  Show what imports an entity
  depends <symbol>      Show reverse dependencies
  entity <id>           Get entity details with claims and edges
  explain <symbol>      Explain an entity with history

Infrastructure:
  docker start          Start the IX backend (ArangoDB + Memory Layer)
  docker stop           Stop the backend (--remove-data to wipe volumes)
  docker status         Show container and health status
  docker logs           Tail backend logs
  docker restart        Restart backend containers

Diagnostics / State / History:
  ingest [path]         Ingest source files or GitHub data
  status                Show backend health
  stats                 Show graph statistics
  doctor                Check system health
  history <entityId>    Show entity provenance chain
  diff <from> <to>      Show diff between revisions
  truth                 Manage project intents
  text <term>           Fast lexical/text search (ripgrep)

Use "ix help workflows" for the recommended development loop.
Use "ix <command> --help" for details on any command.
`;

const program = new Command();
program
  .name("ix")
  .description("Ix Memory — Persistent Memory for LLM Systems")
  .version("0.1.0")
  .addHelpText("before", HELP_HEADER);

registerQueryCommand(program);
registerIngestCommand(program);
registerDecideCommand(program);
registerDecisionsCommand(program);
registerSearchCommand(program);
registerTruthCommand(program);
registerPatchesCommand(program);
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
registerGoalCommand(program);
registerPlanCommand(program);
registerTaskCommand(program);
registerBugCommand(program);
registerBugsCommand(program);
registerPlansCommand(program);
registerWatchCommand(program);
registerBriefingCommand(program);
registerWorkflowCommand(program);
registerWorkflowsHelpCommand(program);
registerTasksCommand(program);
registerGoalsCommand(program);
registerDockerCommand(program);

program.parse();
