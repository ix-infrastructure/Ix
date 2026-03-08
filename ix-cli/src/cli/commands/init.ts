import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint, loadConfig, saveConfig, type WorkspaceConfig } from "../config.js";

export const IX_MARKER_START = "<!-- IX-MEMORY START -->";
export const IX_MARKER_END = "<!-- IX-MEMORY END -->";

export const IX_CLAUDE_MD_BLOCK = `${IX_MARKER_START}
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## Interface

Use the \`ix\` CLI exclusively. Do NOT use MCP tools — the CLI is the canonical agent interface.
All commands support \`--format json\` for machine-readable output.

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
- \`ix locate <symbol>\` — find symbol via graph + text

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

### Best practices
- Use \`--kind\` and \`--limit\` to constrain results
- Use \`--format json\` when chaining command results
- Use \`--path\` or \`--language\` to restrict text searches
- Use exact entity IDs from previous JSON results
- Decompose large questions into multiple targeted calls

## Do NOT Use
- \`ix query\` — deprecated, oversized low-signal responses
- MCP tools — deprecated, use CLI instead
- Broad repo-wide inventory queries

## Confidence Scores
Ix returns confidence scores with results. When data has low confidence:
- Mention the uncertainty to the user
- Suggest re-ingesting the relevant files
- Never present low-confidence data as established fact
${IX_MARKER_END}`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Ix in the current project")
    .option("--force", "Overwrite existing CLAUDE.md")
    .action(async (opts: { force?: boolean }) => {
      console.log("Initializing Ix Memory...\n");

      // 1. Check backend health
      const client = new IxClient(getEndpoint());
      try {
        await client.health();
        console.log("  [ok] Backend is running at " + getEndpoint());
      } catch {
        console.error("  [!!] Backend not reachable at " + getEndpoint());
        console.error("       Run ./stack.sh first, or set IX_ENDPOINT.");
        process.exit(1);
      }

      // 2. Create ~/.ix/config.yaml
      const configDir = join(homedir(), ".ix");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.yaml"),
        `endpoint: ${getEndpoint()}\nformat: text\n`
      );
      console.log("  [ok] Created ~/.ix/config.yaml");

      // 2b. Register workspace
      const rootPath = resolve(process.cwd());
      const workspaceName = basename(rootPath);

      const config = loadConfig();
      const existingWorkspaces = config.workspaces ?? [];
      const alreadyRegistered = existingWorkspaces.find(w => w.root_path === rootPath);

      if (alreadyRegistered) {
        console.log(`  [ok] Workspace already registered: ${alreadyRegistered.workspace_name} (${alreadyRegistered.workspace_id})`);
      } else {
        const hasDefault = existingWorkspaces.some(w => w.default);
        const newWs: WorkspaceConfig = {
          workspace_id: randomUUID().slice(0, 8),
          workspace_name: workspaceName,
          root_path: rootPath,
          default: !hasDefault,
        };

        if (hasDefault) {
          const defaultWs = existingWorkspaces.find(w => w.default)!;
          console.log(`\n  A default workspace already exists:`);
          console.log(`    ${defaultWs.workspace_name} at ${defaultWs.root_path}`);
          console.log(`  New workspace: ${workspaceName} at ${rootPath}`);
          console.log(`  (Set as non-default. Use 'ix init --set-default' to change.)\n`);
        }

        config.workspaces = [...existingWorkspaces, newWs];
        saveConfig(config);
        console.log(`  [ok] Registered workspace: ${workspaceName} (${newWs.workspace_id})`);
      }

      // 3. Add IX block to CLAUDE.md (using markers for clean add/remove)
      if (existsSync("CLAUDE.md")) {
        const existing = await readFile("CLAUDE.md", "utf-8");
        if (existing.includes(IX_MARKER_START)) {
          if (opts.force) {
            // Replace existing IX block
            const re = new RegExp(`${IX_MARKER_START}[\\s\\S]*?${IX_MARKER_END}`, "g");
            await writeFile("CLAUDE.md", existing.replace(re, IX_CLAUDE_MD_BLOCK));
            console.log("  [ok] Updated Ix rules in CLAUDE.md");
          } else {
            console.log("  [ok] CLAUDE.md already contains Ix rules (use --force to replace)");
          }
        } else {
          // Append IX block to existing CLAUDE.md
          await writeFile("CLAUDE.md", existing.trimEnd() + "\n\n" + IX_CLAUDE_MD_BLOCK + "\n");
          console.log("  [ok] Appended Ix rules to CLAUDE.md");
        }
      } else {
        await writeFile("CLAUDE.md", IX_CLAUDE_MD_BLOCK + "\n");
        console.log("  [ok] Created CLAUDE.md with Ix rules");
      }

      console.log("\nIx Memory initialized.");
      console.log("Next: run 'ix ingest ./src --recursive' to ingest your codebase.");
    });
}
