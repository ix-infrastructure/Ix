import type { Command } from "commander";

const WORKFLOWS_TEXT = `
Recommended Development Loop:

  1. ix briefing                          Resume context
  2. ix overview <target>                 Understand a component
  3. ix impact <target>                   Check blast radius before changes
  4. ix rank --by callers --kind method   Find hotspots
  5. ix plan next <id> --with-workflow    Get next task with commands

Staged Workflows:
  A workflow is a staged sequence of Ix commands attached to a task/plan/decision.
  It is NOT a goal, plan, task, or bug — those are developer-cycle objects that may HAVE workflows.

  Stages: discover → implement → validate

  Attach a workflow from a file:
    ix workflow attach task <id> --file /path/to/workflow.json
    ix workflow attach plan <id> --file /path/to/workflow.json

  Or inline when creating a task:
    ix plan task "Step 1" --plan <id> --workflow-staged '{"discover":["ix overview X"]}'

  ix workflow show task <id>              Show workflow on a task
  ix workflow show plan <id>              Show workflow on a plan
  ix workflow validate task <id>          Validate workflow structure
  ix workflow run task <id>               Run all workflow stages
  ix workflow run task <id> --stage discover   Run one stage

Bug Workflow:
  ix bugs --status open                   See open bugs
  ix bug show <id>                        Get bug details
  ix plan create "Fix X" --goal <id> --responds-to <bugId>
  ix plan task "Step 1" --plan <id> --resolves <bugId>

Decision Recording:
  ix decide "Use X" --rationale "..." --affects Entity

Task Listing:
  ix tasks                                List all tasks
  ix tasks --status pending               Only pending tasks
  ix tasks --plan <id>                    Tasks in a specific plan
`;

const ADVANCED_TEXT = `
Advanced (low-level graph commands):
  contains <symbol>     Show members of a class/module/file
  callers <symbol>      Show callers of a function/method
  callees <symbol>      Show callees of a function/method
  imports <symbol>      Show what an entity imports
  imported-by <symbol>  Show what imports an entity
  depends <symbol>      Show reverse dependencies
  entity <id>           Get entity details with claims and edges
  text <term>           Fast lexical/text search (ripgrep)
  conflicts             Detect contradictory information
  query <nql>           Raw NQL graph query (deprecated)

Use "ix <command> --help" for details on any command.
`;

export function registerWorkflowsHelpCommand(program: Command): void {
  const help = program
    .command("help [topic]")
    .description("Additional help topics")
    .action((topic: string | undefined) => {
      if (!topic) {
        // ix help — call our overridden helpInformation() directly
        console.log(program.helpInformation());
        return;
      }

      if (topic === "workflows" || topic === "workflow") {
        console.log(WORKFLOWS_TEXT);
        return;
      }

      if (topic === "advanced") {
        console.log(ADVANCED_TEXT);
        return;
      }

      // "goals" → forward to "goal" command help
      if (topic === "goals") {
        const goalCmd = program.commands.find(
          (c: Command) => c.name() === "goal"
        );
        if (goalCmd) {
          goalCmd.outputHelp();
          return;
        }
      }

      // Look up the topic as a registered command and show its help
      const cmd = program.commands.find(
        (c: Command) => c.name() === topic
      );
      if (cmd) {
        cmd.outputHelp();
      } else {
        console.error(`Unknown help topic: "${topic}". Try "ix --help" for available commands.`);
        process.exitCode = 1;
      }
    });
}
