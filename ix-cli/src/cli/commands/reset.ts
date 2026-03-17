import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Wipe all graph data (nodes + edges) for a clean re-ingest")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        process.stdout.write(
          chalk.yellow("This will delete all nodes and edges. Are you sure? (y/N) ")
        );
        const answer = await new Promise<string>(resolve => {
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (chunk: string) => resolve(chunk.trim()));
        });
        if (answer.toLowerCase() !== "y") {
          console.log(chalk.dim("Aborted."));
          return;
        }
      }

      const client = new IxClient(getEndpoint());
      try {
        await client.reset();
        console.log(chalk.green("✓") + " Graph wiped. Run " + chalk.bold("ix ingest . --recursive") + " to re-ingest.");
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
      }
    });
}
