import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export const IX_MARKER_START = "<!-- IX-MEMORY START -->";
export const IX_MARKER_END = "<!-- IX-MEMORY END -->";

export const IX_CLAUDE_MD_BLOCK = `${IX_MARKER_START}
# Ix Memory System

This project uses Ix Memory — persistent, time-aware context for LLM assistants.

## MANDATORY RULES
1. BEFORE answering any question about the codebase → call \`ix_query\` first. Do NOT answer from training data alone.
2. AFTER every design or architecture decision → call \`ix_decide\` with both the conclusion AND the reasoning.
3. When you notice contradictory information → call \`ix_conflicts\` and present conflicts to the user before continuing.
4. NEVER guess about codebase facts — if Ix has structured data, use it. Say "according to Ix" when citing results.
5. IMMEDIATELY after modifying code → call \`ix_ingest\` on changed files. Do not batch this to the end of the session.
6. At start of each session → review \`ix://session/context\` to load prior work and decisions.
7. When the user states a goal → call \`ix_truth\` to record the intent so all decisions can trace back to it.

## Workflow
A typical session follows this flow:
1. **Start** — Read \`ix://session/context\` and \`ix://project/intent\` to understand prior state.
2. **Query** — Before any task, call \`ix_query\` to get relevant context from the knowledge graph.
3. **Work** — Implement changes, making decisions as needed.
4. **Ingest** — After each file change, call \`ix_ingest\` immediately to keep the graph current.
5. **Decide** — Record any design decisions with \`ix_decide\` so future sessions can understand why.

## What NOT to Do
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
