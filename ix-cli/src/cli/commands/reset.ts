import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stopServer, startServer, isServerRunning } from "../server-manager.js";
import { getDataDir } from "../config.js";

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Wipe the Ix database and start fresh")
    .option("--force", "Skip confirmation prompt")
    .action(async (opts: { force?: boolean }) => {
      try {
        if (!opts.force) {
          const confirmed = await confirm(
            "This will delete ALL graph data (nodes, edges, claims, decisions, plans, bugs).\n" +
            "Config and workspace registrations are preserved.\n" +
            "Continue? (y/N) "
          );
          if (!confirmed) {
            console.log("Cancelled.");
            return;
          }
        }

        // Stop server
        if (isServerRunning()) {
          console.log("Stopping server...");
          await stopServer();
        }

        // Wipe database
        const graphDir = join(getDataDir(), "data", "graph");
        if (existsSync(graphDir)) {
          console.log("Wiping database...");
          rmSync(graphDir, { recursive: true, force: true });
        }

        // Recreate directory
        mkdirSync(graphDir, { recursive: true });

        // Start server (creates fresh schema)
        console.log("Starting server with fresh database...");
        await startServer();

        console.log(chalk.green("\nDatabase reset complete."));
        console.log(`Re-ingest your codebase: ${chalk.bold("ix ingest ./src --recursive")}`);
      } catch (err: any) {
        console.error(chalk.red(`Reset failed: ${err.message}`));
        process.exit(1);
      }
    });
}

function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}
