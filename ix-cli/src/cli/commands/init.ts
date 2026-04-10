import type { Command } from "commander";
import chalk from "chalk";
import { bootstrap } from "../bootstrap.js";

export const IX_MARKER_START = "<!-- IX-MEMORY START -->";
export const IX_MARKER_END = "<!-- IX-MEMORY END -->";

export const IX_CLAUDE_MD_BLOCK = `${IX_MARKER_START}
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## Interface

Use the \`ix\` CLI exclusively. All commands support \`--format json\` for machine-readable output.

## MANDATORY RULES
1. BEFORE answering codebase questions → use targeted \`ix\` CLI commands (see routing below). Do NOT answer from training data alone.
2. AFTER every design or architecture decision → run \`ix decide <title> --rationale <text>\`.
3. When you notice contradictory information → run \`ix conflicts\` and present results to the user.
4. NEVER guess about codebase facts — if Ix has structured data, use it.
5. IMMEDIATELY after modifying code → run \`ix ingest <path>\` on changed files.
6. When the user states a goal → run \`ix truth add "<statement>"\`.

## Ix CLI Command Routing

Use bounded, composable CLI commands — never broad queries.

### Finding & Understanding Code
- \`ix search <term>\` — find entities by name (\`--kind class --limit 10\`)
- \`ix explain <symbol>\` — structure, container, history, calls
- \`ix read <target>\` — read source (\`file.py:10-50\` or symbol name)
- \`ix entity <id>\` — full entity details by ID
- \`ix text <term>\` — fast text search (\`--language python --limit 20\`)
- \`ix locate <symbol>\` — find where something lives and how it connects

### Navigating Relationships
- \`ix callers <symbol>\` — what calls a function (cross-file)
- \`ix callees <symbol>\` — what a function calls
- \`ix contains <symbol>\` — members of a class/module
- \`ix imports <symbol>\` — what an entity imports
- \`ix imported-by <symbol>\` — what imports an entity
- \`ix depends <symbol>\` — dependency impact analysis

### History & Decisions
- \`ix decisions\` — list design decisions (\`--topic ingestion\`)
- \`ix history <entityId>\` — entity provenance chain
- \`ix diff <from> <to>\` — changes between revisions
- \`ix conflicts\` — detect contradictions

### Planning & Goals
- \`ix goal create <statement>\` — create a project goal
- \`ix goal list\` — list all goals
- \`ix plan create <title> --goal <id>\` — create a plan linked to a goal
- \`ix plan task <title> --plan <id>\` — add a task to a plan
- \`ix plan next <plan-id>\` — get the next actionable task
- \`ix task update <id> --status done\` — update task status
- \`ix decide <title> --rationale <text> --affects <entities>\` — record a linked decision

### Best practices
- Use \`--kind\` and \`--limit\` to constrain results
- Use \`--format json\` when chaining command results
- Use \`--path\` or \`--language\` to restrict text searches
- Use exact entity IDs from previous JSON results
- Decompose large questions into multiple targeted calls

## Do NOT Use
- \`ix query\` — deprecated, oversized low-signal responses
- Broad repo-wide inventory queries

## Confidence Scores
Ix returns confidence scores with results. When data has low confidence:
- Mention the uncertainty to the user
- Suggest re-ingesting the relevant files
- Never present low-confidence data as established fact
${IX_MARKER_END}`;

/** @deprecated Use `ix map .` — bootstrap is now automatic. */
export function registerInitCommand(program: Command): void {
  const cmd = program
    .command("init")
    .description("(deprecated) Initialize Ix — use ix map . instead")
    .action(async () => {
      try {
        await bootstrap();
        console.log(chalk.green("✓") + " Ix is ready. Run " + chalk.bold("ix map .") + " to get started.");
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
      }
    });

  // Hide from default help — no longer the recommended entrypoint
  (cmd as any).hidden = true;
}
