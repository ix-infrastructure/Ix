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

## MANDATORY RULES
1. BEFORE answering codebase questions → use targeted Ix tools (see Command Routing below). Do NOT answer from training data alone.
2. AFTER every design or architecture decision → call \`ix_decide\` with both the conclusion AND the reasoning.
3. When you notice contradictory information → call \`ix_conflicts\` and present conflicts to the user before continuing.
4. NEVER guess about codebase facts — if Ix has structured data, use it. Say "according to Ix" when citing results.
5. IMMEDIATELY after modifying code → call \`ix_ingest\` on changed files. Do not batch this to the end of the session.
6. At start of each session → review \`ix://session/context\` to load prior work and decisions.
7. When the user states a goal → call \`ix_truth\` to record the intent so all decisions can trace back to it.

## Preferred Ix Command Routing

Use bounded, composable primitives — never broad NLP-style queries.

- \`ix_search\` — find entities by name, kind, or language (\`--kind class --limit 10\`)
- \`ix_entity\` — get full entity details (node, claims, edges) by ID
- \`ix_expand\` — traverse edges: CALLS, IMPORTS, CONTAINS (use direction + predicates)
- \`ix_text\` — fast lexical search via ripgrep (\`--language python --path src/\`)
- \`ix_decisions\` — list past design decisions (\`--topic "ingestion"\`)
- \`ix_history\` — entity provenance chain
- \`ix_diff\` — what changed between revisions
- \`ix_conflicts\` — detect contradictions
- \`ix_truth\` — manage project intents/goals

### Decompose broad questions into targeted calls:
- "How does X work?" → \`ix_search "X"\` → \`ix_entity <id>\` → \`ix_expand <id>\`
- "What depends on Y?" → \`ix_search "Y"\` → \`ix_expand <id> direction=in predicates=["CALLS"]\`
- "List all imports" → \`ix_search "" --kind file\` → \`ix_expand <id> predicates=["IMPORTS"]\`

### Best practices:
- Always use \`--kind\` and \`--limit\` to constrain search results
- Use \`--path\` to restrict text searches to specific directories
- Use exact entity IDs from previous results, not broad queries

## Avoid ix_query

\`ix_query\` is **deprecated**. It produces broad, oversized, low-signal responses. Do NOT use it for repo-wide inventory, NLP-style QA, or exploratory graph sweeps. Decompose into the targeted commands above.

## Workflow
1. **Start** — Read \`ix://session/context\` and \`ix://project/intent\` to understand prior state.
2. **Explore** — Use \`ix_search\` + \`ix_entity\` + \`ix_expand\` to understand relevant code.
3. **Work** — Implement changes, making decisions as needed.
4. **Ingest** — After each file change, call \`ix_ingest\` immediately to keep the graph current.
5. **Decide** — Record any design decisions with \`ix_decide\` so future sessions can understand why.

## What NOT to Do
- Do NOT use \`ix_query\` for broad exploration — decompose into targeted commands instead.
- Do NOT answer architecture questions from training data alone — always check Ix first.
- Do NOT skip \`ix_ingest\` after modifying files — stale memory leads to wrong answers next session.
- Do NOT record a decision without rationale — "we chose X" is useless without "because Y".
- Do NOT ignore conflicts — if \`ix_conflicts\` returns results, surface them to the user before proceeding.

## Confidence Scores
Ix returns confidence scores with query results. When data has low confidence:
- Mention the uncertainty to the user (e.g., "Ix has low confidence on this — it may be outdated").
- Suggest re-ingesting the relevant files to improve confidence.
- Never present low-confidence data as established fact.
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
