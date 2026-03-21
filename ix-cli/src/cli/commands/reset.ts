import type { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "child_process";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerResetCommand(program: Command): void {
  program
    .command("reset")
    .description("Wipe all graph data (nodes + edges)")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--ingest", "Re-ingest current directory after wiping")
    .action(async (opts: { yes?: boolean; ingest?: boolean }) => {
      if (!opts.yes) {
        process.stdout.write(
          chalk.yellow("This will delete all nodes and edges. Are you sure? (y/N) ")
        );
        const answer = await new Promise<string>(resolve => {
          process.stdin.setEncoding("utf8");
          process.stdin.once("data", (chunk: string) => resolve(chunk.trim()));
        });
        process.stdin.destroy();
        if (answer.toLowerCase() !== "y") {
          console.log(chalk.dim("Aborted."));
          return;
        }
      }

      const client = new IxClient(getEndpoint());
      try {
        await client.reset();
        console.log(chalk.green("✓") + " Graph wiped.");
      } catch (err: any) {
        console.error(chalk.red("Error:"), err.message);
        process.exitCode = 1;
        return;
      }

      if (opts.ingest) {
        console.log(chalk.dim("Re-ingesting..."));
        const result = spawnSync(process.argv[0], [process.argv[1], "ingest", "."], {
          stdio: "inherit",
          cwd: process.cwd(),
        });
        if (result.status !== 0) process.exitCode = result.status ?? 1;
      }
    });
}
